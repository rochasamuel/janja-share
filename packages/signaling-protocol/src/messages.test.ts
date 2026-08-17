import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./messages.js";

describe("parseClientMessage", () => {
  it("accepts a well-formed join-room", () => {
    const result = parseClientMessage(JSON.stringify({ type: "join-room", roomId: "7DS4B2" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.message.type).toBe("join-room");
  });

  it("accepts create-room and leave-room", () => {
    expect(parseClientMessage(JSON.stringify({ type: "create-room" })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "leave-room" })).ok).toBe(true);
  });

  it("accepts a well-formed ice-candidate", () => {
    const raw = JSON.stringify({
      type: "ice-candidate",
      targetId: randomUUID(),
      candidate: { candidate: "candidate:1 1 udp 2130706431 192.168.0.2 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 },
    });
    expect(parseClientMessage(raw).ok).toBe(true);
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

  it("rejects a join-room carrying a malformed room id", () => {
    expect(parseClientMessage(JSON.stringify({ type: "join-room", roomId: "!!" })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: "join-room", roomId: "ABCDEI" })).ok).toBe(false);
  });

  it("rejects an offer whose targetId is not a uuid", () => {
    const raw = JSON.stringify({ type: "offer", targetId: "viewer-1", sdp: "v=0" });
    expect(parseClientMessage(raw).ok).toBe(false);
  });

  it("rejects an oversized sdp", () => {
    const raw = JSON.stringify({
      type: "offer",
      targetId: randomUUID(),
      sdp: "x".repeat(70_000),
    });
    expect(parseClientMessage(raw).ok).toBe(false);
  });

  it("rejects an oversized ice candidate string", () => {
    const raw = JSON.stringify({
      type: "ice-candidate",
      targetId: randomUUID(),
      candidate: { candidate: "c".repeat(2000) },
    });
    expect(parseClientMessage(raw).ok).toBe(false);
  });
});
