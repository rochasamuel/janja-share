import { z } from "zod";
import { roomIdSchema } from "./room-id.js";

/**
 * SDP for a 1080p60 screen share with a handful of codecs runs a few kilobytes.
 * 64 KB is generous headroom while still bounding what one client can push
 * through the server in a single frame.
 */
const MAX_SDP_BYTES = 64 * 1024;

/** Session ids are always server-generated UUIDs. Never trusted from a client. */
const sessionIdSchema = z.string().uuid();

const iceCandidateInitSchema = z.object({
  candidate: z.string().max(1024),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(16).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});

export type IceCandidateInit = z.infer<typeof iceCandidateInitSchema>;

// --- client -> server ---------------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create-room") }),
  z.object({ type: z.literal("join-room"), roomId: roomIdSchema }),
  z.object({ type: z.literal("leave-room") }),
  z.object({
    type: z.literal("offer"),
    targetId: sessionIdSchema,
    sdp: z.string().max(MAX_SDP_BYTES),
  }),
  z.object({
    type: z.literal("answer"),
    targetId: sessionIdSchema,
    sdp: z.string().max(MAX_SDP_BYTES),
  }),
  z.object({
    type: z.literal("ice-candidate"),
    targetId: sessionIdSchema,
    candidate: iceCandidateInitSchema,
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientMessageType = ClientMessage["type"];

// --- server -> client ---------------------------------------------------------

export type ErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "ALREADY_IN_ROOM"
  | "NOT_IN_ROOM"
  | "INVALID_MESSAGE"
  | "RATE_LIMITED"
  | "NOT_AUTHORIZED"
  | "INTERNAL";

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export type ViewerLeftReason = "left" | "disconnected";

export type ServerMessage =
  | {
      type: "room-created";
      roomId: string;
      sessionId: string;
      iceServers: IceServer[];
      maxViewers: number;
    }
  | {
      type: "room-joined";
      roomId: string;
      sessionId: string;
      sharerId: string;
      iceServers: IceServer[];
    }
  | { type: "viewer-joined"; viewerId: string }
  | { type: "viewer-left"; viewerId: string; reason: ViewerLeftReason }
  | { type: "offer"; fromId: string; sdp: string }
  | { type: "answer"; fromId: string; sdp: string }
  | { type: "ice-candidate"; fromId: string; candidate: IceCandidateInit }
  | { type: "room-ended"; reason: "sharer-left" }
  | { type: "error"; code: ErrorCode; message: string };

export type ServerMessageType = ServerMessage["type"];

// --- parsing ------------------------------------------------------------------

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: "INVALID_MESSAGE" };

/**
 * The only door client input comes through. Never throws: bad JSON, unknown
 * types and schema violations all come back as a rejection the caller answers
 * with an error frame.
 */
export function parseClientMessage(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, code: "INVALID_MESSAGE" };
  }

  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) return { ok: false, code: "INVALID_MESSAGE" };
  return { ok: true, message: parsed.data };
}
