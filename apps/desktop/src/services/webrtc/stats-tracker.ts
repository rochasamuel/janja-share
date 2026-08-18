import type { QualitySample } from "./connection-quality.js";

/**
 * Which end of the stream this tracker is watching.
 *
 * It has to be told. A sharer's connection carries no inbound video, and a
 * viewer's carries no outbound, so a tracker that guessed by looking for
 * whichever entry existed would read audio statistics as video the moment one
 * appeared.
 */
export type StatsDirection = "send" | "receive";

interface Counters {
  /** Packets received, or packets sent, depending on the direction. */
  delivered: number | undefined;
  lost: number | undefined;
  bytes: number | undefined;
  timestamp: number | undefined;
}

interface VideoStats extends Counters {
  framesPerSecond: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  codec: string | null;
  powerEfficient: boolean | null;
  implementation: string | null;
  qualityLimitation: string | null;
}

/**
 * Reduces an RTCStatsReport to the handful of numbers we grade on and show.
 *
 * Packet loss and bitrate are measured over the interval between samples, not
 * since the connection opened. A cumulative ratio would be dominated by
 * whatever happened during setup and would barely move afterwards, so a stream
 * that went bad thirty seconds ago would still read as healthy.
 */
export class StatsTracker {
  readonly #direction: StatsDirection;
  #previous: Counters | undefined;

  constructor(direction: StatsDirection) {
    this.#direction = direction;
  }

  sample(report: RTCStatsReport, iceState: RTCIceConnectionState): QualitySample {
    const rttMs = readRoundTripTime(report);
    const video = this.#readVideo(report);

    const packetLossRatio = this.#lossOverInterval(video);
    const bitrateBps = this.#bitrateOverInterval(video);

    this.#previous = {
      delivered: video.delivered,
      lost: video.lost,
      bytes: video.bytes,
      timestamp: video.timestamp,
    };

    return {
      rttMs,
      packetLossRatio,
      framesPerSecond: video.framesPerSecond,
      bitrateBps,
      frameWidth: video.frameWidth,
      frameHeight: video.frameHeight,
      codec: video.codec,
      powerEfficient: video.powerEfficient,
      implementation: video.implementation,
      qualityLimitation: video.qualityLimitation,
      iceState,
    };
  }

  reset(): void {
    this.#previous = undefined;
  }

  #readVideo(report: RTCStatsReport): VideoStats {
    const sending = this.#direction === "send";
    const rtpType = sending ? "outbound-rtp" : "inbound-rtp";
    const bytesKey = sending ? "bytesSent" : "bytesReceived";
    const deliveredKey = sending ? "packetsSent" : "packetsReceived";

    const video: VideoStats = {
      delivered: undefined,
      lost: undefined,
      bytes: undefined,
      timestamp: undefined,
      framesPerSecond: null,
      frameWidth: null,
      frameHeight: null,
      codec: null,
      powerEfficient: null,
      implementation: null,
      qualityLimitation: null,
    };

    // The rtp entry names its codec by id rather than carrying it, so the
    // codec entries have to be collected before they can be resolved.
    const codecs = new Map<string, string>();
    let codecId: string | undefined;

    report.forEach((entry) => {
      const stat = entry as Record<string, unknown>;

      if (stat["type"] === "codec") {
        const id = stat["id"];
        const mimeType = stat["mimeType"];
        if (typeof id === "string" && typeof mimeType === "string") {
          // "video/H264" is the whole name; only the half after the slash
          // means anything to a person.
          codecs.set(id, mimeType.split("/")[1] ?? mimeType);
        }
        return;
      }

      if (stat["kind"] !== "video") return;

      if (stat["type"] === rtpType) {
        video.framesPerSecond = numberOrNull(stat["framesPerSecond"]);
        video.frameWidth = numberOrNull(stat["frameWidth"]);
        video.frameHeight = numberOrNull(stat["frameHeight"]);
        video.delivered = numberOrUndefined(stat[deliveredKey]);
        video.bytes = numberOrUndefined(stat[bytesKey]);
        video.timestamp = numberOrUndefined(stat["timestamp"]);

        const id = stat["codecId"];
        if (typeof id === "string") codecId = id;

        video.implementation = stringOrNull(
          sending ? stat["encoderImplementation"] : stat["decoderImplementation"],
        );
        video.powerEfficient = booleanOrNull(
          sending ? stat["powerEfficientEncoder"] : stat["powerEfficientDecoder"],
        );
        // Only the sender has one: a receiver does not choose what it is sent.
        // "none" is the healthy case and is not worth carrying as a value.
        if (sending) {
          const reason = stringOrNull(stat["qualityLimitationReason"]);
          video.qualityLimitation = reason === "none" ? null : reason;
        }
        // A receiver counts its own losses; a sender only learns about them
        // from the receiver report that comes back.
        if (!sending) video.lost = numberOrUndefined(stat["packetsLost"]);
        return;
      }

      if (sending && stat["type"] === "remote-inbound-rtp") {
        video.lost = numberOrUndefined(stat["packetsLost"]);
      }
    });

    if (codecId !== undefined) video.codec = codecs.get(codecId) ?? null;

    // Older Chromium omits the power-efficiency flag but still names the
    // implementation, and its software encoders are recognisable by name.
    if (video.powerEfficient === null && video.implementation !== null) {
      video.powerEfficient = !/libvpx|openh264|ffmpeg|software/i.test(video.implementation);
    }

    return video;
  }

  #lossOverInterval(current: Counters): number | null {
    const previous = this.#previous;
    if (!previous) return null;
    if (current.delivered === undefined || previous.delivered === undefined) return null;
    if (current.lost === undefined || previous.lost === undefined) return null;

    const deltaDelivered = current.delivered - previous.delivered;
    const deltaLost = current.lost - previous.lost;

    // Sent packets already include the ones that went missing; received ones
    // do not, so the denominator differs by direction.
    const total =
      this.#direction === "send" ? deltaDelivered : deltaDelivered + deltaLost;

    // A stalled interval carries no information; reporting 0 would look like
    // a perfectly healthy stream that happens to have stopped.
    if (total <= 0) return null;

    return Math.max(0, deltaLost) / total;
  }

  #bitrateOverInterval(current: Counters): number | null {
    const previous = this.#previous;
    if (!previous) return null;
    if (current.bytes === undefined || previous.bytes === undefined) return null;
    if (current.timestamp === undefined || previous.timestamp === undefined) return null;

    const seconds = (current.timestamp - previous.timestamp) / 1000;
    const deltaBytes = current.bytes - previous.bytes;

    // A counter that went backwards means the sender restarted rather than
    // that the link ran in reverse.
    if (seconds <= 0 || deltaBytes < 0) return null;

    return (deltaBytes * 8) / seconds;
  }
}

function readRoundTripTime(report: RTCStatsReport): number | null {
  let rttMs: number | null = null;
  report.forEach((entry) => {
    const stat = entry as Record<string, unknown>;
    if (stat["type"] !== "candidate-pair" || stat["state"] !== "succeeded") return;
    const rtt = stat["currentRoundTripTime"];
    if (typeof rtt === "number") rttMs = rtt * 1000;
  });
  return rttMs;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
