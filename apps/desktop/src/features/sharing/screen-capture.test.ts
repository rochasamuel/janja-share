import { describe, expect, it, vi } from "vitest";
import {
  CaptureCancelledError,
  CaptureUnavailableError,
  onCaptureEnded,
  startCapture,
  stopCapture,
} from "./screen-capture.js";

function makeTrack(kind: "video" | "audio", label = "") {
  const listeners = new Map<string, (() => void)[]>();
  return {
    kind,
    label,
    contentHint: "",
    stopped: false,
    stop() {
      this.stopped = true;
    },
    addEventListener(type: string, handler: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    removeEventListener(type: string, handler: () => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter((h) => h !== handler));
    },
    emit(type: string) {
      for (const handler of listeners.get(type) ?? []) handler();
    },
  };
}

function makeStream(initial: ReturnType<typeof makeTrack>[]) {
  const tracks = [...initial];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    addTrack: (track: ReturnType<typeof makeTrack>) => tracks.push(track),
    removeTrack: (track: ReturnType<typeof makeTrack>) => {
      const index = tracks.indexOf(track);
      if (index >= 0) tracks.splice(index, 1);
    },
  } as unknown as MediaStream;
}

describe("startCapture", () => {
  it("asks for 1080p60 as a preference rather than a requirement", async () => {
    const getDisplayMedia = vi.fn(async (_constraints: DisplayMediaStreamOptions) =>
      makeStream([makeTrack("video")]),
    );
    await startCapture({ getDisplayMedia });

    const constraints = getDisplayMedia.mock.calls[0]![0] as unknown as Record<string, any>;
    expect(constraints["video"].width).toEqual({ ideal: 1920 });
    expect(constraints["video"].frameRate).toEqual({ ideal: 60 });
    // `exact` would fail outright on a monitor that cannot match it.
    expect(JSON.stringify(constraints)).not.toContain("exact");
  });

  it("asks the picker to offer system sound", async () => {
    const getDisplayMedia = vi.fn(async (_constraints: DisplayMediaStreamOptions) =>
      makeStream([makeTrack("video")]),
    );
    await startCapture({ getDisplayMedia });

    const constraints = getDisplayMedia.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(constraints["audio"]).toBe(true);
    expect(constraints["systemAudio"]).toBe("include");
  });

  it("marks the track as detail so text stays readable", async () => {
    const video = makeTrack("video");
    const { stream } = await startCapture({ getDisplayMedia: async () => makeStream([video]) });

    expect(video.contentHint).toBe("detail");
    expect(stream).toBeDefined();
  });

  it("falls back to system audio when per-app capture is unavailable", async () => {
    const withSound = await startCapture({
      getDisplayMedia: async () => makeStream([makeTrack("video"), makeTrack("audio")]),
      startAppAudio: async () => {
        throw new Error("needs windows 11");
      },
    });
    expect(withSound.audioSource).toBe("system");
    expect(withSound.audioNote).toContain("windows 11");
  });

  it("reports no audio at all when neither path works", async () => {
    const silent = await startCapture({
      getDisplayMedia: async () => makeStream([makeTrack("video")]),
      startAppAudio: async () => {
        throw new Error("whole screen");
      },
    });
    expect(silent.audioSource).toBe("none");
  });

  it("treats a cancelled picker as a decision, not a failure", async () => {
    for (const name of ["NotAllowedError", "AbortError"]) {
      const error = new Error("cancelled");
      error.name = name;
      await expect(
        startCapture({
          getDisplayMedia: async () => {
            throw error;
          },
        }),
      ).rejects.toBeInstanceOf(CaptureCancelledError);
    }
  });

  it("reports a genuine capture failure as unavailable", async () => {
    const error = new Error("device in use");
    error.name = "NotReadableError";

    await expect(
      startCapture({
        getDisplayMedia: async () => {
          throw error;
        },
      }),
    ).rejects.toBeInstanceOf(CaptureUnavailableError);
  });

  it("refuses a stream that carries no video and releases what it got", async () => {
    const audio = makeTrack("audio");
    await expect(
      startCapture({ getDisplayMedia: async () => makeStream([audio]) }),
    ).rejects.toBeInstanceOf(CaptureUnavailableError);
    expect(audio.stopped).toBe(true);
  });
});

describe("onCaptureEnded", () => {
  it("fires when Windows' own stop button ends the track", async () => {
    const video = makeTrack("video");
    const stream = makeStream([video]);
    const onEnded = vi.fn();

    onCaptureEnded(stream, onEnded);
    video.emit("ended");

    expect(onEnded).toHaveBeenCalledOnce();
  });

  it("stops listening once unsubscribed", () => {
    const video = makeTrack("video");
    const onEnded = vi.fn();

    const unsubscribe = onCaptureEnded(makeStream([video]), onEnded);
    unsubscribe();
    video.emit("ended");

    expect(onEnded).not.toHaveBeenCalled();
  });
});

describe("stopCapture", () => {
  it("stops every track", () => {
    const video = makeTrack("video");
    const audio = makeTrack("audio");
    stopCapture(makeStream([video, audio]));

    expect(video.stopped).toBe(true);
    expect(audio.stopped).toBe(true);
  });

  it("tolerates being called with nothing", () => {
    expect(() => stopCapture(undefined)).not.toThrow();
  });
});

describe("per-application audio", () => {
  const appTrack = () => makeTrack("audio");

  it("replaces the system mix with the app's own audio", async () => {
    const systemAudio = makeTrack("audio");
    const perApp = appTrack();

    const result = await startCapture({
      getDisplayMedia: async () => makeStream([makeTrack("video"), systemAudio]),
      startAppAudio: async () => ({
        track: perApp as unknown as MediaStreamTrack,
        process: "Discord.exe",
        stop: async () => {},
      }),
    });

    expect(result.audioSource).toBe("app");
    expect(result.audioProcess).toBe("Discord.exe");
    // The system mix has to be stopped, not merely unused: leaving it running
    // would put the voice call back into the stream.
    expect(systemAudio.stopped).toBe(true);
  });

  it("passes the shared window's label through so Rust can find the process", async () => {
    let seen: string | undefined;
    await startCapture({
      getDisplayMedia: async () => makeStream([makeTrack("video", "window:1051672:0")]),
      startAppAudio: async (label) => {
        seen = label;
        return { track: appTrack() as unknown as MediaStreamTrack, process: "x", stop: async () => {} };
      },
    });
    expect(seen).toBe("window:1051672:0");
  });

  it("hands back a way to release the native capture", async () => {
    let stopped = false;
    const result = await startCapture({
      getDisplayMedia: async () => makeStream([makeTrack("video")]),
      startAppAudio: async () => ({
        track: appTrack() as unknown as MediaStreamTrack,
        process: "x",
        stop: async () => {
          stopped = true;
        },
      }),
    });

    await result.stopAudio?.();
    expect(stopped).toBe(true);
  });

  it("can be told to skip per-app capture entirely", async () => {
    const result = await startCapture({
      getDisplayMedia: async () => makeStream([makeTrack("video"), makeTrack("audio")]),
      preferAppAudio: false,
      startAppAudio: async () => {
        throw new Error("should not be called");
      },
    });
    expect(result.audioSource).toBe("system");
  });
});
