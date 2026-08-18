import { describe, expect, it, vi } from "vitest";
import type { ClientMessage, Member, ServerMessage } from "@janja/signaling-protocol";
import { ChannelManager } from "./channel-manager.js";
import type { SharingManager } from "../sharing/sharing-manager.js";
import type { ViewingManager } from "../viewing/viewing-manager.js";
import type { SignalingClient, SignalingState } from "../../services/signaling/signaling-client.js";

function setup() {
  const sent: ClientMessage[] = [];
  let onMessage: ((message: ServerMessage) => void) | undefined;
  let onState: ((state: SignalingState) => void) | undefined;

  let connected = true;

  const signaling = {
    send: (message: ClientMessage) => {
      if (!connected) throw new Error("signaling socket is not connected");
      sent.push(message);
    },
    onMessage: (callback: (message: ServerMessage) => void) => {
      onMessage = callback;
      return () => {
        onMessage = undefined;
      };
    },
    onStateChange: (callback: (state: SignalingState) => void) => {
      onState = callback;
      return () => {
        onState = undefined;
      };
    },
  } as unknown as SignalingClient;

  const sharing = {
    snapshot: { state: "idle", viewerIds: [] },
    setSession: vi.fn(),
    start: vi.fn(async () => true),
    stop: vi.fn(async () => {}),
    addWatcher: vi.fn(async () => {}),
    removeWatcher: vi.fn(),
    handleMessage: vi.fn(async () => {}),
  };

  const viewing = {
    snapshot: { state: "idle" as string, publisherId: null as string | null },
    setSession: vi.fn(),
    watch: vi.fn(),
    stop: vi.fn(),
    fail: vi.fn(),
    handleMessage: vi.fn(async () => {}),
  };

  const manager = new ChannelManager({
    signaling,
    sharing: sharing as unknown as SharingManager,
    viewing: viewing as unknown as ViewingManager,
    readMachineName: async () => "PC-SAM",
  });

  const deliver = (message: ServerMessage) => onMessage?.(message);

  /**
   * Routing is async, so a message handed to two sub-managers reaches the
   * second one a microtask later. Asserting without this reads the spy before
   * the second call has happened.
   */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  const joined = (members: Member[] = []) =>
    deliver({
      type: "channel-joined",
      channelId: "AB12CD",
      sessionId: "self-1",
      displayName: "PC-SAM",
      members,
      iceServers: [],
      maxViewersPerPublisher: 6,
    });

  return {
    manager,
    sent,
    sharing,
    viewing,
    deliver,
    flush,
    offline: () => {
      connected = false;
    },
    joined,
    reconnect: () => onState?.("connected"),
  };
}

describe("ChannelManager", () => {
  it("creates a channel under this machine's name", async () => {
    const { manager, sent } = setup();
    await manager.create();

    expect(sent).toEqual([{ type: "create-channel", displayName: "PC-SAM" }]);
    expect(manager.snapshot.state).toBe("joining");
  });

  it("joins an existing channel by code", async () => {
    const { manager, sent } = setup();
    await manager.join("AB12CD");

    expect(sent).toEqual([{ type: "join-channel", channelId: "AB12CD", displayName: "PC-SAM" }]);
  });

  it("records the roster and the deduplicated name the server chose", async () => {
    const { manager, deliver } = setup();
    await manager.create();
    deliver({
      type: "channel-joined",
      channelId: "AB12CD",
      sessionId: "self-1",
      displayName: "PC-SAM (2)",
      members: [{ id: "ana", name: "PC-ANA", publishing: true }],
      iceServers: [],
      maxViewersPerPublisher: 6,
    });

    expect(manager.snapshot).toMatchObject({
      state: "joined",
      channelId: "AB12CD",
      selfId: "self-1",
      selfName: "PC-SAM (2)",
    });
    expect(manager.snapshot.members).toEqual([{ id: "ana", name: "PC-ANA", publishing: true }]);
  });

  it("hands the session to both sub-managers", async () => {
    const { manager, joined, sharing, viewing } = setup();
    await manager.create();
    joined();

    expect(sharing.setSession).toHaveBeenCalledWith("self-1", [], 6);
    expect(viewing.setSession).toHaveBeenCalledWith([]);
  });

  it("adds and removes members as they come and go", async () => {
    const { manager, joined, deliver } = setup();
    await manager.create();
    joined();

    deliver({ type: "member-joined", member: { id: "ana", name: "PC-ANA", publishing: false } });
    expect(manager.snapshot.members.map((m) => m.id)).toEqual(["ana"]);

    deliver({ type: "member-left", memberId: "ana", reason: "disconnected" });
    expect(manager.snapshot.members).toEqual([]);
  });

  it("sorts publishers to the top, then by name", async () => {
    const { manager, deliver } = setup();
    await manager.create();
    deliver({
      type: "channel-joined",
      channelId: "AB12CD",
      sessionId: "self-1",
      displayName: "PC-SAM",
      members: [
        { id: "1", name: "PC-ZE", publishing: false },
        { id: "2", name: "PC-ANA", publishing: false },
        { id: "3", name: "PC-LEO", publishing: true },
      ],
      iceServers: [],
      maxViewersPerPublisher: 6,
    });

    expect(manager.snapshot.members.map((m) => m.name)).toEqual(["PC-LEO", "PC-ANA", "PC-ZE"]);
  });

  it("tracks who is publishing", async () => {
    const { manager, joined, deliver } = setup();
    await manager.create();
    joined([{ id: "ana", name: "PC-ANA", publishing: false }]);

    deliver({ type: "member-publishing", memberId: "ana", publishing: true });
    expect(manager.snapshot.members[0]?.publishing).toBe(true);
  });

  it("announces publishing only after capture actually started", async () => {
    const { manager, joined, sent, sharing } = setup();
    await manager.create();
    joined();

    await manager.startPublishing();
    expect(sent).toContainEqual({ type: "publish-start" });

    sent.length = 0;
    sharing.start.mockResolvedValueOnce(false);
    await manager.startPublishing();
    // The user pressed cancel in the picker. Telling the channel we are live
    // would put a badge on a stream nobody can watch.
    expect(sent).toEqual([]);
  });

  it("stops publishing and tells the channel", async () => {
    const { manager, joined, sent, sharing } = setup();
    await manager.create();
    joined();
    await manager.stopPublishing();

    expect(sharing.stop).toHaveBeenCalled();
    expect(sent).toContainEqual({ type: "publish-stop" });
  });

  it("routes a watch-request to the sharing manager", async () => {
    const { manager, joined, deliver, sharing } = setup();
    await manager.create();
    joined();

    deliver({ type: "watch-request", fromId: "ana" });
    expect(sharing.addWatcher).toHaveBeenCalledWith("ana");
  });

  it("routes an unwatch to the sharing manager", async () => {
    const { manager, joined, deliver, sharing } = setup();
    await manager.create();
    joined();

    deliver({ type: "unwatch", fromId: "ana" });
    expect(sharing.removeWatcher).toHaveBeenCalledWith("ana");
  });

  it("drops a departed member's connection from both sides", async () => {
    const { manager, joined, deliver, sharing, viewing } = setup();
    await manager.create();
    joined([{ id: "ana", name: "PC-ANA", publishing: true }]);

    deliver({ type: "member-left", memberId: "ana", reason: "disconnected" });
    expect(sharing.removeWatcher).toHaveBeenCalledWith("ana");
    expect(viewing.handleMessage).toHaveBeenCalled();
  });

  it("gives an offer to the viewing manager and an answer to the sharing manager", async () => {
    const { manager, joined, deliver, sharing, viewing } = setup();
    await manager.create();
    joined();

    const offer = { type: "offer", fromId: "ana", publisherId: "ana", sdp: "v=0" } as const;
    const answer = { type: "answer", fromId: "ana", publisherId: "self-1", sdp: "v=0" } as const;
    deliver(offer);
    deliver(answer);

    expect(viewing.handleMessage).toHaveBeenCalledWith(offer);
    expect(sharing.handleMessage).toHaveBeenCalledWith(answer);
    expect(sharing.handleMessage).not.toHaveBeenCalledWith(offer);
  });

  it("gives a candidate to both, which each filters by publisherId", async () => {
    const { manager, joined, deliver, flush, sharing, viewing } = setup();
    await manager.create();
    joined();

    const candidate = {
      type: "ice-candidate",
      fromId: "ana",
      publisherId: "ana",
      candidate: { candidate: "candidate:1 1 udp" },
    } as const;
    deliver(candidate);
    await flush();

    expect(viewing.handleMessage).toHaveBeenCalledWith(candidate);
    expect(sharing.handleMessage).toHaveBeenCalledWith(candidate);
  });

  it("sends a watch and names the publisher for the viewing manager", async () => {
    const { manager, joined, viewing } = setup();
    await manager.create();
    joined([{ id: "ana", name: "PC-ANA", publishing: true }]);

    manager.watch("ana");
    expect(viewing.watch).toHaveBeenCalledWith("ana", "PC-ANA");
  });

  it("ignores a click on somebody who is no longer in the channel", async () => {
    const { manager, joined, viewing } = setup();
    await manager.create();
    joined();

    manager.watch("ghost");
    expect(viewing.watch).not.toHaveBeenCalled();
  });

  it("routes a watch error to the viewing manager while it is connecting", async () => {
    const { manager, joined, deliver, viewing } = setup();
    await manager.create();
    joined([{ id: "ana", name: "PC-ANA", publishing: true }]);
    viewing.snapshot = { state: "connecting", publisherId: "ana" };

    deliver({ type: "error", code: "PUBLISHER_FULL", message: "full" });
    expect(viewing.fail).toHaveBeenCalledWith("Essa transmissão está lotada.");
    expect(manager.snapshot.state).toBe("joined");
  });

  it("surfaces a join error on the channel itself", async () => {
    const { manager, deliver } = setup();
    await manager.join("AB12CD");

    deliver({ type: "error", code: "CHANNEL_NOT_FOUND", message: "no" });
    expect(manager.snapshot).toMatchObject({
      state: "error",
      message: "Esse código não corresponde a nenhum canal.",
    });
  });

  it("rejoins the same channel after the socket comes back", async () => {
    const { manager, joined, sent, reconnect } = setup();
    await manager.create();
    joined();
    sent.length = 0;

    reconnect();
    expect(sent).toEqual([{ type: "join-channel", channelId: "AB12CD", displayName: "PC-SAM" }]);
  });

  it("does not rejoin when it was never in a channel", () => {
    const { sent, reconnect } = setup();
    reconnect();
    expect(sent).toEqual([]);
  });

  it("leaves cleanly, stopping both directions", async () => {
    const { manager, joined, sent, sharing, viewing } = setup();
    await manager.create();
    joined();
    manager.leave();

    expect(viewing.stop).toHaveBeenCalled();
    expect(sharing.stop).toHaveBeenCalled();
    expect(sent).toContainEqual({ type: "leave-channel" });
    expect(manager.snapshot.state).toBe("idle");
    expect(manager.snapshot.channelId).toBeNull();
  });

  it("does not rejoin a channel it deliberately left", async () => {
    const { manager, joined, sent, reconnect } = setup();
    await manager.create();
    joined();
    manager.leave();
    sent.length = 0;

    reconnect();
    expect(sent).toEqual([]);
  });

  it("says so when the socket is down instead of sitting on joining", async () => {
    const { manager, offline } = setup();
    offline();

    await manager.create();
    expect(manager.snapshot).toMatchObject({
      state: "error",
      message: "Sem conexão com o servidor. Tente de novo.",
    });
  });

  it("does the same for a join, and keeps no channel it never entered", async () => {
    const { manager, offline, sent, reconnect } = setup();
    offline();

    await manager.join("AB12CD");
    expect(manager.snapshot.state).toBe("error");
    expect(manager.snapshot.channelId).toBeNull();

    // A rejoin on reconnect must not resurrect a channel the person never got
    // into in the first place.
    sent.length = 0;
    reconnect();
    expect(sent).toEqual([]);
  });
});
