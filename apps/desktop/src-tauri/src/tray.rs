use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, Runtime,
};

/// What the tray icon is currently telling the user.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrayStatus {
    Idle,
    Sharing,
    Watching,
    Error,
}

impl TrayStatus {
    fn icon_bytes(self) -> &'static [u8] {
        match self {
            TrayStatus::Idle => include_bytes!("../icons/tray-idle.png"),
            TrayStatus::Sharing => include_bytes!("../icons/tray-sharing.png"),
            TrayStatus::Watching => include_bytes!("../icons/tray-watching.png"),
            TrayStatus::Error => include_bytes!("../icons/tray-error.png"),
        }
    }
}

pub const TRAY_ID: &str = "main";
/// Frontend listens for this and routes the click to the right screen.
pub const TRAY_ACTION_EVENT: &str = "tray://action";

pub fn build_menu<R: Runtime>(app: &App<R>) -> tauri::Result<Menu<R>> {
    let open = MenuItemBuilder::with_id("open", "Open").build(app)?;
    let share = MenuItemBuilder::with_id("share", "Share Screen").build(app)?;
    let watch = MenuItemBuilder::with_id("watch", "Watch Stream").build(app)?;
    let stop = MenuItemBuilder::with_id("stop", "Stop Sharing")
        .enabled(false)
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    MenuBuilder::new(app)
        .items(&[&open, &share, &watch])
        .separator()
        .items(&[&stop])
        .separator()
        .items(&[&quit])
        .build()
}

pub fn init<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let menu = build_menu(app)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(TrayStatus::Idle.icon_bytes())?)
        .tooltip("ScreenShare — idle")
        .menu(&menu)
        // Left click reopens the window; the menu handles everything else.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "quit" => {
                    // The only path that actually terminates the process.
                    app.exit(0);
                }
                "open" => show_main_window(app),
                // The frontend owns capture and peer connections, so tray
                // clicks are forwarded rather than acted on here.
                "share" | "watch" | "stop" => {
                    show_main_window(app);
                    let _ = app.emit(TRAY_ACTION_EVENT, id.to_string());
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Reflects app state on the tray: icon colour plus the tooltip text that
/// tells the user what is happening while the window is hidden.
pub fn apply_status<R: Runtime>(
    app: &AppHandle<R>,
    status: TrayStatus,
    detail: Option<String>,
) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };

    tray.set_icon(Some(Image::from_bytes(status.icon_bytes())?))?;

    let label = match status {
        TrayStatus::Idle => "idle".to_string(),
        TrayStatus::Sharing => detail
            .clone()
            .map(|d| format!("sharing — {d}"))
            .unwrap_or_else(|| "sharing".to_string()),
        TrayStatus::Watching => detail
            .clone()
            .map(|d| format!("watching — {d}"))
            .unwrap_or_else(|| "watching".to_string()),
        TrayStatus::Error => detail
            .clone()
            .unwrap_or_else(|| "something went wrong".to_string()),
    };
    tray.set_tooltip(Some(format!("ScreenShare — {label}")))?;

    Ok(())
}
