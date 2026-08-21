import type { IceServer } from "@janja/signaling-protocol";

/**
 * Every RTCPeerConnection in the app is built here, so codec preference and
 * ICE policy are decided once rather than drifting between sharer and viewer.
 */
export function createPeerConnection(iceServers: IceServer[]): RTCPeerConnection {
  const connection = new RTCPeerConnection({
    iceServers: iceServers.map((server) => ({
      urls: server.urls,
      ...(server.username === undefined ? {} : { username: server.username }),
      ...(server.credential === undefined ? {} : { credential: server.credential }),
    })),
    // Pooling a candidate up front shaves a round trip off the first connect.
    iceCandidatePoolSize: 1,
    ...(forceRelay() ? { iceTransportPolicy: "relay" as const } : {}),
  });

  return connection;
}

/**
 * Set VITE_FORCE_RELAY=1 to discard direct candidates and prove the TURN path
 * works. Without this you cannot tell a working relay from a connection that
 * quietly succeeded peer-to-peer.
 */
function forceRelay(): boolean {
  return import.meta.env["VITE_FORCE_RELAY"] === "1";
}

/**
 * How much each video codec is worth to us, best first.
 *
 * H.264 leads because it is the only codec measured here that both holds
 * 1080p60 and has hardware encoding on essentially every Windows machine. That
 * matters more than it looks: the sharer runs one encoder per viewer, so
 * per-frame cost is multiplied by the size of the audience.
 *
 * Within H.264, **profile** is what this used to get wrong. Filtering on the
 * mime type alone left Chromium's own ordering intact, and Chromium lists
 * Baseline first — so every share this app has ever sent went out as
 * Constrained Baseline. Measured at 1080p inside a 2.5 Mbps ceiling
 * (`spikes/codec-probe`, PSNR against the source frame):
 *
 *     H.264 High  35.3 dB      VP9   34.8 dB      H.264 Main  34.3 dB
 *     VP8         34.4 dB      AV1   33.9 dB      H.264 Base  33.2 dB
 *
 * High costs 2.1 dB over Baseline for nothing but a reordering — same bitrate,
 * same encode time — because it adds CABAC and the 8x8 transform.
 *
 * **Level is deliberately not ranked.** Levels 3.1, 4.0 and 5.0 measured
 * within 0.2 dB of each other, which is noise. Only the profile is worth
 * asking for.
 *
 * VP9 is the fallback: close on quality, but it held only 37 fps where H.264
 * held 50+. AV1 is last despite being the newest — 15.8 fps at 10.6 ms per
 * frame, which one viewer might survive and four would not.
 */
const H264_PROFILE_ORDER = [0x64, 0x4d, 0x42]; // High, Main, Baseline

function h264Score(codec: RTCRtpCodec): number {
  const fmtp = codec.sdpFmtpLine ?? "";
  const profile = /profile-level-id=([0-9a-f]{2})/i.exec(fmtp);
  const rank = profile ? H264_PROFILE_ORDER.indexOf(Number.parseInt(profile[1]!, 16)) : -1;
  // Unknown profiles sort below every known one rather than above Baseline:
  // we would rather ship a profile we have measured.
  const profileScore = rank === -1 ? 0 : (H264_PROFILE_ORDER.length - rank) * 10;
  // Mode 1 lets one frame span several packets. Mode 0 caps a NAL unit at the
  // MTU, which at 1080p means splitting work the encoder should not have to.
  return profileScore + (/packetization-mode=1/.test(fmtp) ? 1 : 0);
}

const IS_H264 = /h264/i;
const IS_VP9 = /vp9/i;
const IS_AV1 = /av01|av1/i;

/**
 * Orders a capability list best-first. Split out from the transceiver walk
 * below so the ranking can be tested without a peer connection.
 */
export function rankVideoCodecs(
  codecs: readonly RTCRtpCodec[],
): RTCRtpCodec[] {
  const is = (re: RegExp) => (c: RTCRtpCodec) => re.test(c.mimeType);
  const h264 = codecs.filter(is(IS_H264)).sort((a, b) => h264Score(b) - h264Score(a));
  const vp9 = codecs.filter(is(IS_VP9));
  const av1 = codecs.filter(is(IS_AV1));
  const rest = codecs.filter(
    (c) => !IS_H264.test(c.mimeType) && !IS_VP9.test(c.mimeType) && !IS_AV1.test(c.mimeType),
  );
  return [...h264, ...vp9, ...rest, ...av1];
}

/**
 * Applies that ranking to every video transceiver that already has a track.
 *
 * **Call this after addTrack and before createOffer.** It used to run from a
 * `negotiationneeded` listener, but that event is delivered in a queued task,
 * so it fired after `createOffer` had already been called — and since the
 * sharer never re-negotiates, the preference reached the wire for nobody.
 */
export function applyCodecPreferences(connection: RTCPeerConnection): void {
  // Reached through globalThis so this stays callable outside a browser, where
  // the identifier itself does not exist and a bare reference would throw.
  const sender = globalThis.RTCRtpSender as typeof RTCRtpSender | undefined;
  const capabilities = sender?.getCapabilities?.("video");
  if (!capabilities) return;

  const ranked = rankVideoCodecs(capabilities.codecs);

  for (const transceiver of connection.getTransceivers?.() ?? []) {
    if (transceiver.sender.track?.kind !== "video") continue;
    try {
      transceiver.setCodecPreferences?.(ranked);
    } catch {
      // Unsupported ordering is not worth failing a session over.
    }
  }
}
