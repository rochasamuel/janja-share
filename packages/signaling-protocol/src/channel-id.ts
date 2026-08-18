import { z } from "zod";

/**
 * Crockford base32: the digits plus the uppercase letters, minus I, L, O and U.
 * Those four are excluded because a person has to read a channel code aloud to a
 * friend, and I/1, L/1, O/0 and U/V are exactly where that goes wrong.
 */
export const CHANNEL_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CHANNEL_ID_LENGTH = 6;

export const channelIdSchema = z
  .string()
  .length(CHANNEL_ID_LENGTH)
  .regex(/^[0-9A-HJKMNP-TV-Z]{6}$/);

/**
 * ~1.07 billion possibilities (32^6). Combined with join rate limiting on the
 * server, guessing a live channel is impractical.
 */
export function generateChannelId(): string {
  // Web Crypto rather than node:crypto: this package is imported by both the
  // server and the desktop bundle, and a Node-only import breaks the browser
  // build of a module the client only wanted constants from.
  const bytes = new Uint8Array(CHANNEL_ID_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CHANNEL_ID_LENGTH; i += 1) {
    // 256 divides evenly by 32, so the modulo introduces no bias.
    out += CHANNEL_ID_ALPHABET[bytes[i]! % CHANNEL_ID_ALPHABET.length];
  }
  return out;
}
