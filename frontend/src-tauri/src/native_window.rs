#[cfg(target_os = "windows")]
use std::sync::{
    atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicUsize, Ordering},
    Arc, Mutex,
};
use windows::{
    core::Result,
    Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    },
    Win32::{
        Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, WPARAM},
        Graphics::Dwm::{
            DwmExtendFrameIntoClientArea, DwmFlush, DwmSetWindowAttribute,
            DWMWINDOWATTRIBUTE, DWM_SYSTEMBACKDROP_TYPE, DWM_WINDOW_CORNER_PREFERENCE,
        },
        System::{
            Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS},
            Threading::{AttachThreadInput, GetCurrentThreadId},
            WinRT::{RoInitialize, RO_INIT_MULTITHREADED},
        },
        UI::Controls::MARGINS,
        UI::Input::KeyboardAndMouse::{SetActiveWindow, SetFocus},
        UI::WindowsAndMessaging::{
            AllowSetForegroundWindow, BeginDeferWindowPos, BringWindowToTop, CallWindowProcW,
            DefWindowProcW, DeferWindowPos, EndDeferWindowPos, GetCursorPos, GetForegroundWindow,
            GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
            IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow, SetLayeredWindowAttributes,
            SetWindowLongPtrW, SetWindowPos, ShowWindow, ASFW_ANY, GWL_EXSTYLE, GWLP_WNDPROC,
            HWND_TOPMOST, LWA_ALPHA, MA_NOACTIVATE, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
            SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            SWP_NOZORDER, SW_HIDE, SW_SHOWNOACTIVATE, WM_MOUSEACTIVATE, WM_NCACTIVATE, WNDPROC,
            WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
        },
    },
};

#[cfg(target_os = "windows")]
static PREV_WNDPROC: AtomicUsize = AtomicUsize::new(0);

#[cfg(target_os = "windows")]
static DRAWER_PREV_WNDPROC: AtomicUsize = AtomicUsize::new(0);

#[cfg(target_os = "windows")]
unsafe extern "system" fn drawer_subclass_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // Keep Windows 11 Acrylic vibrant while unfocused, and ensure clicks/scrolls inside
    // the detached search drawer never steal keyboard focus from the Search or Ask pill.
    if msg == WM_NCACTIVATE {
        return unsafe { DefWindowProcW(hwnd, WM_NCACTIVATE, WPARAM(1), lparam) };
    }
    if msg == WM_MOUSEACTIVATE {
        return LRESULT(MA_NOACTIVATE as isize);
    }

    let prev = DRAWER_PREV_WNDPROC.load(Ordering::Relaxed);
    if prev != 0 {
        let prev_fn: WNDPROC = unsafe { std::mem::transmute(prev) };
        unsafe { CallWindowProcW(prev_fn, hwnd, msg, wparam, lparam) }
    } else {
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }
}

#[cfg(target_os = "windows")]
pub fn apply_native_drawer_chrome(hwnd: HWND, dark_mode: bool) -> Result<()> {
    unsafe {
        let margins = MARGINS {
            cxLeftWidth: -1,
            cxRightWidth: -1,
            cyTopHeight: -1,
            cyBottomHeight: -1,
        };
        let _ = DwmExtendFrameIntoClientArea(hwnd, &margins);

        let backdrop = DWM_SYSTEMBACKDROP_TYPE(3); // DWMSBT_TRANSIENTWINDOW (Acrylic)
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(38),
            &backdrop as *const _ as *const _,
            std::mem::size_of_val(&backdrop) as u32,
        );

        let corner = DWM_WINDOW_CORNER_PREFERENCE(2); // DWMWCP_ROUND
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(33),
            &corner as *const _ as *const _,
            std::mem::size_of_val(&corner) as u32,
        );

        let border_color: u32 = if dark_mode { 0x00383838 } else { 0x00D0D0D0 };
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(34),
            &border_color as *const _ as *const _,
            std::mem::size_of_val(&border_color) as u32,
        );

        let dark = windows::core::BOOL(if dark_mode { 1 } else { 0 });
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(20),
            &dark as *const _ as *const _,
            std::mem::size_of_val(&dark) as u32,
        );

        let prev = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
        let my_proc = drawer_subclass_wndproc as *const () as usize as isize;
        if prev != 0 && prev != my_proc {
            DRAWER_PREV_WNDPROC.store(prev as usize, Ordering::Relaxed);
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, my_proc);
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn pill_subclass_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // Intercept WM_NCACTIVATE to force the window to always report as ACTIVE to DWM.
    // This prevents Windows 11 Acrylic from collapsing to a flat opaque gray when unfocused!
    if msg == WM_NCACTIVATE {
        return unsafe { DefWindowProcW(hwnd, WM_NCACTIVATE, WPARAM(1), lparam) };
    }

    let prev = PREV_WNDPROC.load(Ordering::Relaxed);
    if prev != 0 {
        let prev_fn: WNDPROC = unsafe { std::mem::transmute(prev) };
        unsafe { CallWindowProcW(prev_fn, hwnd, msg, wparam, lparam) }
    } else {
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }
}

#[cfg(target_os = "windows")]
pub fn apply_native_pill_chrome(hwnd: HWND, dark_mode: bool) -> Result<()> {
    unsafe {
        // 1. Extend DWM frame into the entire client area
        let margins = MARGINS {
            cxLeftWidth: -1,
            cxRightWidth: -1,
            cyTopHeight: -1,
            cyBottomHeight: -1,
        };
        let _ = DwmExtendFrameIntoClientArea(hwnd, &margins);

        // 2. Set System Backdrop to DWMSBT_TRANSIENTWINDOW (Acrylic backdrop)
        let backdrop = DWM_SYSTEMBACKDROP_TYPE(3);
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(38), // DWMWA_SYSTEMBACKDROP_TYPE
            &backdrop as *const _ as *const _,
            std::mem::size_of_val(&backdrop) as u32,
        );

        // 3. Set Window Corner Preference to DWMWCP_ROUND (Standard Windows 11 rounded corners ~8-12px)
        let corner = DWM_WINDOW_CORNER_PREFERENCE(2);
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(33), // DWMWA_WINDOW_CORNER_PREFERENCE
            &corner as *const _ as *const _,
            std::mem::size_of_val(&corner) as u32,
        );

        // 4. Set Border Color (DWMWA_BORDER_COLOR = 34, 0x00BBGGRR)
        let border_color: u32 = if dark_mode { 0x00383838 } else { 0x00D0D0D0 };
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(34),
            &border_color as *const _ as *const _,
            std::mem::size_of_val(&border_color) as u32,
        );

        // 5. Immersive Dark Mode (DWMWA_USE_IMMERSIVE_DARK_MODE = 20)
        let dark = windows::core::BOOL(if dark_mode { 1 } else { 0 });
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(20),
            &dark as *const _ as *const _,
            std::mem::size_of_val(&dark) as u32,
        );

        // 6. Subclass window to maintain active acrylic blur while unfocused
        let prev = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
        if prev != 0 && prev != (pill_subclass_wndproc as *const () as usize as isize) {
            PREV_WNDPROC.store(prev as usize, Ordering::Relaxed);
            SetWindowLongPtrW(
                hwnd,
                GWLP_WNDPROC,
                pill_subclass_wndproc as *const () as usize as isize,
            );
        }
    }

    Ok(())
}

#[derive(Clone, Copy, Debug)]
pub struct RectTarget {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MorphEasing {
    QuarticOut,
    DynamicSpring,
    CollapseInOut,
}

#[derive(Clone, Copy, Debug)]
struct MorphTask {
    target: RectTarget,
    duration_ms: u64,
    easing: MorphEasing,
    fade_out_on_hide: bool,
    hide_on_finish: bool,
    reset_rect_on_hide: Option<RectTarget>,
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug)]
struct PipDragSession {
    origin_x: i32,
    origin_y: i32,
    start_cursor_x: i32,
    start_cursor_y: i32,
    bounds_x: i32,
    bounds_y: i32,
    bounds_w: i32,
    bounds_h: i32,
    win_w: i32,
    win_h: i32,
}

#[cfg(target_os = "windows")]
pub fn get_cursor_pos_phys() -> Option<(i32, i32)> {
    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_ok() {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
}

#[cfg(target_os = "windows")]
pub fn get_virtual_screen_bounds() -> (i32, i32, i32, i32) {
    unsafe {
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN).max(640);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN).max(480);
        (vx, vy, vw, vh)
    }
}

#[cfg(target_os = "windows")]
pub fn clamp_origin_to_bounds(
    x: i32,
    y: i32,
    win_w: i32,
    win_h: i32,
    bounds: (i32, i32, i32, i32),
    pad: i32,
) -> (i32, i32) {
    let (bx, by, bw, bh) = bounds;
    let min_x = bx + pad;
    let min_y = by + pad;
    let max_x = (bx + bw - win_w - pad).max(min_x);
    let max_y = (by + bh - win_h - pad).max(min_y);
    (x.clamp(min_x, max_x), y.clamp(min_y, max_y))
}

#[cfg(target_os = "windows")]
pub fn compute_delta_logical(
    cursor_x: i32,
    cursor_y: i32,
    rect_left: i32,
    rect_top: i32,
    rect_right: i32,
    rect_bottom: i32,
    scale: f64,
) -> (f64, f64, f64) {
    let s = if scale > 0.1 { scale } else { 1.0 };
    let center_x = rect_left as f64 + (rect_right - rect_left) as f64 * 0.5;
    let center_y = rect_top as f64 + (rect_bottom - rect_top) as f64 * 0.5;
    let dx = (cursor_x as f64 - center_x) / s;
    let dy = (cursor_y as f64 - center_y) / s;
    (dx, dy, (dx * dx + dy * dy).sqrt())
}

#[cfg(target_os = "windows")]
pub fn cursor_delta_for_hwnd(hwnd_raw: isize, scale: f64) -> Option<(f64, f64, f64)> {
    let (cx, cy) = get_cursor_pos_phys()?;
    let hwnd = HWND(hwnd_raw as *mut _);
    let mut r = windows::Win32::Foundation::RECT::default();
    let ok = unsafe { GetWindowRect(hwnd, &mut r).is_ok() };
    if !ok {
        return None;
    }
    Some(compute_delta_logical(cx, cy, r.left, r.top, r.right, r.bottom, scale))
}

#[cfg(target_os = "windows")]
pub struct WindowMorpher {
    hwnd: isize,
    current_rect: Arc<Mutex<RectTarget>>,
    target_rect: Arc<Mutex<Option<MorphTask>>>,
    is_running: Arc<AtomicBool>,
    is_awake_target: Arc<AtomicBool>,
    resting_y: Arc<AtomicI32>,
    is_layered_fade: Arc<AtomicBool>,
    saved_ex_style: Arc<AtomicIsize>,
    pip_active: Arc<AtomicBool>,
    pip_saved_pos: Arc<Mutex<Option<(i32, i32)>>>,
    drag_session: Arc<Mutex<Option<PipDragSession>>>,
}

#[cfg(target_os = "windows")]
fn restore_unlayered_style(
    hwnd: HWND,
    is_layered_fade: &AtomicBool,
    saved_ex_style: &AtomicIsize,
) {
    if is_layered_fade.swap(false, Ordering::SeqCst) {
        let orig_ex = saved_ex_style.load(Ordering::Acquire);
        unsafe {
            let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
            if (orig_ex & (WS_EX_LAYERED.0 as isize)) == 0 {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, orig_ex);
            }
        }
    }
}

#[cfg(target_os = "windows")]
impl WindowMorpher {
    pub fn new(hwnd: HWND) -> Self {
        let mut initial = RectTarget {
            x: 0,
            y: 0,
            width: 466,
            height: 60,
        };
        unsafe {
            let mut r = windows::Win32::Foundation::RECT::default();
            if GetWindowRect(hwnd, &mut r).is_ok() {
                initial.x = r.left;
                initial.y = r.top;
                initial.width = r.right - r.left;
                initial.height = r.bottom - r.top;
            }
        }

        let rest_y = initial.y;
        Self {
            hwnd: hwnd.0 as isize,
            current_rect: Arc::new(Mutex::new(initial)),
            target_rect: Arc::new(Mutex::new(None)),
            is_running: Arc::new(AtomicBool::new(false)),
            is_awake_target: Arc::new(AtomicBool::new(false)),
            resting_y: Arc::new(AtomicI32::new(rest_y)),
            is_layered_fade: Arc::new(AtomicBool::new(false)),
            saved_ex_style: Arc::new(AtomicIsize::new(0)),
            pip_active: Arc::new(AtomicBool::new(false)),
            pip_saved_pos: Arc::new(Mutex::new(None)),
            drag_session: Arc::new(Mutex::new(None)),
        }
    }

    pub fn hwnd_raw(&self) -> isize {
        self.hwnd
    }

    pub fn set_resting_y(&self, rest_y: i32) {
        self.resting_y.store(rest_y, Ordering::Relaxed);
    }

    pub fn set_pip_active(&self, active: bool) {
        self.pip_active.store(active, Ordering::Release);
        if !active {
            if let Ok(mut guard) = self.drag_session.lock() {
                *guard = None;
            }
        }
    }

    pub fn is_pip_active(&self) -> bool {
        self.pip_active.load(Ordering::Acquire)
    }

    pub fn is_morphing(&self) -> bool {
        self.is_running.load(Ordering::Acquire)
    }

    pub fn sync_bop_rect(&self, x: i32, y: i32) {
        if let Ok(mut cur) = self.current_rect.lock() {
            cur.x = x;
            cur.y = y;
        }
    }

    pub fn get_saved_pip_pos(&self) -> Option<(i32, i32)> {
        self.pip_saved_pos.lock().ok().and_then(|g| *g)
    }

    pub fn live_rect(&self) -> RectTarget {
        let hwnd = HWND(self.hwnd as *mut _);
        unsafe {
            let mut r = windows::Win32::Foundation::RECT::default();
            if GetWindowRect(hwnd, &mut r).is_ok() {
                return RectTarget {
                    x: r.left,
                    y: r.top,
                    width: r.right - r.left,
                    height: r.bottom - r.top,
                };
            }
        }
        self.current_rect
            .lock()
            .map(|c| *c)
            .unwrap_or(RectTarget {
                x: 0,
                y: 0,
                width: 466,
                height: 60,
            })
    }

    pub fn morph_to_rect(&self, target: RectTarget, duration_ms: u64, easing: MorphEasing) {
        let hwnd = HWND(self.hwnd as *mut _);
        restore_unlayered_style(hwnd, &self.is_layered_fade, &self.saved_ex_style);
        if !self.is_running.load(Ordering::Acquire) {
            let live = self.live_rect();
            if let Ok(mut cur) = self.current_rect.lock() {
                *cur = live;
            }
        }
        self.animate_task(MorphTask {
            target,
            duration_ms,
            easing,
            fade_out_on_hide: false,
            hide_on_finish: false,
            reset_rect_on_hide: None,
        });
    }

    pub fn begin_pip_drag(&self) -> Option<(i32, i32, i32, i32)> {
        // Cancel any lingering morph animation before direct cursor tracking
        if let Ok(mut tgt) = self.target_rect.lock() {
            *tgt = None;
        }
        let rect = self.live_rect();
        if let Ok(mut cur) = self.current_rect.lock() {
            *cur = rect;
        }
        let (cx, cy) = get_cursor_pos_phys()?;
        let (bx, by, bw, bh) = get_virtual_screen_bounds();
        let session = PipDragSession {
            origin_x: rect.x,
            origin_y: rect.y,
            start_cursor_x: cx,
            start_cursor_y: cy,
            bounds_x: bx,
            bounds_y: by,
            bounds_w: bw,
            bounds_h: bh,
            win_w: rect.width.max(40),
            win_h: rect.height.max(40),
        };
        if let Ok(mut guard) = self.drag_session.lock() {
            *guard = Some(session);
        }
        Some((rect.x, rect.y, cx, cy))
    }

    pub fn step_pip_drag(&self) -> Option<(i32, i32, i32, i32)> {
        let session = self.drag_session.lock().ok().and_then(|g| *g)?;
        let (cx, cy) = get_cursor_pos_phys()?;
        let (nx, ny) = clamp_origin_to_bounds(
            session.origin_x + (cx - session.start_cursor_x),
            session.origin_y + (cy - session.start_cursor_y),
            session.win_w,
            session.win_h,
            (session.bounds_x, session.bounds_y, session.bounds_w, session.bounds_h),
            6,
        );

        let hwnd = HWND(self.hwnd as *mut _);
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                None,
                nx,
                ny,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        if let Ok(mut cur) = self.current_rect.lock() {
            cur.x = nx;
            cur.y = ny;
        }
        if let Ok(mut saved) = self.pip_saved_pos.lock() {
            *saved = Some((nx, ny));
        }
        Some((nx, ny, cx, cy))
    }

    pub fn end_pip_drag(&self) -> Option<(i32, i32)> {
        let session = self.drag_session.lock().ok().and_then(|mut g| g.take());
        let rect = self.live_rect();
        if let Ok(mut cur) = self.current_rect.lock() {
            *cur = rect;
        }
        if session.is_some() {
            if let Ok(mut saved) = self.pip_saved_pos.lock() {
                *saved = Some((rect.x, rect.y));
            }
        }
        Some((rect.x, rect.y))
    }

    pub fn cursor_delta_logical(&self, scale: f64) -> Option<(f64, f64, f64)> {
        cursor_delta_for_hwnd(self.hwnd, scale)
    }

    pub fn update_rect(&self, rect: RectTarget) {
        self.resting_y.store(rect.y, Ordering::Relaxed);
        if let Ok(mut cur) = self.current_rect.lock() {
            *cur = rect;
        }
    }

    pub fn set_awake_flag(&self, awake: bool) {
        self.is_awake_target.store(awake, Ordering::Release);
    }

    pub fn is_awake(&self) -> bool {
        self.is_awake_target.load(Ordering::Acquire)
    }

    pub fn snap_to_rect(&self, target: RectTarget) {
        if let Ok(mut tgt) = self.target_rect.lock() {
            *tgt = None;
        }
        let hwnd = HWND(self.hwnd as *mut _);
        restore_unlayered_style(hwnd, &self.is_layered_fade, &self.saved_ex_style);
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                None,
                target.x,
                target.y,
                target.width,
                target.height,
                SWP_NOACTIVATE | SWP_NOZORDER,
            );
        }
        if let Ok(mut cur) = self.current_rect.lock() {
            *cur = target;
        }
    }

    /// Snap hidden HWND cleanly into a slim centered capsule just before ShowWindow.
    /// If already visible (rapid re-wake mid-hide), keeps current mid-flight bounds and restores opacity.
    pub fn prepare_wake_orb(&self, rest_x: i32, rest_y: i32, rest_w: i32, _rest_h: i32, scale: f64) {
        self.is_awake_target.store(true, Ordering::Release);
        self.set_pip_active(false);
        self.resting_y.store(rest_y, Ordering::Relaxed);

        let hwnd = HWND(self.hwnd as *mut _);
        restore_unlayered_style(hwnd, &self.is_layered_fade, &self.saved_ex_style);

        let already_visible = unsafe { IsWindowVisible(hwnd).as_bool() };
        if already_visible {
            if let Ok(r) = unsafe {
                let mut wr = windows::Win32::Foundation::RECT::default();
                GetWindowRect(hwnd, &mut wr).map(|()| wr)
            } {
                if let Ok(mut cur) = self.current_rect.lock() {
                    *cur = RectTarget {
                        x: r.left,
                        y: r.top,
                        width: r.right - r.left,
                        height: r.bottom - r.top,
                    };
                }
            }
            return;
        }

        // Keep horizontal pill proportions so Windows 11 DWM rounded corners never look boxy
        let orb_w = (168.0 * scale).round() as i32;
        let orb_h = (48.0 * scale).round() as i32;
        let orb_x = rest_x + (rest_w - orb_w) / 2;
        let orb_y = rest_y - (6.0 * scale).round() as i32;
        let orb = RectTarget {
            x: orb_x,
            y: orb_y,
            width: orb_w,
            height: orb_h,
        };
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                None,
                orb.x,
                orb.y,
                orb.width,
                orb.height,
                SWP_NOACTIVATE | SWP_NOZORDER,
            );
        }
        if let Ok(mut cur) = self.current_rect.lock() {
            *cur = orb;
        }
    }

    /// Triggers the horizontal Dynamic Island bloom from slim capsule -> resting 466x60 capsule.
    pub fn start_wake_bloom(&self, rest_x: i32, rest_y: i32, rest_w: i32, rest_h: i32) {
        self.is_awake_target.store(true, Ordering::Release);
        self.resting_y.store(rest_y, Ordering::Relaxed);
        let hwnd = HWND(self.hwnd as *mut _);
        restore_unlayered_style(hwnd, &self.is_layered_fade, &self.saved_ex_style);
        self.animate_task(MorphTask {
            target: RectTarget {
                x: rest_x,
                y: rest_y,
                width: rest_w,
                height: rest_h,
            },
            duration_ms: 320,
            easing: MorphEasing::DynamicSpring,
            fade_out_on_hide: false,
            hide_on_finish: false,
            reset_rect_on_hide: None,
        });
    }

    /// Collapses the pill into a slim horizontal capsule while fading out natively just before SW_HIDE.
    pub fn collapse_and_hide(&self, rest_x: i32, rest_y: i32, rest_w: i32, rest_h: i32, scale: f64) {
        let was_pip = self.pip_active.swap(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.drag_session.lock() {
            *guard = None;
        }
        self.is_awake_target.store(false, Ordering::Release);
        self.resting_y.store(rest_y, Ordering::Relaxed);

        let hwnd = HWND(self.hwnd as *mut _);
        let cur = unsafe {
            let mut r = windows::Win32::Foundation::RECT::default();
            if GetWindowRect(hwnd, &mut r).is_ok() {
                RectTarget {
                    x: r.left,
                    y: r.top,
                    width: r.right - r.left,
                    height: r.bottom - r.top,
                }
            } else if let Ok(c) = self.current_rect.lock() {
                *c
            } else {
                RectTarget {
                    x: rest_x,
                    y: rest_y,
                    width: rest_w,
                    height: rest_h,
                }
            }
        };

        if let Ok(mut c) = self.current_rect.lock() {
            *c = cur;
        }

        // Collapse to a sleek 4:1 slim horizontal capsule (or shrink in place if sleeping directly from PiP)
        let (orb_w, orb_h, orb_y) = if was_pip {
            let w = (cur.width as f64 * 0.72).round().max(40.0) as i32;
            let h = (cur.height as f64 * 0.72).round().max(40.0) as i32;
            let y = cur.y + (cur.height - h) / 2;
            (w, h, y)
        } else {
            (
                (176.0 * scale).round() as i32,
                (44.0 * scale).round() as i32,
                rest_y - (6.0 * scale).round() as i32,
            )
        };
        let cur_center_x = cur.x + cur.width / 2;
        let orb_x = cur_center_x - orb_w / 2;

        self.animate_task(MorphTask {
            target: RectTarget {
                x: orb_x,
                y: orb_y,
                width: orb_w,
                height: orb_h,
            },
            duration_ms: 240,
            easing: MorphEasing::CollapseInOut,
            fade_out_on_hide: true,
            hide_on_finish: true,
            reset_rect_on_hide: Some(RectTarget {
                x: rest_x,
                y: rest_y,
                width: rest_w,
                height: rest_h,
            }),
        });
    }

    pub fn morph(&self, target_width: f64, target_height: f64, duration_ms: u64) {
        let hwnd = HWND(self.hwnd as *mut _);
        let cur = unsafe {
            let mut r = windows::Win32::Foundation::RECT::default();
            if GetWindowRect(hwnd, &mut r).is_ok() {
                RectTarget {
                    x: r.left,
                    y: r.top,
                    width: r.right - r.left,
                    height: r.bottom - r.top,
                }
            } else if let Ok(c) = self.current_rect.lock() {
                *c
            } else {
                RectTarget {
                    x: 0,
                    y: 0,
                    width: 466,
                    height: 60,
                }
            }
        };

        if let Ok(mut c) = self.current_rect.lock() {
            *c = cur;
        }

        let target_w = target_width.round() as i32;
        let target_h = target_height.round() as i32;
        let cur_center_x = cur.x + cur.width / 2;
        let target_x = cur_center_x - target_w / 2;
        let target_y = self.resting_y.load(Ordering::Relaxed);

        if cur.x == target_x && cur.y == target_y && cur.width == target_w && cur.height == target_h {
            return;
        }

        self.animate_to(
            RectTarget {
                x: target_x,
                y: target_y,
                width: target_w,
                height: target_h,
            },
            duration_ms,
        );
    }

    pub fn animate_to(&self, target: RectTarget, duration_ms: u64) {
        let hwnd = HWND(self.hwnd as *mut _);
        restore_unlayered_style(hwnd, &self.is_layered_fade, &self.saved_ex_style);
        self.animate_task(MorphTask {
            target,
            duration_ms,
            easing: MorphEasing::QuarticOut,
            fade_out_on_hide: false,
            hide_on_finish: false,
            reset_rect_on_hide: None,
        });
    }

    fn animate_task(&self, task_req: MorphTask) {
        let target = task_req.target;
        let duration_ms = task_req.duration_ms;
        if duration_ms == 0 {
            // Instant snap
            let hwnd = HWND(self.hwnd as *mut _);
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    target.x,
                    target.y,
                    target.width,
                    target.height,
                    SWP_NOACTIVATE | SWP_NOZORDER,
                );
                if task_req.hide_on_finish && !self.is_awake_target.load(Ordering::Acquire) {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                }
            }
            if let Ok(mut cur) = self.current_rect.lock() {
                *cur = target;
            }
            if let Ok(mut tgt) = self.target_rect.lock() {
                *tgt = None;
            }
            return;
        }

        // Store new target
        if let Ok(mut tgt) = self.target_rect.lock() {
            *tgt = Some(task_req);
        }

        // Spawn loop if not already running
        if !self.is_running.swap(true, Ordering::SeqCst) {
            let hwnd_raw = self.hwnd;
            let current_arc = Arc::clone(&self.current_rect);
            let target_arc = Arc::clone(&self.target_rect);
            let running_flag = Arc::clone(&self.is_running);
            let awake_flag = Arc::clone(&self.is_awake_target);
            let layered_flag = Arc::clone(&self.is_layered_fade);
            let saved_ex_arc = Arc::clone(&self.saved_ex_style);

            std::thread::spawn(move || {
                let hwnd = HWND(hwnd_raw as *mut _);

                while running_flag.load(Ordering::Relaxed) {
                    let task = {
                        let mut guard = target_arc.lock().unwrap();
                        guard.take()
                    };

                    let task = match task {
                        Some(t) => t,
                        None => {
                            running_flag.store(false, Ordering::SeqCst);
                            break;
                        }
                    };

                    if !task.fade_out_on_hide {
                        restore_unlayered_style(hwnd, &layered_flag, &saved_ex_arc);
                    }

                    let start_rect = { *current_arc.lock().unwrap() };
                    let target = task.target;
                    let start_time = std::time::Instant::now();
                    let duration = std::time::Duration::from_millis(task.duration_ms);
                    let start_center_x = start_rect.x as f64 + start_rect.width as f64 * 0.5;
                    let target_center_x = target.x as f64 + target.width as f64 * 0.5;

                    loop {
                        // Check if an updated target arrived mid-flight
                        {
                            let guard = target_arc.lock().unwrap();
                            if guard.is_some() {
                                break;
                            }
                        }

                        let elapsed = start_time.elapsed();
                        let progress = (elapsed.as_secs_f64() / duration.as_secs_f64()).min(1.0);

                        let (w_eased, other_eased) = if progress >= 1.0 {
                            (1.0, 1.0)
                        } else {
                            match task.easing {
                                MorphEasing::QuarticOut => {
                                    let inv = 1.0 - progress;
                                    let e = 1.0 - inv * inv * inv * inv;
                                    (e, e)
                                }
                                MorphEasing::DynamicSpring => {
                                    // Crisp Dynamic Island horizontal spring (~6% overshoot settle) + smooth vertical ease
                                    let raw = 1.0 - (-8.4 * progress).exp() * (9.4 * progress).cos();
                                    let end = 1.0 - (-8.4_f64).exp() * 9.4_f64.cos();
                                    let w_s = raw / end;
                                    let inv = 1.0 - progress;
                                    let v_e = 1.0 - inv * inv * inv * inv;
                                    (w_s, v_e)
                                }
                                MorphEasing::CollapseInOut => {
                                    let e = if progress < 0.5 {
                                        4.0 * progress * progress * progress
                                    } else {
                                        1.0 - (-2.0 * progress + 2.0).powi(3) / 2.0
                                    };
                                    (e, e)
                                }
                            }
                        };

                        let cur_w = (start_rect.width as f64
                            + (target.width - start_rect.width) as f64 * w_eased)
                            .round()
                            .max(12.0) as i32;
                        let cur_h = (start_rect.height as f64
                            + (target.height - start_rect.height) as f64 * other_eased)
                            .round()
                            .max(12.0) as i32;
                        let cur_cx = start_center_x + (target_center_x - start_center_x) * other_eased;
                        let cur_x = (cur_cx - cur_w as f64 * 0.5).round() as i32;
                        let cur_y = start_rect.y
                            + ((target.y - start_rect.y) as f64 * other_eased).round() as i32;

                        unsafe {
                            let _ = SetWindowPos(
                                hwnd,
                                None,
                                cur_x,
                                cur_y,
                                cur_w,
                                cur_h,
                                SWP_NOACTIVATE | SWP_NOZORDER,
                            );

                            // Smoothly fade entire native window (including DWM Acrylic & border) over final ~62% of hide
                            if task.fade_out_on_hide && progress >= 0.38 {
                                let fade_u = ((progress - 0.38) / 0.62).clamp(0.0, 1.0);
                                let fade_eased = fade_u * fade_u * (3.0 - 2.0 * fade_u);
                                let alpha = ((1.0 - fade_eased) * 255.0).round().clamp(0.0, 255.0) as u8;
                                if !layered_flag.swap(true, Ordering::SeqCst) {
                                    let orig_ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                                    saved_ex_arc.store(orig_ex, Ordering::Release);
                                    if (orig_ex & (WS_EX_LAYERED.0 as isize)) == 0 {
                                        SetWindowLongPtrW(
                                            hwnd,
                                            GWL_EXSTYLE,
                                            orig_ex | (WS_EX_LAYERED.0 as isize),
                                        );
                                    }
                                }
                                let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), alpha, LWA_ALPHA);
                            }

                            let _ = DwmFlush();
                        }

                        if let Ok(mut cur) = current_arc.lock() {
                            cur.x = cur_x;
                            cur.y = cur_y;
                            cur.width = cur_w;
                            cur.height = cur_h;
                        }

                        if progress >= 1.0 {
                            let final_rect = if task.hide_on_finish {
                                // Only hide if user didn't wake AIDEN back up mid-collapse
                                let pending_new = target_arc.lock().map(|g| g.is_some()).unwrap_or(false);
                                if !pending_new && !awake_flag.load(Ordering::Acquire) {
                                    unsafe {
                                        let _ = ShowWindow(hwnd, SW_HIDE);
                                    }
                                    restore_unlayered_style(hwnd, &layered_flag, &saved_ex_arc);
                                    if let Some(rest) = task.reset_rect_on_hide {
                                        unsafe {
                                            let _ = SetWindowPos(
                                                hwnd,
                                                None,
                                                rest.x,
                                                rest.y,
                                                rest.width,
                                                rest.height,
                                                SWP_NOACTIVATE | SWP_NOZORDER,
                                            );
                                        }
                                        rest
                                    } else {
                                        target
                                    }
                                } else {
                                    restore_unlayered_style(hwnd, &layered_flag, &saved_ex_arc);
                                    target
                                }
                            } else {
                                unsafe {
                                    let _ = SetWindowPos(
                                        hwnd,
                                        None,
                                        target.x,
                                        target.y,
                                        target.width,
                                        target.height,
                                        SWP_NOACTIVATE | SWP_NOZORDER,
                                    );
                                }
                                target
                            };

                            if let Ok(mut cur) = current_arc.lock() {
                                *cur = final_rect;
                            }
                            break;
                        }
                    }
                }
            });
        }
    }
}

#[cfg(target_os = "windows")]
pub fn make_noactivate_tool_window(hwnd: HWND) {
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let desired = ex
            | (WS_EX_NOACTIVATE.0 as isize)
            | (WS_EX_TOOLWINDOW.0 as isize)
            | (WS_EX_TRANSPARENT.0 as isize);
        if desired != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, desired);
        }
    }
}

/// Interactive non-activating tool window (for the detached search drawer):
/// receives mouse hover, wheel scrolling, and row clicks WITHOUT stealing keyboard focus.
#[cfg(target_os = "windows")]
pub fn make_noactivate_interactive_tool_window(hwnd: HWND) {
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let desired = (ex | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize))
            & !(WS_EX_TRANSPARENT.0 as isize);
        if desired != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, desired);
        }
    }
}

#[cfg(target_os = "windows")]
pub fn move_window_topmost_noactivate(hwnd: HWND, x: i32, y: i32, w: i32, h: i32) {
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE);
    }
}

#[cfg(target_os = "windows")]
pub fn dwm_flush_vsync() {
    unsafe {
        if DwmFlush().is_err() {
            std::thread::sleep(std::time::Duration::from_millis(16));
        }
    }
}

/// Atomically moves `chat_pill` together with `pip_headphones` and `pip_bubble` in one
/// Win32 compositor transaction (`BeginDeferWindowPos` / `EndDeferWindowPos`), keeping
/// static headphones locked to the cube with zero frame slip.
#[cfg(target_os = "windows")]
pub fn atomic_move_pip_group(
    cube_hwnd: HWND,
    cube_x: i32,
    cube_y: i32,
    hp: Option<(HWND, i32, i32, i32, i32)>,
    bubble: Option<(HWND, i32, i32, i32, i32)>,
) {
    unsafe {
        let count = 1 + i32::from(hp.is_some()) + i32::from(bubble.is_some());
        if let Ok(mut hdwp) = BeginDeferWindowPos(count) {
            if let Ok(next) = DeferWindowPos(
                hdwp,
                cube_hwnd,
                None,
                cube_x,
                cube_y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            ) {
                hdwp = next;
            }
            if let Some((h, x, y, w, h_px)) = hp {
                if let Ok(next) = DeferWindowPos(
                    hdwp,
                    h,
                    Some(HWND_TOPMOST),
                    x,
                    y,
                    w,
                    h_px,
                    SWP_NOACTIVATE,
                ) {
                    hdwp = next;
                }
            }
            if let Some((h, x, y, w, h_px)) = bubble {
                if let Ok(next) = DeferWindowPos(
                    hdwp,
                    h,
                    Some(HWND_TOPMOST),
                    x,
                    y,
                    w,
                    h_px,
                    SWP_NOACTIVATE,
                ) {
                    hdwp = next;
                }
            }
            let _ = EndDeferWindowPos(hdwp);
        } else {
            let _ = SetWindowPos(
                cube_hwnd,
                None,
                cube_x,
                cube_y,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            if let Some((h, x, y, w, h_px)) = hp {
                let _ = SetWindowPos(h, Some(HWND_TOPMOST), x, y, w, h_px, SWP_NOACTIVATE);
            }
            if let Some((h, x, y, w, h_px)) = bubble {
                let _ = SetWindowPos(h, Some(HWND_TOPMOST), x, y, w, h_px, SWP_NOACTIVATE);
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub fn show_window_noactivate(hwnd: HWND) {
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
}

#[cfg(target_os = "windows")]
pub fn hide_window_clean(hwnd: HWND) {
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

#[cfg(target_os = "windows")]
pub fn get_foreground_hwnd_raw() -> Option<isize> {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            None
        } else {
            Some(fg.0 as isize)
        }
    }
}

/// Reliably transfers Windows foreground keyboard focus to `target_hwnd`, bypassing
/// Windows' foreground lock when waking AIDEN from Terminal, Chrome, or VS Code.
#[cfg(target_os = "windows")]
fn force_foreground_window_inner(target_hwnd: HWND, reassert_topmost: bool) {
    unsafe {
        if !IsWindow(Some(target_hwnd)).as_bool() {
            return;
        }
        let fg = GetForegroundWindow();
        if fg == target_hwnd {
            let _ = SetActiveWindow(target_hwnd);
            let _ = SetFocus(Some(target_hwnd));
            return;
        }
        let fg_tid = if !fg.0.is_null() {
            GetWindowThreadProcessId(fg, None)
        } else {
            0
        };
        let my_tid = GetCurrentThreadId();
        let target_tid = GetWindowThreadProcessId(target_hwnd, None);

        let _ = AllowSetForegroundWindow(ASFW_ANY);

        let attached_fg =
            fg_tid != 0 && fg_tid != my_tid && AttachThreadInput(my_tid, fg_tid, true).as_bool();
        let attached_target = target_tid != 0
            && target_tid != my_tid
            && target_tid != fg_tid
            && AttachThreadInput(my_tid, target_tid, true).as_bool();

        let _ = BringWindowToTop(target_hwnd);
        let ok = SetForegroundWindow(target_hwnd).as_bool();
        let _ = SetActiveWindow(target_hwnd);
        let _ = SetFocus(Some(target_hwnd));

        if !ok && reassert_topmost {
            // Re-assert topmost activation for AIDEN's pill if foreground lock resisted once
            let _ = SetWindowPos(
                target_hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE,
            );
            let _ = SetForegroundWindow(target_hwnd);
            let _ = SetActiveWindow(target_hwnd);
            let _ = SetFocus(Some(target_hwnd));
        }

        if attached_target {
            let _ = AttachThreadInput(my_tid, target_tid, false);
        }
        if attached_fg {
            let _ = AttachThreadInput(my_tid, fg_tid, false);
        }
    }
}

#[cfg(target_os = "windows")]
pub fn force_foreground_window(target_hwnd: HWND) {
    force_foreground_window_inner(target_hwnd, true);
}

/// Hands keyboard focus cleanly back to the window the user was working in before waking AIDEN.
#[cfg(target_os = "windows")]
pub fn restore_foreground_window(hwnd_raw: isize) {
    if hwnd_raw == 0 {
        return;
    }
    let hwnd = HWND(hwnd_raw as *mut _);
    unsafe {
        if IsWindow(Some(hwnd)).as_bool()
            && IsWindowVisible(hwnd).as_bool()
            && !IsIconic(hwnd).as_bool()
        {
            force_foreground_window_inner(hwnd, false);
        }
    }
}

/// Computes physical `(x, y, width, height, flip_right)` for the 76x64 transparent
/// comment bubble positioned beside the cube's top-left corner, auto-flipping to
/// top-right when near the virtual screen's left boundary.
pub fn compute_pip_bubble_rect(
    cube_x: i32,
    cube_y: i32,
    cube_w: i32,
    scale: f64,
    bounds: (i32, i32, i32, i32),
) -> (i32, i32, i32, i32, bool) {
    let s = if scale > 0.1 { scale } else { 1.0 };
    let bw_phys = (76.0 * s).round() as i32;
    let bh_phys = (64.0 * s).round() as i32;
    let (bx, by, bw, bh) = bounds;
    let pad = (4.0 * s).round() as i32;

    let left_x = cube_x - (51.0 * s).round() as i32;
    let flip_right = left_x < bx + pad;
    let raw_x = if flip_right {
        cube_x + cube_w - (25.0 * s).round() as i32
    } else {
        left_x
    };
    let raw_y = cube_y - (36.0 * s).round() as i32;

    let min_x = bx + pad;
    let max_x = (bx + bw - bw_phys - pad).max(min_x);
    let min_y = by + pad;
    let max_y = (by + bh - bh_phys - pad).max(min_y);

    (raw_x.clamp(min_x, max_x), raw_y.clamp(min_y, max_y), bw_phys, bh_phys, flip_right)
}

/// Computes physical `(x, y, width, height)` for the 128x122 transparent click-through
/// Apple AirPods Max overlay aligned pixel-for-pixel around the 68x68 PiP cube
/// (30px left/right margin, 40px top margin for drop/lift headroom, 14px bottom margin).
pub fn compute_pip_headphones_rect(cube_x: i32, cube_y: i32, scale: f64) -> (i32, i32, i32, i32) {
    let s = if scale > 0.1 { scale } else { 1.0 };
    let hx = cube_x - (30.0 * s).round() as i32;
    let hy = cube_y - (40.0 * s).round() as i32;
    let hw = (128.0 * s).round() as i32;
    let hh = (122.0 * s).round() as i32;
    (hx, hy, hw, hh)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpotifyMediaSnapshot {
    pub running: bool,
    pub playing: bool,
    pub paused: bool,
    pub has_track: bool,
    pub track_key: String,
}

impl Default for SpotifyMediaSnapshot {
    fn default() -> Self {
        Self {
            running: false,
            playing: false,
            paused: false,
            has_track: false,
            track_key: String::new(),
        }
    }
}

/// Returns true strictly for Spotify desktop/Store media sessions (ignoring browsers, VLC, etc.).
pub fn is_spotify_app_id(app_id: &str) -> bool {
    let lower = app_id.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    lower.contains("spotify")
}

/// Returns true when metadata corresponds to a real music track (ignoring blank sessions or ads).
pub fn is_valid_music_track(title: &str, artist: &str) -> bool {
    let t = title.trim();
    let a = artist.trim();
    if t.is_empty() {
        return false;
    }
    let tl = t.to_ascii_lowercase();
    if tl == "advertisement" || tl == "spotify" && a.is_empty() {
        return false;
    }
    true
}

#[cfg(target_os = "windows")]
fn ensure_winrt_initialized() {
    thread_local! {
        static INIT: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    INIT.with(|done| {
        if !done.get() {
            unsafe {
                let _ = RoInitialize(RO_INIT_MULTITHREADED);
            }
            done.set(true);
        }
    });
}

/// Polls Windows GSMTC (`GlobalSystemMediaTransportControlsSessionManager`) filtered
/// strictly to Spotify Desktop / Microsoft Store sessions.
#[cfg(target_os = "windows")]
pub fn get_spotify_media_snapshot() -> SpotifyMediaSnapshot {
    ensure_winrt_initialized();

    let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() else {
        return SpotifyMediaSnapshot::default();
    };
    let Ok(manager) = op.join() else {
        return SpotifyMediaSnapshot::default();
    };
    let Ok(sessions) = manager.GetSessions() else {
        return SpotifyMediaSnapshot::default();
    };
    let Ok(count) = sessions.Size() else {
        return SpotifyMediaSnapshot::default();
    };

    let mut chosen: Option<SpotifyMediaSnapshot> = None;

    for idx in 0..count {
        let Ok(session) = sessions.GetAt(idx) else {
            continue;
        };
        let app_id = session
            .SourceAppUserModelId()
            .map(|h| h.to_string_lossy())
            .unwrap_or_default();
        if !is_spotify_app_id(&app_id) {
            continue;
        }

        let status = session
            .GetPlaybackInfo()
            .and_then(|info| info.PlaybackStatus())
            .unwrap_or(GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed);

        let is_playing = status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
        let is_paused = status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused;

        let (title, artist) = session
            .TryGetMediaPropertiesAsync()
            .ok()
            .and_then(|props_op| props_op.join().ok())
            .map(|props| {
                let t = props.Title().map(|h| h.to_string_lossy()).unwrap_or_default();
                let a = props.Artist().map(|h| h.to_string_lossy()).unwrap_or_default();
                (t, a)
            })
            .unwrap_or_default();

        let has_track = is_valid_music_track(&title, &artist);
        let track_key = if has_track {
            let t = title.trim();
            let a = artist.trim();
            if a.is_empty() {
                t.to_string()
            } else {
                format!("{} — {}", t, a)
            }
        } else {
            String::new()
        };

        let snap = SpotifyMediaSnapshot {
            running: true,
            playing: is_playing && has_track,
            paused: is_paused && has_track,
            has_track,
            track_key,
        };

        if snap.playing {
            return snap;
        }
        if chosen.is_none() {
            chosen = Some(snap);
        }
    }

    chosen.unwrap_or_default()
}

/// Classifies Spotify state transitions into cube reaction events:
/// `"play"`, `"resume"`, `"pause"`, `"track_change"`, or `"stop"`.
pub fn classify_spotify_event(
    prev: Option<&SpotifyMediaSnapshot>,
    curr: &SpotifyMediaSnapshot,
) -> Option<&'static str> {
    let Some(p) = prev else {
        if curr.running && curr.playing && curr.has_track {
            return Some("play");
        }
        return None;
    };

    if !curr.running {
        if p.playing || p.paused {
            return Some("stop");
        }
        return None;
    }

    if !p.playing && curr.playing && curr.has_track {
        return Some(if p.paused { "resume" } else { "play" });
    }

    if p.playing && curr.paused {
        return Some("pause");
    }

    if p.playing && !curr.playing && !curr.paused {
        return Some("stop");
    }

    if p.playing
        && curr.playing
        && curr.has_track
        && !p.track_key.is_empty()
        && curr.track_key != p.track_key
    {
        return Some("track_change");
    }

    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PowerStatusSnapshot {
    pub has_battery: bool,
    pub plugged_in: bool,
    pub percent: u8,
}

#[cfg(target_os = "windows")]
pub fn get_system_power_snapshot() -> Option<PowerStatusSnapshot> {
    unsafe {
        let mut sps = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut sps).is_err() {
            return None;
        }
        let no_battery = (sps.BatteryFlag & 128) != 0 || sps.BatteryLifePercent == 255;
        Some(PowerStatusSnapshot {
            has_battery: !no_battery,
            plugged_in: sps.ACLineStatus == 1,
            percent: if no_battery {
                100
            } else {
                sps.BatteryLifePercent.min(100)
            },
        })
    }
}

/// Maps power transitions between two snapshots into a cube reaction event:
/// `"plug_in"`, `"unplugged"`, `"low"`, or `"full"`.
pub fn classify_battery_event(
    prev: Option<PowerStatusSnapshot>,
    curr: PowerStatusSnapshot,
) -> Option<&'static str> {
    if !curr.has_battery {
        return None;
    }
    let p = prev?;
    if !p.has_battery {
        return None;
    }
    if !p.plugged_in && curr.plugged_in {
        return Some("plug_in");
    }
    if p.plugged_in && !curr.plugged_in {
        if curr.percent <= 20 {
            return Some("low");
        }
        return Some("unplugged");
    }
    if !curr.plugged_in && curr.percent <= 20 && p.percent > 20 {
        return Some("low");
    }
    if curr.plugged_in && curr.percent >= 100 && p.percent < 100 {
        return Some("full");
    }
    None
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{
        clamp_origin_to_bounds, classify_battery_event, classify_spotify_event,
        compute_delta_logical, compute_pip_bubble_rect, compute_pip_headphones_rect,
        is_spotify_app_id, is_valid_music_track, PowerStatusSnapshot, SpotifyMediaSnapshot,
    };

    #[test]
    fn clamp_respects_multi_monitor_negative_origins() {
        let bounds = (-1920, 0, 3840, 1080);
        assert_eq!(clamp_origin_to_bounds(-2100, -40, 102, 102, bounds, 8), (-1912, 8));
        assert_eq!(clamp_origin_to_bounds(2200, 1200, 102, 102, bounds, 8), (1810, 970));
        assert_eq!(clamp_origin_to_bounds(400, 300, 102, 102, bounds, 8), (400, 300));
    }

    #[test]
    fn delta_logical_accounts_for_hidpi_scale() {
        // 68 logical px window at 1.5x DPI is 102x102 physical px centered at (151, 251)
        let (dx, dy, dist) = compute_delta_logical(301, 251, 100, 200, 202, 302, 1.5);
        assert!((dx - 100.0).abs() < 1e-6);
        assert!(dy.abs() < 1e-6);
        assert!((dist - 100.0).abs() < 1e-6);
    }

    #[test]
    fn pip_bubble_rect_places_top_left_and_flips_on_left_edge() {
        let bounds = (-1920, 0, 3840, 1080);
        let (x, y, w, h, flip) = compute_pip_bubble_rect(800, 400, 68, 1.0, bounds);
        assert_eq!((x, y, w, h, flip), (749, 364, 76, 64, false));

        // Near negative multi-monitor left boundary: flips cleanly to right side of cube
        let (fx, fy, fw, fh, flipped) = compute_pip_bubble_rect(-1905, 400, 68, 1.0, bounds);
        assert_eq!((fx, fy, fw, fh, flipped), (-1862, 364, 76, 64, true));
    }

    #[test]
    fn battery_classifier_detects_all_transitions_and_ignores_no_battery() {
        let desktop = PowerStatusSnapshot { has_battery: false, plugged_in: true, percent: 100 };
        assert_eq!(classify_battery_event(None, desktop), None);
        assert_eq!(classify_battery_event(Some(desktop), desktop), None);

        let dc_ok = PowerStatusSnapshot { has_battery: true, plugged_in: false, percent: 65 };
        let ac_ok = PowerStatusSnapshot { has_battery: true, plugged_in: true, percent: 65 };
        let ac_full = PowerStatusSnapshot { has_battery: true, plugged_in: true, percent: 100 };
        let dc_21 = PowerStatusSnapshot { has_battery: true, plugged_in: false, percent: 21 };
        let dc_low = PowerStatusSnapshot { has_battery: true, plugged_in: false, percent: 20 };

        assert_eq!(classify_battery_event(Some(dc_ok), ac_ok), Some("plug_in"));
        assert_eq!(classify_battery_event(Some(ac_ok), dc_ok), Some("unplugged"));
        assert_eq!(classify_battery_event(Some(dc_21), dc_low), Some("low"));
        assert_eq!(classify_battery_event(Some(ac_ok), dc_low), Some("low"));
        assert_eq!(classify_battery_event(Some(ac_ok), ac_full), Some("full"));
        assert_eq!(classify_battery_event(Some(dc_ok), dc_ok), None);
    }

    #[test]
    fn pip_headphones_rect_centers_around_cube_at_hidpi() {
        assert_eq!(compute_pip_headphones_rect(800, 400, 1.0), (770, 360, 128, 122));
        assert_eq!(compute_pip_headphones_rect(800, 400, 1.5), (755, 340, 192, 183));
    }

    #[test]
    fn spotify_filter_and_classifier_handle_full_lifecycle() {
        assert!(is_spotify_app_id("Spotify.exe"));
        assert!(is_spotify_app_id("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"));
        assert!(!is_spotify_app_id("chrome.exe"));
        assert!(!is_spotify_app_id("msedge.exe"));
        assert!(!is_spotify_app_id("vlc.exe"));
        assert!(!is_spotify_app_id(""));

        assert!(is_valid_music_track("Midnight City", "M83"));
        assert!(!is_valid_music_track("", "M83"));
        assert!(!is_valid_music_track("Advertisement", ""));
        assert!(!is_valid_music_track("Spotify", ""));

        let closed = SpotifyMediaSnapshot::default();
        let idle = SpotifyMediaSnapshot { running: true, ..Default::default() };
        let playing_a = SpotifyMediaSnapshot {
            running: true,
            playing: true,
            paused: false,
            has_track: true,
            track_key: "Midnight City — M83".to_string(),
        };
        let playing_b = SpotifyMediaSnapshot {
            running: true,
            playing: true,
            paused: false,
            has_track: true,
            track_key: "Instant Crush — Daft Punk".to_string(),
        };
        let paused_b = SpotifyMediaSnapshot {
            running: true,
            playing: false,
            paused: true,
            has_track: true,
            track_key: "Instant Crush — Daft Punk".to_string(),
        };

        assert_eq!(classify_spotify_event(None, &closed), None);
        assert_eq!(classify_spotify_event(None, &playing_a), Some("play"));
        assert_eq!(classify_spotify_event(Some(&idle), &playing_a), Some("play"));
        assert_eq!(classify_spotify_event(Some(&playing_a), &playing_b), Some("track_change"));
        assert_eq!(classify_spotify_event(Some(&playing_b), &paused_b), Some("pause"));
        assert_eq!(classify_spotify_event(Some(&paused_b), &playing_b), Some("resume"));
        assert_eq!(classify_spotify_event(Some(&paused_b), &closed), Some("stop"));
        assert_eq!(classify_spotify_event(Some(&playing_b), &closed), Some("stop"));
        assert_eq!(classify_spotify_event(Some(&playing_b), &playing_b), None);
    }
}
