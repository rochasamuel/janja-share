import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@janja/signaling-protocol";
import { QUALITY_PRESETS } from "../../services/settings.js";
import { SharingManager } from "./sharing-manager.js";

/** Records what capture was asked for, and what it was later asked to change to. */
function fakeCapture() {
  const applied: MediaTrackConstraints[] = [];
  const videoTrack = {
    kind: "video",
    contentHint: "",
    label: "Screen 1",
    applyConstraints: vi.fn(async (constraints: MediaTrackConstraints) => {
      applied.push(constraints);
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    stop: () => {},
  };
  const stream = {
    getTracks: () => [videoTrack],
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [],
    addTrack: () => {},
    removeTrack: () => {},
  } as unknown as MediaStream;

  const requested: DisplayMediaStreamOptions[] = [];
  return {
    applied,
    requested,
    videoTrack,
    options: {
      getDisplayMedia: async (constraints: DisplayMediaStreamOptions) => {
        requested.push(constraints);
        return stream;
      },
      // Keep the native per-app path out of it; audio is not what is under test.
      preferAppAudio: false,
    },
  };
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;
  iceConnectionState: RTCIceConnectionState = "connected";

  readonly parameters = { encodings: [{}] } as RTCRtpSendParameters;
  statsReport: unknown[] = [];

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTrack() {}

  getSenders() {
    return [
      {
        track: { kind: "video" },
        getParameters: () => this.parameters,
        setParameters: async (updated: RTCRtpSendParameters) => {
          Object.assign(this.parameters, updated);
        },
      },
    ] as unknown as RTCRtpSender[];
  }

  remoteDescriptions: RTCSessionDescriptionInit[] = [];

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescriptions.push(description);
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0 offer" };
  }
  async setLocalDescription(): Promise<void> {}
  async getStats(): Promise<RTCStatsReport> {
    const entries = this.statsReport;
    return {
      forEach(callback: (value: unknown) => void) {
        for (const entry of entries) callback(entry);
      },
    } as unknown as RTCStatsReport;
  }
  close() {}
}

function setup(quality?: (typeof QUALITY_PRESETS)[keyof typeof QUALITY_PRESETS]["profile"]) {
  const capture = fakeCapture();
  const sent: ClientMessage[] = [];

  const signaling = {
    send: (message: ClientMessage) => sent.push(message),
  } as unknown as ConstructorParameters<typeof SharingManager>[0]["signaling"];

  const manager = new SharingManager({
    signaling,
    createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
    capture: capture.options,
    ...(quality ? { quality } : {}),
  });

  /** Puts the manager into a live share inside a channel. */
  const goLive = async () => {
    manager.setSession(PUBLISHER, [], 6);
    return await manager.start();
  };

  const addWatcher = async (viewerId: string) => {
    await manager.addWatcher(viewerId);
  };

  const deliver = (message: ServerMessage) => manager.handleMessage(message);

  return { manager, capture, sent, goLive, addWatcher, deliver };
}

const PUBLISHER = "publisher-1";

const pcFor = (index: number) => FakePeerConnection.instances[index]!;

describe("SharingManager quality", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
  });

  it("asks capture for the starting preset's picture", async () => {
    const { capture, goLive } = setup(QUALITY_PRESETS.thrifty.profile);
    await goLive();

    const video = capture.requested[0]?.video as MediaTrackConstraints;
    expect(video.width).toEqual({ ideal: 1280 });
    expect(video.height).toEqual({ ideal: 720 });
    expect(video.frameRate).toEqual({ ideal: 30 });
  });

  it("defaults to automatic when no preset was given", async () => {
    const { capture, goLive } = setup();
    await goLive();

    const video = capture.requested[0]?.video as MediaTrackConstraints;
    expect(video.height).toEqual({ ideal: 1080 });
  });

  it("hands the preset's ceiling to each viewer connection", async () => {
    const { goLive, addWatcher } = setup(QUALITY_PRESETS.smooth.profile);
    await goLive();
    await addWatcher("viewer-1");

    expect(pcFor(0).parameters.encodings?.[0]?.maxBitrate).toBe(12_000_000);
    expect(pcFor(0).parameters.degradationPreference).toBe("maintain-framerate");
  });

  it("re-sizes the live picture when the preset changes mid-share", async () => {
    const { manager, capture, goLive } = setup();
    await goLive();

    await manager.setQuality(QUALITY_PRESETS.thrifty.profile);

    expect(capture.applied).toEqual([
      { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    ]);
  });

  it("re-aims the viewers already connected", async () => {
    const { manager, goLive, addWatcher } = setup();
    await goLive();
    await addWatcher("viewer-1");
    expect(pcFor(0).parameters.encodings?.[0]?.maxBitrate).toBe(8_000_000);

    await manager.setQuality(QUALITY_PRESETS.thrifty.profile);

    expect(pcFor(0).parameters.encodings?.[0]?.maxBitrate).toBe(2_500_000);
  });

  it("keeps sharing when the capture source refuses to be re-sized", async () => {
    // Some windows cannot change size once capture has started. Losing the
    // share over a preference change would be far worse than keeping the old
    // dimensions.
    const { manager, capture, goLive } = setup();
    await goLive();
    capture.videoTrack.applyConstraints.mockRejectedValueOnce(new Error("OverconstrainedError"));

    await expect(manager.setQuality(QUALITY_PRESETS.sharp.profile)).resolves.toBeUndefined();
    expect(manager.snapshot.state).toBe("sharing");
  });

  it("remembers a preset chosen while idle and uses it on the next share", async () => {
    const { manager, capture, goLive } = setup();
    await manager.setQuality(QUALITY_PRESETS.sharp.profile);
    await goLive();

    const video = capture.requested[0]?.video as MediaTrackConstraints;
    expect(video.height).toEqual({ ideal: 1440 });
  });
});

describe("SharingManager statistics", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
  });

  it("has no reading before the first poll", async () => {
    const { manager, goLive } = setup();
    await goLive();
    expect(manager.snapshot.stats).toBeNull();
  });

  it("publishes what the viewers measured", async () => {
    const { manager, goLive, addWatcher } = setup();
    await goLive();
    await addWatcher("viewer-1");

    const report = (bytesSent: number, timestamp: number) => [
      { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.042 },
      {
        type: "outbound-rtp",
        kind: "video",
        framesPerSecond: 58,
        frameWidth: 1920,
        frameHeight: 1080,
        bytesSent,
        timestamp,
      },
    ];

    pcFor(0).statsReport = report(0, 1000);
    await manager.pollQuality();
    pcFor(0).statsReport = report(1_000_000, 3000);
    await manager.pollQuality();

    expect(manager.snapshot.stats).toMatchObject({
      rttMs: 42,
      bitrateBps: 4_000_000,
      frameWidth: 1920,
      frameHeight: 1080,
      framesPerSecond: 58,
    });
  });

  it("drops the reading when the share stops", async () => {
    const { manager, goLive, addWatcher } = setup();
    await goLive();
    await addWatcher("viewer-1");
    pcFor(0).statsReport = [
      { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.042 },
    ];
    await manager.pollQuality();

    await manager.stop();

    expect(manager.snapshot.stats).toBeNull();
  });
});

describe("SharingManager in a channel", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
  });

  it("does not create a channel when a share starts", async () => {
    const { sent, goLive } = setup();
    await goLive();
    // Publishing is announced by the channel, not by this manager. Sending a
    // membership message from here is how the two would drift apart.
    expect(sent.filter((m) => m.type === "create-channel")).toHaveLength(0);
    expect(sent.filter((m) => m.type === "join-channel")).toHaveLength(0);
    expect(sent.filter((m) => m.type === "publish-start")).toHaveLength(0);
  });

  it("reports whether capture succeeded, so the caller can announce it", async () => {
    const { goLive } = setup();
    expect(await goLive()).toBe(true);
  });

  it("refuses to capture before a channel has been joined", async () => {
    const { manager } = setup();
    expect(await manager.start()).toBe(false);
    expect(manager.snapshot.state).toBe("error");
  });

  it("builds nothing until somebody asks to watch", async () => {
    const { goLive } = setup();
    await goLive();
    expect(FakePeerConnection.instances).toHaveLength(0);
  });

  it("builds exactly one connection per watcher", async () => {
    const { goLive, addWatcher } = setup();
    await goLive();
    await addWatcher("viewer-1");
    await addWatcher("viewer-2");
    expect(FakePeerConnection.instances).toHaveLength(2);
  });

  it("ignores an answer meant for somebody else's stream", async () => {
    const { goLive, addWatcher, deliver } = setup();
    await goLive();
    await addWatcher("viewer-1");

    // A stream we publish is not the only one on this socket: the same member
    // may be publishing to us at the same time.
    await deliver({
      type: "answer",
      fromId: "viewer-1",
      publisherId: "someone-else",
      sdp: "v=0",
    });
    expect(pcFor(0).remoteDescriptions).toHaveLength(0);
  });

  it("accepts an answer for its own stream", async () => {
    const { goLive, addWatcher, deliver } = setup();
    await goLive();
    await addWatcher("viewer-1");

    await deliver({
      type: "answer",
      fromId: "viewer-1",
      publisherId: PUBLISHER,
      sdp: "v=0",
    });
    expect(pcFor(0).remoteDescriptions).toEqual([{ type: "answer", sdp: "v=0" }]);
  });

  it("drops one watcher without touching the others", async () => {
    const { goLive, addWatcher, manager } = setup();
    await goLive();
    await addWatcher("viewer-1");
    await addWatcher("viewer-2");

    manager.removeWatcher("viewer-1");
    expect(manager.snapshot.viewerIds).toEqual(["viewer-2"]);
  });

  it("closes every connection when the share stops", async () => {
    const { goLive, addWatcher, manager } = setup();
    await goLive();
    await addWatcher("viewer-1");
    await manager.stop();

    expect(manager.snapshot.viewerIds).toEqual([]);
    expect(manager.snapshot.state).toBe("idle");
  });
});
