import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "@janja/signaling-protocol";
import { buildIceServers, type IceConfig } from "./ice-servers.js";
import { RoomManager, type Room } from "./room-manager.js";
import { TokenBucket, type RateLimitConfig } from "./rate-limiter.js";
import { consoleLogger, type Logger } from "./logger.js";

export interface SignalingServerOptions {
  port?: number;
  host?: string;
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

  const rooms = new RoomManager(options.maxViewers);
  const sessions = new Map<string, Session>();

  const http = createServer(handleHttp);
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_FRAME_BYTES });

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "GET" && req.url === "/api/ice-servers") {
      // A fresh session id keeps each issued credential distinct and short-lived.
      const body = JSON.stringify({ iceServers: buildIceServers(options.ice, randomUUID()) });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: rooms.roomCount }));
      return;
    }
    // Rooms are deliberately not enumerable over any route.
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
   * The authorization rule the whole protocol rests on: a viewer may only talk
   * to its sharer, and a sharer only to its own viewers. Without this, any
   * viewer could push SDP into another viewer's peer connection.
   */
  function resolveTarget(
    session: Session,
    targetId: string,
  ): { ok: true; room: Room } | { ok: false; code: ErrorCode } {
    const room = rooms.getRoomForSession(session.id);
    if (!room) return { ok: false, code: "NOT_IN_ROOM" };

    const senderIsSharer = room.sharerId === session.id;
    const allowed = senderIsSharer ? room.viewers.has(targetId) : targetId === room.sharerId;
    if (!allowed) return { ok: false, code: "NOT_AUTHORIZED" };

    return { ok: true, room };
  }

  function handleMessage(session: Session, message: ClientMessage): void {
    switch (message.type) {
      case "create-room": {
        const room = rooms.createRoom(session.id);
        logger.info("ROOM", "room created", { room: room.roomId, sharer: session.id });
        send(session, {
          type: "room-created",
          roomId: room.roomId,
          sessionId: session.id,
          iceServers: buildIceServers(options.ice, session.id),
          maxViewers: rooms.maxViewers,
        });
        return;
      }

      case "join-room": {
        const result = rooms.joinRoom(message.roomId, session.id);
        if (!result.ok) {
          logger.info("ROOM", "join refused", { room: message.roomId, reason: result.code });
          sendError(session, result.code, joinErrorMessage(result.code, rooms.maxViewers));
          return;
        }

        logger.info("ROOM", "viewer joined", {
          room: result.room.roomId,
          viewer: session.id,
          viewers: result.room.viewers.size,
        });
        send(session, {
          type: "room-joined",
          roomId: result.room.roomId,
          sessionId: session.id,
          sharerId: result.room.sharerId,
          iceServers: buildIceServers(options.ice, session.id),
        });
        sendTo(result.room.sharerId, { type: "viewer-joined", viewerId: session.id });
        return;
      }

      case "leave-room": {
        const effect = rooms.removeSession(session.id);
        if (effect.kind === "none") {
          sendError(session, "NOT_IN_ROOM", "You are not in a room.");
          return;
        }
        announceDeparture(effect, "left");
        return;
      }

      case "offer":
      case "answer": {
        const target = resolveTarget(session, message.targetId);
        if (!target.ok) {
          sendError(session, target.code, "You cannot send to that peer.");
          return;
        }
        sendTo(message.targetId, { type: message.type, fromId: session.id, sdp: message.sdp });
        return;
      }

      case "ice-candidate": {
        const target = resolveTarget(session, message.targetId);
        if (!target.ok) {
          sendError(session, target.code, "You cannot send to that peer.");
          return;
        }
        sendTo(message.targetId, {
          type: "ice-candidate",
          fromId: session.id,
          candidate: message.candidate,
        });
        return;
      }
    }
  }

  function announceDeparture(
    effect: ReturnType<RoomManager["removeSession"]>,
    reason: "left" | "disconnected",
  ): void {
    if (effect.kind === "room-ended") {
      logger.info("ROOM", "room ended", {
        room: effect.room.roomId,
        viewers: effect.room.viewers.size,
      });
      for (const viewerId of effect.room.viewers) {
        sendTo(viewerId, { type: "room-ended", reason: "sharer-left" });
      }
      return;
    }
    if (effect.kind === "viewer-left") {
      logger.info("ROOM", "viewer left", {
        room: effect.room.roomId,
        viewer: effect.viewerId,
        reason,
      });
      sendTo(effect.room.sharerId, {
        type: "viewer-left",
        viewerId: effect.viewerId,
        reason,
      });
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
      announceDeparture(rooms.removeSession(session.id), "disconnected");
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
  logger.info("APP", "signaling server listening", { port, maxViewers: options.maxViewers });

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

function joinErrorMessage(code: ErrorCode, maxViewers: number): string {
  switch (code) {
    case "ROOM_FULL":
      return `This stream is full. Maximum viewers: ${maxViewers}`;
    case "ROOM_NOT_FOUND":
      return "That room does not exist.";
    case "ALREADY_IN_ROOM":
      return "You are already in this room.";
    default:
      return "Unable to join.";
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
