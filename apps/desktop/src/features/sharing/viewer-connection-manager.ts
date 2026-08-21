import type { ClientMessage, IceCandidateInit, ViewSize } from "@janja/signaling-protocol";
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
  /**
   * Our own session id, stamped on everything we send.
   *
   * Two members can watch each other, which is two peer connections between
   * the same pair going opposite ways. Without this the far end cannot tell
   * which of the two an offer belongs to.
   */
  publisherId: string;
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
  /**
   * How much picture this viewer can show. Panel until it says otherwise,
   * because the panel is where every viewer starts.
   */
  size: ViewSize;
}

/**
 * How far down to scale for each size a viewer can report.
 *
 * 1920/3 is 640 device pixels across, and the panel's 312px element at
 * devicePixelRatio 2 needs 624 — so the panel is covered with nothing spent on
 * detail it cannot resolve. Fullscreen gets the picture untouched.
 */
const SCALE_FOR: Record<ViewSize, number> = { panel: 3, fullscreen: 1 };

/**
 * The most frames per second worth encoding for each size a viewer can report.
 *
 * A 312px panel cannot show the difference between 30 and 60 fps, but the
 * sharer pays for every frame twice over — once per viewer, in an encoder that
 * competes with whatever game is running. Fullscreen is left uncapped: there
 * the preset's capture rate is the only ceiling that should apply.
 */
const MAX_FRAMERATE_FOR: Record<ViewSize, number | undefined> = {
  panel: 30,
  fullscreen: undefined,
};

/**
 * The floor under a scaled ceiling.
 *
 * Below this, screen text starts falling apart at any resolution, and the
 * ceiling stops being a limit and becomes a straitjacket.
 */
const MIN_BITRATE_BPS = 500_000;

/**
 * The ceiling for one viewer, scaled to the picture it is actually being sent.
 *
 * Bitrate demand tracks pixel count, and a third of the width is a ninth of
 * the area. Leaving the full-screen ceiling in place for a panel viewer would
 * not save the bandwidth the scaling was for: congestion control probes upward
 * for as long as the link allows, and the encoder would happily spend eight
 * megabits producing a near-lossless 640x360.
 */
function ceilingFor(maxBitrateBps: number, size: ViewSize): number {
  const scale = SCALE_FOR[size];
  return Math.max(MIN_BITRATE_BPS, Math.round(maxBitrateBps / (scale * scale)));
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
      size: "panel",
    };
    this.#viewers.set(viewerId, entry);
    this.#notifyViewersChanged();

    try {
      connection.onicecandidate = (event) => {
        if (!event.candidate) return;
        this.#safeSend({
          type: "ice-candidate",
          targetId: viewerId,
          publisherId: this.#options.publisherId,
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
      this.#applySendParameters(connection, entry.size);

      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);

      this.#safeSend({
        type: "offer",
        targetId: viewerId,
        publisherId: this.#options.publisherId,
        sdp: offer.sdp ?? "",
      });
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
      this.#applySendParameters(entry.connection, entry.size);
    }
  }

  /**
   * A viewer reported how much picture it can show.
   *
   * Like setEncoding, this is a parameter change and not a renegotiation, so
   * going fullscreen costs nobody their picture.
   */
  setViewerSize(viewerId: string, size: ViewSize): void {
    const entry = this.#viewers.get(viewerId);
    if (!entry || entry.size === size) return;
    entry.size = size;
    this.#applySendParameters(entry.connection, size);
  }

  #applySendParameters(connection: RTCPeerConnection, size: ViewSize): void {
    const { maxBitrateBps, degradationPreference } = this.#encoding;

    for (const sender of connection.getSenders()) {
      if (sender.track?.kind !== "video") continue;

      try {
        const parameters = sender.getParameters();
        parameters.encodings = parameters.encodings?.length
          ? parameters.encodings
          : [{}];
        const maxFramerate = MAX_FRAMERATE_FOR[size];
        for (const encoding of parameters.encodings) {
          encoding.maxBitrate = ceilingFor(maxBitrateBps, size);
          encoding.scaleResolutionDownBy = SCALE_FOR[size];
          // Removed, not merely left alone: getParameters hands back whatever
          // the last call set, so a cap applied in the panel would otherwise
          // follow the viewer into fullscreen.
          if (maxFramerate === undefined) delete encoding.maxFramerate;
          else encoding.maxFramerate = maxFramerate;
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
