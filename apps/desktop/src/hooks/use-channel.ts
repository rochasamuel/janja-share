import { useCallback, useEffect, useRef, useState } from "react";
import { config } from "../config.js";
import { ChannelManager, type ChannelSnapshot } from "../features/channel/channel-manager.js";
import { SharingManager, type SharingSnapshot } from "../features/sharing/sharing-manager.js";
import { ViewingManager, type ViewingSnapshot } from "../features/viewing/viewing-manager.js";
import { createPeerConnection } from "../services/webrtc/peer-connection.js";
import { setAutoHide, setPickerMode } from "../services/panel.js";
import {
  QUALITY_PRESETS,
  loadPreset,
  savePreset,
  type QualityPreset,
} from "../services/settings.js";
import type { SignalingClient } from "../services/signaling/signaling-client.js";

export interface UseChannel {
  channel: ChannelSnapshot;
  sharing: SharingSnapshot;
  viewing: ViewingSnapshot;
  /** True while Chromium's picker is on screen. */
  picking: boolean;
  preset: QualityPreset;
  setPreset: (preset: QualityPreset) => void;
  create: () => Promise<void>;
  join: (channelId: string) => Promise<void>;
  leave: () => void;
  startPublishing: () => Promise<void>;
  stopPublishing: () => Promise<void>;
  watch: (publisherId: string) => void;
  stopWatching: () => void;
  attachVideo: (element: HTMLVideoElement | null) => void;
}

const EMPTY_CHANNEL: ChannelSnapshot = {
  state: "idle",
  channelId: null,
  selfId: null,
  selfName: null,
  members: [],
  message: null,
};

const EMPTY_SHARING: SharingSnapshot = {
  state: "idle",
  viewerIds: [],
  maxViewers: 6,
  audioSource: "none",
  audioProcess: null,
  message: null,
  quality: new Map(),
  stats: null,
};

const EMPTY_VIEWING: ViewingSnapshot = {
  state: "idle",
  publisherId: null,
  publisherName: null,
  quality: "reconnecting",
  stats: null,
  message: null,
};

/**
 * One channel for the life of the app, held in a ref.
 *
 * It must not live in React state for the same reason the signaling client
 * does not: a re-render that replaced it would drop every peer connection
 * being negotiated through it. Closing the panel or navigating home must not
 * end a share or a stream.
 */
export function useChannel(signaling: SignalingClient | null): UseChannel {
  const managerRef = useRef<ChannelManager | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [channel, setChannel] = useState<ChannelSnapshot>(EMPTY_CHANNEL);
  const [sharing, setSharing] = useState<SharingSnapshot>(EMPTY_SHARING);
  const [viewing, setViewing] = useState<ViewingSnapshot>(EMPTY_VIEWING);
  const [picking, setPicking] = useState(false);
  // Read once, at the first render: the stored preset is what the next share
  // uses, and nothing else can change it behind this hook's back.
  const [preset, setStoredPreset] = useState<QualityPreset>(loadPreset);

  if (managerRef.current === null && signaling) {
    const sharingManager = new SharingManager({
      signaling,
      createPeerConnection,
      quality: QUALITY_PRESETS[preset].profile,
      onChange: setSharing,
    });

    const viewingManager = new ViewingManager({
      signaling,
      createPeerConnection,
      onChange: setViewing,
      // Straight to the element: no canvas, no frame copying, which is what
      // keeps WebView2's hardware decode path intact.
      onStream: (stream) => {
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      },
    });

    managerRef.current = new ChannelManager({
      signaling,
      sharing: sharingManager,
      viewing: viewingManager,
      onChange: setChannel,
    });
  }

  const setPreset = useCallback((next: QualityPreset) => {
    setStoredPreset(next);
    savePreset(next);
    // Live if a share is running, remembered if not. Either way the manager
    // owns the decision from here.
    void managerRef.current?.sharing.setQuality(QUALITY_PRESETS[next].profile);
  }, []);

  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;

    const timer = setInterval(() => {
      void manager.sharing.pollQuality();
      void manager.viewing.pollQuality();
    }, config.qualityIntervalMs);

    return () => {
      clearInterval(timer);
      manager.dispose();
    };
  }, [signaling]);

  /**
   * The video element mounts and unmounts as the user moves between screens,
   * but the stream outlives it. Re-attaching on mount is what keeps the
   * picture from coming back black.
   */
  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    if (element) element.srcObject = streamRef.current;
  }, []);

  const create = useCallback(async () => {
    await managerRef.current?.create();
  }, []);

  const join = useCallback(async (channelId: string) => {
    await managerRef.current?.join(channelId);
  }, []);

  const leave = useCallback(() => {
    managerRef.current?.leave();
    void setAutoHide(true);
  }, []);

  /**
   * Grows the window around Chromium's picker.
   *
   * This lives in the hook rather than in a screen's effect because React
   * remounts components in development, and an effect that toggled picker
   * mode would grow and shrink the window in a race — which opened the picker
   * clipped and left the panel displaced.
   */
  const startPublishing = useCallback(async () => {
    setPicking(true);
    await setPickerMode(true);
    try {
      await managerRef.current?.startPublishing();
    } finally {
      await setPickerMode(false);
      setPicking(false);
    }
  }, []);

  const stopPublishing = useCallback(async () => {
    await managerRef.current?.stopPublishing();
  }, []);

  const watch = useCallback((publisherId: string) => {
    managerRef.current?.watch(publisherId);
  }, []);

  const stopWatching = useCallback(() => {
    managerRef.current?.stopWatching();
  }, []);

  return {
    channel,
    sharing,
    viewing,
    picking,
    preset,
    setPreset,
    create,
    join,
    leave,
    startPublishing,
    stopPublishing,
    watch,
    stopWatching,
    attachVideo,
  };
}
