import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./messages.js";

describe("parseClientMessage", () => {
  it("accepts create-channel and join-channel", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "create-channel", displayName: "PC-SAM" })).ok,
    ).toBe(true);
    expect(
      parseClientMessage(
        JSON.stringify({ type: "join-channel", channelId: "7DS4B2", displayName: "PC-ANA" }),
      ).ok,
    ).toBe(true);
  });

  it("accepts the publishing and watching verbs", () => {
    const publisherId = randomUUID();
    expect(parseClientMessage(JSON.stringify({ type: "publish-start" })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "publish-stop" })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "watch", publisherId })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "unwatch", publisherId })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "leave-channel" })).ok).toBe(true);
  });

  it("requires a publisherId on every signaling message", () => {
    const targetId = randomUUID();
    expect(parseClientMessage(JSON.stringify({ type: "offer", targetId, sdp: "v=0" })).ok).toBe(
      false,
    );
    expect(
      parseClientMessage(
        JSON.stringify({ type: "offer", targetId, publisherId: randomUUID(), sdp: "v=0" }),
      ).ok,
    ).toBe(true);
  });

  it("rejects a join carrying a malformed channel id", () => {
    const bad = { type: "join-channel", channelId: "ABCDEI", displayName: "PC" };
    expect(parseClientMessage(JSON.stringify(bad)).ok).toBe(false);
  });

  it("rejects an empty or absurdly long display name", () => {
    expect(parseClientMessage(JSON.stringify({ type: "create-channel", displayName: "" })).ok).toBe(
      false,
    );
    expect(
      parseClientMessage(
        JSON.stringify({ type: "create-channel", displayName: "A".repeat(500) }),
      ).ok,
    ).toBe(false);
  });

  it("rejects a publisherId that is not a uuid", () => {
    expect(parseClientMessage(JSON.stringify({ type: "watch", publisherId: "sam" })).ok).toBe(false);
  });

  it("rejects invalid JSON without throwing", () => {
    expect(parseClientMessage("{not json").ok).toBe(false);
  });

  it("rejects a non-object payload", () => {
    expect(parseClientMessage("42").ok).toBe(false);
    expect(parseClientMessage("null").ok).toBe(false);
  });

  it("rejects an unknown message type", () => {
    expect(parseClientMessage(JSON.stringify({ type: "shutdown" })).ok).toBe(false);
  });

  it("rejects an oversized sdp", () => {
    const raw = JSON.stringify({
      type: "offer",
      targetId: randomUUID(),
      publisherId: randomUUID(),
      sdp: "x".repeat(70_000),
    });
    expect(parseClientMessage(raw).ok).toBe(false);
  });

  it("rejects an oversized ice candidate string", () => {
    const raw = JSON.stringify({
      type: "ice-candidate",
      targetId: randomUUID(),
      publisherId: randomUUID(),
      candidate: { candidate: "c".repeat(2000) },
    });
    expect(parseClientMessage(raw).ok).toBe(false);
  });

  it("accepts view-size for both sizes", () => {
    const publisherId = randomUUID();
    expect(
      parseClientMessage(JSON.stringify({ type: "view-size", publisherId, size: "panel" })).ok,
    ).toBe(true);
    expect(
      parseClientMessage(JSON.stringify({ type: "view-size", publisherId, size: "fullscreen" })).ok,
    ).toBe(true);
  });

  it("rejects a view-size with an unknown size or a bad publisher", () => {
    const publisherId = randomUUID();
    expect(
      parseClientMessage(JSON.stringify({ type: "view-size", publisherId, size: "huge" })).ok,
    ).toBe(false);
    expect(
      parseClientMessage(JSON.stringify({ type: "view-size", publisherId: "nope", size: "panel" }))
        .ok,
    ).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: "view-size", size: "panel" })).ok).toBe(false);
  });
});
