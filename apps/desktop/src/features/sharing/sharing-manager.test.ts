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
  let listener: ((message: ServerMessage) => void) | undefined;

  const signaling = {
    send: (message: ClientMessage) => sent.push(message),
    onMessage: (callback: (message: ServerMessage) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as ConstructorParameters<typeof SharingManager>[0]["signaling"];

  const manager = new SharingManager({
    signaling,
    createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
    capture: capture.options,
    ...(quality ? { quality } : {}),
  });

  /** Puts the manager into a live share with a room open. */
  const openRoom = async () => {
    await manager.start();
    listener?.({
      type: "room-created",
      roomId: "AB12CD",
      sessionId: "session-1",
      maxViewers: 6,
      iceServers: [],
    } satisfies ServerMessage);
  };

  const addViewer = async (viewerId: string) => {
    await listener?.({ type: "viewer-joined", viewerId } as ServerMessage);
  };

  return { manager, capture, sent, openRoom, addViewer };
}

const pcFor = (index: number) => FakePeerConnection.instances[index]!;

describe("SharingManager quality", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
  });

  it("asks capture for the starting preset's picture", async () => {
    const { capture, openRoom } = setup(QUALITY_PRESETS.thrifty.profile);
    await openRoom();

    const video = capture.requested[0]?.video as MediaTrackConstraints;
    expect(video.width).toEqual({ ideal: 1280 });
    expect(video.height).toEqual({ ideal: 720 });
    expect(video.frameRate).toEqual({ ideal: 30 });
  });

  it("defaults to automatic when no preset was given", async () => {
    const { capture, openRoom } = setup();
    await openRoom();

    const video = capture.requested[0]?.video as MediaTrackConstraints;
    expect(video.height).toEqual({ ideal: 1080 });
  });

  it("hands the preset's ceiling to each viewer connection", async () => {
    const { openRoom, addViewer } = setup(QUALITY_PRESETS.smooth.profile);
    await openRoom();
    await addViewer("viewer-1");

    expect(pcFor(0).parameters.encodings?.[0]?.maxBitrate).toBe(12_000_000);
    expect(pcFor(0).parameters.degradationPreference).toBe("maintain-framerate");
  });

  it("re-sizes the live picture when the preset changes mid-share", async () => {
    const { manager, capture, openRoom } = setup();
    await openRoom();

    await manager.setQuality(QUALITY_PRESETS.thrifty.profile);

    expect(capture.applied).toEqual([
      { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    ]);
  });

  it("re-aims the viewers already connected", async () => {
    const { manager, openRoom, addViewer } = setup();
    await openRoom();
    await addViewer("viewer-1");
    expect(pcFor(0).parameters.encodings?.[0]?.maxBitrate).toBe(8_000_000);

    await manager.setQuality(QUALITY_PRESETS.thrifty.profile);

    expect(pcFor(0).parameters.encodings?.[0]?.maxBitrate).toBe(2_500_000);
  });

  it("keeps sharing when the capture source refuses to be re-sized", async () => {
    // Some windows cannot change size once capture has started. Losing the
    // share over a preference change would be far worse than keeping the old
    // dimensions.
    const { manager, capture, openRoom } = setup();
    await openRoom();
    capture.videoTrack.applyConstraints.mockRejectedValueOnce(new Error("OverconstrainedError"));

    await expect(manager.setQuality(QUALITY_PRESETS.sharp.profile)).resolves.toBeUndefined();
    expect(manager.snapshot.state).toBe("sharing");
  });

  it("remembers a preset chosen while idle and uses it on the next share", async () => {
    const { manager, capture, openRoom } = setup();
    await manager.setQuality(QUALITY_PRESETS.sharp.profile);
    await openRoom();

    const video = capture.requested[0]?.video as MediaTrackConstraints;
    expect(video.height).toEqual({ ideal: 1440 });
  });
});

describe("SharingManager statistics", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
  });

  it("has no reading before the first poll", async () => {
    const { manager, openRoom } = setup();
    await openRoom();
    expect(manager.snapshot.stats).toBeNull();
  });

  it("publishes what the viewers measured", async () => {
    const { manager, openRoom, addViewer } = setup();
    await openRoom();
    await addViewer("viewer-1");

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
    const { manager, openRoom, addViewer } = setup();
    await openRoom();
    await addViewer("viewer-1");
    pcFor(0).statsReport = [
      { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.042 },
    ];
    await manager.pollQuality();

    await manager.stop();

    expect(manager.snapshot.stats).toBeNull();
  });
});
