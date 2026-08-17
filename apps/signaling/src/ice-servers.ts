import { createHmac } from "node:crypto";
import type { IceServer } from "@janja/signaling-protocol";

export interface IceConfig {
  stunUrl?: string;
  turnUrl?: string;
  turnTlsUrl?: string;
  /** coturn's `static-auth-secret`. Server-side only, never sent to a client. */
  turnSecret?: string;
  ttlSeconds: number;
}

/**
 * coturn's REST credential scheme (`use-auth-secret`): the username carries its
 * own expiry, and the password is an HMAC of it. coturn validates both without
 * any shared user database, and the client only ever holds a short-lived pair,
 * so the long-lived secret never leaves this process.
 */
export function buildIceServers(
  config: IceConfig,
  sessionId: string,
  now: number = Date.now(),
): IceServer[] {
  const servers: IceServer[] = [];

  if (config.stunUrl) {
    servers.push({ urls: [config.stunUrl] });
  }

  const turnUrls = [config.turnUrl, config.turnTlsUrl].filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );

  // Without both halves there is nothing usable to hand out, and shipping a
  // TURN url with no credential just produces ICE failures that look like bugs.
  if (turnUrls.length > 0 && config.turnSecret) {
    const expiry = Math.floor(now / 1000) + config.ttlSeconds;
    const username = `${expiry}:${sessionId}`;
    servers.push({
      urls: turnUrls,
      username,
      credential: createHmac("sha1", config.turnSecret).update(username).digest("base64"),
    });
  }

  return servers;
}
