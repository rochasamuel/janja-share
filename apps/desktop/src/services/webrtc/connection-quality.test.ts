import { describe, expect, it } from "vitest";
import { classifyQuality, type QualitySample } from "./connection-quality.js";

const sample = (overrides: Partial<QualitySample> = {}): QualitySample => ({
  rttMs: 40,
  packetLossRatio: 0,
  framesPerSecond: 60,
  // Grading ignores these three; they are carried for the readouts only.
  bitrateBps: 4_000_000,
  frameWidth: 1920,
  frameHeight: 1080,
  codec: "H264",
  powerEfficient: true,
  implementation: "ExternalEncoder",
  iceState: "connected",
  ...overrides,
});

describe("classifyQuality", () => {
  it("grades a healthy connection excellent", () => {
    expect(classifyQuality(sample())).toBe("excellent");
  });

  it("reports reconnecting whenever the transport is down", () => {
    for (const iceState of ["disconnected", "failed", "closed"] as const) {
      expect(classifyQuality(sample({ iceState }))).toBe("reconnecting");
    }
  });

  it("ignores good-looking numbers when the transport is down", () => {
    expect(classifyQuality(sample({ rttMs: 5, iceState: "failed" }))).toBe("reconnecting");
  });

  it("downgrades on latency alone", () => {
    expect(classifyQuality(sample({ rttMs: 150 }))).toBe("good");
    expect(classifyQuality(sample({ rttMs: 400 }))).toBe("poor");
  });

  it("downgrades on packet loss alone", () => {
    expect(classifyQuality(sample({ packetLossRatio: 0.02 }))).toBe("good");
    expect(classifyQuality(sample({ packetLossRatio: 0.12 }))).toBe("poor");
  });

  it("downgrades on frame rate alone", () => {
    expect(classifyQuality(sample({ framesPerSecond: 20 }))).toBe("good");
    expect(classifyQuality(sample({ framesPerSecond: 4 }))).toBe("poor");
  });

  it("takes the worst dimension rather than an average", () => {
    // Perfect latency and frame rate must not mask a third of the packets
    // going missing.
    expect(classifyQuality(sample({ rttMs: 10, framesPerSecond: 60, packetLossRatio: 0.3 })))
      .toBe("poor");
  });

  it("stays optimistic before the first measurement arrives", () => {
    const fresh = sample({ rttMs: null, packetLossRatio: null, framesPerSecond: null });
    expect(classifyQuality(fresh)).toBe("good");
  });

  it("treats a still-negotiating connection with no data as reconnecting", () => {
    const negotiating = sample({
      rttMs: null,
      packetLossRatio: null,
      framesPerSecond: null,
      iceState: "checking",
    });
    expect(classifyQuality(negotiating)).toBe("reconnecting");
  });

  it("grades on whatever dimensions are available", () => {
    expect(classifyQuality(sample({ rttMs: null, framesPerSecond: null, packetLossRatio: 0.2 })))
      .toBe("poor");
  });
});
