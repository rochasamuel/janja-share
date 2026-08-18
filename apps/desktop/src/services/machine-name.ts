import { sanitizeName } from "@janja/signaling-protocol";

/** What a machine with no usable name is called in the member list. */
const FALLBACK = "PC";

/**
 * Reads the computer's name, the way the rest of the channel will see it.
 *
 * This must never reject: a machine with an unreadable name still deserves to
 * join, under a generic label, rather than be locked out of the app.
 */
export async function resolveMachineName(
  read: () => Promise<string> = readNative,
): Promise<string> {
  try {
    return sanitizeName(await read()) ?? FALLBACK;
  } catch {
    // A plain browser during `pnpm dev`, or a Tauri command that is gone.
    return FALLBACK;
  }
}

async function readNative(): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<string>("machine_name");
}
