import { describe, expect, it } from "vitest";
import { StatsTracker } from "./stats-tracker.js";

/** Minimal stand-in for RTCStatsReport: it only has to be forEach-able. */
function report(entries: Record<string, unknown>[]): RTCStatsReport {
  return {
    forEach(callback: (value: unknown) => void) {
      for (const entry of entries) callback(entry);
    },
  } as unknown as RTCStatsReport;
}

const candidatePair = (rttSeconds: number) => ({
  type: "candidate-pair",
  state: "succeeded",
  currentRoundTripTime: rttSeconds,
});

type Fields = Record<string, number>;

const inboundVideo = (fields: Fields) => ({ type: "inbound-rtp", kind: "video", ...fields });
const outboundVideo = (fields: Fields) => ({ type: "outbound-rtp", kind: "video", ...fields });
const remoteInboundVideo = (fields: Fields) => ({
  type: "remote-inbound-rtp",
  kind: "video",
  ...fields,
});

describe("StatsTracker, either direction", () => {
  it("converts round trip time from seconds to milliseconds", () => {
    const tracker = new StatsTracker("receive");
    const sample = tracker.sample(report([candidatePair(0.042)]), "connected");
    expect(sample.rttMs).toBeCloseTo(42);
  });

  it("ignores candidate pairs that are not the selected one", () => {
    const tracker = new StatsTracker("receive");
    const sample = tracker.sample(
      report([{ type: "candidate-pair", state: "failed", currentRoundTripTime: 9 }]),
      "connected",
    );
    expect(sample.rttMs).toBeNull();
  });

  it("passes the ice state straight through", () => {
    const tracker = new StatsTracker("receive");
    expect(tracker.sample(report([]), "checking").iceState).toBe("checking");
  });

  it("survives a report with nothing useful in it", () => {
    const tracker = new StatsTracker("receive");
    expect(tracker.sample(report([{ type: "transport" }]), "connected")).toEqual({
      rttMs: null,
      packetLossRatio: null,
      framesPerSecond: null,
      bitrateBps: null,
      frameWidth: null,
      frameHeight: null,
      codec: null,
      powerEfficient: null,
      implementation: null,
      qualityLimitation: null,
      iceState: "connected",
    });
  });

  it("forgets its history on reset, so a reconnect starts clean", () => {
    const tracker = new StatsTracker("receive");
    tracker.sample(report([inboundVideo({ packetsReceived: 1000, packetsLost: 0 })]), "connected");
    tracker.reset();
    const afterReset = tracker.sample(
      report([inboundVideo({ packetsReceived: 50, packetsLost: 0 })]),
      "connected",
    );
    expect(afterReset.packetLossRatio).toBeNull();
  });
});

describe("StatsTracker receiving", () => {
  it("reports no loss figure until it has two samples to compare", () => {
    const tracker = new StatsTracker("receive");
    const first = tracker.sample(
      report([inboundVideo({ packetsReceived: 1000, packetsLost: 10 })]),
      "connected",
    );
    expect(first.packetLossRatio).toBeNull();
  });

  it("measures loss over the interval, not since the connection opened", () => {
    const tracker = new StatsTracker("receive");
    // A rough start: 100 of the first 1100 packets were lost.
    tracker.sample(report([inboundVideo({ packetsReceived: 1000, packetsLost: 100 })]), "connected");
    // The interval since then was clean: 1000 more packets, none lost.
    const second = tracker.sample(
      report([inboundVideo({ packetsReceived: 2000, packetsLost: 100 })]),
      "connected",
    );
    expect(second.packetLossRatio).toBe(0);
  });

  it("computes the ratio across the interval's received and lost packets", () => {
    const tracker = new StatsTracker("receive");
    tracker.sample(report([inboundVideo({ packetsReceived: 1000, packetsLost: 0 })]), "connected");
    // 90 arrived, 10 were lost.
    const second = tracker.sample(
      report([inboundVideo({ packetsReceived: 1090, packetsLost: 10 })]),
      "connected",
    );
    expect(second.packetLossRatio).toBeCloseTo(0.1);
  });

  it("returns null when no packets moved at all in the interval", () => {
    const tracker = new StatsTracker("receive");
    tracker.sample(report([inboundVideo({ packetsReceived: 1000, packetsLost: 5 })]), "connected");
    const stalled = tracker.sample(
      report([inboundVideo({ packetsReceived: 1000, packetsLost: 5 })]),
      "connected",
    );
    expect(stalled.packetLossRatio).toBeNull();
  });

  it("picks up the picture it is decoding", () => {
    const tracker = new StatsTracker("receive");
    const sample = tracker.sample(
      report([inboundVideo({ framesPerSecond: 58, frameWidth: 1920, frameHeight: 1080 })]),
      "connected",
    );
    expect(sample.framesPerSecond).toBe(58);
    expect(sample.frameWidth).toBe(1920);
    expect(sample.frameHeight).toBe(1080);
  });

  it("derives bitrate from the bytes that arrived between samples", () => {
    const tracker = new StatsTracker("receive");
    tracker.sample(report([inboundVideo({ bytesReceived: 0, timestamp: 1000 })]), "connected");
    // 500 kB over two seconds is 2 Mbps.
    const second = tracker.sample(
      report([inboundVideo({ bytesReceived: 500_000, timestamp: 3000 })]),
      "connected",
    );
    expect(second.bitrateBps).toBeCloseTo(2_000_000);
  });

  it("has no bitrate to report on the first sample", () => {
    const tracker = new StatsTracker("receive");
    const first = tracker.sample(
      report([inboundVideo({ bytesReceived: 500_000, timestamp: 1000 })]),
      "connected",
    );
    expect(first.bitrateBps).toBeNull();
  });

  it("refuses to divide by an interval of no time", () => {
    const tracker = new StatsTracker("receive");
    tracker.sample(report([inboundVideo({ bytesReceived: 0, timestamp: 1000 })]), "connected");
    const same = tracker.sample(
      report([inboundVideo({ bytesReceived: 500_000, timestamp: 1000 })]),
      "connected",
    );
    expect(same.bitrateBps).toBeNull();
  });

  it("does not read the sending side's numbers", () => {
    const tracker = new StatsTracker("receive");
    const sample = tracker.sample(
      report([outboundVideo({ framesPerSecond: 30, frameWidth: 640, frameHeight: 480 })]),
      "connected",
    );
    expect(sample.framesPerSecond).toBeNull();
    expect(sample.frameWidth).toBeNull();
  });
});

describe("StatsTracker, the encoder in use", () => {
  // The one reading that explains a busy CPU: H.264 has a hardware encoder on
  // essentially every Windows machine, VP8 has one nowhere, and the sharer
  // runs one encoder per viewer.

  const codecEntry = (id: string, mimeType: string) => ({ type: "codec", id, mimeType });

  it("resolves the codec the rtp entry points at", () => {
    const tracker = new StatsTracker("send");
    const sample = tracker.sample(
      report([
        codecEntry("codec-1", "video/H264"),
        codecEntry("codec-2", "video/VP8"),
        { ...outboundVideo({}), codecId: "codec-1" },
      ]),
      "connected",
    );
    expect(sample.codec).toBe("H264");
  });

  it("reports hardware encoding when the browser says so", () => {
    const tracker = new StatsTracker("send");
    const sample = tracker.sample(
      report([
        { ...outboundVideo({}), powerEfficientEncoder: true, encoderImplementation: "ExternalEncoder" },
      ]),
      "connected",
    );
    expect(sample.powerEfficient).toBe(true);
    expect(sample.implementation).toBe("ExternalEncoder");
  });

  it("reports why the encoder is holding back, which is the whole diagnosis", () => {
    // "cpu" and "bandwidth" call for opposite responses, and without this the
    // two are indistinguishable from the outside: both read as a low frame
    // rate that a restart appears to cure.
    const tracker = new StatsTracker("send");
    const sample = tracker.sample(
      report([{ ...outboundVideo({}), qualityLimitationReason: "cpu" }]),
      "connected",
    );
    expect(sample.qualityLimitation).toBe("cpu");
  });

  it("treats an unlimited encoder as nothing to report", () => {
    const tracker = new StatsTracker("send");
    const sample = tracker.sample(
      report([{ ...outboundVideo({}), qualityLimitationReason: "none" }]),
      "connected",
    );
    expect(sample.qualityLimitation).toBeNull();
  });

  it("reports software encoding, which is the case worth catching", () => {
    const tracker = new StatsTracker("send");
    const sample = tracker.sample(
      report([{ ...outboundVideo({}), powerEfficientEncoder: false }]),
      "connected",
    );
    expect(sample.powerEfficient).toBe(false);
  });

  it("infers software from the implementation name when the flag is missing", () => {
    // Older Chromium omits powerEfficientEncoder but still names the encoder.
    const tracker = new StatsTracker("send");
    const sample = tracker.sample(
      report([{ ...outboundVideo({}), encoderImplementation: "libvpx" }]),
      "connected",
    );
    expect(sample.powerEfficient).toBe(false);
  });

  it("does not guess when it has neither flag nor name", () => {
    const tracker = new StatsTracker("send");
    expect(tracker.sample(report([outboundVideo({})]), "connected").powerEfficient).toBeNull();
  });

  it("reads the decoder on the watching end", () => {
    const tracker = new StatsTracker("receive");
    const sample = tracker.sample(
      report([
        { ...inboundVideo({}), decoderImplementation: "ExternalDecoder", powerEfficientDecoder: true },
      ]),
      "connected",
    );
    expect(sample.implementation).toBe("ExternalDecoder");
    expect(sample.powerEfficient).toBe(true);
  });
});

describe("StatsTracker sending", () => {
  // The sharer's connection carries no inbound video at all. Reading
  // inbound-rtp here — which is what the tracker used to do in both
  // directions — left frame rate and loss permanently null, so a sharer's
  // quality was graded on round trip time alone.

  it("picks up the picture it is encoding", () => {
    const tracker = new StatsTracker("send");
    const sample = tracker.sample(
      report([outboundVideo({ framesPerSecond: 58, frameWidth: 1920, frameHeight: 1080 })]),
      "connected",
    );
    expect(sample.framesPerSecond).toBe(58);
    expect(sample.frameWidth).toBe(1920);
    expect(sample.frameHeight).toBe(1080);
  });

  it("takes loss from what the far end reports back", () => {
    const tracker = new StatsTracker("send");
    tracker.sample(
      report([outboundVideo({ packetsSent: 1000 }), remoteInboundVideo({ packetsLost: 0 })]),
      "connected",
    );
    // 100 more went out, and the receiver says 10 of them never arrived.
    const second = tracker.sample(
      report([outboundVideo({ packetsSent: 1100 }), remoteInboundVideo({ packetsLost: 10 })]),
      "connected",
    );
    expect(second.packetLossRatio).toBeCloseTo(0.1);
  });

  it("reports no loss while the far end has said nothing yet", () => {
    const tracker = new StatsTracker("send");
    tracker.sample(report([outboundVideo({ packetsSent: 1000 })]), "connected");
    const second = tracker.sample(report([outboundVideo({ packetsSent: 1100 })]), "connected");
    expect(second.packetLossRatio).toBeNull();
  });

  it("derives bitrate from the bytes that went out between samples", () => {
    const tracker = new StatsTracker("send");
    tracker.sample(report([outboundVideo({ bytesSent: 0, timestamp: 1000 })]), "connected");
    const second = tracker.sample(
      report([outboundVideo({ bytesSent: 1_000_000, timestamp: 3000 })]),
      "connected",
    );
    expect(second.bitrateBps).toBeCloseTo(4_000_000);
  });

  it("does not read the receiving side's numbers", () => {
    // A sharer that also received audio must not have its video figures taken
    // from whatever inbound entry happens to be in the report.
    const tracker = new StatsTracker("send");
    const sample = tracker.sample(
      report([inboundVideo({ framesPerSecond: 30, frameWidth: 640, frameHeight: 480 })]),
      "connected",
    );
    expect(sample.framesPerSecond).toBeNull();
    expect(sample.frameWidth).toBeNull();
  });

  it("survives a counter that went backwards after a renegotiation", () => {
    const tracker = new StatsTracker("send");
    tracker.sample(report([outboundVideo({ bytesSent: 900_000, timestamp: 1000 })]), "connected");
    const restarted = tracker.sample(
      report([outboundVideo({ bytesSent: 10_000, timestamp: 3000 })]),
      "connected",
    );
    expect(restarted.bitrateBps).toBeNull();
  });
});
