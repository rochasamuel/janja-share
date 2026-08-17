import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Crockford base32: the digits plus the uppercase letters, minus I, L, O and U.
 * Those four are excluded because a person has to read a room code aloud to a
 * friend, and I/1, L/1, O/0 and U/V are exactly where that goes wrong.
 */
export const ROOM_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ROOM_ID_LENGTH = 6;

export const roomIdSchema = z
  .string()
  .length(ROOM_ID_LENGTH)
  .regex(/^[0-9A-HJKMNP-TV-Z]{6}$/);

/**
 * ~1.07 billion possibilities (32^6). Combined with join rate limiting on the
 * server, guessing a live room is impractical.
 */
export function generateRoomId(): string {
  const bytes = randomBytes(ROOM_ID_LENGTH);
  let out = "";
  for (let i = 0; i < ROOM_ID_LENGTH; i += 1) {
    // 256 divides evenly by 32, so the modulo introduces no bias.
    out += ROOM_ID_ALPHABET[bytes[i]! % ROOM_ID_ALPHABET.length];
  }
  return out;
}
