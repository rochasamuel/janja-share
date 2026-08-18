#[cfg(target_os = "windows")]
mod app_audio;
mod popover;
mod shortcut;
mod sources;
mod tray;
mod window_info;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Manager, State, WindowEvent};
use tray::TrayStatus;

/// Whether clicking away closes the panel.
///
/// A tray popover should vanish when it loses focus. But the Windows screen
/// picker *takes* focus, so without this the panel would disappear the instant
/// the user tries to start sharing, and the session would look broken.
struct AutoHide(AtomicBool);

/// Where the panel was before it grew to fit the picker.
#[derive(Default)]
struct PanelGeometry(Mutex<Option<popover::SavedGeometry>>);

/// Lets the frontend drive the tray as its own state changes.
#[tauri::command]
fn set_tray_status(
    app: tauri::AppHandle,
    status: TrayStatus,
    detail: Option<String>,
) -> Result<(), String> {
    tray::apply_status(&app, status, detail).map_err(|e| e.to_string())
}

/// Called around the screen picker, and while watching a stream, so the panel
/// stays put instead of vanishing on the first click elsewhere.
#[tauri::command]
fn set_auto_hide(state: tauri::State<'_, AutoHide>, enabled: bool) {
    state.0.store(enabled, Ordering::Relaxed);
}

/// Grows the panel while Chromium's source picker is on screen.
///
/// The picker renders inside the webview rather than as a system dialog, so at
/// the panel's normal 320px it is cut off. This is the only lever available:
/// WebView2 offers no way to restyle, resize or reposition that UI.
#[tauri::command]
fn set_picker_mode(
    window: tauri::WebviewWindow,
    geometry: State<'_, PanelGeometry>,
    auto_hide: State<'_, AutoHide>,
    enabled: bool,
) {
    // The picker takes focus; hiding on blur now would kill it mid-choice.
    auto_hide.0.store(!enabled, Ordering::Relaxed);

    let Ok(mut slot) = geometry.0.lock() else {
        return;
    };

    if enabled {
        // Idempotent on purpose. A second enter would save the already-grown
        // geometry as if it were the panel's resting place, and restoring it
        // later would leave an 880px window sitting where the popover was.
        if slot.is_some() {
            return;
        }
        *slot = popover::enter_picker_mode(&window);
    } else {
        // Nothing to leave. Restoring here would shrink the window while the
        // picker is still open, which is what clipped it.
        let Some(saved) = slot.take() else {
            return;
        };
        popover::leave_picker_mode(&window, Some(saved));
    }
}

#[tauri::command]
fn hide_panel(window: tauri::WebviewWindow) {
    let _ = window.hide();
}

/// Brings the panel up from wherever the user was.
///
/// Needed by the global shortcut: pressed with no channel joined there is
/// nothing to share into, and the honest answer is to show the panel rather
/// than to do nothing and look broken.
#[tauri::command]
fn show_panel(app: tauri::AppHandle) {
    tray::show_main_window(&app);
}

/// The running per-application audio capture, if any.
#[cfg(target_os = "windows")]
#[derive(Default)]
struct AudioCapture(Mutex<Option<app_audio::CaptureHandle>>);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioStarted {
    pid: u32,
    process: String,
    sample_rate: u32,
    channels: u16,
}

/// Captures only what the shared application plays, and streams it to the
/// frontend as raw f32 frames.
///
/// Returns an error rather than silence when the platform refuses, so the
/// caller can fall back to system audio and say so.
#[cfg(target_os = "windows")]
#[tauri::command]
fn start_app_audio(
    state: State<'_, AudioCapture>,
    label: String,
    channel: Channel<InvokeResponseBody>,
) -> Result<AudioStarted, String> {
    let window_id = window_info::parse_window_label(&label)
        .ok_or_else(|| "that source is a whole screen, not one app".to_string())?;
    let info = window_info::describe(window_id)
        .ok_or_else(|| "could not tell which app owns that window".to_string())?;

    // Replace any previous capture: two of them would double the audio.
    if let Ok(mut slot) = state.0.lock() {
        if let Some(previous) = slot.take() {
            previous.stop();
        }
    }

    let handle = app_audio::start(info.pid, move |samples| {
        let mut bytes = Vec::with_capacity(samples.len() * 4);
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        let _ = channel.send(InvokeResponseBody::Raw(bytes));
    })?;

    state
        .0
        .lock()
        .map_err(|_| "audio state is poisoned".to_string())?
        .replace(handle);

    Ok(AudioStarted {
        pid: info.pid,
        process: info.process,
        sample_rate: app_audio::SAMPLE_RATE,
        channels: app_audio::CHANNELS,
    })
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn stop_app_audio(state: State<'_, AudioCapture>) {
    if let Ok(mut slot) = state.0.lock() {
        if let Some(handle) = slot.take() {
            handle.stop();
        }
    }
}

/// Lists the windows and screens a person could share.
///
/// Groundwork for a custom picker, and right now the input to testing whether
/// WebView2 will accept a source we name ourselves.
#[tauri::command]
fn list_capture_sources() -> Vec<sources::CaptureSource> {
    sources::list()
}

/// Reports which process owns a shared window, so the capture check can prove
/// the label Chromium hands us really is an HWND before anything depends on it.
#[tauri::command]
fn describe_window(label: String) -> Option<window_info::WindowInfo> {
    window_info::parse_window_label(&label).and_then(window_info::describe)
}

/// The name the rest of the channel will see.
///
/// `COMPUTERNAME` is what Windows itself shows in Settings, and it is what the
/// group already uses to refer to each other's machines. Falling back to
/// `HOSTNAME` keeps a non-Windows dev build working; an empty result is handled
/// on the TypeScript side, which has a friendlier default than Rust does.
#[tauri::command]
fn machine_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default()
}

/// Sharing must survive the panel closing, so quitting has to be explicit.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // In release a second launch (including a future deep link) focuses the
    // running instance rather than starting a rival copy with its own
    // capture. In development that rule makes it impossible to run a sharer
    // and a viewer on one machine, which is the only way to test the thing
    // end to end without a second PC — so debug builds allow many instances.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        tray::show_main_window(app);
    }));

    builder
        .plugin(shortcut::plugin())
        .manage(AutoHide(AtomicBool::new(true)))
        .manage(AudioCapture::default())
        .manage(PanelGeometry::default())
        .invoke_handler(tauri::generate_handler![
            set_tray_status,
            set_auto_hide,
            set_picker_mode,
            hide_panel,
            show_panel,
            describe_window,
            list_capture_sources,
            start_app_audio,
            stop_app_audio,
            quit_app,
            machine_name
        ])
        .setup(|app| {
            tray::init(app)?;

            // Survivable: another application may already own Ctrl+Alt+S, and
            // refusing to start over a hotkey would be worse than starting
            // without it.
            if let Err(message) = shortcut::register(app.handle()) {
                eprintln!("janja: {message}");
            }

            if let Some(window) = app.get_webview_window("main") {
                popover::apply_blur(&window);
                popover::apply_rounded_corners(&window);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                // Closing hides the panel. A share in progress keeps running,
                // which is the entire point of living in the tray.
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            WindowEvent::Focused(false) => {
                if window.label() != "main" {
                    return;
                }
                let allowed = window
                    .try_state::<AutoHide>()
                    .map(|state| state.0.load(Ordering::Relaxed))
                    .unwrap_or(true);
                if allowed {
                    let _ = window.hide();
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
