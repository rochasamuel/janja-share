import { generateRoomId } from "@janja/signaling-protocol";

export interface Room {
  readonly roomId: string;
  readonly sharerId: string;
  readonly viewers: Set<string>;
  readonly createdAt: number;
}

export type JoinResult =
  | { ok: true; room: Room }
  | { ok: false; code: "ROOM_NOT_FOUND" | "ROOM_FULL" | "ALREADY_IN_ROOM" };

export type RemovalEffect =
  | { kind: "none" }
  | { kind: "room-ended"; room: Room }
  | { kind: "viewer-left"; room: Room; viewerId: string };

/**
 * All room state, with no knowledge of sockets. Keeping the transport out means
 * the rules that actually matter — who may join, what a disconnect destroys —
 * are testable without a network.
 */
export class RoomManager {
  readonly #rooms = new Map<string, Room>();
  /** Reverse index so a disconnect is O(1) and can never leave a stale session. */
  readonly #sessionRooms = new Map<string, string>();
  readonly #maxViewers: number;

  constructor(maxViewers: number) {
    this.#maxViewers = maxViewers;
  }

  get maxViewers(): number {
    return this.#maxViewers;
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  createRoom(sharerId: string): Room {
    // A sharer that creates a second room abandons the first; leaving the old
    // one behind would strand its viewers on a room nobody is feeding.
    this.removeSession(sharerId);

    let roomId = generateRoomId();
    while (this.#rooms.has(roomId)) roomId = generateRoomId();

    const room: Room = {
      roomId,
      sharerId,
      viewers: new Set(),
      createdAt: Date.now(),
    };

    this.#rooms.set(roomId, room);
    this.#sessionRooms.set(sharerId, roomId);
    return room;
  }

  joinRoom(roomId: string, viewerId: string): JoinResult {
    const room = this.#rooms.get(roomId);
    if (!room) return { ok: false, code: "ROOM_NOT_FOUND" };
    if (room.sharerId === viewerId || room.viewers.has(viewerId)) {
      return { ok: false, code: "ALREADY_IN_ROOM" };
    }
    if (room.viewers.size >= this.#maxViewers) return { ok: false, code: "ROOM_FULL" };

    room.viewers.add(viewerId);
    this.#sessionRooms.set(viewerId, roomId);
    return { ok: true, room };
  }

  /**
   * Handles both an explicit leave and a dropped socket. A sharer leaving ends
   * the room for everyone; a viewer leaving is invisible to the other viewers.
   */
  removeSession(sessionId: string): RemovalEffect {
    const roomId = this.#sessionRooms.get(sessionId);
    if (roomId === undefined) return { kind: "none" };

    const room = this.#rooms.get(roomId);
    this.#sessionRooms.delete(sessionId);
    if (!room) return { kind: "none" };

    if (room.sharerId === sessionId) {
      for (const viewerId of room.viewers) this.#sessionRooms.delete(viewerId);
      this.#rooms.delete(roomId);
      return { kind: "room-ended", room };
    }

    room.viewers.delete(sessionId);
    return { kind: "viewer-left", room, viewerId: sessionId };
  }

  getRoom(roomId: string): Room | undefined {
    return this.#rooms.get(roomId);
  }

  getRoomForSession(sessionId: string): Room | undefined {
    const roomId = this.#sessionRooms.get(sessionId);
    return roomId === undefined ? undefined : this.#rooms.get(roomId);
  }
}
