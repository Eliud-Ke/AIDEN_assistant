//! Native Win32 low-level keyboard hook (`WH_KEYBOARD_LL`) using **Deferred `VK_LWIN` Down**:
//!
//! - On physical Left `Win` (`VK_LWIN`) key-down (with no other modifier already held), the hook
//!   swallows `VK_LWIN DOWN` so Windows never arms the Start Menu on a solo tap.
//! - On a clean solo Left `Win` key-up, the hook swallows `VK_LWIN UP` and toggles AIDEN
//!   (`Awake <-> Minimize`) with zero Start Menu flicker, zero dummy keystrokes, and zero focus races.
//! - On any `Win+*` combo (`Win+E`, `Win+R`, `Win+D`, `Win+V`, `Win+Shift+S`, `Win+Tab`,
//!   `Win+Arrows`, etc.), the hook atomically replays `[VK_LWIN DOWN, <key> DOWN]` preserving
//!   hardware scan codes and extended-key flags, then passes all subsequent keys and key-ups through.
//! - On `Win+L`, since Windows blocks synthetic `SendInput` workstation locking for security, the
//!   hook swallows `'L'` and invokes Win32 `LockWorkStation()` directly on its worker thread.
//! - `Right Win` (`VK_RWIN`), `Ctrl+Esc`, and pre-held chords (`Ctrl+Win+*`, `Alt+Win+*`,
//!   `Shift+Win+*`) always pass straight through 100% natively.

pub const VK_LWIN_CODE: u32 = 0x5B;
pub const VK_L_CODE: u32 = 0x4C;
#[cfg(target_os = "windows")]
const LWIN_HARDWARE_SCAN: u16 = 0x5B;
#[cfg(target_os = "windows")]
const AIDEN_INJECTED_TAG: usize = 0x4149_444E; // "AIDN"

const DEBOUNCE_MS: u64 = 180;
const MAX_TAP_HOLD_MS: u64 = 800;
const STALE_HOLD_MS: u64 = 5000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookAction {
    /// Pass event unchanged to Windows (`CallNextHookEx`).
    PassThrough,
    /// Swallow event completely (`return LRESULT(1)`), send nothing.
    Swallow,
    /// Swallow `VK_LWIN UP` (`return LRESULT(1)`) and toggle AIDEN (`Awake <-> Minimize`).
    SwallowAndTriggerAiden,
    /// Swallow `<key> DOWN` (`return LRESULT(1)`) and atomically replay `[VK_LWIN DOWN, <key> DOWN]`.
    ForwardLWinAndKeyDown,
    /// Swallow `'L' DOWN` (`return LRESULT(1)`) and call `LockWorkStation()` off-hook.
    SwallowAndLockWorkstation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
enum LWinPhase {
    #[default]
    Idle,
    /// Physical `VK_LWIN` is held and swallowed; Windows does not know `LWin` is down yet.
    HeldSuppressed,
    /// Another key was pressed while holding `LWin`; `[VK_LWIN DOWN, <key> DOWN]` was replayed to Windows.
    ForwardedCombo,
    /// `Win+L` triggered `LockWorkStation()` directly; swallow its matching key-ups cleanly.
    LockedSuppressed,
}

/// Pure, allocation-free, unit-tested Deferred-`VK_LWIN` state machine.
#[derive(Debug, Default)]
pub struct WinKeyStateMachine {
    phase: LWinPhase,
    down_at_ms: u64,
    last_activity_ms: u64,
    last_trigger_ms: u64,
    has_triggered: bool,
}

impl WinKeyStateMachine {
    pub const fn new() -> Self {
        Self {
            phase: LWinPhase::Idle,
            down_at_ms: 0,
            last_activity_ms: 0,
            last_trigger_ms: 0,
            has_triggered: false,
        }
    }

    pub fn reset(&mut self) {
        self.phase = LWinPhase::Idle;
        self.down_at_ms = 0;
        self.last_activity_ms = 0;
    }

    /// Processes a single low-level keyboard event.
    /// Must remain branch-minimal and allocation-free so `WH_KEYBOARD_LL` returns in microseconds.
    pub fn on_key_event(
        &mut self,
        vk_code: u32,
        is_down: bool,
        is_injected: bool,
        other_modifier_held: bool,
        now_ms: u64,
    ) -> HookAction {
        if is_injected {
            return HookAction::PassThrough;
        }

        // Stale safety recovery if a secure desktop (UAC / Winlogon) swallowed a key-up.
        if self.phase != LWinPhase::Idle
            && now_ms.saturating_sub(self.last_activity_ms) > STALE_HOLD_MS
        {
            self.phase = LWinPhase::Idle;
        }

        if vk_code == VK_LWIN_CODE {
            if is_down {
                match self.phase {
                    LWinPhase::HeldSuppressed => {
                        // Keyboard auto-repeat while user holds Left Win: keep suppressing Start.
                        self.last_activity_ms = now_ms;
                        return HookAction::Swallow;
                    }
                    LWinPhase::Idle | LWinPhase::ForwardedCombo | LWinPhase::LockedSuppressed => {
                        // If Ctrl/Alt/Shift/RightWin is already held before Left Win goes down,
                        // let Windows handle chords like Ctrl+Win+Left/Right 100% natively.
                        if other_modifier_held {
                            self.phase = LWinPhase::Idle;
                            return HookAction::PassThrough;
                        }
                        self.phase = LWinPhase::HeldSuppressed;
                        self.down_at_ms = now_ms;
                        self.last_activity_ms = now_ms;
                        return HookAction::Swallow;
                    }
                }
            } else {
                // Physical VK_LWIN UP
                match self.phase {
                    LWinPhase::HeldSuppressed => {
                        self.phase = LWinPhase::Idle;
                        let hold_ms = now_ms.saturating_sub(self.down_at_ms);
                        let debounced = self.has_triggered
                            && now_ms.saturating_sub(self.last_trigger_ms) < DEBOUNCE_MS;
                        if hold_ms <= MAX_TAP_HOLD_MS && !debounced {
                            self.last_trigger_ms = now_ms;
                            self.has_triggered = true;
                            return HookAction::SwallowAndTriggerAiden;
                        }
                        return HookAction::Swallow;
                    }
                    LWinPhase::LockedSuppressed => {
                        self.phase = LWinPhase::Idle;
                        return HookAction::Swallow;
                    }
                    LWinPhase::ForwardedCombo => {
                        self.phase = LWinPhase::Idle;
                        return HookAction::PassThrough;
                    }
                    LWinPhase::Idle => {
                        return HookAction::PassThrough;
                    }
                }
            }
        }

        // Non-LWin key event
        match self.phase {
            LWinPhase::HeldSuppressed => {
                if is_down {
                    self.last_activity_ms = now_ms;
                    if vk_code == VK_L_CODE && !other_modifier_held {
                        self.phase = LWinPhase::LockedSuppressed;
                        return HookAction::SwallowAndLockWorkstation;
                    }
                    self.phase = LWinPhase::ForwardedCombo;
                    return HookAction::ForwardLWinAndKeyDown;
                }
                HookAction::PassThrough
            }
            LWinPhase::LockedSuppressed => {
                if !is_down && vk_code == VK_L_CODE {
                    return HookAction::Swallow;
                }
                if is_down {
                    // User unlocked workstation and pressed another key (Winlogon ate LWin UP).
                    self.phase = LWinPhase::Idle;
                }
                HookAction::PassThrough
            }
            LWinPhase::ForwardedCombo => {
                self.last_activity_ms = now_ms;
                HookAction::PassThrough
            }
            LWinPhase::Idle => HookAction::PassThrough,
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{
        HookAction, WinKeyStateMachine, AIDEN_INJECTED_TAG, LWIN_HARDWARE_SCAN, VK_LWIN_CODE,
        VK_L_CODE,
    };
    use std::sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc, Mutex, OnceLock,
    };
    use std::time::Instant;
    use windows::Win32::{
        Foundation::{LPARAM, LRESULT, WPARAM},
        System::{Shutdown::LockWorkStation, Threading::GetCurrentThreadId},
        UI::{
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
                KEYEVENTF_EXTENDEDKEY, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN,
                VK_SHIFT,
            },
            WindowsAndMessaging::{
                CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW,
                SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT,
                LLKHF_EXTENDED, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
                WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
            },
        },
    };

    enum WorkerCmd {
        ToggleAiden,
        LockWorkstation,
    }

    static USER_ENABLED: AtomicBool = AtomicBool::new(true);
    static ENGINE_PAUSED: AtomicBool = AtomicBool::new(false);
    static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
    static START_INSTANT: OnceLock<Instant> = OnceLock::new();
    static STATE_MACHINE: Mutex<WinKeyStateMachine> = Mutex::new(WinKeyStateMachine::new());
    static WORKER_TX: OnceLock<Mutex<Option<mpsc::Sender<WorkerCmd>>>> = OnceLock::new();

    fn now_ms() -> u64 {
        let start = START_INSTANT.get_or_init(Instant::now);
        start.elapsed().as_millis() as u64
    }

    fn hook_active() -> bool {
        USER_ENABLED.load(Ordering::Acquire) && !ENGINE_PAUSED.load(Ordering::Acquire)
    }

    fn other_modifier_is_held() -> bool {
        unsafe {
            let is_down = |vk: VIRTUAL_KEY| ((GetAsyncKeyState(vk.0 as i32) as u16) & 0x8000) != 0;
            is_down(VK_CONTROL) || is_down(VK_MENU) || is_down(VK_SHIFT) || is_down(VK_RWIN)
        }
    }

    fn dispatch_worker(cmd: WorkerCmd) {
        if let Some(lock) = WORKER_TX.get() {
            if let Ok(guard) = lock.try_lock() {
                if let Some(ref tx) = *guard {
                    let _ = tx.send(cmd);
                }
            }
        }
    }

    /// Atomically replays `[VK_LWIN DOWN, <key> DOWN]` into the Windows input stream,
    /// preserving the combo key's hardware scan code and extended-key flag (critical for
    /// `Win+Arrows`, `Win+Shift+S`, `Win+Tab`, `Win+E`, `Win+R`, etc.).
    fn send_forwarded_lwin_and_key_down(vk_code: u32, scan_code: u32, is_extended: bool) {
        let lwin_down = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_LWIN,
                    wScan: LWIN_HARDWARE_SCAN,
                    dwFlags: KEYEVENTF_EXTENDEDKEY,
                    time: 0,
                    dwExtraInfo: AIDEN_INJECTED_TAG,
                },
            },
        };

        let key_down = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(vk_code as u16),
                    wScan: scan_code as u16,
                    dwFlags: if is_extended {
                        KEYEVENTF_EXTENDEDKEY
                    } else {
                        Default::default()
                    },
                    time: 0,
                    dwExtraInfo: AIDEN_INJECTED_TAG,
                },
            },
        };

        let inputs = [lwin_down, key_down];
        unsafe {
            let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    unsafe extern "system" fn low_level_keyboard_proc(
        n_code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        if n_code >= 0 && hook_active() && l_param.0 != 0 {
            let msg = w_param.0 as u32;
            let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;

            if is_down || is_up {
                let kb = unsafe { &*(l_param.0 as *const KBDLLHOOKSTRUCT) };
                let is_injected = (kb.flags.0 & LLKHF_INJECTED.0) != 0
                    || kb.dwExtraInfo == AIDEN_INJECTED_TAG;

                if !is_injected {
                    let check_mods = is_down && (kb.vkCode == VK_LWIN_CODE || kb.vkCode == VK_L_CODE);
                    let other_mod = if check_mods {
                        other_modifier_is_held()
                    } else {
                        false
                    };

                    let action = if let Ok(mut sm) = STATE_MACHINE.try_lock() {
                        sm.on_key_event(kb.vkCode, is_down, false, other_mod, now_ms())
                    } else {
                        HookAction::PassThrough
                    };

                    match action {
                        HookAction::Swallow => {
                            return LRESULT(1);
                        }
                        HookAction::SwallowAndTriggerAiden => {
                            dispatch_worker(WorkerCmd::ToggleAiden);
                            return LRESULT(1);
                        }
                        HookAction::ForwardLWinAndKeyDown => {
                            let is_extended = (kb.flags.0 & LLKHF_EXTENDED.0) != 0;
                            send_forwarded_lwin_and_key_down(kb.vkCode, kb.scanCode, is_extended);
                            return LRESULT(1);
                        }
                        HookAction::SwallowAndLockWorkstation => {
                            dispatch_worker(WorkerCmd::LockWorkstation);
                            return LRESULT(1);
                        }
                        HookAction::PassThrough => {}
                    }
                }
            }
        }

        unsafe { CallNextHookEx(None, n_code, w_param, l_param) }
    }

    pub fn set_enabled(enabled: bool) {
        USER_ENABLED.store(enabled, Ordering::Release);
        if !enabled {
            if let Ok(mut sm) = STATE_MACHINE.lock() {
                sm.reset();
            }
        }
    }

    pub fn is_enabled() -> bool {
        USER_ENABLED.load(Ordering::Acquire)
    }

    pub fn set_engine_paused(paused: bool) {
        ENGINE_PAUSED.store(paused, Ordering::Release);
        if paused {
            if let Ok(mut sm) = STATE_MACHINE.lock() {
                sm.reset();
            }
        }
    }

    pub fn stop_hook() {
        USER_ENABLED.store(false, Ordering::Release);
        let tid = HOOK_THREAD_ID.swap(0, Ordering::SeqCst);
        if tid != 0 {
            unsafe {
                let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }

    pub fn start_hook<F>(on_trigger: F)
    where
        F: Fn() + Send + 'static,
    {
        let _ = START_INSTANT.get_or_init(Instant::now);
        let (tx, rx) = mpsc::channel::<WorkerCmd>();

        let holder = WORKER_TX.get_or_init(|| Mutex::new(None));
        if let Ok(mut guard) = holder.lock() {
            *guard = Some(tx);
        }

        // Dedicated worker thread runs Tauri toggle & Win+L lock completely off the hook thread
        std::thread::spawn(move || {
            while let Ok(cmd) = rx.recv() {
                match cmd {
                    WorkerCmd::ToggleAiden => on_trigger(),
                    WorkerCmd::LockWorkstation => unsafe {
                        let _ = LockWorkStation();
                    },
                }
            }
        });

        // Dedicated Win32 message-pump thread owns WH_KEYBOARD_LL
        std::thread::spawn(move || unsafe {
            let tid = GetCurrentThreadId();
            HOOK_THREAD_ID.store(tid, Ordering::SeqCst);

            let Ok(hook) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(low_level_keyboard_proc), None, 0)
            else {
                eprintln!("[WIN_HOTKEY] Failed to install WH_KEYBOARD_LL hook.");
                HOOK_THREAD_ID.store(0, Ordering::SeqCst);
                return;
            };

            println!("[WIN_HOTKEY] Installed Deferred Left-Win hook (zero-flicker Start Menu override active).");

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let _ = UnhookWindowsHookEx(hook);
            HOOK_THREAD_ID.store(0, Ordering::SeqCst);
            println!("[WIN_HOTKEY] Unhooked Left-Win hook cleanly.");
        });
    }
}

#[cfg(target_os = "windows")]
pub use platform::{is_enabled, set_enabled, set_engine_paused, start_hook, stop_hook};

#[cfg(not(target_os = "windows"))]
pub fn set_enabled(_enabled: bool) {}
#[cfg(not(target_os = "windows"))]
pub fn is_enabled() -> bool {
    false
}
#[cfg(not(target_os = "windows"))]
pub fn set_engine_paused(_paused: bool) {}
#[cfg(not(target_os = "windows"))]
pub fn stop_hook() {}
#[cfg(not(target_os = "windows"))]
pub fn start_hook<F>(_on_trigger: F)
where
    F: Fn() + Send + 'static,
{
}

#[cfg(test)]
mod tests {
    use super::{HookAction, WinKeyStateMachine, VK_LWIN_CODE, VK_L_CODE};

    const VK_RWIN: u32 = 0x5C;
    const VK_E: u32 = 0x45;
    const VK_LSHIFT: u32 = 0xA0;
    const VK_S: u32 = 0x53;
    const VK_RIGHT: u32 = 0x27;
    const VK_UP: u32 = 0x26;

    #[test]
    fn solo_left_win_tap_swallows_both_edges_and_triggers() {
        let mut sm = WinKeyStateMachine::new();
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, true, false, false, 100), HookAction::Swallow);
        // Auto-repeat while held stays swallowed
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, true, false, false, 200), HookAction::Swallow);
        assert_eq!(
            sm.on_key_event(VK_LWIN_CODE, false, false, false, 240),
            HookAction::SwallowAndTriggerAiden
        );
    }

    #[test]
    fn win_combos_defer_lwin_down_then_pass_through_cleanly() {
        let mut sm = WinKeyStateMachine::new();
        // Win + E
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, true, false, false, 100), HookAction::Swallow);
        assert_eq!(
            sm.on_key_event(VK_E, true, false, false, 130),
            HookAction::ForwardLWinAndKeyDown
        );
        assert_eq!(sm.on_key_event(VK_E, false, false, false, 170), HookAction::PassThrough);
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, false, false, false, 200), HookAction::PassThrough);

        // Win + Shift + S (Snipping Tool)
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, true, false, false, 500), HookAction::Swallow);
        assert_eq!(
            sm.on_key_event(VK_LSHIFT, true, false, false, 520),
            HookAction::ForwardLWinAndKeyDown
        );
        assert_eq!(sm.on_key_event(VK_S, true, false, false, 540), HookAction::PassThrough);
        assert_eq!(sm.on_key_event(VK_S, false, false, false, 580), HookAction::PassThrough);
        assert_eq!(sm.on_key_event(VK_LSHIFT, false, false, false, 590), HookAction::PassThrough);
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, false, false, false, 610), HookAction::PassThrough);

        // Multi-key snap: Win + Right, then Up while still holding Win
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, true, false, false, 900), HookAction::Swallow);
        assert_eq!(
            sm.on_key_event(VK_RIGHT, true, false, false, 920),
            HookAction::ForwardLWinAndKeyDown
        );
        assert_eq!(sm.on_key_event(VK_RIGHT, false, false, false, 950), HookAction::PassThrough);
        assert_eq!(sm.on_key_event(VK_UP, true, false, false, 980), HookAction::PassThrough);
        assert_eq!(sm.on_key_event(VK_UP, false, false, false, 1010), HookAction::PassThrough);
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, false, false, false, 1040), HookAction::PassThrough);

        // Pre-held modifier (Ctrl+Win+Right) passes straight through untouched
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, true, false, true, 1500), HookAction::PassThrough);
        assert_eq!(sm.on_key_event(VK_RIGHT, true, false, true, 1520), HookAction::PassThrough);
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, false, false, false, 1560), HookAction::PassThrough);
    }

    #[test]
    fn win_l_invokes_native_lock_and_recovers_after_unlock() {
        let mut sm = WinKeyStateMachine::new();
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, true, false, false, 100), HookAction::Swallow);
        assert_eq!(
            sm.on_key_event(VK_L_CODE, true, false, false, 130),
            HookAction::SwallowAndLockWorkstation
        );
        // Even if Winlogon swallows both key-ups, unlocking and tapping Left Win works immediately
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, true, false, false, 900), HookAction::Swallow);
        assert_eq!(
            sm.on_key_event(VK_LWIN_CODE, false, false, false, 960),
            HookAction::SwallowAndTriggerAiden
        );
    }

    #[test]
    fn right_win_injected_bounces_and_long_holds_stay_clean() {
        let mut sm = WinKeyStateMachine::new();
        // Right Win stays 100% native
        assert_eq!(sm.on_key_event(VK_RWIN, true, false, false, 100), HookAction::PassThrough);
        assert_eq!(sm.on_key_event(VK_RWIN, false, false, false, 150), HookAction::PassThrough);

        // Injected events always pass through
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, true, true, false, 200), HookAction::PassThrough);
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, false, true, false, 220), HookAction::PassThrough);

        // Hardware bounce < 180ms is swallowed silently without double-toggling
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, true, false, false, 400), HookAction::Swallow);
        assert_eq!(
            sm.on_key_event(VK_LWIN_CODE, false, false, false, 450),
            HookAction::SwallowAndTriggerAiden
        );
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, true, false, false, 500), HookAction::Swallow);
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, false, false, false, 530), HookAction::Swallow);

        // Aborted long solo hold (> 800ms) silently cancels without triggering AIDEN or Start Menu
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, true, false, false, 2000), HookAction::Swallow);
        assert_eq!(sm.on_key_event(VK_LWIN_CODE, false, false, false, 3200), HookAction::Swallow);
    }
}
