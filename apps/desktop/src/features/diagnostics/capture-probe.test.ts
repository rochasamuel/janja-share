import { describe, expect, it } from "vitest";
import { probeCapture, summarize } from "./capture-probe.js";

function track(kind: "video" | "audio", label: string, settings: Record<string, unknown> = {}) {
  let stopped = false;
  return {
    kind,
    label,
    getSettings: () => settings,
    stop: () => {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
  };
}

function stream(tracks: ReturnType<typeof track>[]) {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  } as unknown as MediaStream;
}

const deps = (getDisplayMedia: () => Promise<MediaStream>) => ({
  getDisplayMedia,
  getVideoCodecs: () => ["video/H264", "video/VP9"],
  userAgent: "test-agent",
});

describe("probeCapture", () => {
  it("reports the negotiated video settings", async () => {
    const video = track("video", "Screen 1", { width: 1920, height: 1080, frameRate: 60 });
    const result = await probeCapture(deps(async () => stream([video])));

    expect(result.ok).toBe(true);
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.frameRate).toBe(60);
  });

  it("flags the presence of a system audio track", async () => {
    const withAudio = await probeCapture(
      deps(async () => stream([track("video", "Screen 1"), track("audio", "System Audio")])),
    );
    expect(withAudio.hasSystemAudio).toBe(true);

    const withoutAudio = await probeCapture(deps(async () => stream([track("video", "Window")])));
    expect(withoutAudio.hasSystemAudio).toBe(false);
  });

  it("stops every track, so probing never leaves a capture running", async () => {
    const video = track("video", "Screen 1");
    const audio = track("audio", "System Audio");
    await probeCapture(deps(async () => stream([video, audio])));

    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(true);
  });

  it("distinguishes a denied permission from a cancelled picker", async () => {
    const denied = await probeCapture(
      deps(async () => {
        const error = new Error("permission denied");
        error.name = "NotAllowedError";
        throw error;
      }),
    );
    expect(denied.ok).toBe(false);
    expect(denied.permissionLikelyDenied).toBe(true);

    const other = await probeCapture(
      deps(async () => {
        const error = new Error("device busy");
        error.name = "NotReadableError";
        throw error;
      }),
    );
    expect(other.permissionLikelyDenied).toBe(false);
  });

  it("does not throw when capture fails", async () => {
    const result = await probeCapture(
      deps(async () => {
        throw new Error("boom");
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorMessage).toBe("boom");
  });

  it("summarizes a successful probe in a form worth pasting into RESULTS.md", async () => {
    const result = await probeCapture(
      deps(async () =>
        stream([
          track("video", "Screen 1", { width: 1920, height: 1080, frameRate: 59.94 }),
          track("audio", "System Audio"),
        ]),
      ),
    );

    const text = summarize(result);
    expect(text).toContain("picker shown:      yes");
    expect(text).toContain("1920x1080 @ 60 fps");
    expect(text).toContain("h264 available:    yes");
    expect(text).not.toContain("no system audio");
  });

  it("calls out missing system audio in the summary", async () => {
    const result = await probeCapture(deps(async () => stream([track("video", "Window")])));
    expect(summarize(result)).toContain("no system audio");
  });
});
