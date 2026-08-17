import type { QualitySample } from "./connection-quality.js";

interface Counters {
  packetsReceived: number;
  packetsLost: number;
}

/**
 * Reduces an RTCStatsReport to the handful of numbers we grade on.
 *
 * Packet loss is measured over the interval between samples, not since the
 * connection opened. A cumulative ratio would be dominated by whatever
 * happened during setup and would barely move afterwards, so a stream that
 * went bad thirty seconds ago would still read as healthy.
 */
export class StatsTracker {
  #previous: Counters | undefined;

  sample(report: RTCStatsReport, iceState: RTCIceConnectionState): QualitySample {
    let rttMs: number | null = null;
    let framesPerSecond: number | null = null;
    let packetsReceived: number | undefined;
    let packetsLost: number | undefined;

    report.forEach((entry) => {
      const stat = entry as Record<string, unknown>;

      if (stat["type"] === "candidate-pair" && stat["state"] === "succeeded") {
        const rtt = stat["currentRoundTripTime"];
        if (typeof rtt === "number") rttMs = rtt * 1000;
      }

      if (stat["type"] === "inbound-rtp" && stat["kind"] === "video") {
        const fps = stat["framesPerSecond"];
        if (typeof fps === "number") framesPerSecond = fps;

        const received = stat["packetsReceived"];
        const lost = stat["packetsLost"];
        if (typeof received === "number") packetsReceived = received;
        if (typeof lost === "number") packetsLost = lost;
      }
    });

    const packetLossRatio = this.#lossOverInterval(packetsReceived, packetsLost);

    return { rttMs, packetLossRatio, framesPerSecond, iceState };
  }

  #lossOverInterval(received: number | undefined, lost: number | undefined): number | null {
    if (received === undefined || lost === undefined) return null;

    const previous = this.#previous;
    this.#previous = { packetsReceived: received, packetsLost: lost };
    if (!previous) return null;

    const deltaReceived = received - previous.packetsReceived;
    const deltaLost = lost - previous.packetsLost;
    const total = deltaReceived + deltaLost;

    // A stalled interval carries no information; reporting 0 would look like
    // a perfectly healthy stream that happens to have stopped.
    if (total <= 0) return null;

    return Math.max(0, deltaLost) / total;
  }

  reset(): void {
    this.#previous = undefined;
  }
}
