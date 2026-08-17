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

  preferCodecs(connection);
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
 * Screen content is text and straight edges. H.264 has hardware encoding on
 * essentially every Windows machine, which keeps the sharer's CPU free while
 * it uploads a copy of the stream per viewer; VP9 is the fallback.
 */
function preferCodecs(connection: RTCPeerConnection): void {
  const capabilities = RTCRtpSender.getCapabilities?.("video");
  if (!capabilities) return;

  const ranked = [
    ...capabilities.codecs.filter((c) => /h264/i.test(c.mimeType)),
    ...capabilities.codecs.filter((c) => /vp9/i.test(c.mimeType)),
    ...capabilities.codecs.filter((c) => !/h264|vp9/i.test(c.mimeType)),
  ];

  connection.addEventListener("negotiationneeded", () => {
    for (const transceiver of connection.getTransceivers()) {
      if (transceiver.sender.track?.kind !== "video") continue;
      try {
        transceiver.setCodecPreferences?.(ranked);
      } catch {
        // Unsupported ordering is not worth failing a session over.
      }
    }
  });
}
