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

export function hidePanel(): Promise<void> {
  return invokeSafely("hide_panel");
}

export function quitApp(): Promise<void> {
  return invokeSafely("quit_app");
}
