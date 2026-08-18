use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Runtime,
};

use crate::popover;

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

/// The tray lives here and only here.
///
/// `tauri.conf.json` deliberately has no `trayIcon` block: declaring it there
/// as well makes Tauri create a second icon at startup, one with no menu and
/// no click handler, so half the user's clicks land on a dead icon.
pub const TRAY_ID: &str = "main";
/// Frontend listens for this and routes the click to the right screen.
pub const TRAY_ACTION_EVENT: &str = "tray://action";

/// The right-click menu stays deliberately thin. The panel itself is the
/// interface now, so this only holds what you would want without opening it.
fn build_menu<R: Runtime>(app: &App<R>) -> tauri::Result<Menu<R>> {
    let open = MenuItemBuilder::with_id("open", "Abrir Janja Share").build(app)?;
    let stop = MenuItemBuilder::with_id("stop", "Parar de compartilhar").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Sair").build(app)?;

    MenuBuilder::new(app)
        .items(&[&open])
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
        .tooltip("Janja Share — parado")
        .menu(&menu)
        // Left click opens the panel; the menu is on right click, which is
        // what a tray popover is expected to do.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = popover::main_window(app) {
                    let position = rect.position.to_physical::<f64>(1.0);
                    let size = rect.size.to_physical::<f64>(1.0);
                    popover::toggle(
                        &window,
                        Some((
                            position.x,
                            position.y,
                            position.x + size.width,
                            position.y + size.height,
                        )),
                    );
                }
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "quit" => app.exit(0),
                "open" => {
                    if let Some(window) = popover::main_window(app) {
                        popover::show(&window, None);
                    }
                }
                "stop" => {
                    if let Some(window) = popover::main_window(app) {
                        popover::show(&window, None);
                    }
                    let _ = app.emit(TRAY_ACTION_EVENT, id.to_string());
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(())
}

/// Used by the single-instance handler, which only exists in release builds.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = popover::main_window(app) {
        popover::show(&window, None);
    }
}

/// Reflects app state on the tray: icon colour plus the tooltip that tells the
/// user what is happening while the panel is closed.
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
        TrayStatus::Idle => "parado".to_string(),
        TrayStatus::Sharing => detail
            .clone()
            .map(|d| format!("compartilhando — {d}"))
            .unwrap_or_else(|| "compartilhando".to_string()),
        TrayStatus::Watching => detail
            .clone()
            .map(|d| format!("assistindo — {d}"))
            .unwrap_or_else(|| "assistindo".to_string()),
        TrayStatus::Error => detail
            .clone()
            .unwrap_or_else(|| "algo deu errado".to_string()),
    };
    tray.set_tooltip(Some(format!("Janja Share — {label}")))?;

    Ok(())
}
