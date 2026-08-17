import { useCallback, useEffect, useRef, useState } from "react";
import { config } from "../../config.js";
import { createPeerConnection } from "../../services/webrtc/peer-connection.js";
import { setTrayStatus } from "../../services/tray-status.js";
import type { SignalingClient } from "../../services/signaling/signaling-client.js";
import { SharingManager, type SharingSnapshot } from "./sharing-manager.js";

interface Props {
  signaling: SignalingClient;
  onBack: () => void;
}

const EMPTY: SharingSnapshot = {
  state: "idle",
  roomId: null,
  viewerIds: [],
  maxViewers: 6,
  hasSystemAudio: false,
  message: null,
  quality: new Map(),
};

export function ShareScreen({ signaling, onBack }: Props) {
  const managerRef = useRef<SharingManager | null>(null);
  const [snapshot, setSnapshot] = useState<SharingSnapshot>(EMPTY);
  const [copied, setCopied] = useState<string | null>(null);

  if (managerRef.current === null) {
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

    // Deliberately no stop() here: leaving this screen must not end the
    // share, which is the entire reason the app lives in the tray.
    return () => clearInterval(timer);
  }, []);

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

  const copy = useCallback((text: string, label: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1600);
    });
  }, []);

  const manager = managerRef.current;

  if (snapshot.state !== "sharing") {
    return (
      <div className="screen">
        <div>
          <h1 className="screen-title">Share my screen</h1>
          <p className="screen-lede">Windows will ask which screen or window to share.</p>
        </div>

        <div className="notice" data-tone="warn">
          Turn on the audio option in the Windows picker before you choose, or
          your friends will watch in silence. It can't be switched on afterwards.
        </div>

        {snapshot.state === "error" && snapshot.message ? (
          <div className="notice">{snapshot.message}</div>
        ) : null}

        <div className="grow" />

        <button
          className="button"
          data-variant="primary"
          disabled={snapshot.state === "starting"}
          onClick={() => void manager?.start()}
        >
          {snapshot.state === "starting"
            ? "Waiting for you to choose..."
            : "Choose what to share"}
        </button>

        <div className="footer">
          <button className="link" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="plate">
        <span className="caption">Room code</span>
        <span className="code">{snapshot.roomId}</span>
      </div>

      <div className="button-row">
        <button className="button" onClick={() => copy(snapshot.roomId ?? "", "code")}>
          {copied === "code" ? "Copied" : "Copy code"}
        </button>
        <button
          className="button"
          onClick={() => copy(`screenshare://room/${snapshot.roomId}`, "link")}
        >
          {copied === "link" ? "Copied" : "Copy link"}
        </button>
      </div>

      <div className="stack">
        <div className="readout">
          <span className="key">Watching</span>
          <span className="value">
            {snapshot.viewerIds.length} / {snapshot.maxViewers}
          </span>
        </div>
        <div className="readout">
          <span className="key">Sound</span>
          <span className="value" data-tone={snapshot.hasSystemAudio ? "ok" : "fault"}>
            {snapshot.hasSystemAudio ? "on" : "off"}
          </span>
        </div>
      </div>

      {snapshot.message ? (
        <div className="notice" data-tone="warn">
          {snapshot.message}
        </div>
      ) : null}

      <div className="grow" />

      <button className="button" data-variant="danger" onClick={() => void manager?.stop()}>
        Stop sharing
      </button>

      <div className="footer">
        <button className="link" onClick={onBack}>
          Back — keeps sharing
        </button>
      </div>
    </div>
  );
}
