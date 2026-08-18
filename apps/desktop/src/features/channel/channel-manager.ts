import type { ClientMessage, Member, ServerMessage } from "@janja/signaling-protocol";
import type { SignalingClient } from "../../services/signaling/signaling-client.js";
import { resolveMachineName } from "../../services/machine-name.js";
import type { SharingManager } from "../sharing/sharing-manager.js";
import { watchErrorMessage, type ViewingManager } from "../viewing/viewing-manager.js";

export type ChannelState = "idle" | "joining" | "joined" | "error";

export type ChannelMember = Member;

export interface ChannelSnapshot {
  state: ChannelState;
  channelId: string | null;
  selfId: string | null;
  /** What the server settled on: it deduplicates names within a channel. */
  selfName: string | null;
  /** Everyone but you, publishers first, then by name. */
  members: ChannelMember[];
  message: string | null;
}

export interface ChannelManagerOptions {
  signaling: SignalingClient;
  sharing: SharingManager;
  viewing: ViewingManager;
  /** Injected in tests; defaults to the real native read. */
  readMachineName?: () => Promise<string>;
  onChange?: (snapshot: ChannelSnapshot) => void;
}

/**
 * Membership, and the one subscriber to the signaling socket.
 *
 * Both sub-managers used to subscribe themselves and both handled `offer` and
 * `ice-candidate` blindly, which was only safe because sharing and watching
 * could never run at once. In a channel they run at once by design, so routing
 * lives here and each sub-manager filters on `publisherId`.
 */
export class ChannelManager {
  readonly #options: ChannelManagerOptions;
  readonly #unsubscribe: Array<() => void> = [];

  #state: ChannelState = "idle";
  #channelId: string | null = null;
  #selfId: string | null = null;
  #selfName: string | null = null;
  #members = new Map<string, ChannelMember>();
  #message: string | null = null;
  /** The name we asked to join under, kept for the rejoin after a reconnect. */
  #requestedName: string | null = null;

  constructor(options: ChannelManagerOptions) {
    this.#options = options;

    this.#unsubscribe.push(
      options.signaling.onMessage((message) => {
        void this.#handleMessage(message);
      }),
    );
    this.#unsubscribe.push(
      options.signaling.onStateChange((state) => {
        // A reconnect issues a new session id, so the only way back into the
        // channel is to join it again. Everyone else sees us blink out and in.
        if (state === "connected" && this.#channelId !== null) this.#rejoin();
      }),
    );
  }

  get sharing(): SharingManager {
    return this.#options.sharing;
  }

  get viewing(): ViewingManager {
    return this.#options.viewing;
  }

  get snapshot(): ChannelSnapshot {
    return {
      state: this.#state,
      channelId: this.#channelId,
      selfId: this.#selfId,
      selfName: this.#selfName,
      members: sortMembers([...this.#members.values()]),
      message: this.#message,
    };
  }

  async create(): Promise<void> {
    const displayName = await this.#name();
    this.#requestedName = displayName;
    this.#setState("joining", null);
    this.#send({ type: "create-channel", displayName });
  }

  async join(channelId: string): Promise<void> {
    const displayName = await this.#name();
    this.#requestedName = displayName;
    this.#channelId = channelId;
    this.#setState("joining", null);
    this.#send({ type: "join-channel", channelId, displayName });
  }

  leave(): void {
    this.#options.viewing.stop();
    void this.#options.sharing.stop();
    this.#send({ type: "leave-channel" });

    this.#channelId = null;
    this.#selfId = null;
    this.#selfName = null;
    this.#requestedName = null;
    this.#members.clear();
    this.#setState("idle", null);
  }

  /**
   * Capture first, announcement second.
   *
   * Telling the channel we are live before the picker has been answered would
   * put a badge on a stream that does not exist, and every click on it would
   * fail.
   */
  async startPublishing(): Promise<void> {
    const live = await this.#options.sharing.start();
    if (!live) return;
    this.#send({ type: "publish-start" });
    this.#emit();
  }

  async stopPublishing(): Promise<void> {
    await this.#options.sharing.stop();
    this.#send({ type: "publish-stop" });
    this.#emit();
  }

  watch(publisherId: string): void {
    const member = this.#members.get(publisherId);
    if (!member) return;
    this.#options.viewing.watch(publisherId, member.name);
  }

  stopWatching(): void {
    this.#options.viewing.stop();
  }

  dispose(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe.length = 0;
  }

  async #handleMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case "channel-joined": {
        this.#channelId = message.channelId;
        this.#selfId = message.sessionId;
        this.#selfName = message.displayName;
        this.#members = new Map(message.members.map((member) => [member.id, member]));
        this.#options.sharing.setSession(
          message.sessionId,
          message.iceServers,
          message.maxViewersPerPublisher,
        );
        this.#options.viewing.setSession(message.iceServers);
        this.#setState("joined", null);
        return;
      }

      case "member-joined": {
        this.#members.set(message.member.id, message.member);
        this.#emit();
        return;
      }

      case "member-left": {
        this.#members.delete(message.memberId);
        // Both directions: they may have been watching us, and we may have
        // been watching them. Neither connection can survive their departure.
        this.#options.sharing.removeWatcher(message.memberId);
        await this.#options.viewing.handleMessage(message);
        this.#emit();
        return;
      }

      case "member-publishing": {
        const member = this.#members.get(message.memberId);
        if (member) member.publishing = message.publishing;
        await this.#options.viewing.handleMessage(message);
        this.#emit();
        return;
      }

      case "watch-request": {
        await this.#options.sharing.addWatcher(message.fromId);
        return;
      }

      case "unwatch": {
        this.#options.sharing.removeWatcher(message.fromId);
        return;
      }

      case "offer": {
        await this.#options.viewing.handleMessage(message);
        return;
      }

      case "answer": {
        await this.#options.sharing.handleMessage(message);
        return;
      }

      case "ice-candidate": {
        // Handed to both. Each one drops what does not match its publisherId,
        // which is cheaper and safer than deciding here from stale state.
        await this.#options.viewing.handleMessage(message);
        await this.#options.sharing.handleMessage(message);
        return;
      }

      case "error": {
        this.#handleError(message.code, message.message);
        return;
      }

      default:
        return;
    }
  }

  /**
   * Errors carry no publisherId, so the state decides who they belong to: a
   * viewing session still connecting is the only thing that could have caused
   * one that is not about membership.
   */
  #handleError(code: string, fallback: string): void {
    if (this.#options.viewing.snapshot.state === "connecting") {
      this.#options.viewing.fail(watchErrorMessage(code, fallback));
      return;
    }
    this.#setState("error", channelErrorMessage(code, fallback));
  }

  #rejoin(): void {
    const channelId = this.#channelId;
    const displayName = this.#requestedName;
    if (channelId === null || displayName === null) return;
    this.#setState("joining", null);
    this.#send({ type: "join-channel", channelId, displayName });
  }

  async #name(): Promise<string> {
    const read = this.#options.readMachineName ?? (() => resolveMachineName());
    return await read();
  }

  #send(message: ClientMessage): void {
    try {
      this.#options.signaling.send(message);
    } catch {
      // The socket is down and reconnecting. Membership is re-established by
      // the rejoin above, so there is nothing useful to queue here.
    }
  }

  #setState(state: ChannelState, message: string | null): void {
    this.#state = state;
    this.#message = message;
    this.#emit();
  }

  #emit(): void {
    this.#options.onChange?.(this.snapshot);
  }
}

/** Publishers first — the only rows worth clicking — then alphabetical. */
function sortMembers(members: ChannelMember[]): ChannelMember[] {
  return [...members].sort((a, b) => {
    if (a.publishing !== b.publishing) return a.publishing ? -1 : 1;
    return a.name.localeCompare(b.name, "pt-BR");
  });
}

function channelErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case "CHANNEL_NOT_FOUND":
      return "Esse código não corresponde a nenhum canal.";
    case "CHANNEL_FULL":
      return "Esse canal está cheio.";
    case "ALREADY_IN_CHANNEL":
      return "Você já está nesse canal.";
    default:
      return fallback;
  }
}
