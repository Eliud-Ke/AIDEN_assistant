#[cfg(target_os = "windows")]
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
use windows::{
    core::Result,
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        Graphics::Dwm::{
            DwmExtendFrameIntoClientArea, DwmFlush, DwmSetWindowAttribute,
            DWMWINDOWATTRIBUTE, DWM_SYSTEMBACKDROP_TYPE, DWM_WINDOW_CORNER_PREFERENCE,
        },
        UI::Controls::MARGINS,
        UI::WindowsAndMessaging::{
            CallWindowProcW, DefWindowProcW, GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW,
            SetWindowPos, GWLP_WNDPROC, SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOZORDER,
            WM_NCACTIVATE, WNDPROC,
        },
    },
};

#[cfg(target_os = "windows")]
static PREV_WNDPROC: AtomicUsize = AtomicUsize::new(0);

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

#[cfg(target_os = "windows")]
pub struct WindowMorpher {
    hwnd: isize,
    current_rect: Arc<Mutex<RectTarget>>,
    target_rect: Arc<Mutex<Option<(RectTarget, u64)>>>,
    is_running: Arc<AtomicBool>,
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

        Self {
            hwnd: hwnd.0 as isize,
            current_rect: Arc::new(Mutex::new(initial)),
            target_rect: Arc::new(Mutex::new(None)),
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn update_rect(&self, rect: RectTarget) {
        if let Ok(mut cur) = self.current_rect.lock() {
            *cur = rect;
        }
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
        let target_y = cur.y;

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
                    SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOCOPYBITS,
                );
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
            *tgt = Some((target, duration_ms));
        }

        // Spawn loop if not already running
        if !self.is_running.swap(true, Ordering::SeqCst) {
            let hwnd_raw = self.hwnd;
            let current_arc = Arc::clone(&self.current_rect);
            let target_arc = Arc::clone(&self.target_rect);
            let running_flag = Arc::clone(&self.is_running);

            std::thread::spawn(move || {
                let hwnd = HWND(hwnd_raw as *mut _);

                while running_flag.load(Ordering::Relaxed) {
                    let task = {
                        let mut guard = target_arc.lock().unwrap();
                        guard.take()
                    };

                    let (target, dur_ms) = match task {
                        Some(t) => t,
                        None => {
                            running_flag.store(false, Ordering::SeqCst);
                            break;
                        }
                    };

                    let start_rect = { *current_arc.lock().unwrap() };
                    let start_time = std::time::Instant::now();
                    let duration = std::time::Duration::from_millis(dur_ms);

                    loop {
                        // Check if an updated target arrived mid-flight
                        {
                            let guard = target_arc.lock().unwrap();
                            if guard.is_some() {
                                // Jump to the new target immediately
                                break;
                            }
                        }

                        let elapsed = start_time.elapsed();
                        let progress = (elapsed.as_secs_f64() / duration.as_secs_f64()).min(1.0);

                        // Apple Siri-style spring curve: cubic-bezier(0.18, 1.25, 0.35, 1.0)
                        let eased = if progress >= 1.0 {
                            1.0
                        } else {
                            // Approximated cubic-bezier ease-out with slight overshoot
                            let p = progress;
                            let inv = 1.0 - p;
                            3.0 * inv * inv * p * 1.25 + 3.0 * inv * p * p * 1.0 + p * p * p
                        };

                        let cur_x = start_rect.x + ((target.x - start_rect.x) as f64 * eased) as i32;
                        let cur_y = start_rect.y + ((target.y - start_rect.y) as f64 * eased) as i32;
                        let cur_w = start_rect.width + ((target.width - start_rect.width) as f64 * eased) as i32;
                        let cur_h = start_rect.height + ((target.height - start_rect.height) as f64 * eased) as i32;

                        unsafe {
                            let _ = SetWindowPos(
                                hwnd,
                                None,
                                cur_x,
                                cur_y,
                                cur_w,
                                cur_h,
                                SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOCOPYBITS,
                            );
                            // Pace frame timing with Desktop Window Manager compositor vsync
                            let _ = DwmFlush();
                        }

                        if let Ok(mut cur) = current_arc.lock() {
                            cur.x = cur_x;
                            cur.y = cur_y;
                            cur.width = cur_w;
                            cur.height = cur_h;
                        }

                        if progress >= 1.0 {
                            // Snap exactly to final target
                            unsafe {
                                let _ = SetWindowPos(
                                    hwnd,
                                    None,
                                    target.x,
                                    target.y,
                                    target.width,
                                    target.height,
                                    SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOCOPYBITS,
                                );
                            }
                            if let Ok(mut cur) = current_arc.lock() {
                                *cur = target;
                            }
                            break;
                        }
                    }
                }
            });
        }
    }
}
