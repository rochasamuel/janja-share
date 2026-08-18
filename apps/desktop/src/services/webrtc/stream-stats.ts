import type { QualitySample } from "./connection-quality.js";

/**
 * The measurements behind the one-word verdict, in the shape a readout wants.
 *
 * `classifyQuality` deliberately reduces all of this to four words, because a
 * word is what tells someone whether to move closer to the router. These are
 * the numbers underneath it, for the person who does want to look.
 */
export interface StreamStats {
  rttMs: number | null;
  packetLossRatio: number | null;
  bitrateBps: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  codec: string | null;
  powerEfficient: boolean | null;
  implementation: string | null;
}

/**
 * Folds every viewer's sample into one reading.
 *
 * Latency and loss take the worst value rather than the average: averaging
 * would bury the one person whose picture has fallen apart. Bitrate is summed,
 * because six viewers at 4 Mbps is 24 Mbps leaving this machine, and that is
 * the number that explains a saturated uplink.
 */
export function aggregateStats(samples: QualitySample[]): StreamStats | null {
  if (samples.length === 0) return null;

  return {
    rttMs: worst(samples.map((s) => s.rttMs)),
    packetLossRatio: worst(samples.map((s) => s.packetLossRatio)),
    bitrateBps: total(samples.map((s) => s.bitrateBps)),
    frameWidth: worst(samples.map((s) => s.frameWidth)),
    frameHeight: worst(samples.map((s) => s.frameHeight)),
    framesPerSecond: worst(samples.map((s) => s.framesPerSecond)),
    codec: first(samples.map((s) => s.codec)),
    // One viewer falling back to software is the whole story: a GPU with its
    // encoder sessions exhausted hands the rest to the CPU, and that is what a
    // game feels.
    powerEfficient: anyFalse(samples.map((s) => s.powerEfficient)),
    implementation: first(samples.map((s) => s.implementation)),
  };
}

/** "H264 · GPU", or "VP8 · CPU" when something is being encoded in software. */
export function formatEncoder(stats: StreamStats | null): string | null {
  if (!stats) return null;
  if (stats.codec === null && stats.powerEfficient === null) return null;

  const parts: string[] = [];
  if (stats.codec !== null) parts.push(stats.codec);
  if (stats.powerEfficient !== null) parts.push(stats.powerEfficient ? "GPU" : "CPU");

  return parts.join(" · ");
}

/** "1920×1080 · 58 fps" */
export function formatScreen(stats: StreamStats | null): string | null {
  if (!stats) return null;

  const parts: string[] = [];
  if (stats.frameWidth !== null && stats.frameHeight !== null) {
    parts.push(`${Math.round(stats.frameWidth)}×${Math.round(stats.frameHeight)}`);
  }
  if (stats.framesPerSecond !== null) {
    parts.push(`${Math.round(stats.framesPerSecond)} fps`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "42 ms · 0.2% · 4.2 Mbps" */
export function formatNetwork(stats: StreamStats | null): string | null {
  if (!stats) return null;

  const parts: string[] = [];
  if (stats.rttMs !== null) parts.push(`${Math.round(stats.rttMs)} ms`);
  if (stats.packetLossRatio !== null) parts.push(formatPercent(stats.packetLossRatio));
  if (stats.bitrateBps !== null) parts.push(formatRate(stats.bitrateBps));

  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatPercent(ratio: number): string {
  const percent = ratio * 100;
  // A clean link reads better as a flat 0 than as 0.0.
  if (percent === 0) return "0%";
  return `${percent.toFixed(1)}%`;
}

function formatRate(bitsPerSecond: number): string {
  // Below a megabit, one decimal place of Mbps carries no information.
  if (bitsPerSecond < 1_000_000) return `${Math.round(bitsPerSecond / 1000)} kbps`;
  return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
}

/** Largest of the measured values — for latency, loss and picture size alike. */
function worst(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.max(...present) : null;
}

function first(values: (string | null)[]): string | null {
  return values.find((value): value is string => value !== null) ?? null;
}

/** False if any reading says false; null only when nothing was measured. */
function anyFalse(values: (boolean | null)[]): boolean | null {
  const present = values.filter((value): value is boolean => value !== null);
  if (present.length === 0) return null;
  return !present.includes(false);
}

function total(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : null;
}
