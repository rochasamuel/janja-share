import type { ClientMessage, IceCandidateInit } from "@janja/signaling-protocol";
import { StatsTracker } from "../../services/webrtc/stats-tracker.js";
import { classifyQuality, type ConnectionQuality } from "../../services/webrtc/connection-quality.js";

export type PeerConnectionFactory = () => RTCPeerConnection;

export interface ViewerConnectionManagerOptions {
  createPeerConnection: PeerConnectionFactory;
  send: (message: ClientMessage) => void;
  /** Ceiling, not a target. Congestion control decides the actual rate. */
  maxBitrateBps?: number;
  onViewersChanged?: (viewerIds: string[]) => void;
  onError?: (viewerId: string, error: unknown) => void;
}

interface ViewerEntry {
  readonly connection: RTCPeerConnection;
  readonly stats: StatsTracker;
  quality: ConnectionQuality;
}

const DEFAULT_MAX_BITRATE_BPS = 8_000_000;

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

  constructor(options: ViewerConnectionManagerOptions) {
    this.#options = options;
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
    const entry: ViewerEntry = { connection, stats: new StatsTracker(), quality: "reconnecting" };
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
          entry.quality = classifyQuality(
            entry.stats.sample(report, entry.connection.iceConnectionState),
          );
        } catch {
          entry.quality = "reconnecting";
        }
        results.set(viewerId, entry.quality);
      }),
    );

    return results;
  }

  #applySendParameters(connection: RTCPeerConnection): void {
    const maxBitrate = this.#options.maxBitrateBps ?? DEFAULT_MAX_BITRATE_BPS;

    for (const sender of connection.getSenders()) {
      if (sender.track?.kind !== "video") continue;

      try {
        const parameters = sender.getParameters();
        parameters.encodings = parameters.encodings?.length
          ? parameters.encodings
          : [{}];
        for (const encoding of parameters.encodings) {
          encoding.maxBitrate = maxBitrate;
        }
        // Screen content is unreadable when resolution is sacrificed, so drop
        // frames instead of pixels when bandwidth gets tight.
        parameters.degradationPreference = "maintain-resolution";
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
