/**
 * Turns raw WebRTC statistics into the four words a user is allowed to see.
 * Raw numbers stay in the logs: "Average jitter 0.25 ms" tells a person
 * nothing about whether they should move closer to the router.
 */
export type ConnectionQuality = "excellent" | "good" | "poor" | "reconnecting";

export interface QualitySample {
  /** Round trip time in milliseconds, or null before the first measurement. */
  rttMs: number | null;
  /** Packets lost over the last interval as a ratio, 0 to 1. */
  packetLossRatio: number | null;
  /** Frames per second, encoded or decoded, or null when nothing moved yet. */
  framesPerSecond: number | null;
  /** Video bits per second over the last interval, or null. */
  bitrateBps: number | null;
  /** Size of the picture actually on the wire, which is not the monitor's. */
  frameWidth: number | null;
  frameHeight: number | null;
  /** Negotiated codec, short form: "H264", "VP8". */
  codec: string | null;
  /**
   * Whether the codec is running on the GPU.
   *
   * This is the number that explains a busy CPU. H.264 has a hardware encoder
   * on essentially every Windows machine; VP8 has one nowhere, and the sharer
   * runs one encoder per viewer.
   */
  powerEfficient: boolean | null;
  /** What Chromium calls the implementation, e.g. "ExternalEncoder", "libvpx". */
  implementation: string | null;
  iceState: RTCIceConnectionState;
}

const RTT_EXCELLENT_MS = 100;
const RTT_GOOD_MS = 250;
const LOSS_EXCELLENT = 0.01;
const LOSS_GOOD = 0.03;
const FPS_EXCELLENT = 24;
const FPS_GOOD = 15;

export function classifyQuality(sample: QualitySample): ConnectionQuality {
  // Transport state outranks every measurement: a dead path with a stale
  // 40 ms RTT is not "excellent", it is broken.
  if (
    sample.iceState === "disconnected" ||
    sample.iceState === "failed" ||
    sample.iceState === "closed"
  ) {
    return "reconnecting";
  }

  // Before the first real measurement there is nothing to grade. Saying
  // "poor" here would flash a warning at every viewer on every join.
  if (
    sample.rttMs === null &&
    sample.packetLossRatio === null &&
    sample.framesPerSecond === null
  ) {
    return sample.iceState === "connected" || sample.iceState === "completed"
      ? "good"
      : "reconnecting";
  }

  const rttRating = rate(sample.rttMs, RTT_EXCELLENT_MS, RTT_GOOD_MS);
  const lossRating = rate(sample.packetLossRatio, LOSS_EXCELLENT, LOSS_GOOD);
  const fpsRating = rateInverted(sample.framesPerSecond, FPS_EXCELLENT, FPS_GOOD);

  // The worst dimension wins. Smooth video with a third of the packets missing
  // is not a good experience, and averaging would hide exactly that.
  return worst([rttRating, lossRating, fpsRating]);
}

type Rating = "excellent" | "good" | "poor";

/** Lower is better: latency, loss. */
function rate(value: number | null, excellent: number, good: number): Rating | null {
  if (value === null) return null;
  if (value < excellent) return "excellent";
  if (value < good) return "good";
  return "poor";
}

/** Higher is better: frame rate. */
function rateInverted(value: number | null, excellent: number, good: number): Rating | null {
  if (value === null) return null;
  if (value >= excellent) return "excellent";
  if (value >= good) return "good";
  return "poor";
}

function worst(ratings: (Rating | null)[]): ConnectionQuality {
  const present = ratings.filter((r): r is Rating => r !== null);
  if (present.length === 0) return "good";
  if (present.includes("poor")) return "poor";
  if (present.includes("good")) return "good";
  return "excellent";
}
