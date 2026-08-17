import { beforeEach, describe, expect, it } from "vitest";
import { RoomManager } from "./room-manager.js";

describe("RoomManager", () => {
  let rooms: RoomManager;

  beforeEach(() => {
    rooms = new RoomManager(6);
  });

  it("creates a room owned by the sharer", () => {
    const room = rooms.createRoom("sharer-1");
    expect(room.sharerId).toBe("sharer-1");
    expect(room.viewers.size).toBe(0);
    expect(rooms.getRoom(room.roomId)).toBe(room);
  });

  it("admits a viewer", () => {
    const room = rooms.createRoom("sharer-1");
    const result = rooms.joinRoom(room.roomId, "viewer-1");
    expect(result.ok).toBe(true);
    expect(room.viewers.has("viewer-1")).toBe(true);
  });

  it("refuses an unknown room", () => {
    expect(rooms.joinRoom("ZZZZZZ", "viewer-1")).toEqual({ ok: false, code: "ROOM_NOT_FOUND" });
  });

  it("refuses the seventh viewer", () => {
    const room = rooms.createRoom("sharer-1");
    for (let i = 0; i < 6; i += 1) {
      expect(rooms.joinRoom(room.roomId, `viewer-${i}`).ok).toBe(true);
    }
    expect(rooms.joinRoom(room.roomId, "viewer-6")).toEqual({ ok: false, code: "ROOM_FULL" });
    expect(room.viewers.size).toBe(6);
  });

  it("respects a configured viewer limit other than the default", () => {
    const small = new RoomManager(2);
    const room = small.createRoom("sharer-1");
    expect(small.joinRoom(room.roomId, "viewer-1").ok).toBe(true);
    expect(small.joinRoom(room.roomId, "viewer-2").ok).toBe(true);
    expect(small.joinRoom(room.roomId, "viewer-3")).toEqual({ ok: false, code: "ROOM_FULL" });
  });

  it("refuses a viewer that is already in the room", () => {
    const room = rooms.createRoom("sharer-1");
    rooms.joinRoom(room.roomId, "viewer-1");
    expect(rooms.joinRoom(room.roomId, "viewer-1")).toEqual({ ok: false, code: "ALREADY_IN_ROOM" });
    expect(room.viewers.size).toBe(1);
  });

  it("refuses a sharer trying to join its own room as a viewer", () => {
    const room = rooms.createRoom("sharer-1");
    expect(rooms.joinRoom(room.roomId, "sharer-1")).toEqual({ ok: false, code: "ALREADY_IN_ROOM" });
  });

  it("removing a viewer leaves the room and its other viewers intact", () => {
    const room = rooms.createRoom("sharer-1");
    rooms.joinRoom(room.roomId, "viewer-1");
    rooms.joinRoom(room.roomId, "viewer-2");

    expect(rooms.removeSession("viewer-1")).toEqual({
      kind: "viewer-left",
      room,
      viewerId: "viewer-1",
    });
    expect(room.viewers.has("viewer-1")).toBe(false);
    expect(room.viewers.has("viewer-2")).toBe(true);
    expect(rooms.getRoom(room.roomId)).toBe(room);
  });

  it("removing the sharer ends the room", () => {
    const room = rooms.createRoom("sharer-1");
    rooms.joinRoom(room.roomId, "viewer-1");

    expect(rooms.removeSession("sharer-1")).toEqual({ kind: "room-ended", room });
    expect(rooms.getRoom(room.roomId)).toBeUndefined();
    expect(rooms.roomCount).toBe(0);
  });

  it("forgets viewer sessions when the room ends", () => {
    const room = rooms.createRoom("sharer-1");
    rooms.joinRoom(room.roomId, "viewer-1");
    rooms.removeSession("sharer-1");

    expect(rooms.getRoomForSession("viewer-1")).toBeUndefined();
    expect(rooms.removeSession("viewer-1")).toEqual({ kind: "none" });
  });

  it("removing an unknown session does nothing", () => {
    expect(rooms.removeSession("nobody")).toEqual({ kind: "none" });
  });

  it("maps a session back to its room", () => {
    const room = rooms.createRoom("sharer-1");
    rooms.joinRoom(room.roomId, "viewer-1");
    expect(rooms.getRoomForSession("viewer-1")).toBe(room);
    expect(rooms.getRoomForSession("sharer-1")).toBe(room);
    expect(rooms.getRoomForSession("stranger")).toBeUndefined();
  });

  it("lets a sharer create only one room at a time", () => {
    const first = rooms.createRoom("sharer-1");
    const second = rooms.createRoom("sharer-1");
    expect(rooms.getRoom(first.roomId)).toBeUndefined();
    expect(rooms.getRoom(second.roomId)).toBe(second);
    expect(rooms.roomCount).toBe(1);
  });

  it("issues room ids that pass protocol validation", () => {
    const room = rooms.createRoom("sharer-1");
    expect(room.roomId).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  });
});
