import type { IceCandidateInit, IceServer, ServerMessage } from "@janja/signaling-protocol";
import type { SignalingClient } from "../../services/signaling/signaling-client.js";
import {
  classifyQuality,
  type ConnectionQuality,
} from "../../services/webrtc/connection-quality.js";
import { StatsTracker } from "../../services/webrtc/stats-tracker.js";

export type ViewingState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface ViewingSnapshot {
  state: ViewingState;
  roomId: string | null;
  quality: ConnectionQuality;
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
  readonly #stats = new StatsTracker();

  #connection: RTCPeerConnection | undefined;
  #unsubscribeSignaling: (() => void) | undefined;
  #sharerId: string | null = null;
  #iceServers: IceServer[] = [];
  /** Candidates that arrive before the offer does; WebRTC rejects those. */
  #pendingCandidates: RTCIceCandidateInit[] = [];

  #state: ViewingState = "idle";
  #roomId: string | null = null;
  #quality: ConnectionQuality = "reconnecting";
  #message: string | null = null;

  constructor(options: ViewingManagerOptions) {
    this.#options = options;
  }

  get snapshot(): ViewingSnapshot {
    return {
      state: this.#state,
      roomId: this.#roomId,
      quality: this.#quality,
      message: this.#message,
    };
  }

  join(roomId: string): void {
    if (this.#state === "connecting" || this.#state === "connected") return;

    this.#roomId = roomId;
    this.#setState("connecting", null);

    this.#unsubscribeSignaling = this.#options.signaling.onMessage((message) => {
      void this.#handleSignalingMessage(message);
    });

    this.#options.signaling.send({ type: "join-room", roomId });
  }

  leave(): void {
    try {
      this.#options.signaling.send({ type: "leave-room" });
    } catch {
      // Nothing to tell the server if the socket is already gone.
    }
    this.#cleanup();
    this.#roomId = null;
    this.#setState("idle", null);
  }

  async pollQuality(): Promise<void> {
    const connection = this.#connection;
    if (!connection || this.#state !== "connected") return;

    try {
      const report = await connection.getStats();
      this.#quality = classifyQuality(
        this.#stats.sample(report, connection.iceConnectionState),
      );
    } catch {
      this.#quality = "reconnecting";
    }
    this.#emit();
  }

  async #handleSignalingMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case "room-joined": {
        this.#sharerId = message.sharerId;
        this.#iceServers = message.iceServers;
        return;
      }

      case "offer": {
        await this.#acceptOffer(message.fromId, message.sdp);
        return;
      }

      case "ice-candidate": {
        await this.#addCandidate(message.candidate);
        return;
      }

      case "room-ended": {
        this.#cleanup();
        this.#setState("disconnected", "The stream has ended.");
        return;
      }

      case "error": {
        this.#cleanup();
        this.#setState("error", viewerErrorMessage(message.code, message.message));
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
        sdp: answer.sdp ?? "",
      });
    } catch {
      this.#setState("error", "Unable to connect to the stream.");
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
      if (!event.candidate || !this.#sharerId) return;
      try {
        this.#options.signaling.send({
          type: "ice-candidate",
          targetId: this.#sharerId,
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
    this.#unsubscribeSignaling?.();
    this.#unsubscribeSignaling = undefined;

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
    this.#sharerId = null;
    this.#pendingCandidates = [];
    this.#stats.reset();
    this.#quality = "reconnecting";
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

function viewerErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case "ROOM_NOT_FOUND":
      return "That room code doesn't match a live stream.";
    case "ROOM_FULL":
      return "This stream is full.";
    default:
      return fallback;
  }
}
