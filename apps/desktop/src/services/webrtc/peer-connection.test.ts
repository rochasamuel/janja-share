import { describe, expect, it } from "vitest";
import { rankVideoCodecs } from "./peer-connection.js";

/** Chromium's real capability list, in the order it actually reports it. */
const fmtp = (mode: 0 | 1, plid: string) =>
  `level-asymmetry-allowed=1;packetization-mode=${mode};profile-level-id=${plid}`;

const CHROMIUM: RTCRtpCodec[] = [
  { mimeType: "video/VP8", clockRate: 90000 },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: fmtp(1, "42001f") },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: fmtp(0, "42001f") },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: fmtp(1, "42e01f") },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: fmtp(1, "4d001f") },
  { mimeType: "video/H264", clockRate: 90000, sdpFmtpLine: fmtp(1, "640032") },
  { mimeType: "video/VP9", clockRate: 90000 },
  { mimeType: "video/AV1", clockRate: 90000 },
];

const profileOf = (codec: RTCRtpCodec | undefined) =>
  /profile-level-id=([0-9a-f]{6})/i.exec(codec?.sdpFmtpLine ?? "")?.[1];

describe("rankVideoCodecs", () => {
  it("puts H.264 High first, not whatever Chromium listed first", () => {
    // The bug this exists to prevent: filtering on the mime type alone leaves
    // Chromium's own order intact, and Chromium lists Baseline first — which
    // is how every share this app sent went out as Constrained Baseline.
    const ranked = rankVideoCodecs(CHROMIUM);

    expect(ranked[0]?.mimeType).toBe("video/H264");
    expect(profileOf(ranked[0])).toBe("640032");
  });

  it("orders the H.264 profiles High, then Main, then Baseline", () => {
    const profiles = rankVideoCodecs(CHROMIUM)
      .filter((codec) => codec.mimeType === "video/H264")
      .map((codec) => profileOf(codec)?.slice(0, 2));

    expect(profiles).toEqual(["64", "4d", "42", "42", "42"]);
  });

  it("prefers packetization-mode 1 within the same profile", () => {
    const baseline = rankVideoCodecs(CHROMIUM).filter((codec) =>
      profileOf(codec)?.startsWith("42"),
    );

    expect(baseline[0]?.sdpFmtpLine).toContain("packetization-mode=1");
  });

  it("keeps VP9 as the fallback, ahead of VP8", () => {
    const ranked = rankVideoCodecs(CHROMIUM).map((codec) => codec.mimeType);

    expect(ranked.indexOf("video/VP9")).toBeLessThan(ranked.indexOf("video/VP8"));
  });

  it("puts AV1 last: it could not hold 1080p60 on the hardware we ship to", () => {
    expect(rankVideoCodecs(CHROMIUM).at(-1)?.mimeType).toBe("video/AV1");
  });

  it("keeps every codec it was given, dropping none", () => {
    const ranked = rankVideoCodecs(CHROMIUM);

    expect(ranked).toHaveLength(CHROMIUM.length);
    for (const codec of CHROMIUM) expect(ranked).toContain(codec);
  });

  it("ranks an unknown H.264 profile below every profile we have measured", () => {
    const exotic: RTCRtpCodec = {
      mimeType: "video/H264",
      clockRate: 90000,
      sdpFmtpLine: fmtp(1, "f4001f"),
    };

    const h264 = rankVideoCodecs([exotic, ...CHROMIUM]).filter(
      (codec) => codec.mimeType === "video/H264",
    );

    expect(h264.at(-1)).toBe(exotic);
  });

  it("survives a codec carrying no fmtp line at all", () => {
    const bare: RTCRtpCodec = { mimeType: "video/H264", clockRate: 90000 };

    expect(() => rankVideoCodecs([bare, ...CHROMIUM])).not.toThrow();
    expect(profileOf(rankVideoCodecs([bare, ...CHROMIUM])[0])).toBe("640032");
  });

  it("returns an empty list unchanged", () => {
    expect(rankVideoCodecs([])).toEqual([]);
  });
});
