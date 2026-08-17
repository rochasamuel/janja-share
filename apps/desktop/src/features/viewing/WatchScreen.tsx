import { useCallback, useEffect, useRef, useState } from "react";
import { config } from "../../config.js";
import { createPeerConnection } from "../../services/webrtc/peer-connection.js";
import { setTrayStatus } from "../../services/tray-status.js";
import type { SignalingClient } from "../../services/signaling/signaling-client.js";
import { ROOM_ID_LENGTH } from "@janja/signaling-protocol";
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
  const [snapshot, setSnapshot] = useState<ViewingSnapshot>({
    state: "idle",
    roomId: null,
    quality: "reconnecting",
    message: null,
  });
  const [muted, setMuted] = useState(false);

  if (managerRef.current === null) {
    managerRef.current = new ViewingManager({
      signaling,
      createPeerConnection,
      onChange: setSnapshot,
      // Straight to the element. No canvas, no frame copying — that is what
      // keeps WebView2's hardware decoding path intact.
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
      void setTrayStatus("idle");
    };
  }, []);

  useEffect(() => {
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
      <div className="screen">
        <div>
          <h1 className="screen-title">Watch a stream</h1>
          <p className="screen-lede">Type the code the person sharing gave you.</p>
        </div>

        <div className="plate">
          <span className="caption">Room code</span>
          <input
            className="code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase().slice(0, ROOM_ID_LENGTH))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && ready) join();
            }}
            placeholder="——————"
            spellCheck={false}
            autoFocus
            style={{
              background: "transparent",
              border: 0,
              outline: 0,
              textAlign: "center",
              width: "100%",
              font: "inherit",
              color: "inherit",
            }}
          />
        </div>

        {snapshot.message ? <div className="notice">{snapshot.message}</div> : null}

        <div className="grow" />

        <button className="button" data-variant="primary" disabled={!ready} onClick={join}>
          Watch
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
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        onDoubleClick={toggleFullscreen}
        style={{
          width: "100%",
          borderRadius: 8,
          background: "#000",
          aspectRatio: "16 / 9",
          objectFit: "contain",
        }}
      />

      <div className="stack">
        <div className="readout">
          <span className="key">Room</span>
          <span className="value">{snapshot.roomId}</span>
        </div>
        <div className="readout">
          <span className="key">Connection</span>
          <span
            className="value"
            data-tone={
              snapshot.quality === "poor" || snapshot.quality === "reconnecting"
                ? "fault"
                : "ok"
            }
          >
            {snapshot.state === "connecting"
              ? "Connecting"
              : QUALITY_LABEL[snapshot.quality]}
          </span>
        </div>
      </div>

      <div className="grow" />

      <div className="button-row">
        <button className="button" onClick={toggleFullscreen}>
          Fullscreen
        </button>
        <button className="button" onClick={() => setMuted((value) => !value)}>
          {muted ? "Unmute" : "Mute"}
        </button>
      </div>

      <div className="footer">
        <button
          className="link"
          onClick={() => {
            managerRef.current?.leave();
            onBack();
          }}
        >
          Leave
        </button>
      </div>
    </div>
  );
}
