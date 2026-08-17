import { describe, expect, it } from "vitest";
import { generateRoomId, ROOM_ID_ALPHABET, roomIdSchema } from "./room-id.js";

describe("generateRoomId", () => {
  it("returns 6 characters from the Crockford alphabet", () => {
    const id = generateRoomId();
    expect(id).toHaveLength(6);
    for (const ch of id) expect(ROOM_ID_ALPHABET).toContain(ch);
  });

  it("never emits the ambiguous characters I, L, O, or U", () => {
    const ids = Array.from({ length: 500 }, generateRoomId).join("");
    expect(ids).not.toMatch(/[ILOU]/);
  });

  it("produces distinct ids", () => {
    const ids = new Set(Array.from({ length: 200 }, generateRoomId));
    expect(ids.size).toBeGreaterThan(190);
  });

  it("accepts generated ids and rejects malformed ones", () => {
    expect(roomIdSchema.safeParse(generateRoomId()).success).toBe(true);
    expect(roomIdSchema.safeParse("ABC").success).toBe(false);
    expect(roomIdSchema.safeParse("ABCDEI").success).toBe(false);
    expect(roomIdSchema.safeParse("abcdef").success).toBe(false);
  });
});
