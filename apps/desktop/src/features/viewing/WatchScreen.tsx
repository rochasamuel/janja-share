import { useCallback, useEffect, useRef, useState } from "react";
import { ROOM_ID_LENGTH } from "@janja/signaling-protocol";
import { Row } from "../../components/Row.js";
import { config } from "../../config.js";
import { setAutoHide } from "../../services/panel.js";
import { createPeerConnection } from "../../services/webrtc/peer-connection.js";
import { setTrayStatus } from "../../services/tray-status.js";
import type { SignalingClient } from "../../services/signaling/signaling-client.js";
import { ViewingManager, type ViewingSnapshot } from "./viewing-manager.js";

interface Props {
  signaling: SignalingClient;
  onBack: () => void;
}

const QUALITY_LABEL = {
  excellent: "Excellent",
  good: "Good",
  poor: "Poor",
  reconnecting: "Reconnecting",
} as const;

export function WatchScreen({ signaling, onBack }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const managerRef = useRef<ViewingManager | null>(null);
  const [code, setCode] = useState("");
  const [muted, setMuted] = useState(false);
  const [snapshot, setSnapshot] = useState<ViewingSnapshot>({
    state: "idle",
    roomId: null,
    quality: "reconnecting",
    message: null,
  });

  if (managerRef.current === null) {
    managerRef.current = new ViewingManager({
      signaling,
      createPeerConnection,
      onChange: setSnapshot,
      // Straight to the element: no canvas, no frame copying, which is what
      // keeps WebView2's hardware decode path intact.
      onStream: (stream) => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      },
    });
  }

  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;

    const timer = setInterval(() => {
      void manager.pollQuality();
    }, config.qualityIntervalMs);

    return () => {
      clearInterval(timer);
      manager.leave();
      void setAutoHide(true);
      void setTrayStatus("idle");
    };
  }, []);

  // While watching, a click elsewhere must not close the panel and kill the
  // picture the user is looking at.
  useEffect(() => {
    const watching = snapshot.state === "connected" || snapshot.state === "reconnecting";
    void setAutoHide(!watching);
    if (snapshot.state === "connected") {
      void setTrayStatus("watching", snapshot.roomId ?? undefined);
    }
  }, [snapshot.state, snapshot.roomId]);

  const join = useCallback(() => {
    managerRef.current?.join(code.trim().toUpperCase());
  }, [code]);

  const toggleFullscreen = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void video.requestFullscreen();
  }, []);

  const watching = snapshot.state === "connected" || snapshot.state === "reconnecting";
  const ready = code.trim().length === ROOM_ID_LENGTH;

  if (!watching && snapshot.state !== "connecting") {
    return (
      <>
        <div className="card">
          <div className="sub">Room code</div>
          <input
            className="code-input"
            value={code}
            onChange={(event) =>
              setCode(event.target.value.toUpperCase().slice(0, ROOM_ID_LENGTH))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && ready) join();
            }}
            placeholder="––––––"
            spellCheck={false}
            autoFocus
          />
        </div>

        {snapshot.message ? <div className="notice">{snapshot.message}</div> : null}

        <div className="grow" />
        <div className="divider" />

        <div className="rows">
          <Row icon="watch" label="Watch" shortcut="Enter" disabled={!ready} onClick={join} />
          <Row icon="back" label="Back" shortcut="Esc" onClick={onBack} />
        </div>
      </>
    );
  }

  return (
    <>
      <video ref={videoRef} className="video" autoPlay playsInline muted={muted} onDoubleClick={toggleFullscreen} />

      <div className="readout">
        <span className="key">Room</span>
        <span className="value">{snapshot.roomId}</span>
      </div>
      <div className="readout">
        <span className="key">Connection</span>
        <span
          className="value"
          data-tone={
            snapshot.quality === "poor" || snapshot.quality === "reconnecting" ? "fault" : "ok"
          }
        >
          {snapshot.state === "connecting" ? "Connecting" : QUALITY_LABEL[snapshot.quality]}
        </span>
      </div>

      <div className="grow" />
      <div className="divider" />

      <div className="rows">
        <Row icon="expand" label="Fullscreen" shortcut="F" onClick={toggleFullscreen} />
        <Row
          icon={muted ? "mute" : "volume"}
          label={muted ? "Unmute" : "Mute"}
          shortcut="M"
          onClick={() => setMuted((value) => !value)}
        />
        <Row
          icon="back"
          label="Leave"
          shortcut="Esc"
          onClick={() => {
            managerRef.current?.leave();
            onBack();
          }}
        />
      </div>
    </>
  );
}
