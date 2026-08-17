//! Enumerates what the user could share.
//!
//! Needed by any custom picker, and needed right now to test whether WebView2
//! will accept a source we name ourselves. Electron apps like Discord get this
//! from `desktopCapturer` plus `setDisplayMediaRequestHandler`; WebView2
//! exposes neither, so the list has to come from Win32.

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    /// Chromium's desktop-capture id format, e.g. `window:1051672:0`.
    pub id: String,
    pub title: String,
    pub process: String,
    pub kind: &'static str,
}

#[cfg(target_os = "windows")]
pub fn list() -> Vec<CaptureSource> {
    use std::sync::Mutex;
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW,
        GetWindowTextW, IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
    };

    static COLLECTED: Mutex<Vec<(u64, String)>> = Mutex::new(Vec::new());

    unsafe extern "system" fn callback(hwnd: HWND, _param: LPARAM) -> BOOL {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                return BOOL(1);
            }
            // Owned windows are dialogs and popups belonging to something else;
            // listing them buries the handful of windows a person recognises.
            if GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.is_invalid()) {
                return BOOL(1);
            }
            // Tool windows are palettes and tray helpers, never a share target.
            if GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
                return BOOL(1);
            }

            let length = GetWindowTextLengthW(hwnd);
            if length <= 0 {
                return BOOL(1);
            }

            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_err() {
                return BOOL(1);
            }
            // Skip slivers: minimised and zero-area windows show as nothing.
            if rect.right - rect.left < 120 || rect.bottom - rect.top < 80 {
                return BOOL(1);
            }

            let mut buffer = vec![0u16; length as usize + 1];
            let written = GetWindowTextW(hwnd, &mut buffer);
            if written <= 0 {
                return BOOL(1);
            }
            let title = String::from_utf16_lossy(&buffer[..written as usize]);

            if let Ok(mut collected) = COLLECTED.lock() {
                collected.push((hwnd.0 as u64, title));
            }
            BOOL(1)
        }
    }

    if let Ok(mut collected) = COLLECTED.lock() {
        collected.clear();
    }

    unsafe {
        let _ = EnumWindows(Some(callback), LPARAM(0));
    }

    let windows = COLLECTED
        .lock()
        .map(|collected| collected.clone())
        .unwrap_or_default();

    let mut sources: Vec<CaptureSource> = windows
        .into_iter()
        .map(|(handle, title)| {
            let process = crate::window_info::describe(handle)
                .map(|info| info.process)
                .unwrap_or_else(|| "unknown".to_string());
            CaptureSource {
                // Matches the id Chromium itself uses, so the same string works
                // whether it comes from here or from a track label.
                id: format!("window:{handle}:0"),
                title,
                process,
                kind: "window",
            }
        })
        .collect();

    sources.sort_by(|a, b| a.process.to_lowercase().cmp(&b.process.to_lowercase()));

    // The whole desktop, listed first because it is the common choice.
    sources.insert(
        0,
        CaptureSource {
            id: "screen:0:0".to_string(),
            title: "Entire screen".to_string(),
            process: String::new(),
            kind: "screen",
        },
    );

    sources
}

#[cfg(not(target_os = "windows"))]
pub fn list() -> Vec<CaptureSource> {
    Vec::new()
}
