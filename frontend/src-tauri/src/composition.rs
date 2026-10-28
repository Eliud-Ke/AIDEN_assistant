#[cfg(target_os = "windows")]
use windows::{
    core::{Interface, Result, BOOL},
    System::{DispatcherQueue, DispatcherQueueController},
    UI::Composition::{
        CompositionBackdropBrush, CompositionGeometricClip,
        CompositionRoundedRectangleGeometry, Compositor, Desktop::DesktopWindowTarget,
        SpriteVisual,
    },
    Win32::Foundation::HWND,
    Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWINDOWATTRIBUTE},
    Win32::System::WinRT::{
        Composition::ICompositorDesktopInterop,
        CreateDispatcherQueueController, DispatcherQueueOptions, DQTAT_COM_NONE, DQTAT_COM_STA,
        DQTYPE_THREAD_CURRENT,
    },
};
#[cfg(target_os = "windows")]
use windows_numerics::{Vector2, Vector3};

#[cfg(target_os = "windows")]
pub struct CompositionHost {
    _dispatcher: Option<DispatcherQueueController>,
    _compositor: Compositor,
    _target: DesktopWindowTarget,
    _sprite: SpriteVisual,
    geometry: CompositionRoundedRectangleGeometry,
}

#[cfg(target_os = "windows")]
impl CompositionHost {
    pub fn attach(
        hwnd: HWND,
        offset_x: f32,
        offset_y: f32,
        initial_width: f32,
        initial_height: f32,
        corner_radius: f32,
    ) -> Result<Self> {
        // 1. Authorize DWM host backdrop sampling for this HWND.
        // We DO NOT call DwmExtendFrameIntoClientArea so DWM does not draw
        // the non-client title bar frame, window outline, or caption buttons (_ [] X).
        unsafe {
            let use_backdrop = BOOL(1);
            let res_attr = DwmSetWindowAttribute(
                hwnd,
                DWMWINDOWATTRIBUTE(17), // DWMWA_USE_HOSTBACKDROPBRUSH
                &use_backdrop as *const _ as *const _,
                std::mem::size_of_val(&use_backdrop) as u32,
            );
            println!("[DWM] DwmSetWindowAttribute(DWMWA_USE_HOSTBACKDROPBRUSH): {:?}", res_attr);
        }

        // 2. Ensure DispatcherQueue is running on UI thread
        let dispatcher = match DispatcherQueue::GetForCurrentThread() {
            Ok(q) => {
                println!("[DWM] Existing DispatcherQueue found for thread: {:?}", q);
                None
            }
            Err(_) => {
                let options_none = DispatcherQueueOptions {
                    dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
                    threadType: DQTYPE_THREAD_CURRENT,
                    apartmentType: DQTAT_COM_NONE,
                };
                let created = unsafe {
                    CreateDispatcherQueueController(options_none).or_else(|e| {
                        println!("[DWM] DQTAT_COM_NONE failed ({:?}), trying DQTAT_COM_STA...", e);
                        let options_sta = DispatcherQueueOptions {
                            dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
                            threadType: DQTYPE_THREAD_CURRENT,
                            apartmentType: DQTAT_COM_STA,
                        };
                        CreateDispatcherQueueController(options_sta)
                    })
                };
                match created {
                    Ok(ctrl) => {
                        println!("[DWM] Created new DispatcherQueueController successfully");
                        Some(ctrl)
                    }
                    Err(e) => {
                        eprintln!("[DWM] Failed creating DispatcherQueueController: {:?}", e);
                        None
                    }
                }
            }
        };

        println!("[DWM] Initializing Compositor...");
        let compositor = Compositor::new()?;
        let interop: ICompositorDesktopInterop = compositor.cast()?;

        println!("[DWM] Calling CreateDesktopWindowTarget for HWND {:?}...", hwnd);
        // false = places composition layer behind window client content
        let target = unsafe { interop.CreateDesktopWindowTarget(hwnd, false)? };
        println!("[DWM] CreateDesktopWindowTarget succeeded!");

        // Samples desktop background directly behind window
        let backdrop_brush: CompositionBackdropBrush = compositor.CreateHostBackdropBrush()?;

        // Create rounded rectangle geometry mask
        let geometry = compositor.CreateRoundedRectangleGeometry()?;
        geometry.SetOffset(Vector2 {
            X: offset_x,
            Y: offset_y,
        })?;
        geometry.SetSize(Vector2 {
            X: initial_width,
            Y: initial_height,
        })?;
        geometry.SetCornerRadius(Vector2 {
            X: corner_radius,
            Y: corner_radius,
        })?;

        // Create geometric clip
        let clip: CompositionGeometricClip =
            compositor.CreateGeometricClipWithGeometry(&geometry)?;

        // Create full visual covering canvas
        let sprite = compositor.CreateSpriteVisual()?;
        sprite.SetBrush(&backdrop_brush)?;
        sprite.SetOffset(Vector3 {
            X: 0.0,
            Y: 0.0,
            Z: 0.0,
        })?;
        sprite.SetSize(Vector2 {
            X: 1920.0,
            Y: 1080.0,
        })?;
        sprite.SetClip(&clip)?;
        // Start hidden until window is woken up
        let _ = sprite.SetIsVisible(false);

        target.SetRoot(&sprite)?;
        println!("[DWM] Root visual set on DesktopWindowTarget with clipped geometry!");

        Ok(Self {
            _dispatcher: dispatcher,
            _compositor: compositor,
            _target: target,
            _sprite: sprite,
            geometry,
        })
    }

    pub fn set_visible(&self, visible: bool) -> Result<()> {
        self._sprite.SetIsVisible(visible)?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn set_opacity(&self, opacity: f32) -> Result<()> {
        self._sprite.SetOpacity(opacity)?;
        Ok(())
    }

    pub fn update_shape(&self, offset_x: f32, offset_y: f32, width: f32, height: f32, corner_radius: f32) -> Result<()> {
        self.geometry.SetOffset(Vector2 {
            X: offset_x,
            Y: offset_y,
        })?;
        self.geometry.SetSize(Vector2 {
            X: width,
            Y: height,
        })?;
        self.geometry.SetCornerRadius(Vector2 {
            X: corner_radius,
            Y: corner_radius,
        })?;
        Ok(())
    }
}
