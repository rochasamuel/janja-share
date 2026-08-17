mod tray;

use tauri::WindowEvent;
use tray::TrayStatus;

/// Lets the frontend drive the tray as its own state changes.
#[tauri::command]
fn set_tray_status(
    app: tauri::AppHandle,
    status: TrayStatus,
    detail: Option<String>,
) -> Result<(), String> {
    tray::apply_status(&app, status, detail).map_err(|e| e.to_string())
}

/// Sharing must survive the window being closed, so "quit" has to be explicit.
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
        .invoke_handler(tauri::generate_handler![set_tray_status, quit_app])
        .setup(|app| {
            tray::init(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Closing the window hides it. A share in progress keeps
                // running, which is the entire point of the tray.
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
