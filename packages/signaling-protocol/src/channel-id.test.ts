import { describe, expect, it } from "vitest";
import { generateChannelId, CHANNEL_ID_ALPHABET, channelIdSchema } from "./channel-id.js";

describe("generateChannelId", () => {
  it("returns 6 characters from the Crockford alphabet", () => {
    const id = generateChannelId();
    expect(id).toHaveLength(6);
    for (const ch of id) expect(CHANNEL_ID_ALPHABET).toContain(ch);
  });

  it("never emits the ambiguous characters I, L, O, or U", () => {
    const ids = Array.from({ length: 500 }, generateChannelId).join("");
    expect(ids).not.toMatch(/[ILOU]/);
  });

  it("produces distinct ids", () => {
    const ids = new Set(Array.from({ length: 200 }, generateChannelId));
    expect(ids.size).toBeGreaterThan(190);
  });

  it("accepts generated ids and rejects malformed ones", () => {
    expect(channelIdSchema.safeParse(generateChannelId()).success).toBe(true);
    expect(channelIdSchema.safeParse("ABC").success).toBe(false);
    expect(channelIdSchema.safeParse("ABCDEI").success).toBe(false);
    expect(channelIdSchema.safeParse("abcdef").success).toBe(false);
  });
});
