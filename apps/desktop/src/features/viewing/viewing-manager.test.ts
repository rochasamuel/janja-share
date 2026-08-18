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
  let deliver: (message: ServerMessage) => void = () => {};

  const signaling = {
    onMessage: (listener: (message: ServerMessage) => void) => {
      deliver = listener;
      return () => {
        deliver = () => {};
      };
    },
    send: (message: ClientMessage) => sent.push(message),
  } as unknown as SignalingClient;

  const manager = new ViewingManager({
    signaling,
    createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection,
    onStream: (stream) => streams.push(stream),
  });

  return { manager, sent, streams, deliver: (m: ServerMessage) => deliver(m) };
}

const pc = () => FakePeerConnection.instances.at(-1)!;
const fakeStream = () => ({ id: "remote" }) as unknown as MediaStream;

describe("ViewingManager", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
  });

  it("asks to join and reports connecting", () => {
    const { manager, sent } = setup();
    manager.join("7DS4B2");

    expect(sent).toEqual([{ type: "join-room", roomId: "7DS4B2" }]);
    expect(manager.snapshot.state).toBe("connecting");
    expect(manager.snapshot.roomId).toBe("7DS4B2");
  });

  it("answers the sharer's offer", async () => {
    const { manager, sent, deliver } = setup();
    manager.join("7DS4B2");
    deliver({ type: "room-joined", roomId: "7DS4B2", sessionId: "v1", sharerId: "s1", iceServers: [] });

    await deliver({ type: "offer", fromId: "s1", sdp: "v=0 offer" });
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    expect(sent[1]).toEqual({ type: "answer", targetId: "s1", sdp: "v=0 answer" });
  });

  it("hands the incoming stream to the player", async () => {
    const { manager, streams, deliver } = setup();
    manager.join("7DS4B2");
    deliver({ type: "room-joined", roomId: "7DS4B2", sessionId: "v1", sharerId: "s1", iceServers: [] });
    await deliver({ type: "offer", fromId: "s1", sdp: "v=0 offer" });

    const remote = fakeStream();
    pc().emitTrack(remote);

    expect(streams).toContain(remote);
  });

  it("buffers candidates that arrive before the offer", async () => {
    const { manager, deliver } = setup();
    manager.join("7DS4B2");
    deliver({ type: "room-joined", roomId: "7DS4B2", sessionId: "v1", sharerId: "s1", iceServers: [] });

    // WebRTC rejects a candidate before a remote description exists, so an
    // early one must be held rather than dropped.
    await deliver({ type: "ice-candidate", fromId: "s1", candidate: { candidate: "early" } });
    await deliver({ type: "offer", fromId: "s1", sdp: "v=0 offer" });

    await vi.waitFor(() => expect(pc().addedCandidates).toEqual([{ candidate: "early" }]));
  });

  it("applies candidates directly once the offer is in place", async () => {
    const { manager, deliver } = setup();
    manager.join("7DS4B2");
    deliver({ type: "room-joined", roomId: "7DS4B2", sessionId: "v1", sharerId: "s1", iceServers: [] });
    await deliver({ type: "offer", fromId: "s1", sdp: "v=0 offer" });

    await deliver({ type: "ice-candidate", fromId: "s1", candidate: { candidate: "late" } });

    await vi.waitFor(() => expect(pc().addedCandidates).toEqual([{ candidate: "late" }]));
  });

  it("sends its own candidates to the sharer", async () => {
    const { manager, sent, deliver } = setup();
    manager.join("7DS4B2");
    deliver({ type: "room-joined", roomId: "7DS4B2", sessionId: "v1", sharerId: "s1", iceServers: [] });
    await deliver({ type: "offer", fromId: "s1", sdp: "v=0 offer" });
    sent.length = 0;

    pc().emitCandidate({ candidate: "mine" });

    expect(sent).toEqual([
      { type: "ice-candidate", targetId: "s1", candidate: { candidate: "mine" } },
    ]);
  });

  it("tracks the connection lifecycle", async () => {
    const { manager, deliver } = setup();
    manager.join("7DS4B2");
    deliver({ type: "room-joined", roomId: "7DS4B2", sessionId: "v1", sharerId: "s1", iceServers: [] });
    await deliver({ type: "offer", fromId: "s1", sdp: "v=0 offer" });

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
    manager.join("7DS4B2");
    deliver({ type: "room-joined", roomId: "7DS4B2", sessionId: "v1", sharerId: "s1", iceServers: [] });
    await deliver({ type: "offer", fromId: "s1", sdp: "v=0 offer" });
    await deliver({ type: "offer", fromId: "s1", sdp: "v=0 restart" });

    await vi.waitFor(() => expect(FakePeerConnection.instances).toHaveLength(1));
  });

  it("says plainly when the sharer stops", async () => {
    const { manager, deliver } = setup();
    manager.join("7DS4B2");
    deliver({ type: "room-joined", roomId: "7DS4B2", sessionId: "v1", sharerId: "s1", iceServers: [] });
    await deliver({ type: "offer", fromId: "s1", sdp: "v=0 offer" });

    deliver({ type: "room-ended", reason: "sharer-left" });

    expect(manager.snapshot.state).toBe("disconnected");
    expect(manager.snapshot.message).toBe("A transmissão foi encerrada.");
    expect(pc().closed).toBe(true);
  });

  it("translates server errors into something a person can act on", () => {
    const cases = [
      { code: "ROOM_NOT_FOUND", expected: "Esse código não corresponde a nenhuma transmissão ao vivo." },
      { code: "ROOM_FULL", expected: "Esta transmissão está lotada." },
    ] as const;

    for (const { code, expected } of cases) {
      const { manager, deliver } = setup();
      manager.join("7DS4B2");
      deliver({ type: "error", code, message: "raw server text" });
      expect(manager.snapshot.message).toBe(expected);
      expect(manager.snapshot.state).toBe("error");
    }
  });

  it("reports a failure when the offer cannot be applied", async () => {
    const sent: ClientMessage[] = [];
    let deliver: (message: ServerMessage) => void = () => {};
    const manager = new ViewingManager({
      signaling: {
        onMessage: (listener: (m: ServerMessage) => void) => {
          deliver = listener;
          return () => {};
        },
        send: (m: ClientMessage) => sent.push(m),
      } as unknown as SignalingClient,
      createPeerConnection: () => {
        const connection = new FakePeerConnection();
        connection.failOn = "setRemote";
        return connection as unknown as RTCPeerConnection;
      },
    });

    manager.join("7DS4B2");
    deliver({ type: "room-joined", roomId: "7DS4B2", sessionId: "v1", sharerId: "s1", iceServers: [] });
    await deliver({ type: "offer", fromId: "s1", sdp: "garbage" });

    await vi.waitFor(() => expect(manager.snapshot.state).toBe("error"));
    expect(manager.snapshot.message).toBe("Não foi possível conectar à transmissão.");
  });

  it("tears everything down on leave", async () => {
    const { manager, sent, streams, deliver } = setup();
    manager.join("7DS4B2");
    deliver({ type: "room-joined", roomId: "7DS4B2", sessionId: "v1", sharerId: "s1", iceServers: [] });
    await deliver({ type: "offer", fromId: "s1", sdp: "v=0 offer" });
    sent.length = 0;

    manager.leave();

    expect(sent).toEqual([{ type: "leave-room" }]);
    expect(pc().closed).toBe(true);
    expect(streams.at(-1)).toBeNull();
    expect(manager.snapshot.state).toBe("idle");
  });

  it("ignores a second join while already connecting", () => {
    const { manager, sent } = setup();
    manager.join("7DS4B2");
    manager.join("X92KD1");

    expect(sent).toHaveLength(1);
  });
});
