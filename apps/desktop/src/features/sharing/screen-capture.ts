/**
 * The single seam between this app and Windows screen capture.
 *
 * Everything the capture check taught us is encoded here, and nothing else in
 * the app calls getDisplayMedia. If WebView2 turns out to need a different
 * path for audio, this is the only file that changes.
 */

/** Where the audio in the stream came from, if any. */
export type AudioSource = "app" | "system" | "none";

export interface CaptureResult {
  stream: MediaStream;
  audioSource: AudioSource;
  /** Set when audioSource is "app": the process the sound belongs to. */
  audioProcess?: string;
  /** Why per-app audio was not used, when it was not. */
  audioNote?: string;
  /** Releases the native capture, if one is running. */
  stopAudio?: () => Promise<void>;
}

export interface CaptureOptions {
  /** Hints, not demands: real capture adapts to the monitor and the GPU. */
  width?: number;
  height?: number;
  frameRate?: number;
  getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
  /**
   * What the encoder should protect. "detail" for code, "motion" for a game —
   * asking an encoder to preserve every edge of a scene that changes
   * completely each frame is the most expensive thing you can request.
   */
  contentHint?: "detail" | "motion" | "text";
  /** Set false to skip native per-app capture and take the system mix. */
  preferAppAudio?: boolean;
  /** Injected in tests; defaults to the real native bridge. */
  startAppAudio?: (trackLabel: string) => Promise<{
    track: MediaStreamTrack;
    process: string;
    stop: () => Promise<void>;
  }>;
}

export class CaptureCancelledError extends Error {
  constructor() {
    super("capture-cancelled");
    this.name = "CaptureCancelledError";
  }
}

export class CaptureUnavailableError extends Error {
  constructor(cause: string) {
    super(cause);
    this.name = "CaptureUnavailableError";
  }
}

const DEFAULTS = { width: 1920, height: 1080, frameRate: 60 };

export async function startCapture(options: CaptureOptions = {}): Promise<CaptureResult> {
  const getDisplayMedia =
    options.getDisplayMedia ??
    ((constraints: DisplayMediaStreamOptions) =>
      navigator.mediaDevices.getDisplayMedia(constraints));

  const constraints = {
    video: {
      // `ideal`, never `exact`: asking a 1440p monitor for exactly 1080p is
      // how you get an OverconstrainedError instead of a picture.
      width: { ideal: options.width ?? DEFAULTS.width },
      height: { ideal: options.height ?? DEFAULTS.height },
      frameRate: { ideal: options.frameRate ?? DEFAULTS.frameRate },
    },
    audio: true,
    // Chromium-only hint asking the picker to offer system sound at all.
    systemAudio: "include",
  } as DisplayMediaStreamOptions;

  let stream: MediaStream;
  try {
    stream = await getDisplayMedia(constraints);
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    // Pressing cancel in the picker is a decision, not a fault, and must not
    // surface as an error screen.
    if (name === "NotAllowedError" || name === "AbortError") {
      throw new CaptureCancelledError();
    }
    throw new CaptureUnavailableError(error instanceof Error ? error.message : String(error));
  }

  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    for (const track of stream.getTracks()) track.stop();
    throw new CaptureUnavailableError("capture returned no video");
  }

  // Screen content is usually text and edges rather than motion, and telling
  // the encoder to protect sharpness is the whole difference between readable
  // code on the other end and a blurry mess. A game is the exception, and the
  // quality preset is what says so.
  videoTrack.contentHint = options.contentHint ?? "detail";

  return attachAudio(stream, videoTrack, options);
}

/**
 * Picks the best audio available, in order: the shared app alone, then the
 * whole computer, then none.
 *
 * Per-app matters because the system mix carries whatever else is playing —
 * most painfully the voice of whoever you are on a call with, fed straight
 * back into the stream.
 */
async function attachAudio(
  stream: MediaStream,
  videoTrack: MediaStreamTrack,
  options: CaptureOptions,
): Promise<CaptureResult> {
  const systemTracks = stream.getAudioTracks();

  if (options.preferAppAudio !== false) {
    // Only the native call belongs in the try. Swallowing a later failure here
    // would report "per-app audio unavailable" for something else entirely.
    let appAudio: Awaited<ReturnType<NonNullable<CaptureOptions["startAppAudio"]>>> | undefined;
    let note: string | undefined;

    try {
      const startAppAudio = options.startAppAudio ?? (await import("./app-audio.js")).startAppAudio;
      appAudio = await startAppAudio(videoTrack.label);
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    }

    if (appAudio) {
      // Drop the system mix: keeping both would play everything twice, with
      // the voice call still in it.
      for (const track of systemTracks) {
        stream.removeTrack(track);
        track.stop();
      }
      stream.addTrack(appAudio.track);

      return {
        stream,
        audioSource: "app",
        audioProcess: appAudio.process,
        stopAudio: appAudio.stop,
      };
    }

    return {
      stream,
      audioSource: systemTracks.length > 0 ? "system" : "none",
      ...(note === undefined ? {} : { audioNote: note }),
    };
  }

  return {
    stream,
    audioSource: systemTracks.length > 0 ? "system" : "none",
  };
}

/**
 * Windows shows its own "Stop sharing" bar over the app, and the user will
 * use it. That ends the track behind our back, so the caller has to hear
 * about it or the UI will claim to be live over a dead stream.
 */
export function onCaptureEnded(stream: MediaStream, callback: () => void): () => void {
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) return () => {};

  const handler = () => callback();
  videoTrack.addEventListener("ended", handler);
  return () => videoTrack.removeEventListener("ended", handler);
}

export function stopCapture(stream: MediaStream | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}
