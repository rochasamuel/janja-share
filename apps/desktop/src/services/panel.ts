/**
 * The popover's own behaviour: closing itself, quitting, and pinning itself
 * open.
 *
 * All of it degrades to nothing outside Tauri, so the same build still runs in
 * a browser tab for testing.
 */

async function invokeSafely(command: string, args?: Record<string, unknown>): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(command, args ?? {});
  } catch {
    // Not running inside Tauri.
  }
}

/**
 * Keeps the panel from closing when it loses focus.
 *
 * Required around the screen picker: the picker takes focus, and a popover
 * that hides on blur would vanish exactly when the user is trying to start
 * sharing.
 */
export function setAutoHide(enabled: boolean): Promise<void> {
  return invokeSafely("set_auto_hide", { enabled });
}

/**
 * Grows the panel so Chromium's source picker fits, and shrinks it back after.
 *
 * The picker is drawn inside the webview rather than as a system dialog, so at
 * the popover's normal width it gets clipped. WebView2 gives no way to restyle
 * or move that UI, so making room for it is the whole fix.
 */
export function setPickerMode(enabled: boolean): Promise<void> {
  return invokeSafely("set_picker_mode", { enabled });
}

/**
 * Drops the popover's two window rules while a stream fills the screen.
 *
 * `alwaysOnTop` and `skipTaskbar` are right for a popover and wrong for
 * anything fullscreen: the first keeps it painted over whatever you alt-tab
 * to, the second keeps it out of the alt-tab list entirely.
 */
export function setFullscreenMode(enabled: boolean): Promise<void> {
  return invokeSafely("set_fullscreen_mode", { enabled });
}

export function hidePanel(): Promise<void> {
  return invokeSafely("hide_panel");
}

/**
 * Brings the panel up from wherever the user was.
 *
 * Used by the global shortcut when there is no channel to share into: doing
 * nothing would be indistinguishable from a shortcut that is not working.
 */
export function showPanel(): Promise<void> {
  return invokeSafely("show_panel");
}

export function quitApp(): Promise<void> {
  return invokeSafely("quit_app");
}
