import { useEffect, useRef, useState } from "react";
import { config } from "../config.js";
import { SharingManager, type SharingSnapshot } from "../features/sharing/sharing-manager.js";
import { createPeerConnection } from "../services/webrtc/peer-connection.js";
import { setTrayStatus } from "../services/tray-status.js";
import type { SignalingClient } from "../services/signaling/signaling-client.js";

const EMPTY: SharingSnapshot = {
  state: "idle",
  roomId: null,
  viewerIds: [],
  maxViewers: 6,
  audioSource: "none",
  audioProcess: null,
  message: null,
  quality: new Map(),
};

/**
 * Owns the sharing session for the whole app, not for one screen.
 *
 * It has to live above the screens: closing the panel or navigating home must
 * not stop a share, and the menu's status card reports on it from outside the
 * sharing screen.
 */
export function useSharing(signaling: SignalingClient | null): {
  snapshot: SharingSnapshot;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const managerRef = useRef<SharingManager | null>(null);
  const [snapshot, setSnapshot] = useState<SharingSnapshot>(EMPTY);

  if (managerRef.current === null && signaling) {
    managerRef.current = new SharingManager({
      signaling,
      createPeerConnection,
      onChange: setSnapshot,
    });
  }

  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;

    const timer = setInterval(() => {
      void manager.pollQuality();
    }, config.qualityIntervalMs);

    return () => clearInterval(timer);
  }, [signaling]);

  useEffect(() => {
    if (snapshot.state === "sharing") {
      const count = snapshot.viewerIds.length;
      void setTrayStatus("sharing", `${count} ${count === 1 ? "viewer" : "viewers"}`);
    } else if (snapshot.state === "error") {
      void setTrayStatus("error", snapshot.message ?? undefined);
    } else if (snapshot.state === "idle") {
      void setTrayStatus("idle");
    }
  }, [snapshot.state, snapshot.viewerIds.length, snapshot.message]);

  return {
    snapshot,
    start: async () => {
      await managerRef.current?.start();
    },
    stop: async () => {
      await managerRef.current?.stop();
    },
  };
}
