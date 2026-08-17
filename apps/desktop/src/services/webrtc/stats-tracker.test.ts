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

const inboundVideo = (packetsReceived: number, packetsLost: number, fps = 60) => ({
  type: "inbound-rtp",
  kind: "video",
  packetsReceived,
  packetsLost,
  framesPerSecond: fps,
});

describe("StatsTracker", () => {
  it("converts round trip time from seconds to milliseconds", () => {
    const tracker = new StatsTracker();
    const sample = tracker.sample(report([candidatePair(0.042)]), "connected");
    expect(sample.rttMs).toBeCloseTo(42);
  });

  it("ignores candidate pairs that are not the selected one", () => {
    const tracker = new StatsTracker();
    const sample = tracker.sample(
      report([{ type: "candidate-pair", state: "failed", currentRoundTripTime: 9 }]),
      "connected",
    );
    expect(sample.rttMs).toBeNull();
  });

  it("reports no loss figure until it has two samples to compare", () => {
    const tracker = new StatsTracker();
    const first = tracker.sample(report([inboundVideo(1000, 10)]), "connected");
    expect(first.packetLossRatio).toBeNull();
  });

  it("measures loss over the interval, not since the connection opened", () => {
    const tracker = new StatsTracker();
    // A rough start: 100 of the first 1100 packets were lost.
    tracker.sample(report([inboundVideo(1000, 100)]), "connected");
    // The interval since then was clean: 1000 more packets, none lost.
    const second = tracker.sample(report([inboundVideo(2000, 100)]), "connected");
    expect(second.packetLossRatio).toBe(0);
  });

  it("computes the ratio across the interval's received and lost packets", () => {
    const tracker = new StatsTracker();
    tracker.sample(report([inboundVideo(1000, 0)]), "connected");
    // 90 arrived, 10 were lost.
    const second = tracker.sample(report([inboundVideo(1090, 10)]), "connected");
    expect(second.packetLossRatio).toBeCloseTo(0.1);
  });

  it("returns null when no packets moved at all in the interval", () => {
    const tracker = new StatsTracker();
    tracker.sample(report([inboundVideo(1000, 5)]), "connected");
    const stalled = tracker.sample(report([inboundVideo(1000, 5)]), "connected");
    expect(stalled.packetLossRatio).toBeNull();
  });

  it("picks up frame rate and ice state", () => {
    const tracker = new StatsTracker();
    const sample = tracker.sample(report([inboundVideo(10, 0, 58)]), "checking");
    expect(sample.framesPerSecond).toBe(58);
    expect(sample.iceState).toBe("checking");
  });

  it("survives a report with nothing useful in it", () => {
    const tracker = new StatsTracker();
    const sample = tracker.sample(report([{ type: "transport" }]), "connected");
    expect(sample).toEqual({
      rttMs: null,
      packetLossRatio: null,
      framesPerSecond: null,
      iceState: "connected",
    });
  });

  it("forgets its history on reset, so a reconnect starts clean", () => {
    const tracker = new StatsTracker();
    tracker.sample(report([inboundVideo(1000, 0)]), "connected");
    tracker.reset();
    const afterReset = tracker.sample(report([inboundVideo(50, 0)]), "connected");
    expect(afterReset.packetLossRatio).toBeNull();
  });
});
