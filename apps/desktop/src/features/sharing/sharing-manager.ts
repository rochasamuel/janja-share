import type { IceServer, ServerMessage } from "@janja/signaling-protocol";
import type { SignalingClient } from "../../services/signaling/signaling-client.js";
import { QUALITY_PRESETS, type QualityProfile } from "../../services/settings.js";
import type { ConnectionQuality } from "../../services/webrtc/connection-quality.js";
import type { StreamStats } from "../../services/webrtc/stream-stats.js";
import {
  CaptureCancelledError,
  onCaptureEnded,
  startCapture,
  stopCapture,
  type AudioSource,
  type CaptureOptions,
} from "./screen-capture.js";
import { ViewerConnectionManager, type EncodingSettings } from "./viewer-connection-manager.js";

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
  /** Every viewer's measurements folded into one, or null before the first poll. */
  stats: StreamStats | null;
}

export interface SharingManagerOptions {
  signaling: SignalingClient;
  createPeerConnection: (iceServers: IceServer[]) => RTCPeerConnection;
  capture?: CaptureOptions;
  /** Starting preset. Changed later with setQuality, including mid-share. */
  quality?: QualityProfile;
  onChange?: (snapshot: SharingSnapshot) => void;
}

function encodingOf(profile: QualityProfile): EncodingSettings {
  return {
    maxBitrateBps: profile.maxBitrateBps,
    degradationPreference: profile.degradationPreference,
  };
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
  #profile: QualityProfile;
  #stats: StreamStats | null = null;

  constructor(options: SharingManagerOptions) {
    this.#options = options;
    this.#profile = options.quality ?? QUALITY_PRESETS.auto.profile;
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
      stats: this.#stats,
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
      const capture = await startCapture({
        ...this.#options.capture,
        width: this.#profile.width,
        height: this.#profile.height,
        frameRate: this.#profile.frameRate,
        contentHint: this.#profile.contentHint,
      });
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
      this.#setState("error", "Não foi possível capturar a sua tela.");
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
    this.#stats = this.#viewers.stats;
    this.#emit();
  }

  /**
   * Switches preset, live if a share is running.
   *
   * Constraints and encoder parameters both change without renegotiating, so
   * nobody watching loses their picture over a preference change. A preset
   * chosen while idle simply waits for the next capture.
   */
  async setQuality(profile: QualityProfile): Promise<void> {
    this.#profile = profile;
    this.#viewers?.setEncoding(encodingOf(profile));

    const track = this.#stream?.getVideoTracks()[0];
    if (track) {
      // Settable on a live track, and the encoder picks it up without any
      // renegotiation — so switching to the game preset mid-session works.
      track.contentHint = profile.contentHint;
      try {
        await track.applyConstraints({
          // `ideal`, never `exact`, for the same reason as in startCapture: an
          // exact demand a source cannot meet ends the track instead of
          // adjusting it.
          width: { ideal: profile.width },
          height: { ideal: profile.height },
          frameRate: { ideal: profile.frameRate },
        });
      } catch {
        // Some capture sources refuse to be re-sized once running. The picture
        // keeps its old dimensions; the bitrate ceiling still moved, and that
        // is the larger of the two levers.
      }
    }

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
          encoding: encodingOf(this.#profile),
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
        this.#setState("error", "Algo deu errado na conexão.");
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
    this.#stats = null;
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
      return "Compartilhando o som do computador inteiro — quem estiver numa chamada de voz com você também vai ser ouvido.";
    case "none":
      return "Compartilhando sem som. Pare e comece de novo, marcando a opção de áudio no seletor do Windows.";
  }
}
