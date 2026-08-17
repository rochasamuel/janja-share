export type TrayStatus = "idle" | "sharing" | "watching" | "error";

/**
 * Pushes app state onto the tray icon. While the window is hidden this is the
 * only thing telling the user a share is still running, so it is kept in sync
 * with the managers rather than only on screen changes.
 *
 * Failures are swallowed: a stale tray tooltip must never take down a live
 * share, and in a plain browser there is no tray at all.
 */
export async function setTrayStatus(status: TrayStatus, detail?: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_tray_status", { status, detail: detail ?? null });
  } catch {
    // Not running inside Tauri, or the tray is gone. Neither is fatal.
  }
}
