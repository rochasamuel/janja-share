import { z } from "zod";
import { channelIdSchema } from "./channel-id.js";
import { MAX_NAME_LENGTH } from "./member-name.js";

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

/**
 * Twice the sanitized limit. The wire accepts a little slack so a name that
 * merely needs trimming is cleaned rather than refused; `sanitizeName` is what
 * actually decides.
 */
const rawNameSchema = z.string().min(1).max(MAX_NAME_LENGTH * 2);

/**
 * How much of the picture a viewer can actually show.
 *
 * Two states rather than a pixel count, because there are only two: a fixed
 * 320px popover and the monitor. A number would bring debounce and
 * devicePixelRatio along with it for a window that cannot be resized.
 */
export const viewSizeSchema = z.enum(["panel", "fullscreen"]);

export type ViewSize = z.infer<typeof viewSizeSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create-channel"), displayName: rawNameSchema }),
  z.object({
    type: z.literal("join-channel"),
    channelId: channelIdSchema,
    displayName: rawNameSchema,
  }),
  z.object({ type: z.literal("leave-channel") }),
  z.object({ type: z.literal("publish-start") }),
  z.object({ type: z.literal("publish-stop") }),
  z.object({ type: z.literal("watch"), publisherId: sessionIdSchema }),
  z.object({ type: z.literal("unwatch"), publisherId: sessionIdSchema }),
  // Names only the publisher, for the same reason watch and unwatch do: this
  // one travels in a single direction, so the publisher is the target.
  z.object({
    type: z.literal("view-size"),
    publisherId: sessionIdSchema,
    size: viewSizeSchema,
  }),
  z.object({
    type: z.literal("offer"),
    targetId: sessionIdSchema,
    // Which stream this describes. Two members watching each other means two
    // connections between the same pair, and targetId alone cannot tell them
    // apart. The publisher's own session id is the id: no new space to
    // generate, and nothing to garbage-collect.
    publisherId: sessionIdSchema,
    sdp: z.string().max(MAX_SDP_BYTES),
  }),
  z.object({
    type: z.literal("answer"),
    targetId: sessionIdSchema,
    publisherId: sessionIdSchema,
    sdp: z.string().max(MAX_SDP_BYTES),
  }),
  z.object({
    type: z.literal("ice-candidate"),
    targetId: sessionIdSchema,
    publisherId: sessionIdSchema,
    candidate: iceCandidateInitSchema,
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientMessageType = ClientMessage["type"];

// --- server -> client ---------------------------------------------------------

export type ErrorCode =
  | "CHANNEL_NOT_FOUND"
  | "CHANNEL_FULL"
  | "PUBLISHER_FULL"
  | "ALREADY_WATCHING"
  | "NOT_PUBLISHING"
  | "ALREADY_IN_CHANNEL"
  | "NOT_IN_CHANNEL"
  | "INVALID_MESSAGE"
  | "RATE_LIMITED"
  | "NOT_AUTHORIZED"
  | "INTERNAL";

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** One person in a channel, as everyone else sees them. */
export interface Member {
  id: string;
  name: string;
  publishing: boolean;
}

export type MemberLeftReason = "left" | "disconnected";

export type ServerMessage =
  | {
      type: "channel-joined";
      channelId: string;
      sessionId: string;
      /** May differ from what was asked for: the server deduplicates names. */
      displayName: string;
      /** Everyone already here, excluding the joiner. */
      members: Member[];
      iceServers: IceServer[];
      maxViewersPerPublisher: number;
    }
  | { type: "member-joined"; member: Member }
  | { type: "member-left"; memberId: string; reason: MemberLeftReason }
  | { type: "member-publishing"; memberId: string; publishing: boolean }
  /** Someone clicked you. Build a connection and offer. */
  | { type: "watch-request"; fromId: string }
  /** They stopped. Tear that one connection down. */
  | { type: "unwatch"; fromId: string }
  /** A viewer says how much picture it can show. Scale that one sender. */
  | { type: "view-size"; fromId: string; size: ViewSize }
  | { type: "offer"; fromId: string; publisherId: string; sdp: string }
  | { type: "answer"; fromId: string; publisherId: string; sdp: string }
  | {
      type: "ice-candidate";
      fromId: string;
      publisherId: string;
      candidate: IceCandidateInit;
    }
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
