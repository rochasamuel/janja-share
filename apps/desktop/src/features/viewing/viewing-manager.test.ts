import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@janja/signaling-protocol";
import { ViewingManager } from "./viewing-manager.js";
import type { SignalingClient } from "../../services/signaling/signaling-client.js";

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  remoteDescription: RTCSessionDescriptionInit | null = null;

  readonly addedCandidates: RTCIceCandidateInit[] = [];
  closed = false;
  failOn: "setRemote" | null = null;

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.failOn === "setRemote") throw new Error("bad sdp");
    this.remoteDescription = description;
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0 answer" };
  }

  async setLocalDescription(): Promise<void> {}

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedCandidates.push(candidate);
  }

  async getStats(): Promise<RTCStatsReport> {
    return { forEach() {} } as unknown as RTCStatsReport;
  }

  close(): void {
    this.closed = true;
  }

  // --- test controls ---
  transitionTo(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  emitTrack(stream: MediaStream): void {
    this.ontrack?.({ streams: [stream] });
  }

  emitCandidate(candidate: unknown): void {
    this.onicecandidate?.({
      candidate: { toJSON: () => candidate } as unknown as RTCIceCandidate,
    });
  }
}

function setup() {
  const sent: ClientMessage[] = [];
  const streams: (MediaStream | null)[] = [];
  const signaling = {
    send: (message: ClientMessage) => sent.push(message),
  } as unknown as SignalingClient;

  const manager = new ViewingManager({
    signaling,
    createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
    onStream: (stream) => streams.push(stream),
  });
  manager.setSession([]);

  return { manager, sent, streams, deliver: (m: ServerMessage) => manager.handleMessage(m) };
}

const PUBLISHER = "publisher-1";
const pc = () => FakePeerConnection.instances.at(-1)!;
const fakeStream = () => ({ id: "remote" }) as unknown as MediaStream;

describe("ViewingManager", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
  });

  it("asks the server to watch and says how much it can show, and nothing else", () => {
    const { manager, sent } = setup();
    manager.watch(PUBLISHER, "PC-SAM");

    // Still builds no connection: the publisher does that. The size rides
    // along so the very first frame is already scaled to the panel.
    expect(sent).toEqual([
      { type: "watch", publisherId: PUBLISHER },
      { type: "view-size", publisherId: PUBLISHER, size: "panel" },
    ]);
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect(manager.snapshot.state).toBe("connecting");
    expect(manager.snapshot.publisherName).toBe("PC-SAM");
  });

  it("answers the sharer's offer", async () => {
    const { manager, sent, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    // The watch and the size are their own test; this one is about the answer.
    sent.length = 0;

    await deliver({ type: "offer", fromId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 offer" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0]).toEqual({ type: "answer", targetId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 answer" });
  });

  it("hands the incoming stream to the player", async () => {
    const { manager, streams, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    await deliver({ type: "offer", fromId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 offer" });

    const remote = fakeStream();
    pc().emitTrack(remote);

    expect(streams).toContain(remote);
  });

  it("buffers candidates that arrive before the offer", async () => {
    const { manager, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");

    // WebRTC rejects a candidate before a remote description exists, so an
    // early one must be held rather than dropped.
    await deliver({ type: "ice-candidate", fromId: PUBLISHER, publisherId: PUBLISHER, candidate: { candidate: "early" } });
    await deliver({ type: "offer", fromId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 offer" });

    await vi.waitFor(() => expect(pc().addedCandidates).toEqual([{ candidate: "early" }]));
  });

  it("applies candidates directly once the offer is in place", async () => {
    const { manager, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    await deliver({ type: "offer", fromId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 offer" });

    await deliver({ type: "ice-candidate", fromId: PUBLISHER, publisherId: PUBLISHER, candidate: { candidate: "late" } });

    await vi.waitFor(() => expect(pc().addedCandidates).toEqual([{ candidate: "late" }]));
  });

  it("sends its own candidates to the sharer", async () => {
    const { manager, sent, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    await deliver({ type: "offer", fromId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 offer" });
    sent.length = 0;

    pc().emitCandidate({ candidate: "mine" });

    expect(sent).toEqual([
      {
        type: "ice-candidate",
        targetId: PUBLISHER,
        publisherId: PUBLISHER,
        candidate: { candidate: "mine" },
      },
    ]);
  });

  it("tracks the connection lifecycle", async () => {
    const { manager, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    await deliver({ type: "offer", fromId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 offer" });

    pc().transitionTo("connected");
    expect(manager.snapshot.state).toBe("connected");

    // A blip is not a failure; ICE usually recovers on its own.
    pc().transitionTo("disconnected");
    expect(manager.snapshot.state).toBe("reconnecting");

    pc().transitionTo("connected");
    expect(manager.snapshot.state).toBe("connected");
  });

  it("reuses the same connection for an ice restart's re-offer", async () => {
    const { manager, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    await deliver({ type: "offer", fromId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 offer" });
    await deliver({ type: "offer", fromId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 restart" });

    await vi.waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
  });

  it("says plainly when the publisher stops", async () => {
    const { manager, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    await deliver({ type: "offer", fromId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 offer" });

    await deliver({ type: "member-publishing", memberId: PUBLISHER, publishing: false });

    expect(manager.snapshot.state).toBe("disconnected");
    expect(manager.snapshot.message).toBe("PC-SAM parou de compartilhar.");
    expect(pc().closed).toBe(true);
  });

  it("surfaces a failure the channel hands it", () => {
    const { manager } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    manager.fail("Essa transmissão está lotada.");

    expect(manager.snapshot.state).toBe("error");
    expect(manager.snapshot.message).toBe("Essa transmissão está lotada.");
  });

  it("reports a failure when the offer cannot be applied", async () => {
    const sent: ClientMessage[] = [];
    const manager = new ViewingManager({
      signaling: {
        send: (m: ClientMessage) => sent.push(m),
      } as unknown as SignalingClient,
      createPeerConnection: () => {
        const connection = new FakePeerConnection();
        connection.failOn = "setRemote";
        return connection as unknown as RTCPeerConnection;
      },
    });

    manager.setSession([]);
    manager.watch(PUBLISHER, "PC-SAM");
    await manager.handleMessage({
      type: "offer",
      fromId: PUBLISHER,
      publisherId: PUBLISHER,
      sdp: "garbage",
    });

    await vi.waitFor(() => expect(manager.snapshot.state).toBe("error"));
    expect(manager.snapshot.message).toBe("Não foi possível conectar à transmissão.");
  });

  it("tears everything down on leave", async () => {
    const { manager, sent, streams, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    await deliver({ type: "offer", fromId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 offer" });
    sent.length = 0;

    manager.stop();

    expect(sent).toEqual([{ type: "unwatch", publisherId: PUBLISHER }]);
    expect(pc().closed).toBe(true);
    expect(streams.at(-1)).toBeNull();
    expect(manager.snapshot.state).toBe("idle");
  });

  it("ignores a second watch while already connecting", () => {
    const { manager, sent } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    sent.length = 0;

    manager.watch("publisher-2", "PC-ANA");

    expect(sent).toEqual([]);
  });

  it("ignores an offer for a stream it did not ask for", async () => {
    const { manager, sent, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    sent.length = 0;

    // This is what a member publishing to us at the same time looks like: an
    // offer on the same socket that has nothing to do with what we watch.
    await deliver({ type: "offer", fromId: "publisher-2", publisherId: "publisher-2", sdp: "v=0" });
    expect(sent.filter((m) => m.type === "answer")).toHaveLength(0);
  });

  it("ignores a candidate belonging to the stream we publish", async () => {
    const { manager, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    await deliver({ type: "offer", fromId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 offer" });
    const before = pc().addedCandidates.length;

    await deliver({
      type: "ice-candidate",
      fromId: "viewer-9",
      publisherId: "self-1",
      candidate: { candidate: "not ours" },
    });
    expect(pc().addedCandidates).toHaveLength(before);
  });

  it("ends the picture when the publisher leaves the channel", async () => {
    const { manager, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    await deliver({ type: "offer", fromId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 offer" });

    await deliver({ type: "member-left", memberId: PUBLISHER, reason: "disconnected" });
    expect(manager.snapshot.state).toBe("disconnected");
    expect(manager.snapshot.message).toBe("PC-SAM saiu do canal.");
  });

  it("ignores a departure that is not the publisher it watches", async () => {
    const { manager, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");

    await deliver({ type: "member-left", memberId: "publisher-2", reason: "left" });
    expect(manager.snapshot.state).toBe("connecting");
  });

  it("does not unwatch a publisher who already stopped", async () => {
    const { manager, sent, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    await deliver({ type: "offer", fromId: PUBLISHER, publisherId: PUBLISHER, sdp: "v=0 offer" });
    await deliver({ type: "member-publishing", memberId: PUBLISHER, publishing: false });
    sent.length = 0;

    // The server dropped the subscription itself. Asking it to drop one that
    // is already gone earns a refusal the person did nothing to deserve, and
    // it surfaced as an error banner on the way back to the channel.
    manager.stop();
    expect(sent).toEqual([]);
    expect(manager.snapshot.state).toBe("idle");
  });

  it("does not unwatch a publisher who left the channel", async () => {
    const { manager, sent, deliver } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    await deliver({ type: "member-left", memberId: PUBLISHER, reason: "disconnected" });
    sent.length = 0;

    manager.stop();
    expect(sent).toEqual([]);
  });

  it("still unwatches a publisher who is genuinely being watched", () => {
    const { manager, sent } = setup();
    manager.watch(PUBLISHER, "PC-SAM");
    sent.length = 0;

    manager.stop();
    expect(sent).toEqual([{ type: "unwatch", publisherId: PUBLISHER }]);
  });

  describe("view size", () => {
    it("reports going fullscreen and coming back", () => {
      const { manager, sent } = setup();
      manager.watch(PUBLISHER, "PC-SAM");
      sent.length = 0;

      manager.setViewSize("fullscreen");
      manager.setViewSize("panel");

      expect(sent).toEqual([
        { type: "view-size", publisherId: PUBLISHER, size: "fullscreen" },
        { type: "view-size", publisherId: PUBLISHER, size: "panel" },
      ]);
    });

    it("says nothing when the size did not actually change", () => {
      const { manager, sent } = setup();
      manager.watch(PUBLISHER, "PC-SAM");
      sent.length = 0;

      manager.setViewSize("panel");

      expect(sent).toEqual([]);
    });

    it("says nothing when it is not watching anyone", () => {
      const { manager, sent } = setup();

      manager.setViewSize("fullscreen");

      expect(sent).toEqual([]);
    });

    it("reports the size it was left in when it starts watching again", () => {
      const { manager, sent } = setup();
      manager.watch(PUBLISHER, "PC-SAM");
      manager.setViewSize("fullscreen");
      manager.stop();
      sent.length = 0;

      manager.watch("publisher-2", "PC-ANA");

      expect(sent).toEqual([
        { type: "watch", publisherId: "publisher-2" },
        { type: "view-size", publisherId: "publisher-2", size: "fullscreen" },
      ]);
    });
  });
});
