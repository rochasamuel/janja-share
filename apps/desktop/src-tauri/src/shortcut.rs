//! The one shortcut that works while another app owns the screen.
//!
//! Every in-app shortcut needs the panel focused, which is useless for the
//! case that matters: a fullscreen game. Reaching the tray means leaving the
//! game, leaving it minimises it, and Chromium's picker does not list
//! minimised windows — because Windows does not draw them, so there would be
//! nothing to capture even if it did.
//!
//! Registering this from Rust rather than from JavaScript keeps the webview's
//! capability surface unchanged: the frontend only ever listens for an event
//! it already has permission to receive.

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Emitted when the shortcut fires. The frontend decides what it means, since
/// only it knows whether a share is already running.
pub const SHARE_SHORTCUT_EVENT: &str = "shortcut://share-toggle";

/// Ctrl+Alt+S.
///
/// Fixed rather than configurable on purpose: a preference costs a settings
/// screen, a storage key and a conflict-detection story, and nobody has hit a
/// conflict yet. Ctrl+Alt is the least-claimed modifier pair on Windows, and S
/// matches the in-app Ctrl+S the person already knows.
pub fn share_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyS)
}

/// The plugin, wired to emit on press.
///
/// Built here rather than in `run` so the accelerator and the handler that
/// recognises it cannot drift apart.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, fired, event| {
            // Pressed, not released: handling both would fire twice per press.
            if event.state() != ShortcutState::Pressed || fired != &share_shortcut() {
                return;
            }
            let _ = app.emit(SHARE_SHORTCUT_EVENT, ());
        })
        .build()
}

/// Claims the accelerator, or reports why it could not be claimed.
///
/// Failure here is survivable and must not stop the app: another application
/// may already own this combination, and a tray app that refused to start over
/// a hotkey would be worse than one without the hotkey.
pub fn register<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    app.global_shortcut()
        .register(share_shortcut())
        .map_err(|e| format!("could not register Ctrl+Alt+S: {e}"))
}
