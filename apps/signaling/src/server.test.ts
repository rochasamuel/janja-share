import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSignalingServer, type SignalingServer } from "./server.js";
import { silentLogger } from "./logger.js";
import { TestClient } from "./test-client.js";

const ICE = {
  stunUrl: "stun:stun.example.com:3478",
  turnUrl: "turn:turn.example.com:3478",
  turnSecret: "test-secret",
  ttlSeconds: 3600,
};

describe("signaling server", () => {
  let server: SignalingServer;
  let clients: TestClient[];

  const connect = async (): Promise<TestClient> => {
    const client = await TestClient.connect(server.port);
    clients.push(client);
    return client;
  };

  /** Creates a room and returns the sharer plus its room id and session id. */
  const openRoom = async () => {
    const sharer = await connect();
    sharer.send({ type: "create-room" });
    const created = await sharer.next();
    if (created.type !== "room-created") throw new Error(`expected room-created, got ${created.type}`);
    return { sharer, roomId: created.roomId, sharerId: created.sessionId };
  };

  /** Joins an existing room and returns the viewer plus its session id. */
  const joinRoom = async (roomId: string) => {
    const viewer = await connect();
    viewer.send({ type: "join-room", roomId });
    const joined = await viewer.next();
    if (joined.type !== "room-joined") throw new Error(`expected room-joined, got ${joined.type}`);
    return { viewer, viewerId: joined.sessionId, sharerId: joined.sharerId };
  };

  beforeEach(async () => {
    clients = [];
    server = await createSignalingServer({
      port: 0,
      host: "127.0.0.1",
      maxViewers: 6,
      ice: ICE,
      heartbeatMs: 0,
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
  });

  describe("room creation", () => {
    it("gives the sharer a room id, a session id and ice servers", async () => {
      const sharer = await connect();
      sharer.send({ type: "create-room" });

      const message = await sharer.next();
      expect(message.type).toBe("room-created");
      if (message.type !== "room-created") return;

      expect(message.roomId).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
      expect(message.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(message.maxViewers).toBe(6);
      expect(message.iceServers.length).toBeGreaterThan(0);
      expect(message.iceServers.some((s) => s.username !== undefined)).toBe(true);
    });

    it("never reuses a session id across connections", async () => {
      const a = await openRoom();
      const b = await openRoom();
      expect(a.sharerId).not.toBe(b.sharerId);
    });
  });

  describe("joining", () => {
    it("tells the viewer who the sharer is", async () => {
      const { roomId, sharerId } = await openRoom();
      const { sharerId: reportedSharer } = await joinRoom(roomId);
      expect(reportedSharer).toBe(sharerId);
    });

    it("tells the sharer a viewer arrived", async () => {
      const { sharer, roomId } = await openRoom();
      const { viewerId } = await joinRoom(roomId);

      const notice = await sharer.next();
      expect(notice).toEqual({ type: "viewer-joined", viewerId });
    });

    it("refuses an unknown room", async () => {
      const viewer = await connect();
      viewer.send({ type: "join-room", roomId: "ZZZZZZ" });

      const message = await viewer.next();
      expect(message.type).toBe("error");
      if (message.type === "error") expect(message.code).toBe("ROOM_NOT_FOUND");
    });

    it("refuses the seventh viewer and does not admit it", async () => {
      const { roomId } = await openRoom();
      for (let i = 0; i < 6; i += 1) await joinRoom(roomId);

      const seventh = await connect();
      seventh.send({ type: "join-room", roomId });

      const message = await seventh.next();
      expect(message.type).toBe("error");
      if (message.type === "error") expect(message.code).toBe("ROOM_FULL");
      await seventh.expectSilence();
    });
  });

  describe("relaying", () => {
    it("delivers an offer only to its target viewer", async () => {
      const { sharer, roomId } = await openRoom();
      const first = await joinRoom(roomId);
      await sharer.next(); // viewer-joined for first
      const second = await joinRoom(roomId);
      await sharer.next(); // viewer-joined for second

      sharer.send({ type: "offer", targetId: first.viewerId, sdp: "v=0 first" });

      const delivered = await first.viewer.next();
      expect(delivered.type).toBe("offer");
      if (delivered.type === "offer") expect(delivered.sdp).toBe("v=0 first");
      await second.viewer.expectSilence();
    });

    it("relays ice candidates in both directions", async () => {
      const { sharer, roomId, sharerId } = await openRoom();
      const { viewer, viewerId } = await joinRoom(roomId);
      await sharer.next(); // viewer-joined

      const candidate = { candidate: "candidate:1 1 udp 1 10.0.0.1 1 typ host", sdpMid: "0", sdpMLineIndex: 0 };

      sharer.send({ type: "ice-candidate", targetId: viewerId, candidate });
      const toViewer = await viewer.next();
      expect(toViewer.type).toBe("ice-candidate");
      if (toViewer.type === "ice-candidate") expect(toViewer.fromId).toBe(sharerId);

      viewer.send({ type: "ice-candidate", targetId: sharerId, candidate });
      const toSharer = await sharer.next();
      expect(toSharer.type).toBe("ice-candidate");
      if (toSharer.type === "ice-candidate") expect(toSharer.fromId).toBe(viewerId);
    });

    it("delivers an answer to the sharer", async () => {
      const { sharer, roomId, sharerId } = await openRoom();
      const { viewer, viewerId } = await joinRoom(roomId);
      await sharer.next(); // viewer-joined

      viewer.send({ type: "answer", targetId: sharerId, sdp: "v=0 answer" });

      const delivered = await sharer.next();
      expect(delivered.type).toBe("answer");
      if (delivered.type === "answer") {
        expect(delivered.sdp).toBe("v=0 answer");
        expect(delivered.fromId).toBe(viewerId);
      }
    });
  });

  describe("authorization", () => {
    it("stops a viewer addressing another viewer", async () => {
      const { sharer, roomId } = await openRoom();
      const first = await joinRoom(roomId);
      await sharer.next();
      const second = await joinRoom(roomId);
      await sharer.next();

      first.viewer.send({ type: "offer", targetId: second.viewerId, sdp: "v=0 hijack" });

      const message = await first.viewer.next();
      expect(message.type).toBe("error");
      if (message.type === "error") expect(message.code).toBe("NOT_AUTHORIZED");
      await second.viewer.expectSilence();
    });

    it("stops addressing a session in another room", async () => {
      const roomA = await openRoom();
      const roomB = await openRoom();
      const viewerB = await joinRoom(roomB.roomId);
      await roomB.sharer.next();

      roomA.sharer.send({ type: "offer", targetId: viewerB.viewerId, sdp: "v=0 cross" });

      const message = await roomA.sharer.next();
      expect(message.type).toBe("error");
      if (message.type === "error") expect(message.code).toBe("NOT_AUTHORIZED");
      await viewerB.viewer.expectSilence();
    });

    it("stops relaying from a client that is in no room", async () => {
      const stray = await connect();
      stray.send({ type: "offer", targetId: crypto.randomUUID(), sdp: "v=0" });

      const message = await stray.next();
      expect(message.type).toBe("error");
      if (message.type === "error") expect(message.code).toBe("NOT_IN_ROOM");
    });
  });

  describe("departures", () => {
    it("tells the sharer when a viewer disconnects and leaves others alone", async () => {
      const { sharer, roomId } = await openRoom();
      const first = await joinRoom(roomId);
      await sharer.next();
      const second = await joinRoom(roomId);
      await sharer.next();

      await first.viewer.close();

      const notice = await sharer.next();
      expect(notice).toEqual({
        type: "viewer-left",
        viewerId: first.viewerId,
        reason: "disconnected",
      });
      await second.viewer.expectSilence();
      expect(second.viewer.isClosed).toBe(false);
    });

    it("reports an explicit leave-room as a leave, not a disconnect", async () => {
      const { sharer, roomId } = await openRoom();
      const { viewer, viewerId } = await joinRoom(roomId);
      await sharer.next();

      viewer.send({ type: "leave-room" });

      const notice = await sharer.next();
      expect(notice).toEqual({ type: "viewer-left", viewerId, reason: "left" });
    });

    it("ends the room for every viewer when the sharer disconnects", async () => {
      const { sharer, roomId } = await openRoom();
      const first = await joinRoom(roomId);
      await sharer.next();
      const second = await joinRoom(roomId);
      await sharer.next();

      await sharer.close();

      expect(await first.viewer.next()).toEqual({ type: "room-ended", reason: "sharer-left" });
      expect(await second.viewer.next()).toEqual({ type: "room-ended", reason: "sharer-left" });
    });

    it("frees the room id so the room cannot be joined afterwards", async () => {
      const { sharer, roomId } = await openRoom();
      await sharer.close();

      const late = await connect();
      late.send({ type: "join-room", roomId });

      const message = await late.next();
      expect(message.type).toBe("error");
      if (message.type === "error") expect(message.code).toBe("ROOM_NOT_FOUND");
    });

    it("rejects leave-room from a client that is in no room", async () => {
      const stray = await connect();
      stray.send({ type: "leave-room" });

      const message = await stray.next();
      expect(message.type).toBe("error");
      if (message.type === "error") expect(message.code).toBe("NOT_IN_ROOM");
    });
  });

  describe("hostile input", () => {
    it("answers malformed JSON with an error and keeps the socket open", async () => {
      const client = await connect();
      client.sendRaw("{not json");

      const message = await client.next();
      expect(message.type).toBe("error");
      if (message.type === "error") expect(message.code).toBe("INVALID_MESSAGE");
      expect(client.isClosed).toBe(false);

      client.send({ type: "create-room" });
      expect((await client.next()).type).toBe("room-created");
    });

    it("rejects an unknown message type", async () => {
      const client = await connect();
      client.send({ type: "shutdown" });

      const message = await client.next();
      expect(message.type).toBe("error");
      if (message.type === "error") expect(message.code).toBe("INVALID_MESSAGE");
    });

    it("rejects a structurally invalid join-room", async () => {
      const client = await connect();
      client.send({ type: "join-room", roomId: 12345 });

      const message = await client.next();
      expect(message.type).toBe("error");
      if (message.type === "error") expect(message.code).toBe("INVALID_MESSAGE");
    });
  });

  describe("rate limiting", () => {
    it("cuts off a client that floods the socket", async () => {
      const limited = await createSignalingServer({
        port: 0,
        host: "127.0.0.1",
        maxViewers: 6,
        ice: ICE,
        heartbeatMs: 0,
        logger: silentLogger,
        rateLimit: { messagesPerSecond: 5, burst: 5 },
      });

      try {
        const client = await TestClient.connect(limited.port);
        for (let i = 0; i < 30; i += 1) client.send({ type: "leave-room" });

        const codes: string[] = [];
        for (let i = 0; i < 30; i += 1) {
          const message = await client.next();
          if (message.type === "error") codes.push(message.code);
        }
        expect(codes).toContain("RATE_LIMITED");
        await client.close();
      } finally {
        await limited.close();
      }
    });
  });

  describe("ice server endpoint", () => {
    it("serves fresh credentials over http", async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/ice-servers`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as { iceServers: { urls: string[]; username?: string }[] };
      expect(body.iceServers.length).toBeGreaterThan(0);
      expect(body.iceServers.some((s) => s.username !== undefined)).toBe(true);
    });

    it("does not leak the turn secret", async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/ice-servers`);
      expect(await response.text()).not.toContain("test-secret");
    });

    it("answers a HEAD health probe, not just GET", async () => {
      // Some platforms probe with HEAD; a 404 there reads as a dead service.
      const response = await fetch(`http://127.0.0.1:${server.port}/healthz`, { method: "HEAD" });
      expect(response.status).toBe(200);
    });

    it("404s an unknown path", async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/rooms`);
      expect(response.status).toBe(404);
    });
  });
});
