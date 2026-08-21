import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@janja/signaling-protocol";
import { ViewerConnectionManager } from "./viewer-connection-manager.js";

/** Enough of RTCPeerConnection to negotiate, fail, and be closed. */
class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  /** Ordered record of the steps whose sequence matters. */
  static calls: string[] = [];

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
    FakePeerConnection.calls.push("createOffer");
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

const PUBLISHER = "publisher-1";

function setup() {
  const sent: ClientMessage[] = [];
  const errors: { viewerId: string; error: unknown }[] = [];
  const viewerSnapshots: string[][] = [];

  const manager = new ViewerConnectionManager({
    publisherId: PUBLISHER,
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
    FakePeerConnection.calls = [];
  });

  it("offers to a new viewer with the capture tracks attached", async () => {
    const { manager, sent } = setup();
    await manager.addViewer("viewer-1");

    expect(pcFor(0).tracks).toHaveLength(2);
    expect(sent).toEqual([
      { type: "offer", targetId: "viewer-1", publisherId: PUBLISHER, sdp: "v=0 offer" },
    ]);
  });

  it("stamps its own publisherId on every message it sends", async () => {
    const { manager, sent } = setup();
    await manager.addViewer("viewer-1");

    expect(sent.find((message) => message.type === "offer")).toMatchObject({
      targetId: "viewer-1",
      publisherId: PUBLISHER,
    });

    pcFor(0).emitCandidate({ candidate: "candidate:1" });
    expect(sent.find((message) => message.type === "ice-candidate")).toMatchObject({
      targetId: "viewer-1",
      publisherId: PUBLISHER,
    });
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
      {
        type: "ice-candidate",
        targetId: "viewer-2",
        publisherId: PUBLISHER,
        candidate: { candidate: "candidate:2" },
      },
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
    // A new viewer is in the panel, so the default ceiling arrives scaled to
    // the picture it is actually being sent.
    expect(parameters.encodings?.[0]?.maxBitrate).toBe(Math.round(5_000_000 / 9));
    expect(parameters.degradationPreference).toBe("maintain-resolution");
  });

  describe("codec preference", () => {
    it("picks the codec before the offer is built, not after", async () => {
      // The offer is the only one this connection ever makes: the sharer never
      // re-negotiates. A preference applied on `negotiationneeded` lands after
      // `createOffer` has already been called, so it never reaches the wire —
      // and the connection falls back to VP8, which no GPU encodes in
      // hardware. Six software encodes is what eats the CPU.
      const applied: string[] = [];
      const manager = new ViewerConnectionManager({
        publisherId: PUBLISHER,
        createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
        send: () => {},
        applyCodecPreferences: () => {
          FakePeerConnection.calls.push("codecs");
          applied.push("once");
        },
      });
      manager.setStream(fakeStream());

      await manager.addViewer("viewer-1");

      expect(applied).toHaveLength(1);
      expect(FakePeerConnection.calls).toEqual(["codecs", "createOffer"]);
    });

    it("does so for every viewer, not just the first", async () => {
      let count = 0;
      const manager = new ViewerConnectionManager({
        publisherId: PUBLISHER,
        createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
        send: () => {},
        applyCodecPreferences: () => {
          count += 1;
        },
      });
      manager.setStream(fakeStream());

      await manager.addViewer("viewer-1");
      await manager.addViewer("viewer-2");

      expect(count).toBe(2);
    });
  });

  describe("encoding settings", () => {
    it("uses the ceiling it was built with", async () => {
      const manager = new ViewerConnectionManager({
        publisherId: PUBLISHER,
        createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
        send: () => {},
        encoding: { maxBitrateBps: 2_500_000, degradationPreference: "maintain-framerate" },
      });
      manager.setStream(fakeStream());
      await manager.addViewer("viewer-1");
      // Fullscreen so this stays a test of the ceiling it was built with,
      // rather than of the scaling arithmetic, which has its own tests.
      manager.setViewerSize("viewer-1", "fullscreen");

      const parameters = pcFor(0).parametersOfVideoSender();
      expect(parameters.encodings?.[0]?.maxBitrate).toBe(2_500_000);
      expect(parameters.degradationPreference).toBe("maintain-framerate");
    });

    it("re-aims every live sender when the preset changes mid-share", async () => {
      // The whole point of doing this through setParameters: nobody watching
      // loses their picture, because there is no renegotiation.
      const { manager, sent } = setup();
      await manager.addViewer("viewer-1");
      await manager.addViewer("viewer-2");
      manager.setViewerSize("viewer-1", "fullscreen");
      manager.setViewerSize("viewer-2", "fullscreen");
      const offersBefore = sent.filter((message) => message.type === "offer").length;

      manager.setEncoding({
        maxBitrateBps: 12_000_000,
        degradationPreference: "maintain-framerate",
      });

      for (const index of [0, 1]) {
        const parameters = pcFor(index).parametersOfVideoSender();
        expect(parameters.encodings?.[0]?.maxBitrate).toBe(12_000_000);
        expect(parameters.degradationPreference).toBe("maintain-framerate");
      }
      expect(sent.filter((message) => message.type === "offer").length).toBe(offersBefore);
    });

    it("applies the new ceiling to viewers who join afterwards", async () => {
      const { manager } = setup();
      manager.setEncoding({
        maxBitrateBps: 2_500_000,
        degradationPreference: "maintain-resolution",
      });
      await manager.addViewer("viewer-1");
      manager.setViewerSize("viewer-1", "fullscreen");

      expect(pcFor(0).parametersOfVideoSender().encodings?.[0]?.maxBitrate).toBe(2_500_000);
    });
  });

  describe("view size", () => {
    it("sends a panel-sized picture until the viewer says otherwise", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");

      expect(pcFor(0).parametersOfVideoSender().encodings?.[0]?.scaleResolutionDownBy).toBe(3);
    });

    it("sends the whole picture to a viewer in fullscreen", async () => {
      const { manager, sent } = setup();
      await manager.addViewer("viewer-1");
      const offersBefore = sent.filter((message) => message.type === "offer").length;

      manager.setViewerSize("viewer-1", "fullscreen");

      expect(pcFor(0).parametersOfVideoSender().encodings?.[0]?.scaleResolutionDownBy).toBe(1);
      // Same reason setEncoding goes through setParameters: no renegotiation,
      // so going fullscreen costs nobody their picture.
      expect(sent.filter((message) => message.type === "offer").length).toBe(offersBefore);
    });

    it("keeps each viewer's own scale when the preset changes", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");
      await manager.addViewer("viewer-2");
      manager.setViewerSize("viewer-2", "fullscreen");

      manager.setEncoding({ maxBitrateBps: 1_000_000, degradationPreference: "balanced" });

      const first = pcFor(0).parametersOfVideoSender().encodings?.[0];
      const second = pcFor(1).parametersOfVideoSender().encodings?.[0];
      expect(first?.scaleResolutionDownBy).toBe(3);
      expect(second?.scaleResolutionDownBy).toBe(1);
      // The ceiling follows the scale: a ninth of 1 Mbps is under the floor,
      // so the floor applies — but capped at a third of the chosen ceiling,
      // because a floor that outranks the ceiling is not a floor.
      expect(first?.maxBitrate).toBe(333_333);
      expect(second?.maxBitrate).toBe(1_000_000);
    });

    it("gives a viewer who joins later the panel scale", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");
      manager.setViewerSize("viewer-1", "fullscreen");

      await manager.addViewer("viewer-2");

      expect(pcFor(1).parametersOfVideoSender().encodings?.[0]?.scaleResolutionDownBy).toBe(3);
    });

    it("scales the ceiling down with the picture, not just the pixels", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");

      // A third of the width is a ninth of the area, and a ceiling left at the
      // full-screen figure would let congestion control spend it all on a
      // near-lossless 640x360.
      expect(pcFor(0).parametersOfVideoSender().encodings?.[0]?.maxBitrate).toBe(
        Math.round(5_000_000 / 9),
      );
    });

    it("gives a fullscreen viewer the whole ceiling", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");

      manager.setViewerSize("viewer-1", "fullscreen");

      expect(pcFor(0).parametersOfVideoSender().encodings?.[0]?.maxBitrate).toBe(5_000_000);
    });

    it("never drops the ceiling below what screen text needs", async () => {
      const manager = new ViewerConnectionManager({
        publisherId: PUBLISHER,
        createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
        send: () => {},
        // A ninth of this is 278 kbps, which is not a ceiling but a straitjacket.
        encoding: { maxBitrateBps: 2_500_000, degradationPreference: "maintain-resolution" },
      });
      manager.setStream(fakeStream());
      await manager.addViewer("viewer-1");

      expect(pcFor(0).parametersOfVideoSender().encodings?.[0]?.maxBitrate).toBe(500_000);
    });

    it("lets a lower preset actually lower what a panel viewer costs", async () => {
      // The reason the floor is capped rather than flat. Every ceiling at or
      // below 4.5 Mbps scales to under 500 kbps, so with a flat floor the two
      // cheapest presets were indistinguishable for a panel viewer — and a
      // panel is where every viewer starts. Someone who drops to "Conexão
      // fraca" because their link is failing has to get something for it.
      const rateFor = async (maxBitrateBps: number) => {
        const manager = new ViewerConnectionManager({
          publisherId: PUBLISHER,
          createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
          send: () => {},
          encoding: { maxBitrateBps, degradationPreference: "maintain-resolution" },
        });
        manager.setStream(fakeStream());
        await manager.addViewer("viewer-1");
        return manager;
      };

      await rateFor(2_500_000);
      const thrifty = pcFor(0).parametersOfVideoSender().encodings?.[0]?.maxBitrate;
      await rateFor(1_200_000);
      const weak = pcFor(1).parametersOfVideoSender().encodings?.[0]?.maxBitrate;

      expect(thrifty).toBe(500_000);
      expect(weak).toBe(400_000);
      expect(weak!).toBeLessThan(thrifty!);
    });

    it("re-aims the ceiling too when the preset changes", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");
      await manager.addViewer("viewer-2");
      manager.setViewerSize("viewer-2", "fullscreen");

      manager.setEncoding({
        maxBitrateBps: 9_000_000,
        degradationPreference: "maintain-resolution",
      });

      expect(pcFor(0).parametersOfVideoSender().encodings?.[0]?.maxBitrate).toBe(1_000_000);
      expect(pcFor(1).parametersOfVideoSender().encodings?.[0]?.maxBitrate).toBe(9_000_000);
    });

    it("caps a panel viewer's frame rate: a 312px picture cannot show 60 fps", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");

      // Half the frames is half the encoding work for that viewer, and the
      // sharer is paying for one encoder per viewer while a game runs.
      expect(pcFor(0).parametersOfVideoSender().encodings?.[0]?.maxFramerate).toBe(30);
    });

    it("lifts the frame-rate cap for a viewer in fullscreen", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");

      manager.setViewerSize("viewer-1", "fullscreen");

      // Absent rather than a large number: the preset's capture rate is the
      // only ceiling a fullscreen viewer should have.
      expect(pcFor(0).parametersOfVideoSender().encodings?.[0]).not.toHaveProperty(
        "maxFramerate",
      );
    });

    it("restores the cap when a fullscreen viewer goes back to the panel", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");
      manager.setViewerSize("viewer-1", "fullscreen");

      manager.setViewerSize("viewer-1", "panel");

      expect(pcFor(0).parametersOfVideoSender().encodings?.[0]?.maxFramerate).toBe(30);
    });

    it("ignores a size for a viewer that has already gone", () => {
      const { manager } = setup();
      expect(() => manager.setViewerSize("ghost", "fullscreen")).not.toThrow();
    });
  });

  describe("stream statistics", () => {
    const sharerReport = (rttSeconds: number, bytesSent: number, timestamp: number) => [
      { type: "candidate-pair", state: "succeeded", currentRoundTripTime: rttSeconds },
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

    it("has nothing to report before the first poll", () => {
      const { manager } = setup();
      expect(manager.stats).toBeNull();
    });

    it("folds every viewer into one reading", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");
      await manager.addViewer("viewer-2");
      for (const index of [0, 1]) pcFor(index).iceConnectionState = "connected";

      pcFor(0).statsReport = sharerReport(0.04, 0, 1000);
      pcFor(1).statsReport = sharerReport(0.32, 0, 1000);
      await manager.pollQuality();

      pcFor(0).statsReport = sharerReport(0.04, 500_000, 3000);
      pcFor(1).statsReport = sharerReport(0.32, 250_000, 3000);
      await manager.pollQuality();

      // Worst latency, summed rate: 2 Mbps out to one viewer and 1 Mbps to
      // the other is 3 Mbps leaving this machine.
      expect(manager.stats).toMatchObject({
        rttMs: 320,
        bitrateBps: 3_000_000,
        frameWidth: 1920,
        framesPerSecond: 58,
      });
    });

    it("leaves out a viewer whose statistics cannot be read", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");
      await manager.addViewer("viewer-2");
      pcFor(0).iceConnectionState = "connected";
      pcFor(0).statsReport = sharerReport(0.04, 0, 1000);
      pcFor(1).failOn = "getStats";

      await manager.pollQuality();

      expect(manager.stats?.rttMs).toBe(40);
    });

    it("forgets a viewer's numbers once they leave", async () => {
      const { manager } = setup();
      await manager.addViewer("viewer-1");
      pcFor(0).iceConnectionState = "connected";
      pcFor(0).statsReport = sharerReport(0.04, 0, 1000);
      await manager.pollQuality();

      manager.removeViewer("viewer-1");

      expect(manager.stats).toBeNull();
    });
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
        publisherId: PUBLISHER,
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
        publisherId: PUBLISHER,
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
      // A sharer's connection reports outbound-rtp. There is no inbound video
      // on this end at all.
      pcFor(0).statsReport = [
        { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.02 },
        { type: "outbound-rtp", kind: "video", framesPerSecond: 60, packetsSent: 10 },
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
