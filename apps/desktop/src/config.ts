/**
 * Everything environment-specific, in one place. Values come from Vite at
 * build time so a production build points at the real server without any code
 * change.
 */
export const config = {
  signalingUrl: (import.meta.env["VITE_SIGNALING_URL"] as string | undefined) ?? "ws://localhost:8787",
  /** How often connection quality is recalculated, in ms. */
  qualityIntervalMs: 2000,
} as const;
