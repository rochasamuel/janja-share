import type { IceServer, ServerMessage } from "@janja/signaling-protocol";
import type { SignalingClient } from "../../services/signaling/signaling-client.js";
import type { ConnectionQuality } from "../../services/webrtc/connection-quality.js";
import {
  CaptureCancelledError,
  onCaptureEnded,
  startCapture,
  stopCapture,
  type AudioSource,
  type CaptureOptions,
} from "./screen-capture.js";
import { ViewerConnectionManager } from "./viewer-connection-manager.js";

export type SharingState = "idle" | "starting" | "sharing" | "stopping" | "error";

export interface SharingSnapshot {
  state: SharingState;
  roomId: string | null;
  viewerIds: string[];
  maxViewers: number;
  audioSource: AudioSource;
  /** Which app the sound belongs to, when it is per-app. */
  audioProcess: string | null;
  /** A short sentence fit to show a person, or null. */
  message: string | null;
  quality: Map<string, ConnectionQuality>;
}

export interface SharingManagerOptions {
  signaling: SignalingClient;
  createPeerConnection: (iceServers: IceServer[]) => RTCPeerConnection;
  capture?: CaptureOptions;
  onChange?: (snapshot: SharingSnapshot) => void;
}

/**
 * Drives one sharing session: capture, room, and every viewer connection.
 *
 * It holds the MediaStream and the peer connections so React never does. A
 * re-render must not be able to restart a capture.
 */
export class SharingManager {
  readonly #options: SharingManagerOptions;
  #viewers: ViewerConnectionManager | undefined;
  #stream: MediaStream | undefined;
  #stopCaptureListener: (() => void) | undefined;
  #unsubscribeSignaling: (() => void) | undefined;
  #iceServers: IceServer[] = [];

  #state: SharingState = "idle";
  #roomId: string | null = null;
  #maxViewers = 6;
  #audioSource: AudioSource = "none";
  #audioProcess: string | null = null;
  #stopAudio: (() => Promise<void>) | undefined;
  #message: string | null = null;
  #quality = new Map<string, ConnectionQuality>();

  constructor(options: SharingManagerOptions) {
    this.#options = options;
  }

  get snapshot(): SharingSnapshot {
    return {
      state: this.#state,
      roomId: this.#roomId,
      viewerIds: this.#viewers?.viewerIds ?? [],
      maxViewers: this.#maxViewers,
      audioSource: this.#audioSource,
      audioProcess: this.#audioProcess,
      message: this.#message,
      quality: new Map(this.#quality),
    };
  }

  /**
   * Capture first, room second. Asking the network for a room before the user
   * has agreed to share their screen would leave a live empty room behind
   * every time someone presses cancel.
   */
  async start(): Promise<void> {
    if (this.#state !== "idle" && this.#state !== "error") return;

    this.#setState("starting", null);

    try {
      const capture = await startCapture(this.#options.capture);
      this.#stream = capture.stream;
      this.#audioSource = capture.audioSource;
      this.#audioProcess = capture.audioProcess ?? null;
      this.#stopAudio = capture.stopAudio;
      const stream = capture.stream;

      this.#stopCaptureListener = onCaptureEnded(stream, () => {
        // Windows' own stop button ended it; the UI must not keep saying LIVE.
        void this.stop();
      });

      this.#unsubscribeSignaling = this.#options.signaling.onMessage((message) => {
        void this.#handleSignalingMessage(message);
      });

      this.#options.signaling.send({ type: "create-room" });

      this.#emit();
    } catch (error) {
      this.#cleanup();
      if (error instanceof CaptureCancelledError) {
        this.#setState("idle", null);
        return;
      }
      this.#setState("error", "Unable to capture your screen.");
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "idle" || this.#state === "stopping") return;

    this.#setState("stopping", null);

    try {
      this.#options.signaling.send({ type: "leave-room" });
    } catch {
      // Already disconnected; the server drops the room when the socket does.
    }

    this.#cleanup();
    this.#roomId = null;
    this.#setState("idle", null);
  }

  /** Refreshes each viewer's quality reading. Driven by a timer in the UI. */
  async pollQuality(): Promise<void> {
    if (!this.#viewers || this.#state !== "sharing") return;
    this.#quality = await this.#viewers.pollQuality();
    this.#emit();
  }

  async #handleSignalingMessage(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case "room-created": {
        this.#roomId = message.roomId;
        this.#maxViewers = message.maxViewers;
        this.#iceServers = message.iceServers;

        this.#viewers = new ViewerConnectionManager({
          createPeerConnection: () => this.#options.createPeerConnection(this.#iceServers),
          send: (outbound) => this.#options.signaling.send(outbound),
          onViewersChanged: () => this.#emit(),
          onError: () => this.#emit(),
        });
        this.#viewers.setStream(this.#stream);

        this.#setState("sharing", audioMessage(this.#audioSource, this.#audioProcess));
        return;
      }

      case "viewer-joined": {
        try {
          await this.#viewers?.addViewer(message.viewerId);
        } catch {
          // Already isolated and cleaned up inside the manager; the room and
          // every other viewer carry on.
        }
        this.#emit();
        return;
      }

      case "viewer-left": {
        this.#viewers?.removeViewer(message.viewerId);
        this.#quality.delete(message.viewerId);
        this.#emit();
        return;
      }

      case "answer": {
        await this.#viewers?.handleAnswer(message.fromId, message.sdp);
        return;
      }

      case "ice-candidate": {
        await this.#viewers?.handleIceCandidate(message.fromId, message.candidate);
        return;
      }

      case "error": {
        // ROOM_FULL is the server refusing a viewer, not a fault in this
        // session, so it must never stop the people already watching.
        if (message.code === "ROOM_FULL") return;
        this.#setState("error", "Something went wrong with the connection.");
        return;
      }

      default:
        return;
    }
  }

  #cleanup(): void {
    this.#stopCaptureListener?.();
    this.#stopCaptureListener = undefined;

    this.#unsubscribeSignaling?.();
    this.#unsubscribeSignaling = undefined;

    this.#viewers?.closeAll();
    this.#viewers = undefined;

    stopCapture(this.#stream);
    this.#stream = undefined;

    // Releases the native capture thread; without this it keeps running and
    // holding the process open after the share ends.
    void this.#stopAudio?.();
    this.#stopAudio = undefined;

    this.#quality.clear();
    this.#audioSource = "none";
    this.#audioProcess = null;
  }

  #setState(state: SharingState, message: string | null): void {
    this.#state = state;
    this.#message = message;
    this.#emit();
  }

  #emit(): void {
    this.#options.onChange?.(this.snapshot);
  }
}

function audioMessage(source: AudioSource, process: string | null): string | null {
  switch (source) {
    case "app":
      // Silence is the right answer when it worked: the readout already says
      // which app, and a banner for success is noise.
      return null;
    case "system":
      return "Sharing the whole computer's sound — anyone in a voice call with you will be heard too.";
    case "none":
      return "Sharing without sound. Stop and share again, ticking the audio option in the Windows picker.";
  }
}
