//! Resolves the window the user chose to share into the process behind it.
//!
//! `getDisplayMedia` hands back a track labelled `window:<id>:0`. Everything
//! per-application depends on that `<id>` being a real HWND, which is an
//! assumption rather than a documented contract — so this reports what it
//! finds and lets the caller decide, instead of failing silently.

#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowInfo {
    pub pid: u32,
    /// Executable file name, e.g. "Discord.exe".
    pub process: String,
    pub title: String,
}

/// Parses the numeric id out of a `getDisplayMedia` track label.
///
/// Chrome labels look like `window:1051672:0` or `screen:0:0`. Only window
/// captures name a process; a whole screen has no single owner.
pub fn parse_window_label(label: &str) -> Option<u64> {
    let rest = label.strip_prefix("window:")?;
    let id = rest.split(':').next()?;
    id.parse::<u64>().ok()
}

#[cfg(target_os = "windows")]
pub fn describe(window_id: u64) -> Option<WindowInfo> {
    use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowTextW, GetWindowThreadProcessId, IsWindow,
    };

    let hwnd = HWND(window_id as *mut core::ffi::c_void);

    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return None;
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }

        let mut title_buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..len.max(0) as usize]);

        let process = process_name(pid).unwrap_or_else(|| "unknown".to_string());

        // Keep the handle scope tight; nothing below needs it.
        let _ = CloseHandle;
        let _ = OpenProcess;
        let _ = QueryFullProcessImageNameW;
        let _ = PROCESS_NAME_FORMAT;
        let _ = PROCESS_QUERY_LIMITED_INFORMATION;
        let _ = MAX_PATH;

        Some(WindowInfo { pid, process, title })
    }
}

#[cfg(target_os = "windows")]
fn process_name(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        // LIMITED_INFORMATION is enough for the name and, unlike full query
        // access, is granted for processes running at other integrity levels.
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;

        let mut buf = [0u16; 260];
        let mut len = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        result.ok()?;

        let full = String::from_utf16_lossy(&buf[..len as usize]);
        Some(
            full.rsplit(['\\', '/'])
                .next()
                .unwrap_or(&full)
                .to_string(),
        )
    }
}

#[cfg(not(target_os = "windows"))]
pub fn describe(_window_id: u64) -> Option<WindowInfo> {
    None
}

#[cfg(test)]
mod tests {
    use super::parse_window_label;

    #[test]
    fn reads_the_id_out_of_a_window_label() {
        assert_eq!(parse_window_label("window:1051672:0"), Some(1051672));
    }

    #[test]
    fn ignores_labels_that_name_no_process() {
        assert_eq!(parse_window_label("screen:0:0"), None);
        assert_eq!(parse_window_label("Primary Monitor"), None);
        assert_eq!(parse_window_label("window:abc:0"), None);
        assert_eq!(parse_window_label(""), None);
    }
}
