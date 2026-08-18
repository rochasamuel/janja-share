import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type Member,
  type MemberLeftReason,
  type ServerMessage,
} from "@janja/signaling-protocol";
import { buildIceServers, type IceConfig } from "./ice-servers.js";
import { ChannelManager, type RemovalEffect } from "./channel-manager.js";
import { TokenBucket, type RateLimitConfig } from "./rate-limiter.js";
import { consoleLogger, type Logger } from "./logger.js";

export interface SignalingServerOptions {
  port?: number;
  host?: string;
  /** People in one channel. */
  maxMembers: number;
  /** Viewers of one publisher. */
  maxViewers: number;
  ice: IceConfig;
  rateLimit?: RateLimitConfig;
  /** Ping interval in ms. 0 disables heartbeats, which is what tests want. */
  heartbeatMs?: number;
  logger?: Logger;
}

export interface SignalingServer {
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = { messagesPerSecond: 40, burst: 80 };
const DEFAULT_HEARTBEAT_MS = 30_000;
/** Bounds a single frame before it is even parsed. */
const MAX_FRAME_BYTES = 128 * 1024;

interface Session {
  readonly id: string;
  readonly socket: WebSocket;
  readonly bucket: TokenBucket;
  alive: boolean;
}

export async function createSignalingServer(
  options: SignalingServerOptions,
): Promise<SignalingServer> {
  const logger = options.logger ?? consoleLogger;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;

  const channels = new ChannelManager({
    maxMembers: options.maxMembers,
    maxViewersPerPublisher: options.maxViewers,
  });
  const sessions = new Map<string, Session>();

  const http = createServer(handleHttp);
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_FRAME_BYTES });

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    // Platform health checks are split between GET and HEAD, and a 404 to a
    // HEAD probe reads as a dead service and rolls the deploy back.
    const isRead = req.method === "GET" || req.method === "HEAD";

    if (isRead && req.url === "/api/ice-servers") {
      // A fresh session id keeps each issued credential distinct and short-lived.
      const body = JSON.stringify({ iceServers: buildIceServers(options.ice, randomUUID()) });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (isRead && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, channels: channels.channelCount }));
      return;
    }
    // Channels are deliberately not enumerable over any route.
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  function send(session: Session, message: ServerMessage): void {
    if (session.socket.readyState !== session.socket.OPEN) return;
    session.socket.send(JSON.stringify(message));
  }

  function sendTo(sessionId: string, message: ServerMessage): void {
    const target = sessions.get(sessionId);
    if (target) send(target, message);
  }

  function sendError(session: Session, code: ErrorCode, message: string): void {
    send(session, { type: "error", code, message });
  }

  /**
   * The authorization rule the whole protocol rests on.
   *
   * Sharing a channel is not enough. A stream exists only because somebody
   * asked for it, so the subscription is what grants the right to send SDP —
   * without that, any member could push an offer into any other member's peer
   * connection just by being in the channel with them.
   */
  function mayAddress(
    session: Session,
    kind: "offer" | "answer" | "ice-candidate",
    targetId: string,
    publisherId: string,
  ): boolean {
    if (!channels.sameChannel(session.id, targetId)) return false;

    const iAmThePublisher = session.id === publisherId;
    if (kind === "offer") {
      // Only the publisher offers, and only to someone who asked.
      return iAmThePublisher && channels.isSubscribed(targetId, publisherId);
    }
    if (kind === "answer") {
      // Only the watcher answers, and only to the publisher it asked.
      return (
        !iAmThePublisher &&
        targetId === publisherId &&
        channels.isSubscribed(session.id, publisherId)
      );
    }
    // Candidates travel both ways over a subscription that already exists.
    return iAmThePublisher
      ? channels.isSubscribed(targetId, publisherId)
      : targetId === publisherId && channels.isSubscribed(session.id, publisherId);
  }

  function sendJoined(
    session: Session,
    channelId: string,
    displayName: string,
    members: Member[],
  ): void {
    send(session, {
      type: "channel-joined",
      channelId,
      sessionId: session.id,
      displayName,
      members,
      iceServers: buildIceServers(options.ice, session.id),
      maxViewersPerPublisher: channels.maxViewersPerPublisher,
    });
  }

  function handleMessage(session: Session, message: ClientMessage): void {
    switch (message.type) {
      case "create-channel": {
        const result = channels.createChannel(session.id, message.displayName);
        if (!result.ok) {
          sendError(session, result.code, "That name cannot be used.");
          return;
        }
        logger.info("CHANNEL", "channel created", {
          channel: result.channelId,
          member: session.id,
        });
        sendJoined(session, result.channelId, result.member.name, result.members);
        return;
      }

      case "join-channel": {
        const result = channels.joinChannel(message.channelId, session.id, message.displayName);
        if (!result.ok) {
          logger.info("CHANNEL", "join refused", {
            channel: message.channelId,
            reason: result.code,
          });
          sendError(session, result.code, joinErrorMessage(result.code, options.maxMembers));
          return;
        }

        logger.info("CHANNEL", "member joined", {
          channel: result.channelId,
          member: session.id,
          members: result.members.length + 1,
        });
        sendJoined(session, result.channelId, result.member.name, result.members);
        for (const memberId of result.notify) {
          sendTo(memberId, { type: "member-joined", member: result.member });
        }
        return;
      }

      case "leave-channel": {
        const effect = channels.removeSession(session.id);
        if (effect.kind === "none") {
          sendError(session, "NOT_IN_CHANNEL", "You are not in a channel.");
          return;
        }
        announceDeparture(effect, "left");
        return;
      }

      case "publish-start":
      case "publish-stop": {
        const publishing = message.type === "publish-start";
        const result = channels.setPublishing(session.id, publishing);
        if (!result.ok) {
          sendError(session, result.code, "You are not in a channel.");
          return;
        }
        logger.info("CHANNEL", "publishing changed", { member: session.id, publishing });
        for (const memberId of result.notify) {
          sendTo(memberId, { type: "member-publishing", memberId: session.id, publishing });
        }
        return;
      }

      case "watch": {
        const result = channels.watch(session.id, message.publisherId);
        if (!result.ok) {
          sendError(session, result.code, watchErrorMessage(result.code, options.maxViewers));
          return;
        }
        // The publisher builds the connection and offers. Nothing exists until
        // this message lands, which is the whole point of joining being cheap.
        sendTo(result.publisherId, { type: "watch-request", fromId: session.id });
        return;
      }

      case "unwatch": {
        // Idempotent, and deliberately silent when there was nothing to drop.
        // Not watching someone is the outcome this asked for, not a failure:
        // the publisher may have stopped a moment earlier, in which case the
        // server already tore the subscription down and the viewer is being
        // told off for a state it did not choose.
        const result = channels.unwatch(session.id, message.publisherId);
        if (result.ok) {
          sendTo(result.publisherId, { type: "unwatch", fromId: session.id });
        }
        return;
      }

      case "offer":
      case "answer": {
        if (!mayAddress(session, message.type, message.targetId, message.publisherId)) {
          sendError(session, "NOT_AUTHORIZED", "You cannot send to that peer.");
          return;
        }
        sendTo(message.targetId, {
          type: message.type,
          fromId: session.id,
          publisherId: message.publisherId,
          sdp: message.sdp,
        });
        return;
      }

      case "ice-candidate": {
        if (!mayAddress(session, "ice-candidate", message.targetId, message.publisherId)) {
          sendError(session, "NOT_AUTHORIZED", "You cannot send to that peer.");
          return;
        }
        sendTo(message.targetId, {
          type: "ice-candidate",
          fromId: session.id,
          publisherId: message.publisherId,
          candidate: message.candidate,
        });
        return;
      }
    }
  }

  function announceDeparture(effect: RemovalEffect, reason: MemberLeftReason): void {
    if (effect.kind === "none") return;
    logger.info("CHANNEL", "member left", {
      channel: effect.channelId,
      member: effect.memberId,
      reason,
    });
    for (const memberId of effect.notify) {
      sendTo(memberId, { type: "member-left", memberId: effect.memberId, reason });
    }
  }

  wss.on("connection", (socket: WebSocket) => {
    const session: Session = {
      id: randomUUID(),
      socket,
      bucket: new TokenBucket(rateLimit),
      alive: true,
    };
    sessions.set(session.id, session);
    logger.info("SIGNALING", "connected", { session: session.id });

    socket.on("pong", () => {
      session.alive = true;
    });

    socket.on("message", (data) => {
      // Nothing a client sends may escape this handler. One malformed frame
      // must never be able to take the process down for everyone else.
      try {
        if (!session.bucket.tryConsume()) {
          sendError(session, "RATE_LIMITED", "Too many messages.");
          return;
        }

        const parsed = parseClientMessage(String(data));
        if (!parsed.ok) {
          sendError(session, "INVALID_MESSAGE", "Malformed message.");
          return;
        }

        handleMessage(session, parsed.message);
      } catch (error) {
        logger.error("SIGNALING", "handler failed", {
          session: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
        sendError(session, "INTERNAL", "Something went wrong.");
      }
    });

    socket.on("close", () => {
      sessions.delete(session.id);
      announceDeparture(channels.removeSession(session.id), "disconnected");
      logger.info("SIGNALING", "disconnected", { session: session.id });
    });

    socket.on("error", (error) => {
      logger.warn("SIGNALING", "socket error", {
        session: session.id,
        error: error.message,
      });
    });
  });

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const session of sessions.values()) {
            if (!session.alive) {
              session.socket.terminate();
              continue;
            }
            session.alive = false;
            session.socket.ping();
          }
        }, heartbeatMs)
      : undefined;
  heartbeat?.unref();

  const port = await listen(http, options.port ?? 0, options.host ?? "0.0.0.0");
  logger.info("APP", "signaling server listening", {
    port,
    maxMembers: options.maxMembers,
    maxViewers: options.maxViewers,
  });

  return {
    port,
    async close() {
      if (heartbeat) clearInterval(heartbeat);
      for (const session of sessions.values()) session.socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function joinErrorMessage(code: ErrorCode, maxMembers: number): string {
  switch (code) {
    case "CHANNEL_FULL":
      return `This channel is full. Maximum members: ${maxMembers}`;
    case "CHANNEL_NOT_FOUND":
      return "That channel does not exist.";
    case "ALREADY_IN_CHANNEL":
      return "You are already in this channel.";
    case "INVALID_MESSAGE":
      return "That name cannot be used.";
    default:
      return "Unable to join.";
  }
}

function watchErrorMessage(code: ErrorCode, maxViewers: number): string {
  switch (code) {
    case "NOT_PUBLISHING":
      return "That member is not sharing a screen.";
    case "ALREADY_WATCHING":
      return "You can only watch one stream at a time.";
    case "PUBLISHER_FULL":
      return `That stream is full. Maximum viewers: ${maxViewers}`;
    default:
      return "Unable to watch.";
  }
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}
