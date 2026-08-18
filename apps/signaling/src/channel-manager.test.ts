import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ChannelManager } from "./channel-manager.js";

const LIMITS = { maxMembers: 3, maxViewersPerPublisher: 2 };

describe("ChannelManager", () => {
  let manager: ChannelManager;
  let sam: string;
  let ana: string;
  let leo: string;

  beforeEach(() => {
    manager = new ChannelManager(LIMITS);
    sam = randomUUID();
    ana = randomUUID();
    leo = randomUUID();
  });

  function open(): string {
    const created = manager.createChannel(sam, "PC-SAM");
    if (!created.ok) throw new Error("could not create the channel");
    return created.channelId;
  }

  it("creates a channel whose only member is its creator", () => {
    const created = manager.createChannel(sam, "PC-SAM");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.member).toEqual({ id: sam, name: "PC-SAM", publishing: false });
    expect(created.members).toEqual([]);
  });

  it("refuses a name that sanitizes to nothing", () => {
    const created = manager.createChannel(sam, "   ");
    expect(created).toEqual({ ok: false, code: "INVALID_MESSAGE" });
  });

  it("lets a second member join and reports who is already there", () => {
    const channelId = open();
    const joined = manager.joinChannel(channelId, ana, "PC-ANA");
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.members.map((m) => m.id)).toEqual([sam]);
    expect(joined.notify).toEqual([sam]);
  });

  it("deduplicates a name already taken in that channel", () => {
    const channelId = open();
    const joined = manager.joinChannel(channelId, ana, "PC-SAM");
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.member.name).toBe("PC-SAM (2)");
  });

  it("rejects an unknown channel", () => {
    expect(manager.joinChannel("ZZZZZZ", ana, "PC-ANA")).toEqual({
      ok: false,
      code: "CHANNEL_NOT_FOUND",
    });
  });

  it("rejects a join past the member cap", () => {
    const channelId = open();
    manager.joinChannel(channelId, ana, "PC-ANA");
    manager.joinChannel(channelId, leo, "PC-LEO");
    expect(manager.joinChannel(channelId, randomUUID(), "PC-X")).toEqual({
      ok: false,
      code: "CHANNEL_FULL",
    });
  });

  it("rejects joining a channel you are already in", () => {
    const channelId = open();
    expect(manager.joinChannel(channelId, sam, "PC-SAM")).toEqual({
      ok: false,
      code: "ALREADY_IN_CHANNEL",
    });
  });

  it("announces publishing to every other member", () => {
    const channelId = open();
    manager.joinChannel(channelId, ana, "PC-ANA");
    const result = manager.setPublishing(sam, true);
    expect(result).toEqual({ ok: true, memberId: sam, publishing: true, notify: [ana] });
  });

  it("refuses to watch someone who is not publishing", () => {
    const channelId = open();
    manager.joinChannel(channelId, ana, "PC-ANA");
    expect(manager.watch(ana, sam)).toEqual({ ok: false, code: "NOT_PUBLISHING" });
  });

  it("refuses to watch someone in another channel", () => {
    open();
    manager.setPublishing(sam, true);
    manager.createChannel(ana, "PC-ANA");
    expect(manager.watch(ana, sam)).toEqual({ ok: false, code: "NOT_AUTHORIZED" });
  });

  it("records a subscription in one direction only", () => {
    const channelId = open();
    manager.joinChannel(channelId, ana, "PC-ANA");
    manager.setPublishing(sam, true);

    expect(manager.watch(ana, sam)).toEqual({ ok: true, viewerId: ana, publisherId: sam });
    expect(manager.isSubscribed(ana, sam)).toBe(true);
    expect(manager.isSubscribed(sam, ana)).toBe(false);
  });

  it("allows two members to watch each other at the same time", () => {
    const channelId = open();
    manager.joinChannel(channelId, ana, "PC-ANA");
    manager.setPublishing(sam, true);
    manager.setPublishing(ana, true);

    expect(manager.watch(ana, sam).ok).toBe(true);
    expect(manager.watch(sam, ana).ok).toBe(true);
    expect(manager.isSubscribed(ana, sam)).toBe(true);
    expect(manager.isSubscribed(sam, ana)).toBe(true);
  });

  it("holds a member to one stream at a time", () => {
    const channelId = open();
    manager.joinChannel(channelId, ana, "PC-ANA");
    manager.joinChannel(channelId, leo, "PC-LEO");
    manager.setPublishing(sam, true);
    manager.setPublishing(leo, true);

    expect(manager.watch(ana, sam).ok).toBe(true);
    expect(manager.watch(ana, leo)).toEqual({ ok: false, code: "ALREADY_WATCHING" });
  });

  it("refuses a viewer past the per-publisher cap", () => {
    const extra = randomUUID();
    const bigger = new ChannelManager({ maxMembers: 8, maxViewersPerPublisher: 2 });
    const created = bigger.createChannel(sam, "PC-SAM");
    if (!created.ok) throw new Error("could not create the channel");
    bigger.joinChannel(created.channelId, ana, "PC-ANA");
    bigger.joinChannel(created.channelId, leo, "PC-LEO");
    bigger.joinChannel(created.channelId, extra, "PC-X");
    bigger.setPublishing(sam, true);
    bigger.watch(ana, sam);
    bigger.watch(leo, sam);
    expect(bigger.watch(extra, sam)).toEqual({ ok: false, code: "PUBLISHER_FULL" });
  });

  it("frees the slot when a viewer unwatches", () => {
    const channelId = open();
    manager.joinChannel(channelId, ana, "PC-ANA");
    manager.joinChannel(channelId, leo, "PC-LEO");
    manager.setPublishing(sam, true);
    manager.setPublishing(leo, true);
    manager.watch(ana, sam);

    expect(manager.unwatch(ana, sam)).toEqual({ ok: true, viewerId: ana, publisherId: sam });
    expect(manager.isSubscribed(ana, sam)).toBe(false);
    expect(manager.watch(ana, leo).ok).toBe(true);
  });

  it("drops every subscription when a publisher stops", () => {
    const channelId = open();
    manager.joinChannel(channelId, ana, "PC-ANA");
    manager.setPublishing(sam, true);
    manager.watch(ana, sam);

    manager.setPublishing(sam, false);
    expect(manager.isSubscribed(ana, sam)).toBe(false);
  });

  it("removes a departing member from the channel and from every subscription", () => {
    const channelId = open();
    manager.joinChannel(channelId, ana, "PC-ANA");
    manager.setPublishing(sam, true);
    manager.watch(ana, sam);

    const effect = manager.removeSession(sam);
    expect(effect).toEqual({ kind: "left", channelId, memberId: sam, notify: [ana] });
    expect(manager.isSubscribed(ana, sam)).toBe(false);
  });

  it("keeps the channel alive when a member leaves and drops it when the last one does", () => {
    const channelId = open();
    manager.joinChannel(channelId, ana, "PC-ANA");

    manager.removeSession(sam);
    expect(manager.channelCount).toBe(1);
    manager.removeSession(ana);
    expect(manager.channelCount).toBe(0);
  });

  it("reports nothing for a session that was never in a channel", () => {
    expect(manager.removeSession(randomUUID())).toEqual({ kind: "none" });
  });

  it("abandons the previous channel when a member creates a second one", () => {
    const first = open();
    manager.createChannel(sam, "PC-SAM");
    expect(manager.memberIds(first)).toEqual([]);
  });
});
