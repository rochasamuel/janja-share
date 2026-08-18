import type { IceCandidateInit, IceServer, ServerMessage } from "@janja/signaling-protocol";
import type { SignalingClient } from "../../services/signaling/signaling-client.js";
import {
  classifyQuality,
  type ConnectionQuality,
} from "../../services/webrtc/connection-quality.js";
import { StatsTracker } from "../../services/webrtc/stats-tracker.js";
import { aggregateStats, type StreamStats } from "../../services/webrtc/stream-stats.js";

export type ViewingState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface ViewingSnapshot {
  state: ViewingState;
  publisherId: string | null;
  publisherName: string | null;
  quality: ConnectionQuality;
  /** The measurements behind that verdict, or null before the first poll. */
  stats: StreamStats | null;
  /** A short sentence fit to show a person, or null. */
  message: string | null;
}

export interface ViewingManagerOptions {
  signaling: SignalingClient;
  createPeerConnection: (iceServers: IceServer[]) => RTCPeerConnection;
  /** Hands the incoming stream to the <video> element. */
  onStream?: (stream: MediaStream | null) => void;
  onChange?: (snapshot: ViewingSnapshot) => void;
}

/** Drives one viewing session: join a room, answer the sharer, render. */
export class ViewingManager {
  readonly #options: ViewingManagerOptions;
  // "receive": this end only ever decodes, so its numbers live in inbound-rtp.
  readonly #stats = new StatsTracker("receive");

  #connection: RTCPeerConnection | undefined;
  #iceServers: IceServer[] = [];
  /** Candidates that arrive before the offer does; WebRTC rejects those. */
  #pendingCandidates: RTCIceCandidateInit[] = [];

  #state: ViewingState = "idle";
  #publisherId: string | null = null;
  #publisherName: string | null = null;
  /**
   * Whether the server still holds a subscription for us.
   *
   * It does not survive the publisher stopping or leaving — the server drops
   * it on its own — and unwatching one that is already gone earns a refusal
   * the person did nothing to deserve.
   */
  #subscribed = false;
  #quality: ConnectionQuality = "reconnecting";
  #streamStats: StreamStats | null = null;
  #message: string | null = null;

  constructor(options: ViewingManagerOptions) {
    this.#options = options;
  }

  get snapshot(): ViewingSnapshot {
    return {
      state: this.#state,
      publisherId: this.#publisherId,
      publisherName: this.#publisherName,
      quality: this.#quality,
      stats: this.#streamStats,
      message: this.#message,
    };
  }

  /** Told to us by the channel on join, and again after a reconnect. */
  setSession(iceServers: IceServer[]): void {
    this.#iceServers = iceServers;
  }

  /**
   * The click. Nothing was connected before this, and the publisher builds the
   * connection — we only answer.
   */
  watch(publisherId: string, publisherName: string): void {
    if (this.#state === "connecting" || this.#state === "connected") return;

    this.#publisherId = publisherId;
    this.#publisherName = publisherName;
    this.#setState("connecting", null);

    try {
      this.#options.signaling.send({ type: "watch", publisherId });
      this.#subscribed = true;
    } catch {
      this.#setState("error", "Sem conexão com o servidor.");
    }
  }

  stop(): void {
    const publisherId = this.#publisherId;
    if (publisherId !== null && this.#subscribed) {
      try {
        this.#options.signaling.send({ type: "unwatch", publisherId });
      } catch {
        // Nothing to tell the server if the socket is already gone; it drops
        // the subscription when the socket does.
      }
    }
    this.#cleanup();
    this.#publisherId = null;
    this.#publisherName = null;
    this.#setState("idle", null);
  }

  /** The channel routes a server error here while we are still connecting. */
  fail(message: string): void {
    this.#cleanup();
    this.#setState("error", message);
  }

  async pollQuality(): Promise<void> {
    const connection = this.#connection;
    if (!connection || this.#state !== "connected") return;

    try {
      const report = await connection.getStats();
      const sample = this.#stats.sample(report, connection.iceConnectionState);
      this.#quality = classifyQuality(sample);
      this.#streamStats = aggregateStats([sample]);
    } catch {
      // Stale numbers on a dead connection read as a healthy stream.
      this.#quality = "reconnecting";
      this.#streamStats = null;
    }
    this.#emit();
  }

  /**
   * Handles only what belongs to the one stream we are watching.
   *
   * Every check against `#publisherId` matters: the same socket carries the
   * stream we publish, and an answer or a candidate from that connection must
   * never reach this one.
   */
  async handleMessage(message: ServerMessage): Promise<void> {
    const publisherId = this.#publisherId;
    if (publisherId === null) return;

    switch (message.type) {
      case "offer": {
        if (message.publisherId !== publisherId) return;
        await this.#acceptOffer(publisherId, message.sdp);
        return;
      }

      case "ice-candidate": {
        if (message.publisherId !== publisherId) return;
        await this.#addCandidate(message.candidate);
        return;
      }

      case "member-publishing": {
        if (message.memberId !== publisherId || message.publishing) return;
        this.#cleanup();
        this.#setState("disconnected", `${this.#publisherName} parou de compartilhar.`);
        return;
      }

      case "member-left": {
        if (message.memberId !== publisherId) return;
        this.#cleanup();
        this.#setState("disconnected", `${this.#publisherName} saiu do canal.`);
        return;
      }

      default:
        return;
    }
  }

  /**
   * Handles the initial offer and every re-offer. An ICE restart arrives as a
   * fresh offer on the same connection, so this must not assume it is new.
   */
  async #acceptOffer(fromId: string, sdp: string): Promise<void> {
    try {
      const connection = this.#connection ?? this.#createConnection();

      await connection.setRemoteDescription({ type: "offer", sdp });

      // Candidates that outran the offer can be applied now.
      for (const candidate of this.#pendingCandidates) {
        await connection.addIceCandidate(candidate).catch(() => {});
      }
      this.#pendingCandidates = [];

      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);

      this.#options.signaling.send({
        type: "answer",
        targetId: fromId,
        publisherId: fromId,
        sdp: answer.sdp ?? "",
      });
    } catch {
      this.#setState("error", "Não foi possível conectar à transmissão.");
    }
  }

  async #addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    const connection = this.#connection;
    if (!connection || !connection.remoteDescription) {
      this.#pendingCandidates.push(candidate);
      return;
    }
    await connection.addIceCandidate(candidate).catch(() => {
      // One unusable candidate is normal; others generally still work.
    });
  }

  #createConnection(): RTCPeerConnection {
    const connection = this.#options.createPeerConnection(this.#iceServers);
    this.#connection = connection;
    this.#stats.reset();

    connection.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) this.#options.onStream?.(stream);
    };

    connection.onicecandidate = (event) => {
      const publisherId = this.#publisherId;
      if (!event.candidate || publisherId === null) return;
      try {
        this.#options.signaling.send({
          type: "ice-candidate",
          targetId: publisherId,
          publisherId,
          candidate: event.candidate.toJSON() as IceCandidateInit,
        });
      } catch {
        // Reconnection logic owns the socket; a lost candidate is survivable.
      }
    };

    connection.onconnectionstatechange = () => {
      switch (connection.connectionState) {
        case "connected":
          this.#setState("connected", null);
          break;
        case "disconnected":
          // Not fatal on its own: ICE often recovers within a few seconds.
          this.#setState("reconnecting", null);
          break;
        case "failed":
          this.#setState("reconnecting", null);
          break;
        case "closed":
          this.#setState("disconnected", null);
          break;
        default:
          break;
      }
    };

    return connection;
  }

  #cleanup(): void {
    if (this.#connection) {
      this.#connection.ontrack = null;
      this.#connection.onicecandidate = null;
      this.#connection.onconnectionstatechange = null;
      try {
        this.#connection.close();
      } catch {
        // Already closed.
      }
    }
    this.#connection = undefined;
    this.#subscribed = false;
    this.#pendingCandidates = [];
    this.#stats.reset();
    this.#quality = "reconnecting";
    this.#streamStats = null;
    this.#options.onStream?.(null);
  }

  #setState(state: ViewingState, message: string | null): void {
    this.#state = state;
    this.#message = message;
    this.#emit();
  }

  #emit(): void {
    this.#options.onChange?.(this.snapshot);
  }
}

/**
 * Turns a server refusal into something a person can act on.
 *
 * The server's own text is never shown. It is written for whoever is reading
 * the logs — in English, about sessions and peers — and this panel is in
 * Portuguese, talking about people and screens.
 */
export function watchErrorMessage(code: string): string {
  switch (code) {
    case "NOT_PUBLISHING":
      return "Essa pessoa parou de compartilhar.";
    case "PUBLISHER_FULL":
      return "Essa transmissão está lotada.";
    case "ALREADY_WATCHING":
      return "Você só pode assistir a uma transmissão por vez.";
    default:
      return "Não foi possível abrir essa transmissão.";
  }
}
