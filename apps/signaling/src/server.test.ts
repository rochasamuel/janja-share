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

  const open = async (): Promise<TestClient> => {
    const client = await TestClient.connect(server.port);
    clients.push(client);
    return client;
  };

  /** Opens a channel and returns its creator, the code, and the session id. */
  const createChannel = async (name = "PC-SAM") => {
    const client = await open();
    client.send({ type: "create-channel", displayName: name });
    const joined = await client.expect("channel-joined");
    return { client, channelId: joined.channelId, id: joined.sessionId, joined };
  };

  /** Joins an existing channel and returns the member plus its session id. */
  const joinChannel = async (channelId: string, name: string) => {
    const client = await open();
    client.send({ type: "join-channel", channelId, displayName: name });
    const joined = await client.expect("channel-joined");
    return { client, id: joined.sessionId, joined };
  };

  beforeEach(async () => {
    clients = [];
    server = await createSignalingServer({
      port: 0,
      host: "127.0.0.1",
      maxMembers: 3,
      maxViewers: 2,
      ice: ICE,
      heartbeatMs: 0,
      logger: silentLogger,
    });
  });

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await server.close();
  });

  describe("membership", () => {
    it("gives the creator a channel code, a session id and ice servers", async () => {
      const sam = await createChannel();
      expect(sam.channelId).toHaveLength(6);
      expect(sam.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(sam.joined.iceServers.length).toBeGreaterThan(0);
      expect(sam.joined.members).toEqual([]);
      expect(sam.joined.maxViewersPerPublisher).toBe(2);
    });

    it("tells an existing member when someone joins, with their name", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      const event = await sam.client.expect("member-joined");
      expect(event.member).toEqual({ id: ana.id, name: "PC-ANA", publishing: false });
    });

    it("hands a joiner the members already present", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      expect(ana.joined.members).toEqual([{ id: sam.id, name: "PC-SAM", publishing: false }]);
    });

    it("deduplicates a name already taken in the channel", async () => {
      const sam = await createChannel();
      const twin = await joinChannel(sam.channelId, "PC-SAM");
      expect(twin.joined.displayName).toBe("PC-SAM (2)");
    });

    it("refuses an unknown channel", async () => {
      const client = await open();
      client.send({ type: "join-channel", channelId: "ZZZZZZ", displayName: "PC-X" });
      const error = await client.expect("error");
      expect(error.code).toBe("CHANNEL_NOT_FOUND");
    });

    it("refuses a join past the member cap", async () => {
      const sam = await createChannel();
      await joinChannel(sam.channelId, "PC-ANA");
      await joinChannel(sam.channelId, "PC-LEO");

      const extra = await open();
      extra.send({ type: "join-channel", channelId: sam.channelId, displayName: "PC-X" });
      const error = await extra.expect("error");
      expect(error.code).toBe("CHANNEL_FULL");
    });

    it("announces a departure to the members who remain", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      ana.client.send({ type: "leave-channel" });
      const event = await sam.client.expect("member-left");
      expect(event).toMatchObject({ memberId: ana.id, reason: "left" });
    });

    it("announces a dropped socket the same way", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      await ana.client.close();
      const event = await sam.client.expect("member-left");
      expect(event).toMatchObject({ memberId: ana.id, reason: "disconnected" });
    });
  });

  describe("publishing", () => {
    it("announces publishing to the other members", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      sam.client.send({ type: "publish-start" });
      const event = await ana.client.expect("member-publishing");
      expect(event).toMatchObject({ memberId: sam.id, publishing: true });
    });

    it("announces stopping too", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      sam.client.send({ type: "publish-start" });
      await ana.client.expect("member-publishing");
      sam.client.send({ type: "publish-stop" });
      const event = await ana.client.expect("member-publishing");
      expect(event).toMatchObject({ memberId: sam.id, publishing: false });
    });

    it("refuses to publish outside a channel", async () => {
      const client = await open();
      client.send({ type: "publish-start" });
      const error = await client.expect("error");
      expect(error.code).toBe("NOT_IN_CHANNEL");
    });
  });

  describe("watching", () => {
    it("delivers a watch request to the publisher", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      sam.client.send({ type: "publish-start" });
      ana.client.send({ type: "watch", publisherId: sam.id });
      const request = await sam.client.expect("watch-request");
      expect(request.fromId).toBe(ana.id);
    });

    it("refuses to watch a member who is not publishing", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      ana.client.send({ type: "watch", publisherId: sam.id });
      const error = await ana.client.expect("error");
      expect(error.code).toBe("NOT_PUBLISHING");
    });

    it("holds a member to one stream at a time", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      const leo = await joinChannel(sam.channelId, "PC-LEO");
      sam.client.send({ type: "publish-start" });
      leo.client.send({ type: "publish-start" });

      ana.client.send({ type: "watch", publisherId: sam.id });
      await sam.client.expect("watch-request");
      ana.client.send({ type: "watch", publisherId: leo.id });
      const error = await ana.client.expect("error");
      expect(error.code).toBe("ALREADY_WATCHING");
    });

    it("refuses a viewer past the per-publisher cap", async () => {
      // Its own server: the shared one caps the channel at three members,
      // which is not enough room to overflow a publisher and still observe it.
      const roomy = await createSignalingServer({
        port: 0,
        host: "127.0.0.1",
        maxMembers: 8,
        maxViewers: 1,
        ice: ICE,
        heartbeatMs: 0,
        logger: silentLogger,
      });
      const local: TestClient[] = [];
      try {
        const sam = await TestClient.connect(roomy.port);
        local.push(sam);
        sam.send({ type: "create-channel", displayName: "PC-SAM" });
        const created = await sam.expect("channel-joined");

        const join = async (name: string) => {
          const client = await TestClient.connect(roomy.port);
          local.push(client);
          client.send({ type: "join-channel", channelId: created.channelId, displayName: name });
          await client.expect("channel-joined");
          return client;
        };

        const ana = await join("PC-ANA");
        const leo = await join("PC-LEO");
        sam.send({ type: "publish-start" });

        ana.send({ type: "watch", publisherId: created.sessionId });
        await sam.expect("watch-request");

        leo.send({ type: "watch", publisherId: created.sessionId });
        const error = await leo.expect("error");
        expect(error.code).toBe("PUBLISHER_FULL");
      } finally {
        await Promise.all(local.map((c) => c.close()));
        await roomy.close();
      }
    });

    it("stays quiet when someone unwatches a member they were not watching", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      await sam.client.expect("member-joined");

      // Not watching them is what this asked for. Answering with an error
      // scolds a person for a state they did not choose — and it reaches the
      // panel, in English, on the way back out of a stream that ended.
      ana.client.send({ type: "unwatch", publisherId: sam.id });
      await ana.client.expectSilence();
      await sam.client.expectSilence();
    });

    it("stays quiet when the publisher stopped first", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      sam.client.send({ type: "publish-start" });
      ana.client.send({ type: "watch", publisherId: sam.id });
      await sam.client.expect("watch-request");
      await ana.client.expect("member-publishing");

      // The server drops every subscription when a publisher stops, so the
      // viewer's own unwatch always arrives at a door that is already shut.
      sam.client.send({ type: "publish-stop" });
      await ana.client.expect("member-publishing");

      ana.client.send({ type: "unwatch", publisherId: sam.id });
      await ana.client.expectSilence();
      await sam.client.expectSilence();
    });

    it("tells the publisher when a viewer stops watching", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      sam.client.send({ type: "publish-start" });
      ana.client.send({ type: "watch", publisherId: sam.id });
      await sam.client.expect("watch-request");
      ana.client.send({ type: "unwatch", publisherId: sam.id });
      const event = await sam.client.expect("unwatch");
      expect(event.fromId).toBe(ana.id);
    });
  });

  describe("authorization", () => {
    it("refuses an offer to a member who never asked to watch", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      sam.client.send({ type: "publish-start" });
      sam.client.send({ type: "offer", targetId: ana.id, publisherId: sam.id, sdp: "v=0" });
      const error = await sam.client.expect("error");
      expect(error.code).toBe("NOT_AUTHORIZED");
    });

    it("forwards an offer once the watch exists", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      sam.client.send({ type: "publish-start" });
      ana.client.send({ type: "watch", publisherId: sam.id });
      await sam.client.expect("watch-request");

      sam.client.send({ type: "offer", targetId: ana.id, publisherId: sam.id, sdp: "v=0" });
      const offer = await ana.client.expect("offer");
      expect(offer).toMatchObject({ fromId: sam.id, publisherId: sam.id, sdp: "v=0" });
    });

    it("refuses a watcher pretending to be the publisher", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      sam.client.send({ type: "publish-start" });
      ana.client.send({ type: "watch", publisherId: sam.id });
      await sam.client.expect("watch-request");

      // Ana is a watcher, not the publisher, so she may not send an offer.
      ana.client.send({ type: "offer", targetId: sam.id, publisherId: sam.id, sdp: "v=0" });
      const error = await ana.client.expect("error");
      expect(error.code).toBe("NOT_AUTHORIZED");
    });

    it("forwards the answer back to the publisher", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      sam.client.send({ type: "publish-start" });
      ana.client.send({ type: "watch", publisherId: sam.id });
      await sam.client.expect("watch-request");

      ana.client.send({ type: "answer", targetId: sam.id, publisherId: sam.id, sdp: "v=0 answer" });
      const answer = await sam.client.expect("answer");
      expect(answer).toMatchObject({ fromId: ana.id, publisherId: sam.id });
    });

    it("carries candidates in both directions over one subscription", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      sam.client.send({ type: "publish-start" });
      ana.client.send({ type: "watch", publisherId: sam.id });
      await sam.client.expect("watch-request");

      const candidate = { candidate: "candidate:1 1 udp 2130706431 192.168.0.2 54321 typ host" };
      sam.client.send({ type: "ice-candidate", targetId: ana.id, publisherId: sam.id, candidate });
      expect((await ana.client.expect("ice-candidate")).fromId).toBe(sam.id);

      ana.client.send({ type: "ice-candidate", targetId: sam.id, publisherId: sam.id, candidate });
      expect((await sam.client.expect("ice-candidate")).fromId).toBe(ana.id);
    });

    it("refuses addressing a member of another channel", async () => {
      const sam = await createChannel();
      const other = await createChannel("PC-ANA");
      sam.client.send({ type: "publish-start" });
      sam.client.send({ type: "offer", targetId: other.id, publisherId: sam.id, sdp: "v=0" });
      const error = await sam.client.expect("error");
      expect(error.code).toBe("NOT_AUTHORIZED");
    });

    it("supports two members watching each other at once", async () => {
      const sam = await createChannel();
      const ana = await joinChannel(sam.channelId, "PC-ANA");
      sam.client.send({ type: "publish-start" });
      ana.client.send({ type: "publish-start" });

      ana.client.send({ type: "watch", publisherId: sam.id });
      expect((await sam.client.expect("watch-request")).fromId).toBe(ana.id);
      sam.client.send({ type: "watch", publisherId: ana.id });
      expect((await ana.client.expect("watch-request")).fromId).toBe(sam.id);

      sam.client.send({ type: "offer", targetId: ana.id, publisherId: sam.id, sdp: "sam" });
      ana.client.send({ type: "offer", targetId: sam.id, publisherId: ana.id, sdp: "ana" });

      // The two connections are told apart by publisherId alone. Without it
      // each end would feed the wrong SDP into the wrong peer connection.
      expect(await ana.client.expect("offer")).toMatchObject({ publisherId: sam.id, sdp: "sam" });
      expect(await sam.client.expect("offer")).toMatchObject({ publisherId: ana.id, sdp: "ana" });
    });
  });

  describe("robustness", () => {
    it("survives a malformed frame", async () => {
      const sam = await createChannel();
      sam.client.sendRaw("{not json");
      const error = await sam.client.expect("error");
      expect(error.code).toBe("INVALID_MESSAGE");
    });

    it("rejects an unknown message type", async () => {
      const sam = await createChannel();
      sam.client.send({ type: "shutdown" });
      const error = await sam.client.expect("error");
      expect(error.code).toBe("INVALID_MESSAGE");
    });

    it("rate limits a flood", async () => {
      // Flooded from inside a channel, where a publish toggle with nobody else
      // present is silent — so the limiter is the only thing that can answer.
      const sam = await createChannel();
      for (let i = 0; i < 200; i += 1) sam.client.send({ type: "publish-start" });
      const error = await sam.client.expect("error");
      expect(error.code).toBe("RATE_LIMITED");
    });

    it("reports health without enumerating channels", async () => {
      await createChannel();
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(await health.json()).toEqual({ ok: true, channels: 1 });

      const listing = await fetch(`http://127.0.0.1:${server.port}/channels`);
      expect(listing.status).toBe(404);
    });

    it("serves ice servers over http", async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/ice-servers`);
      const body = (await response.json()) as { iceServers: unknown[] };
      expect(body.iceServers.length).toBeGreaterThan(0);
    });
  });
});
