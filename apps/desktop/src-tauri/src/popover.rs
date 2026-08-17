use tauri::{LogicalPosition, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewWindow};

/// Gap between the panel and the tray icon, in physical pixels at 100% scale.
const GAP: f64 = 12.0;

/// Frosts the window so the desktop shows through.
///
/// Mica first (Windows 11, cheaper and sharper), acrylic as the fallback
/// (Windows 10). Both are OS effects: CSS `backdrop-filter` blurs what is
/// inside the window, never what is behind it, so this cannot be done from
/// the frontend.
pub fn apply_blur<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_acrylic, apply_mica};

        if apply_mica(window, Some(true)).is_ok() {
            return;
        }
        // A tinted acrylic rather than clear: the panel has to stay readable
        // over a bright desktop.
        let _ = apply_acrylic(window, Some((22, 18, 30, 180)));
    }

    #[cfg(not(target_os = "windows"))]
    let _ = window;
}

/// Places the panel next to the tray icon, the way a menu bar popover sits
/// under its icon.
///
/// `tray_rect` is where Windows drew the icon, in physical pixels. It is
/// unavailable in some situations (keyboard activation, overflow flyout), and
/// then the bottom-right corner above the taskbar is the sane fallback —
/// which is where the tray is anyway.
pub fn position_near_tray<R: Runtime>(
    window: &WebviewWindow<R>,
    tray_rect: Option<(f64, f64, f64, f64)>,
) {
    let Ok(monitor) = window.current_monitor() else {
        return;
    };
    let Some(monitor) = monitor else { return };

    let screen = monitor.size();
    let scale = monitor.scale_factor();

    let Ok(size) = window.outer_size() else { return };
    let width = size.width as f64;
    let height = size.height as f64;

    let (x, y) = match tray_rect {
        Some((left, top, right, _bottom)) => {
            // Centred on the icon, sitting above it.
            let centre = (left + right) / 2.0;
            let x = centre - width / 2.0;
            let y = top - height - GAP;
            (x, y)
        }
        None => (
            screen.width as f64 - width - GAP,
            screen.height as f64 - height - (48.0 * scale) - GAP,
        ),
    };

    // Never let the panel run off the edge of the screen.
    let x = x.max(GAP).min(screen.width as f64 - width - GAP);
    let y = y.max(GAP);

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Shows the panel at the tray, or hides it if it is already up.
pub fn toggle<R: Runtime>(window: &WebviewWindow<R>, tray_rect: Option<(f64, f64, f64, f64)>) {
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    show(window, tray_rect);
}

pub fn show<R: Runtime>(window: &WebviewWindow<R>, tray_rect: Option<(f64, f64, f64, f64)>) {
    position_near_tray(window, tray_rect);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Where the panel sat before it grew for the picker.
pub type SavedGeometry = (tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>);

/// How big the window has to be for Chromium's source picker to fit.
///
/// The picker is drawn *inside* the webview, not as a system dialog, so a
/// 320-wide popover clips it. Growing the window for the duration is the only
/// lever we have: WebView2 exposes no way to restyle or reposition it.
const PICKER_SIZE: (f64, f64) = (880.0, 660.0);

/// Grows and centres the window so the picker fits, returning where it was.
pub fn enter_picker_mode<R: Runtime>(window: &WebviewWindow<R>) -> Option<SavedGeometry> {
    let saved = match (window.outer_position(), window.outer_size()) {
        (Ok(position), Ok(size)) => Some((position, size)),
        _ => None,
    };

    let _ = window.set_size(LogicalSize::new(PICKER_SIZE.0, PICKER_SIZE.1));
    let _ = window.center();
    let _ = window.show();
    let _ = window.set_focus();

    saved
}

/// Puts the panel back exactly where it was.
pub fn leave_picker_mode<R: Runtime>(window: &WebviewWindow<R>, saved: Option<SavedGeometry>) {
    match saved {
        Some((position, size)) => {
            let _ = window.set_size(size);
            let _ = window.set_position(position);
        }
        None => {
            // Nothing recorded: fall back to the tray corner rather than
            // leaving a 880px panel floating in the middle of the screen.
            let _ = window.set_size(LogicalSize::new(320.0, 440.0));
            position_near_tray(window, None);
        }
    }
}

/// Kept so a future settings window can reuse the logical helper.
#[allow(dead_code)]
pub fn move_to<R: Runtime>(window: &WebviewWindow<R>, x: f64, y: f64) {
    let _ = window.set_position(LogicalPosition::new(x, y));
}

/// Convenience for the app handle, which is what event handlers hold.
pub fn main_window<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window("main")
}
