import type { ClientMessage, IceCandidateInit } from "@janja/signaling-protocol";
import { StatsTracker } from "../../services/webrtc/stats-tracker.js";
import {
  classifyQuality,
  type ConnectionQuality,
  type QualitySample,
} from "../../services/webrtc/connection-quality.js";
import { aggregateStats, type StreamStats } from "../../services/webrtc/stream-stats.js";
import { applyCodecPreferences } from "../../services/webrtc/peer-connection.js";

export type PeerConnectionFactory = () => RTCPeerConnection;

/** The half of a quality preset that applies to the encoder, not to capture. */
export interface EncodingSettings {
  /** Ceiling, not a target. Congestion control decides the actual rate. */
  maxBitrateBps: number;
  degradationPreference: RTCDegradationPreference;
}

export interface ViewerConnectionManagerOptions {
  createPeerConnection: PeerConnectionFactory;
  send: (message: ClientMessage) => void;
  encoding?: EncodingSettings;
  /** Injected in tests; defaults to the real H.264-first ranking. */
  applyCodecPreferences?: (connection: RTCPeerConnection) => void;
  onViewersChanged?: (viewerIds: string[]) => void;
  onError?: (viewerId: string, error: unknown) => void;
}

interface ViewerEntry {
  readonly connection: RTCPeerConnection;
  readonly stats: StatsTracker;
  quality: ConnectionQuality;
  /** Last reading, or null while this viewer's statistics are unreadable. */
  sample: QualitySample | null;
}

const DEFAULT_ENCODING: EncodingSettings = {
  maxBitrateBps: 8_000_000,
  // Screen content is unreadable when resolution is sacrificed, so drop frames
  // instead of pixels when bandwidth gets tight.
  degradationPreference: "maintain-resolution",
};

/**
 * One peer connection per viewer, and no shared failure paths between them.
 *
 * Everything that can throw is contained per viewer: a viewer whose
 * negotiation fails is dropped on its own and the other five keep their
 * picture. That isolation is the whole reason this is a class and not a
 * loop over an array of connections.
 */
export class ViewerConnectionManager {
  readonly #viewers = new Map<string, ViewerEntry>();
  readonly #options: ViewerConnectionManagerOptions;
  #stream: MediaStream | undefined;
  #encoding: EncodingSettings;

  constructor(options: ViewerConnectionManagerOptions) {
    this.#options = options;
    this.#encoding = options.encoding ?? DEFAULT_ENCODING;
  }

  /** Every viewer's last reading, folded into one. Null before the first poll. */
  get stats(): StreamStats | null {
    const samples = [...this.#viewers.values()]
      .map((entry) => entry.sample)
      .filter((sample): sample is QualitySample => sample !== null);
    return aggregateStats(samples);
  }

  get viewerIds(): string[] {
    return [...this.#viewers.keys()];
  }

  get viewerCount(): number {
    return this.#viewers.size;
  }

  setStream(stream: MediaStream | undefined): void {
    this.#stream = stream;
  }

  qualityFor(viewerId: string): ConnectionQuality | undefined {
    return this.#viewers.get(viewerId)?.quality;
  }

  /** Builds the connection for a new viewer and sends it an offer. */
  async addViewer(viewerId: string): Promise<void> {
    if (this.#viewers.has(viewerId)) return;

    const stream = this.#stream;
    if (!stream) throw new Error("cannot add a viewer before capture has started");

    const connection = this.#options.createPeerConnection();
    // "send": this end of the connection only ever transmits video, so its
    // frame rate and loss live in outbound-rtp and in the receiver's reports.
    const entry: ViewerEntry = {
      connection,
      stats: new StatsTracker("send"),
      quality: "reconnecting",
      sample: null,
    };
    this.#viewers.set(viewerId, entry);
    this.#notifyViewersChanged();

    try {
      connection.onicecandidate = (event) => {
        if (!event.candidate) return;
        this.#safeSend({
          type: "ice-candidate",
          targetId: viewerId,
          candidate: event.candidate.toJSON() as IceCandidateInit,
        });
      };

      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "failed") {
          // Only this viewer goes. The room does not notice.
          this.removeViewer(viewerId);
        }
      };

      for (const track of stream.getTracks()) {
        connection.addTrack(track, stream);
      }

      // Both of these have to happen before the offer exists. The offer is
      // the only one this connection ever makes.
      (this.#options.applyCodecPreferences ?? applyCodecPreferences)(connection);
      this.#applySendParameters(connection);

      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);

      this.#safeSend({ type: "offer", targetId: viewerId, sdp: offer.sdp ?? "" });
    } catch (error) {
      this.removeViewer(viewerId);
      this.#options.onError?.(viewerId, error);
      throw error;
    }
  }

  async handleAnswer(viewerId: string, sdp: string): Promise<void> {
    const entry = this.#viewers.get(viewerId);
    if (!entry) return;

    try {
      await entry.connection.setRemoteDescription({ type: "answer", sdp });
    } catch (error) {
      this.removeViewer(viewerId);
      this.#options.onError?.(viewerId, error);
    }
  }

  async handleIceCandidate(viewerId: string, candidate: IceCandidateInit): Promise<void> {
    const entry = this.#viewers.get(viewerId);
    if (!entry) return;

    try {
      await entry.connection.addIceCandidate(candidate);
    } catch (error) {
      // A rejected candidate is routine — others usually still work — so this
      // is reported but never fatal.
      this.#options.onError?.(viewerId, error);
    }
  }

  removeViewer(viewerId: string): void {
    const entry = this.#viewers.get(viewerId);
    if (!entry) return;

    this.#viewers.delete(viewerId);
    try {
      entry.connection.onicecandidate = null;
      entry.connection.onconnectionstatechange = null;
      entry.connection.close();
    } catch {
      // Closing an already-dead connection is not worth surfacing.
    }
    this.#notifyViewersChanged();
  }

  closeAll(): void {
    for (const viewerId of [...this.#viewers.keys()]) this.removeViewer(viewerId);
  }

  /** Refreshes every viewer's quality reading. Called on a timer. */
  async pollQuality(): Promise<Map<string, ConnectionQuality>> {
    const results = new Map<string, ConnectionQuality>();

    await Promise.all(
      [...this.#viewers.entries()].map(async ([viewerId, entry]) => {
        try {
          const report = await entry.connection.getStats();
          entry.sample = entry.stats.sample(report, entry.connection.iceConnectionState);
          entry.quality = classifyQuality(entry.sample);
        } catch {
          // Drop the reading rather than keep the last one: stale numbers on
          // a dead connection read as a healthy share.
          entry.sample = null;
          entry.quality = "reconnecting";
        }
        results.set(viewerId, entry.quality);
      }),
    );

    return results;
  }

  /**
   * Re-aims every live sender at a new ceiling.
   *
   * This is a parameter change, not a renegotiation: no new offer, no new
   * answer, and nobody watching loses their picture while it takes effect.
   */
  setEncoding(encoding: EncodingSettings): void {
    this.#encoding = encoding;
    for (const entry of this.#viewers.values()) {
      this.#applySendParameters(entry.connection);
    }
  }

  #applySendParameters(connection: RTCPeerConnection): void {
    const { maxBitrateBps, degradationPreference } = this.#encoding;

    for (const sender of connection.getSenders()) {
      if (sender.track?.kind !== "video") continue;

      try {
        const parameters = sender.getParameters();
        parameters.encodings = parameters.encodings?.length
          ? parameters.encodings
          : [{}];
        for (const encoding of parameters.encodings) {
          encoding.maxBitrate = maxBitrateBps;
        }
        parameters.degradationPreference = degradationPreference;
        void sender.setParameters(parameters);
      } catch {
        // Unsupported parameters are not worth failing a session over; WebRTC
        // falls back to its defaults.
      }
    }
  }

  #safeSend(message: ClientMessage): void {
    try {
      this.#options.send(message);
    } catch {
      // A closed signaling socket is handled by the reconnect logic; losing a
      // single candidate here must not tear down the capture.
    }
  }

  #notifyViewersChanged(): void {
    this.#options.onViewersChanged?.(this.viewerIds);
  }
}
