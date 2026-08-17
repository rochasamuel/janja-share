/**
 * Answers, empirically and inside the real WebView2 window, the one question
 * the whole sharer depends on: does getDisplayMedia work here, and does it
 * hand us a system audio track?
 *
 * Chromium only offers system audio loopback for whole-screen capture on
 * Windows; a single window usually comes back video-only. That is survivable
 * but has to be known rather than assumed, which is why this reports each
 * source kind separately instead of a single pass/fail.
 */

export interface TrackReport {
  label: string;
  settings: Record<string, unknown>;
}

export interface ProbeResult {
  ok: boolean;
  /** Set when the probe failed outright. */
  errorName?: string;
  errorMessage?: string;
  /** True when the failure looks like the host never granted DisplayCapture. */
  permissionLikelyDenied?: boolean;
  video: TrackReport[];
  audio: TrackReport[];
  width: number | null;
  height: number | null;
  frameRate: number | null;
  hasSystemAudio: boolean;
  videoCodecs: string[];
  userAgent: string;
}

export type DisplayMediaFn = (
  constraints: DisplayMediaStreamOptions,
) => Promise<MediaStream>;

export interface ProbeDeps {
  getDisplayMedia?: DisplayMediaFn;
  getVideoCodecs?: () => string[];
  userAgent?: string;
}

function defaultCodecs(): string[] {
  const capabilities = RTCRtpSender.getCapabilities?.("video");
  return (capabilities?.codecs ?? []).map((codec) => codec.mimeType);
}

export async function probeCapture(deps: ProbeDeps = {}): Promise<ProbeResult> {
  const getDisplayMedia =
    deps.getDisplayMedia ??
    ((constraints: DisplayMediaStreamOptions) =>
      navigator.mediaDevices.getDisplayMedia(constraints));
  const getVideoCodecs = deps.getVideoCodecs ?? defaultCodecs;
  const userAgent = deps.userAgent ?? navigator.userAgent;

  const empty = {
    video: [],
    audio: [],
    width: null,
    height: null,
    frameRate: null,
    hasSystemAudio: false,
    videoCodecs: [] as string[],
    userAgent,
  };

  let stream: MediaStream;
  try {
    stream = await getDisplayMedia({
      video: { width: 1920, height: 1080, frameRate: 60 },
      audio: true,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...empty,
      ok: false,
      errorName: name,
      errorMessage: message,
      // NotAllowedError with no picker is the signature of the host refusing
      // the DisplayCapture permission, as opposed to a user pressing cancel.
      permissionLikelyDenied: name === "NotAllowedError" || name === "NotSupportedError",
    };
  }

  const videoTracks = stream.getVideoTracks();
  const audioTracks = stream.getAudioTracks();
  const primary = videoTracks[0]?.getSettings();

  const result: ProbeResult = {
    ok: true,
    video: videoTracks.map(describe),
    audio: audioTracks.map(describe),
    width: primary?.width ?? null,
    height: primary?.height ?? null,
    frameRate: primary?.frameRate ?? null,
    hasSystemAudio: audioTracks.length > 0,
    videoCodecs: getVideoCodecs(),
    userAgent,
  };

  // The probe answers a question; it must not leave a capture running.
  for (const track of stream.getTracks()) track.stop();

  return result;
}

function describe(track: MediaStreamTrack): TrackReport {
  return {
    label: track.label,
    settings: track.getSettings() as unknown as Record<string, unknown>,
  };
}

/** Human-readable summary for the diagnostics log and for RESULTS.md. */
export function summarize(result: ProbeResult): string {
  if (!result.ok) {
    const lines = [
      `FAILED: ${result.errorName}: ${result.errorMessage}`,
      result.permissionLikelyDenied
        ? "Looks like the host never granted DisplayCapture, rather than you pressing cancel."
        : "The picker appeared but capture did not start.",
    ];
    return lines.join("\n");
  }

  return [
    `picker shown:      yes`,
    `video tracks:      ${result.video.length}`,
    `audio tracks:      ${result.audio.length}${result.hasSystemAudio ? "" : "  <-- no system audio"}`,
    `negotiated:        ${result.width ?? "?"}x${result.height ?? "?"} @ ${
      result.frameRate ? Math.round(result.frameRate) : "?"
    } fps`,
    `h264 available:    ${result.videoCodecs.some((c) => /h264/i.test(c)) ? "yes" : "no"}`,
    ``,
    `video: ${result.video.map((t) => t.label).join(", ") || "none"}`,
    `audio: ${result.audio.map((t) => t.label).join(", ") || "none"}`,
  ].join("\n");
}
