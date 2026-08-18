import {
  generateChannelId,
  sanitizeName,
  type ErrorCode,
  type Member,
} from "@janja/signaling-protocol";

/**
 * How many streams one member may watch at once.
 *
 * One, deliberately: the panel is a tray popover, and decoding a second stream
 * while encoding your own is the quickest way to starve the encoder. Raising
 * this is a one-line change, which is why it is a named constant.
 */
export const MAX_WATCHING_PER_MEMBER = 1;

export interface ChannelLimits {
  maxMembers: number;
  maxViewersPerPublisher: number;
}

interface MemberState {
  readonly id: string;
  name: string;
  publishing: boolean;
  /** Publishers this member is watching. */
  readonly watching: Set<string>;
  /** Members watching this one. */
  readonly watchers: Set<string>;
}

interface Channel {
  readonly channelId: string;
  readonly members: Map<string, MemberState>;
  readonly createdAt: number;
}

export type CreateResult =
  | { ok: true; channelId: string; member: Member; members: Member[] }
  | { ok: false; code: "INVALID_MESSAGE" };

export type JoinResult =
  | { ok: true; channelId: string; member: Member; members: Member[]; notify: string[] }
  | {
      ok: false;
      code: "CHANNEL_NOT_FOUND" | "CHANNEL_FULL" | "ALREADY_IN_CHANNEL" | "INVALID_MESSAGE";
    };

export type PublishResult =
  | { ok: true; memberId: string; publishing: boolean; notify: string[] }
  | { ok: false; code: "NOT_IN_CHANNEL" };

export type WatchResult =
  | { ok: true; viewerId: string; publisherId: string }
  | {
      ok: false;
      code: Extract<
        ErrorCode,
        | "NOT_IN_CHANNEL"
        | "NOT_AUTHORIZED"
        | "NOT_PUBLISHING"
        | "ALREADY_WATCHING"
        | "PUBLISHER_FULL"
      >;
    };

export type RemovalEffect =
  | { kind: "none" }
  | { kind: "left"; channelId: string; memberId: string; notify: string[] };

/**
 * All channel state, with no knowledge of sockets.
 *
 * It tracks subscriptions as well as membership, because a subscription is
 * what authorizes an SDP frame — being in the same channel is not enough, or
 * any member could push an offer into any other member's peer connection.
 */
export class ChannelManager {
  readonly #channels = new Map<string, Channel>();
  /** Reverse index so a disconnect is O(1) and can never leave a stale session. */
  readonly #sessionChannels = new Map<string, string>();
  readonly #limits: ChannelLimits;

  constructor(limits: ChannelLimits) {
    this.#limits = limits;
  }

  get maxViewersPerPublisher(): number {
    return this.#limits.maxViewersPerPublisher;
  }

  get channelCount(): number {
    return this.#channels.size;
  }

  createChannel(sessionId: string, rawName: string): CreateResult {
    const name = sanitizeName(rawName);
    if (name === null) return { ok: false, code: "INVALID_MESSAGE" };

    // Creating a second channel abandons the first; leaving the old membership
    // behind would show a ghost in everyone else's list.
    this.removeSession(sessionId);

    let channelId = generateChannelId();
    while (this.#channels.has(channelId)) channelId = generateChannelId();

    const channel: Channel = { channelId, members: new Map(), createdAt: Date.now() };
    const state = this.#addMember(channel, sessionId, name);
    this.#channels.set(channelId, channel);

    return { ok: true, channelId, member: toMember(state), members: [] };
  }

  joinChannel(channelId: string, sessionId: string, rawName: string): JoinResult {
    const name = sanitizeName(rawName);
    if (name === null) return { ok: false, code: "INVALID_MESSAGE" };

    const channel = this.#channels.get(channelId);
    if (!channel) return { ok: false, code: "CHANNEL_NOT_FOUND" };
    if (channel.members.has(sessionId)) return { ok: false, code: "ALREADY_IN_CHANNEL" };
    if (channel.members.size >= this.#limits.maxMembers) {
      return { ok: false, code: "CHANNEL_FULL" };
    }

    const existing = [...channel.members.values()].map(toMember);
    const state = this.#addMember(channel, sessionId, name);

    return {
      ok: true,
      channelId,
      member: toMember(state),
      members: existing,
      notify: existing.map((m) => m.id),
    };
  }

  setPublishing(sessionId: string, publishing: boolean): PublishResult {
    const channel = this.#channelOf(sessionId);
    const state = channel?.members.get(sessionId);
    if (!channel || !state) return { ok: false, code: "NOT_IN_CHANNEL" };

    state.publishing = publishing;
    // Nobody can watch a stream that no longer exists. Dropping the
    // subscriptions here is what frees the publisher's slots and lets the
    // viewer immediately pick someone else.
    if (!publishing) {
      for (const viewerId of state.watchers) {
        channel.members.get(viewerId)?.watching.delete(sessionId);
      }
      state.watchers.clear();
    }

    return {
      ok: true,
      memberId: sessionId,
      publishing,
      notify: this.#others(channel, sessionId),
    };
  }

  watch(sessionId: string, publisherId: string): WatchResult {
    const channel = this.#channelOf(sessionId);
    const viewer = channel?.members.get(sessionId);
    if (!channel || !viewer) return { ok: false, code: "NOT_IN_CHANNEL" };

    const publisher = channel.members.get(publisherId);
    // Same answer for "not in this channel" and "does not exist": a member
    // must not be able to probe for sessions outside their own channel.
    if (!publisher || publisherId === sessionId) return { ok: false, code: "NOT_AUTHORIZED" };
    if (!publisher.publishing) return { ok: false, code: "NOT_PUBLISHING" };
    if (viewer.watching.has(publisherId)) return { ok: false, code: "ALREADY_WATCHING" };
    if (viewer.watching.size >= MAX_WATCHING_PER_MEMBER) {
      return { ok: false, code: "ALREADY_WATCHING" };
    }
    if (publisher.watchers.size >= this.#limits.maxViewersPerPublisher) {
      return { ok: false, code: "PUBLISHER_FULL" };
    }

    viewer.watching.add(publisherId);
    publisher.watchers.add(sessionId);
    return { ok: true, viewerId: sessionId, publisherId };
  }

  unwatch(sessionId: string, publisherId: string): WatchResult {
    const channel = this.#channelOf(sessionId);
    const viewer = channel?.members.get(sessionId);
    if (!channel || !viewer) return { ok: false, code: "NOT_IN_CHANNEL" };
    if (!viewer.watching.has(publisherId)) return { ok: false, code: "NOT_AUTHORIZED" };

    viewer.watching.delete(publisherId);
    channel.members.get(publisherId)?.watchers.delete(sessionId);
    return { ok: true, viewerId: sessionId, publisherId };
  }

  isSubscribed(viewerId: string, publisherId: string): boolean {
    const channel = this.#channelOf(viewerId);
    return channel?.members.get(viewerId)?.watching.has(publisherId) ?? false;
  }

  sameChannel(a: string, b: string): boolean {
    const channelId = this.#sessionChannels.get(a);
    return channelId !== undefined && channelId === this.#sessionChannels.get(b);
  }

  memberIds(channelId: string): string[] {
    const channel = this.#channels.get(channelId);
    return channel ? [...channel.members.keys()] : [];
  }

  /** Handles both an explicit leave and a dropped socket. */
  removeSession(sessionId: string): RemovalEffect {
    const channelId = this.#sessionChannels.get(sessionId);
    if (channelId === undefined) return { kind: "none" };

    this.#sessionChannels.delete(sessionId);
    const channel = this.#channels.get(channelId);
    if (!channel) return { kind: "none" };

    const state = channel.members.get(sessionId);
    channel.members.delete(sessionId);

    if (state) {
      for (const publisherId of state.watching) {
        channel.members.get(publisherId)?.watchers.delete(sessionId);
      }
      for (const viewerId of state.watchers) {
        channel.members.get(viewerId)?.watching.delete(sessionId);
      }
    }

    const notify = [...channel.members.keys()];
    // An empty channel is not kept warm: its code is free to be reissued, and
    // nothing about it is worth remembering.
    if (channel.members.size === 0) this.#channels.delete(channelId);

    return { kind: "left", channelId, memberId: sessionId, notify };
  }

  #addMember(channel: Channel, sessionId: string, name: string): MemberState {
    const state: MemberState = {
      id: sessionId,
      name: uniqueName(channel, name),
      publishing: false,
      watching: new Set(),
      watchers: new Set(),
    };
    channel.members.set(sessionId, state);
    this.#sessionChannels.set(sessionId, channel.channelId);
    return state;
  }

  #channelOf(sessionId: string): Channel | undefined {
    const channelId = this.#sessionChannels.get(sessionId);
    return channelId === undefined ? undefined : this.#channels.get(channelId);
  }

  #others(channel: Channel, sessionId: string): string[] {
    return [...channel.members.keys()].filter((id) => id !== sessionId);
  }
}

function toMember(state: MemberState): Member {
  return { id: state.id, name: state.name, publishing: state.publishing };
}

/**
 * Two machines on one network genuinely can share a name, and a list with the
 * same label twice is a list nobody can click correctly.
 */
function uniqueName(channel: Channel, name: string): string {
  const taken = new Set([...channel.members.values()].map((m) => m.name));
  if (!taken.has(name)) return name;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${name} (${suffix})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name} (?)`;
}
