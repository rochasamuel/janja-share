/**
 * What the global shortcut does, given what the app is currently doing.
 *
 * This lives apart from the listener because the listener cannot be tested —
 * it needs Tauri's event bridge and a real key press — while the decision it
 * makes is the part that can actually be got wrong.
 */

export type ShareShortcutAction =
  /** A share is running. End it without leaving the game. */
  | "stop"
  /** In a channel and idle: this is the case the shortcut exists for. */
  | "start"
  /** Nothing to share into. Show the panel rather than fail silently. */
  | "needs-channel";

export interface ShareShortcutState {
  live: boolean;
  inChannel: boolean;
}

/**
 * Toggling rather than only starting is deliberate.
 *
 * Stopping has exactly the same problem as starting: a fullscreen game has to
 * be left behind to reach the panel, and leaving it is what minimises it. A
 * shortcut that could only start would solve half of a symmetric problem.
 */
export function shareShortcutAction(state: ShareShortcutState): ShareShortcutAction {
  if (state.live) return "stop";
  return state.inChannel ? "start" : "needs-channel";
}
