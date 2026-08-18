import { describe, expect, it } from "vitest";
import type { QualitySample } from "./connection-quality.js";
import {
  aggregateStats,
  formatEncoder,
  formatLimit,
  formatNetwork,
  formatScreen,
  type StreamStats,
} from "./stream-stats.js";

function sample(fields: Partial<QualitySample>): QualitySample {
  return {
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
    ...fields,
  };
}

const nothing: StreamStats = {
  rttMs: null,
  packetLossRatio: null,
  bitrateBps: null,
  frameWidth: null,
  frameHeight: null,
  framesPerSecond: null,
  codec: null,
  powerEfficient: null,
  implementation: null,
  qualityLimitation: null,
};

describe("aggregateStats", () => {
  it("has nothing to say about no viewers at all", () => {
    expect(aggregateStats([])).toBeNull();
  });

  it("passes a single sample through", () => {
    const stats = aggregateStats([
      sample({ rttMs: 42, packetLossRatio: 0.002, bitrateBps: 4_200_000, framesPerSecond: 58 }),
    ]);
    expect(stats).toMatchObject({ rttMs: 42, packetLossRatio: 0.002, bitrateBps: 4_200_000 });
  });

  it("reports the worst latency across viewers, not the average", () => {
    // Averaging would hide the one person whose picture is unusable.
    const stats = aggregateStats([sample({ rttMs: 40 }), sample({ rttMs: 320 })]);
    expect(stats?.rttMs).toBe(320);
  });

  it("reports the worst loss across viewers", () => {
    const stats = aggregateStats([
      sample({ packetLossRatio: 0 }),
      sample({ packetLossRatio: 0.08 }),
    ]);
    expect(stats?.packetLossRatio).toBe(0.08);
  });

  it("adds bitrates up, because that is what the uplink is carrying", () => {
    const stats = aggregateStats([
      sample({ bitrateBps: 2_000_000 }),
      sample({ bitrateBps: 3_000_000 }),
    ]);
    expect(stats?.bitrateBps).toBe(5_000_000);
  });

  it("takes the best picture any viewer is being sent", () => {
    const stats = aggregateStats([
      sample({ frameWidth: 1280, frameHeight: 720, framesPerSecond: 24 }),
      sample({ frameWidth: 1920, frameHeight: 1080, framesPerSecond: 58 }),
    ]);
    expect(stats).toMatchObject({ frameWidth: 1920, frameHeight: 1080, framesPerSecond: 58 });
  });

  it("keeps a figure that only one viewer has managed to measure", () => {
    const stats = aggregateStats([sample({ rttMs: null }), sample({ rttMs: 55 })]);
    expect(stats?.rttMs).toBe(55);
  });

  it("stays null where nothing has been measured yet", () => {
    expect(aggregateStats([sample({}), sample({})])).toEqual(nothing);
  });
});

describe("aggregateStats, the encoder", () => {
  it("names the codec every viewer shares", () => {
    const stats = aggregateStats([sample({ codec: "H264" }), sample({ codec: "H264" })]);
    expect(stats?.codec).toBe("H264");
  });

  it("calls the whole share software the moment one viewer falls back", () => {
    // A GPU with its encoder sessions exhausted hands the overflow to the CPU.
    // Reporting the majority would hide exactly the case that costs frames.
    const stats = aggregateStats([
      sample({ powerEfficient: true }),
      sample({ powerEfficient: true }),
      sample({ powerEfficient: false }),
    ]);
    expect(stats?.powerEfficient).toBe(false);
  });

  it("stays hardware while every viewer is", () => {
    const stats = aggregateStats([
      sample({ powerEfficient: true }),
      sample({ powerEfficient: true }),
    ]);
    expect(stats?.powerEfficient).toBe(true);
  });
});

describe("formatEncoder", () => {
  it("says nothing before anything has been measured", () => {
    expect(formatEncoder(null)).toBeNull();
    expect(formatEncoder(nothing)).toBeNull();
  });

  it("puts the codec next to where it runs", () => {
    expect(formatEncoder({ ...nothing, codec: "H264", powerEfficient: true })).toBe("H264 · GPU");
  });

  it("spells out the expensive case", () => {
    expect(formatEncoder({ ...nothing, codec: "VP8", powerEfficient: false })).toBe("VP8 · CPU");
  });

  it("shows the codec alone when efficiency is unknown", () => {
    expect(formatEncoder({ ...nothing, codec: "VP9" })).toBe("VP9");
  });
});

describe("quality limitation", () => {
  it("surfaces the reason one viewer's encoder is holding back", () => {
    const stats = aggregateStats([sample({ qualityLimitation: "bandwidth" })]);
    expect(stats?.qualityLimitation).toBe("bandwidth");
  });

  it("reports a limit that applies to anyone, not only to everyone", () => {
    // One viewer starved is the story. Requiring all of them to agree would
    // hide exactly the case that is going wrong.
    const stats = aggregateStats([
      sample({ qualityLimitation: null }),
      sample({ qualityLimitation: "cpu" }),
    ]);
    expect(stats?.qualityLimitation).toBe("cpu");
  });

  it("says nothing when nothing is holding the encoder back", () => {
    const stats = aggregateStats([sample({}), sample({})]);
    expect(stats?.qualityLimitation).toBeNull();
  });

  it("names the two causes a person can act on differently", () => {
    expect(formatLimit({ ...nothing, qualityLimitation: "cpu" })).toContain("CPU");
    expect(formatLimit({ ...nothing, qualityLimitation: "bandwidth" })).toContain("banda");
  });

  it("stays absent when there is nothing wrong to report", () => {
    expect(formatLimit(nothing)).toBeNull();
    expect(formatLimit(null)).toBeNull();
  });
});

describe("formatScreen", () => {
  it("says nothing when there is nothing to say", () => {
    expect(formatScreen(null)).toBeNull();
    expect(formatScreen(nothing)).toBeNull();
  });

  it("puts the picture size next to its frame rate", () => {
    expect(
      formatScreen({ ...nothing, frameWidth: 1920, frameHeight: 1080, framesPerSecond: 58 }),
    ).toBe("1920×1080 · 58 fps");
  });

  it("rounds a fractional frame rate to something readable", () => {
    expect(formatScreen({ ...nothing, framesPerSecond: 29.97 })).toBe("30 fps");
  });

  it("shows the size alone before the first frame rate arrives", () => {
    expect(formatScreen({ ...nothing, frameWidth: 1280, frameHeight: 720 })).toBe("1280×720");
  });
});

describe("formatNetwork", () => {
  it("says nothing when there is nothing to say", () => {
    expect(formatNetwork(null)).toBeNull();
    expect(formatNetwork(nothing)).toBeNull();
  });

  it("reads latency, loss and rate in that order", () => {
    expect(
      formatNetwork({ ...nothing, rttMs: 42.4, packetLossRatio: 0.002, bitrateBps: 4_200_000 }),
    ).toBe("42 ms · 0.2% · 4.2 Mbps");
  });

  it("writes a clean link as a flat zero rather than 0.0%", () => {
    expect(formatNetwork({ ...nothing, packetLossRatio: 0 })).toBe("0%");
  });

  it("drops to kbps below a megabit, where one decimal of a Mbps says nothing", () => {
    expect(formatNetwork({ ...nothing, bitrateBps: 820_000 })).toBe("820 kbps");
  });

  it("leaves out whatever has not been measured", () => {
    expect(formatNetwork({ ...nothing, rttMs: 38 })).toBe("38 ms");
  });
});
