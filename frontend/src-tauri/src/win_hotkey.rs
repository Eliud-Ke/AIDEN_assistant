//! Native Win32 low-level keyboard hook (`WH_KEYBOARD_LL`) for the `Win + Space` global shortcut:
//!
//! - Intercepts `Win + Space` (`VK_LWIN` or `VK_RWIN` + `VK_SPACE`) cleanly with zero conflicts
//!   on solo `Win` taps or any other `Win + *` system shortcuts (`Win+E`, `Win+L`, `Win+Shift+S`,
//!   `Win+Arrows`, `Ctrl+Win+Left/Right`, etc. all pass straight through 100% natively).
//! - On `Win + Space` key-down, swallows `VK_SPACE`, injects a harmless `0xFF` key-up chord
//!   suppressor so releasing `Win` never pops the Windows Start Menu (and suppresses the Windows
//!   Input Switcher flyout), and toggles AIDEN (`Awake <-> Minimize`).

pub const VK_LWIN_CODE: u32 = 0x5B;
pub const VK_RWIN_CODE: u32 = 0x5C;
pub const VK_SPACE_CODE: u32 = 0x20;
#[cfg(target_os = "windows")]
const AIDEN_INJECTED_TAG: usize = 0x4149_444E; // "AIDN"

const DEBOUNCE_MS: u64 = 160;
const STALE_HOLD_MS: u64 = 5000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookAction {
    /// Pass event unchanged to Windows (`CallNextHookEx`).
    PassThrough,
    /// Swallow event completely (`return LRESULT(1)`), send nothing.
    Swallow,
    /// Swallow `VK_SPACE DOWN`, suppress Start Menu release on `Win`, and toggle AIDEN.
    SwallowAndTriggerAiden,
}

/// Pure, allocation-free, unit-tested `Win + Space` state machine.
#[derive(Debug, Default)]
pub struct WinKeyStateMachine {
    lwin_down: bool,
    rwin_down: bool,
    space_swallowed: bool,
    last_activity_ms: u64,
    last_trigger_ms: u64,
    has_triggered: bool,
}

impl WinKeyStateMachine {
    pub const fn new() -> Self {
        Self {
            lwin_down: false,
            rwin_down: false,
            space_swallowed: false,
            last_activity_ms: 0,
            last_trigger_ms: 0,
            has_triggered: false,
        }
    }

    pub fn reset(&mut self) {
        self.lwin_down = false;
        self.rwin_down = false;
        self.space_swallowed = false;
        self.last_activity_ms = 0;
    }

    /// Processes a single low-level keyboard event.
    /// Must remain branch-minimal and allocation-free so `WH_KEYBOARD_LL` returns in microseconds.
    pub fn on_key_event(
        &mut self,
        vk_code: u32,
        is_down: bool,
        is_injected: bool,
        win_physically_held: bool,
        other_modifier_held: bool,
        now_ms: u64,
    ) -> HookAction {
        if is_injected {
            return HookAction::PassThrough;
        }

        // Stale safety recovery if a secure desktop (UAC / Winlogon) swallowed key-up events.
        if (self.lwin_down || self.rwin_down || self.space_swallowed)
            && now_ms.saturating_sub(self.last_activity_ms) > STALE_HOLD_MS
        {
            self.reset();
        }

        if vk_code == VK_LWIN_CODE {
            self.lwin_down = is_down;
            self.last_activity_ms = now_ms;
            if !is_down && !self.rwin_down {
                self.space_swallowed = false;
            }
            return HookAction::PassThrough;
        }

        if vk_code == VK_RWIN_CODE {
            self.rwin_down = is_down;
            self.last_activity_ms = now_ms;
            if !is_down && !self.lwin_down {
                self.space_swallowed = false;
            }
            return HookAction::PassThrough;
        }

        if vk_code == VK_SPACE_CODE {
            let win_active = self.lwin_down || self.rwin_down || win_physically_held;
            if is_down {
                if win_active && !other_modifier_held {
                    self.last_activity_ms = now_ms;
                    if self.space_swallowed {
                        return HookAction::Swallow;
                    }
                    self.space_swallowed = true;
                    let debounced = self.has_triggered
                        && now_ms.saturating_sub(self.last_trigger_ms) < DEBOUNCE_MS;
                    if !debounced {
                        self.last_trigger_ms = now_ms;
                        self.has_triggered = true;
                        return HookAction::SwallowAndTriggerAiden;
                    }
                    return HookAction::Swallow;
                }
                return HookAction::PassThrough;
            } else {
                if self.space_swallowed {
                    self.space_swallowed = false;
                    self.last_activity_ms = now_ms;
                    return HookAction::Swallow;
                }
                return HookAction::PassThrough;
            }
        }

        if self.lwin_down || self.rwin_down {
            self.last_activity_ms = now_ms;
        }
        HookAction::PassThrough
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{HookAction, WinKeyStateMachine, AIDEN_INJECTED_TAG, VK_SPACE_CODE};
    use std::sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc, Mutex, OnceLock,
    };
    use std::time::Instant;
    use windows::Win32::{
        Foundation::{LPARAM, LRESULT, WPARAM},
        System::Threading::GetCurrentThreadId,
        UI::{
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT,
                KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
            },
            WindowsAndMessaging::{
                CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW,
                SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT,
                LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT,
                WM_SYSKEYDOWN, WM_SYSKEYUP,
            },
        },
    };

    static USER_ENABLED: AtomicBool = AtomicBool::new(true);
    static ENGINE_PAUSED: AtomicBool = AtomicBool::new(false);
    static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
    static START_INSTANT: OnceLock<Instant> = OnceLock::new();
    static STATE_MACHINE: Mutex<WinKeyStateMachine> = Mutex::new(WinKeyStateMachine::new());
    static WORKER_TX: OnceLock<Mutex<Option<mpsc::Sender<()>>>> = OnceLock::new();

    fn now_ms() -> u64 {
        let start = START_INSTANT.get_or_init(Instant::now);
        start.elapsed().as_millis() as u64
    }

    fn hook_active() -> bool {
        USER_ENABLED.load(Ordering::Acquire) && !ENGINE_PAUSED.load(Ordering::Acquire)
    }

    fn win_is_physically_held() -> bool {
        unsafe {
            let is_down = |vk: VIRTUAL_KEY| ((GetAsyncKeyState(vk.0 as i32) as u16) & 0x8000) != 0;
            is_down(VK_LWIN) || is_down(VK_RWIN)
        }
    }

    fn other_modifier_is_held() -> bool {
        unsafe {
            let is_down = |vk: VIRTUAL_KEY| ((GetAsyncKeyState(vk.0 as i32) as u16) & 0x8000) != 0;
            is_down(VK_CONTROL) || is_down(VK_MENU) || is_down(VK_SHIFT)
        }
    }

    fn dispatch_worker() {
        if let Some(lock) = WORKER_TX.get() {
            if let Ok(guard) = lock.try_lock() {
                if let Some(ref tx) = *guard {
                    let _ = tx.send(());
                }
            }
        }
    }

    /// Injects a benign unassigned VK (`0xFF`) key-up event while `Win` is held so Windows
    /// treats the held `Win` key as part of an answered chord and never opens Start Menu on `Win` up.
    fn send_win_chord_suppressor() {
        let dummy = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0xFF),
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: AIDEN_INJECTED_TAG,
                },
            },
        };
        unsafe {
            let _ = SendInput(&[dummy], std::mem::size_of::<INPUT>() as i32);
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
                    let (win_held, other_mod) = if is_down && kb.vkCode == VK_SPACE_CODE {
                        (win_is_physically_held(), other_modifier_is_held())
                    } else {
                        (false, false)
                    };

                    let action = if let Ok(mut sm) = STATE_MACHINE.try_lock() {
                        sm.on_key_event(kb.vkCode, is_down, false, win_held, other_mod, now_ms())
                    } else {
                        HookAction::PassThrough
                    };

                    match action {
                        HookAction::Swallow => {
                            return LRESULT(1);
                        }
                        HookAction::SwallowAndTriggerAiden => {
                            send_win_chord_suppressor();
                            dispatch_worker();
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
        let (tx, rx) = mpsc::channel::<()>();

        let holder = WORKER_TX.get_or_init(|| Mutex::new(None));
        if let Ok(mut guard) = holder.lock() {
            *guard = Some(tx);
        }

        // Dedicated worker thread runs Tauri toggle completely off the hook thread
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                on_trigger();
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

            println!("[WIN_HOTKEY] Installed Win+Space global shortcut hook.");

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            let _ = UnhookWindowsHookEx(hook);
            HOOK_THREAD_ID.store(0, Ordering::SeqCst);
            println!("[WIN_HOTKEY] Unhooked Win+Space shortcut hook cleanly.");
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
    use super::{
        HookAction, WinKeyStateMachine, VK_LWIN_CODE, VK_RWIN_CODE, VK_SPACE_CODE,
    };

    const VK_E: u32 = 0x45;
    const VK_L: u32 = 0x4C;
    const VK_LSHIFT: u32 = 0xA0;
    const VK_S: u32 = 0x53;

    #[test]
    fn win_space_swallows_space_and_triggers_aiden_while_win_passes_through() {
        let mut sm = WinKeyStateMachine::new();
        assert_eq!(
            sm.on_key_event(VK_LWIN_CODE, true, false, false, false, 100),
            HookAction::PassThrough
        );
        assert_eq!(
            sm.on_key_event(VK_SPACE_CODE, true, false, true, false, 130),
            HookAction::SwallowAndTriggerAiden
        );
        // Auto-repeat while holding Space remains swallowed
        assert_eq!(
            sm.on_key_event(VK_SPACE_CODE, true, false, true, false, 160),
            HookAction::Swallow
        );
        assert_eq!(
            sm.on_key_event(VK_SPACE_CODE, false, false, true, false, 200),
            HookAction::Swallow
        );
        assert_eq!(
            sm.on_key_event(VK_LWIN_CODE, false, false, false, false, 240),
            HookAction::PassThrough
        );
    }

    #[test]
    fn solo_win_and_other_win_combos_pass_through_natively() {
        let mut sm = WinKeyStateMachine::new();
        // Solo Left Win tap
        assert_eq!(
            sm.on_key_event(VK_LWIN_CODE, true, false, false, false, 100),
            HookAction::PassThrough
        );
        assert_eq!(
            sm.on_key_event(VK_LWIN_CODE, false, false, false, false, 150),
            HookAction::PassThrough
        );

        // Win + E, Win + L, Win + Shift + S
        assert_eq!(
            sm.on_key_event(VK_LWIN_CODE, true, false, false, false, 300),
            HookAction::PassThrough
        );
        assert_eq!(
            sm.on_key_event(VK_E, true, false, true, false, 320),
            HookAction::PassThrough
        );
        assert_eq!(
            sm.on_key_event(VK_L, true, false, true, false, 360),
            HookAction::PassThrough
        );
        assert_eq!(
            sm.on_key_event(VK_LSHIFT, true, false, true, false, 400),
            HookAction::PassThrough
        );
        assert_eq!(
            sm.on_key_event(VK_S, true, false, true, true, 420),
            HookAction::PassThrough
        );
        assert_eq!(
            sm.on_key_event(VK_LWIN_CODE, false, false, false, false, 460),
            HookAction::PassThrough
        );

        // Ctrl+Win+Space (other modifier held) passes through natively
        assert_eq!(
            sm.on_key_event(VK_LWIN_CODE, true, false, false, true, 700),
            HookAction::PassThrough
        );
        assert_eq!(
            sm.on_key_event(VK_SPACE_CODE, true, false, true, true, 730),
            HookAction::PassThrough
        );
        assert_eq!(
            sm.on_key_event(VK_SPACE_CODE, false, false, true, true, 760),
            HookAction::PassThrough
        );
    }

    #[test]
    fn right_win_plus_space_and_debounce_work_cleanly() {
        let mut sm = WinKeyStateMachine::new();
        assert_eq!(
            sm.on_key_event(VK_RWIN_CODE, true, false, false, false, 500),
            HookAction::PassThrough
        );
        assert_eq!(
            sm.on_key_event(VK_SPACE_CODE, true, false, true, false, 530),
            HookAction::SwallowAndTriggerAiden
        );
        assert_eq!(
            sm.on_key_event(VK_SPACE_CODE, false, false, true, false, 560),
            HookAction::Swallow
        );

        // Rapid bounce < 160ms while Win still held is swallowed without double trigger
        assert_eq!(
            sm.on_key_event(VK_SPACE_CODE, true, false, true, false, 600),
            HookAction::Swallow
        );
        assert_eq!(
            sm.on_key_event(VK_SPACE_CODE, false, false, true, false, 630),
            HookAction::Swallow
        );
        assert_eq!(
            sm.on_key_event(VK_RWIN_CODE, false, false, false, false, 660),
            HookAction::PassThrough
        );

        // Injected events always pass through
        assert_eq!(
            sm.on_key_event(VK_SPACE_CODE, true, true, true, false, 900),
            HookAction::PassThrough
        );
    }
}
