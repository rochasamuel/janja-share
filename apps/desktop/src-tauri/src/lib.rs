mod popover;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, WindowEvent};
use tray::TrayStatus;

/// Whether clicking away closes the panel.
///
/// A tray popover should vanish when it loses focus. But the Windows screen
/// picker *takes* focus, so without this the panel would disappear the instant
/// the user tries to start sharing, and the session would look broken.
struct AutoHide(AtomicBool);

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

#[tauri::command]
fn hide_panel(window: tauri::WebviewWindow) {
    let _ = window.hide();
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
        .manage(AutoHide(AtomicBool::new(true)))
        .invoke_handler(tauri::generate_handler![
            set_tray_status,
            set_auto_hide,
            hide_panel,
            quit_app
        ])
        .setup(|app| {
            tray::init(app)?;

            if let Some(window) = app.get_webview_window("main") {
                popover::apply_blur(&window);
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
