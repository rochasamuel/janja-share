import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@janja/signaling-protocol";
import { ViewerConnectionManager } from "./viewer-connection-manager.js";

/** Enough of RTCPeerConnection to negotiate, fail, and be closed. */
class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";

  readonly tracks: MediaStreamTrack[] = [];
  readonly remoteDescriptions: RTCSessionDescriptionInit[] = [];
  readonly addedCandidates: unknown[] = [];
  localDescription: RTCSessionDescriptionInit | undefined;
  closed = false;

  /** Set by a test to make one specific step blow up. */
  failOn: "createOffer" | "setRemote" | "addCandidate" | "getStats" | null = null;

  #senders: { track: { kind: string }; getParameters: () => RTCRtpSendParameters; setParameters: (p: RTCRtpSendParameters) => Promise<void> }[] = [];
  statsReport: unknown[] = [];

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track);
    const parameters = { encodings: [{}] } as RTCRtpSendParameters;
    this.#senders.push({
      track: { kind: track.kind },
      getParameters: () => parameters,
      setParameters: async (updated) => {
        Object.assign(parameters, updated);
      },
    });
  }

  getSenders() {
    return this.#senders as unknown as RTCRtpSender[];
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (this.failOn === "createOffer") throw new Error("createOffer failed");
    return { type: "offer", sdp: "v=0 offer" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.failOn === "setRemote") throw new Error("setRemoteDescription failed");
    this.remoteDescriptions.push(description);
  }

  async addIceCandidate(candidate: unknown): Promise<void> {
    if (this.failOn === "addCandidate") throw new Error("bad candidate");
    this.addedCandidates.push(candidate);
  }

  async getStats(): Promise<RTCStatsReport> {
    if (this.failOn === "getStats") throw new Error("stats unavailable");
    const entries = this.statsReport;
    return {
      forEach(callback: (value: unknown) => void) {
        for (const entry of entries) callback(entry);
      },
    } as unknown as RTCStatsReport;
  }

  close(): void {
    this.closed = true;
  }

  // --- test controls ---
  emitCandidate(candidate: unknown): void {
    this.onicecandidate?.({
      candidate: { toJSON: () => candidate } as unknown as RTCIceCandidate,
    });
  }

  emitEndOfCandidates(): void {
    this.onicecandidate?.({ candidate: null });
  }

  fail(): void {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }

  parametersOfVideoSender(): RTCRtpSendParameters {
    return this.#senders.find((s) => s.track.kind === "video")!.getParameters();
  }
}

function fakeStream(): MediaStream {
  const tracks = [
    { kind: "video", id: "v1" },
    { kind: "audio", id: "a1" },
  ] as unknown as MediaStreamTrack[];
  return { getTracks: () => tracks } as unknown as MediaStream;
}

function setup() {
  const sent: ClientMessage[] = [];
  const errors: { viewerId: string; error: unknown }[] = [];
  const viewerSnapshots: string[][] = [];

  const manager = new ViewerConnectionManager({
    createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
    send: (message) => sent.push(message),
    onViewersChanged: (ids) => viewerSnapshots.push(ids),
    onError: (viewerId, error) => errors.push({ viewerId, error }),
  });
  manager.setStream(fakeStream());

  return { manager, sent, errors, viewerSnapshots };
}

const pcFor = (index: number) => FakePeerConnection.instances[index]!;

describe("ViewerConnectionManager", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
  });

  it("offers to a new viewer with the capture tracks attached", async () => {
    const { manager, sent } = setup();
    await manager.addViewer("viewer-1");

    expect(pcFor(0).tracks).toHaveLength(2);
    expect(sent).toEqual([{ type: "offer", targetId: "viewer-1", sdp: "v=0 offer" }]);
  });

  it("builds one connection per viewer", async () => {
    const { manager } = setup();
    await manager.addViewer("viewer-1");
    await manager.addViewer("viewer-2");

    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(manager.viewerCount).toBe(2);
  });

  it("ignores a duplicate viewer instead of building a second connection", async () => {
    const { manager } = setup();
    await manager.addViewer("viewer-1");
    await manager.addViewer("viewer-1");

    expect(FakePeerConnection.instances).toHaveLength(1);
  });

  it("refuses to add a viewer before capture has started", async () => {
    const { manager } = setup();
    manager.setStream(undefined);
    await expect(manager.addViewer("viewer-1")).rejects.toThrow(/before capture/);
  });

  it("forwards ice candidates addressed to the right viewer", async () => {
    const { manager, sent } = setup();
    await manager.addViewer("viewer-1");
    await manager.addViewer("viewer-2");
    sent.length = 0;

    pcFor(1).emitCandidate({ candidate: "candidate:2" });

    expect(sent).toEqual([
      { type: "ice-candidate", targetId: "viewer-2", candidate: { candidate: "candidate:2" } },
    ]);
  });

  it("does not send anything for the end-of-candidates signal", async () => {
    const { manager, sent } = setup();
    await manager.addViewer("viewer-1");
    sent.length = 0;

    pcFor(0).emitEndOfCandidates();
    expect(sent).toEqual([]);
  });

  it("applies the answer to the right viewer's connection", async () => {
    const { manager } = setup();
    await manager.addViewer("viewer-1");
    await manager.addViewer("viewer-2");

    await manager.handleAnswer("viewer-2", "v=0 answer-2");

    expect(pcFor(0).remoteDescriptions).toEqual([]);
    expect(pcFor(1).remoteDescriptions).toEqual([{ type: "answer", sdp: "v=0 answer-2" }]);
  });

  it("caps the bitrate and keeps resolution over frame rate", async () => {
    const { manager } = setup();
    await manager.addViewer("viewer-1");

    const parameters = pcFor(0).parametersOfVideoSender();
    expect(parameters.encodings?.[0]?.maxBitrate).toBe(8_000_000);
    expect(parameters.degradationPreference).toBe("maintain-resolution");
  });

  describe("viewer isolation", () => {
    it("drops only the viewer whose connection failed", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");
      await manager.addViewer("viewer-2");
      await manager.addViewer("viewer-3");

      pcFor(1).fail();

      expect(manager.viewerIds).toEqual(["viewer-1", "viewer-3"]);
      expect(pcFor(1).closed).toBe(true);
      expect(pcFor(0).closed).toBe(false);
      expect(pcFor(2).closed).toBe(false);
    });

    it("drops only the viewer whose answer was unusable", async () => {
      const { manager, errors } = setup();
      await manager.addViewer("viewer-1");
      await manager.addViewer("viewer-2");
      pcFor(0).failOn = "setRemote";

      await manager.handleAnswer("viewer-1", "garbage");

      expect(manager.viewerIds).toEqual(["viewer-2"]);
      expect(errors[0]?.viewerId).toBe("viewer-1");
    });

    it("keeps a viewer alive when one of its ice candidates is rejected", async () => {
      const { manager, errors } = setup();
      await manager.addViewer("viewer-1");
      pcFor(0).failOn = "addCandidate";

      await manager.handleIceCandidate("viewer-1", { candidate: "bad" });

      // A rejected candidate is routine; others usually still connect.
      expect(manager.viewerIds).toEqual(["viewer-1"]);
      expect(errors).toHaveLength(1);
    });

    it("cleans up the failed viewer when negotiation throws", async () => {
      const sent: ClientMessage[] = [];
      const manager = new ViewerConnectionManager({
        createPeerConnection: () => {
          const pc = new FakePeerConnection();
          pc.failOn = "createOffer";
          return pc as unknown as RTCPeerConnection;
        },
        send: (m) => sent.push(m),
      });
      manager.setStream(fakeStream());

      await expect(manager.addViewer("viewer-1")).rejects.toThrow();
      expect(manager.viewerCount).toBe(0);
      expect(pcFor(0).closed).toBe(true);
    });

    it("survives the signaling socket being closed mid-negotiation", async () => {
      const manager = new ViewerConnectionManager({
        createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
        send: () => {
          throw new Error("socket is not connected");
        },
      });
      manager.setStream(fakeStream());

      // Losing the offer must not kill the capture that other viewers use.
      await expect(manager.addViewer("viewer-1")).resolves.toBeUndefined();
      expect(manager.viewerCount).toBe(1);
    });

    it("ignores messages for a viewer that already left", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");
      manager.removeViewer("viewer-1");

      await expect(manager.handleAnswer("viewer-1", "v=0")).resolves.toBeUndefined();
      await expect(
        manager.handleIceCandidate("viewer-1", { candidate: "x" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("bookkeeping", () => {
    it("announces every change to the viewer list", async () => {
      const { manager, viewerSnapshots } = setup();
      await manager.addViewer("viewer-1");
      await manager.addViewer("viewer-2");
      manager.removeViewer("viewer-1");

      expect(viewerSnapshots).toEqual([["viewer-1"], ["viewer-1", "viewer-2"], ["viewer-2"]]);
    });

    it("closes every connection on shutdown", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");
      await manager.addViewer("viewer-2");

      manager.closeAll();

      expect(manager.viewerCount).toBe(0);
      expect(FakePeerConnection.instances.every((pc) => pc.closed)).toBe(true);
    });

    it("grades each viewer independently", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");
      await manager.addViewer("viewer-2");

      pcFor(0).iceConnectionState = "connected";
      pcFor(0).statsReport = [
        { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.02 },
        { type: "inbound-rtp", kind: "video", framesPerSecond: 60, packetsReceived: 10, packetsLost: 0 },
      ];
      pcFor(1).iceConnectionState = "disconnected";

      const quality = await manager.pollQuality();

      expect(quality.get("viewer-1")).toBe("excellent");
      expect(quality.get("viewer-2")).toBe("reconnecting");
    });

    it("marks a viewer as reconnecting when its stats cannot be read", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");
      pcFor(0).failOn = "getStats";

      const quality = await manager.pollQuality();
      expect(quality.get("viewer-1")).toBe("reconnecting");
    });
  });
});
