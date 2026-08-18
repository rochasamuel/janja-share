import { useCallback, useEffect, useRef, useState } from "react";
import { ROOM_ID_LENGTH } from "@janja/signaling-protocol";
import { Row } from "../../components/Row.js";
import { config } from "../../config.js";
import { setAutoHide } from "../../services/panel.js";
import { createPeerConnection } from "../../services/webrtc/peer-connection.js";
import { formatNetwork, formatScreen } from "../../services/webrtc/stream-stats.js";
import { setTrayStatus } from "../../services/tray-status.js";
import type { SignalingClient } from "../../services/signaling/signaling-client.js";
import { ViewingManager, type ViewingSnapshot } from "./viewing-manager.js";

interface Props {
  signaling: SignalingClient;
  onBack: () => void;
}

const QUALITY_LABEL = {
  excellent: "Excelente",
  good: "Boa",
  poor: "Ruim",
  reconnecting: "Reconectando",
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
    stats: null,
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
  const screenLine = formatScreen(snapshot.stats);
  const networkLine = formatNetwork(snapshot.stats);

  if (!watching && snapshot.state !== "connecting") {
    return (
      <>
        <div className="card">
          <div className="sub">Código da sala</div>
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
          <Row icon="watch" label="Assistir" shortcut="Enter" disabled={!ready} onClick={join} />
          <Row icon="back" label="Voltar" shortcut="Esc" onClick={onBack} />
        </div>
      </>
    );
  }

  return (
    <>
      <video ref={videoRef} className="video" autoPlay playsInline muted={muted} onDoubleClick={toggleFullscreen} />

      <div className="readout">
        <span className="key">Sala</span>
        <span className="value">{snapshot.roomId}</span>
      </div>
      <div className="readout">
        <span className="key">Conexão</span>
        <span
          className="value"
          data-tone={
            snapshot.quality === "poor" || snapshot.quality === "reconnecting" ? "fault" : "ok"
          }
        >
          {snapshot.state === "connecting" ? "Conectando" : QUALITY_LABEL[snapshot.quality]}
        </span>
      </div>

      {screenLine ? (
        <div className="readout">
          <span className="key">Imagem</span>
          <span className="value">{screenLine}</span>
        </div>
      ) : null}
      {networkLine ? (
        <div className="readout">
          <span className="key">Rede</span>
          <span className="value">{networkLine}</span>
        </div>
      ) : null}

      <div className="grow" />
      <div className="divider" />

      <div className="rows">
        <Row icon="expand" label="Tela cheia" shortcut="F" onClick={toggleFullscreen} />
        <Row
          icon={muted ? "mute" : "volume"}
          label={muted ? "Ativar som" : "Silenciar"}
          shortcut="M"
          onClick={() => setMuted((value) => !value)}
        />
        <Row
          icon="back"
          label="Sair da sala"
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
