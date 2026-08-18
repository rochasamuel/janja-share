import { useCallback, useEffect, useRef, useState } from "react";
import { config } from "../config.js";
import { SharingManager, type SharingSnapshot } from "../features/sharing/sharing-manager.js";
import { createPeerConnection } from "../services/webrtc/peer-connection.js";
import { setAutoHide, setPickerMode } from "../services/panel.js";
import { QUALITY_PRESETS, loadPreset, savePreset, type QualityPreset } from "../services/settings.js";
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
  stats: null,
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
  /** True while Chromium's picker is on screen. */
  picking: boolean;
  preset: QualityPreset;
  setPreset: (preset: QualityPreset) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const managerRef = useRef<SharingManager | null>(null);
  const [snapshot, setSnapshot] = useState<SharingSnapshot>(EMPTY);
  const [picking, setPicking] = useState(false);
  // Read once, at the first render: the stored preset is what the next share
  // uses, and nothing else can change it behind this hook's back.
  const [preset, setStoredPreset] = useState<QualityPreset>(loadPreset);

  if (managerRef.current === null && signaling) {
    managerRef.current = new SharingManager({
      signaling,
      createPeerConnection,
      quality: QUALITY_PRESETS[preset].profile,
      onChange: setSnapshot,
    });
  }

  const setPreset = useCallback((next: QualityPreset) => {
    setStoredPreset(next);
    savePreset(next);
    // Live if a share is running, remembered if not. Either way the manager
    // owns the decision from here.
    void managerRef.current?.setQuality(QUALITY_PRESETS[next].profile);
  }, []);

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
      void setTrayStatus("sharing", `${count} ${count === 1 ? "espectador" : "espectadores"}`);
    } else if (snapshot.state === "error") {
      void setTrayStatus("error", snapshot.message ?? undefined);
    } else if (snapshot.state === "idle") {
      void setTrayStatus("idle");
    }
  }, [snapshot.state, snapshot.viewerIds.length, snapshot.message]);

  return {
    snapshot,
    picking,
    preset,
    setPreset,
    /**
     * Starts capture, growing the window around Chromium's picker.
     *
     * This lives in the hook rather than in a screen's effect because React
     * remounts components in development, and an effect that toggled picker
     * mode would grow and shrink the window in a race — which opened the
     * picker clipped and left the panel displaced.
     */
    start: async () => {
      setPicking(true);
      await setPickerMode(true);
      try {
        await managerRef.current?.start();
      } finally {
        await setPickerMode(false);
        setPicking(false);
      }
    },
    stop: async () => {
      await managerRef.current?.stop();
      await setAutoHide(true);
    },
  };
}
