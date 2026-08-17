/**
 * The single seam between this app and Windows screen capture.
 *
 * Everything the capture check taught us is encoded here, and nothing else in
 * the app calls getDisplayMedia. If WebView2 turns out to need a different
 * path for audio, this is the only file that changes.
 */

export interface CaptureResult {
  stream: MediaStream;
  /** False when Windows gave us video but no sound for the chosen source. */
  hasSystemAudio: boolean;
}

export interface CaptureOptions {
  /** Hints, not demands: real capture adapts to the monitor and the GPU. */
  width?: number;
  height?: number;
  frameRate?: number;
  getDisplayMedia?: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>;
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

  // Screen content is text and edges, not motion. This tells the encoder to
  // protect sharpness rather than smoothness, which is the whole difference
  // between readable code on the other end and a blurry mess.
  videoTrack.contentHint = "detail";

  return { stream, hasSystemAudio: stream.getAudioTracks().length > 0 };
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
