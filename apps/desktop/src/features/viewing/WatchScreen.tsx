import { useCallback, useRef, useState } from "react";
import { Row } from "../../components/Row.js";
import { formatNetwork, formatScreen } from "../../services/webrtc/stream-stats.js";
import type { ViewingSnapshot } from "./viewing-manager.js";

interface Props {
  snapshot: ViewingSnapshot;
  /** Re-attaches the live stream: this element remounts, the stream does not. */
  attachVideo: (element: HTMLVideoElement | null) => void;
  onStop: () => void;
  onBack: () => void;
}

const QUALITY_LABEL = {
  excellent: "Excelente",
  good: "Boa",
  poor: "Ruim",
  reconnecting: "Reconectando",
} as const;

export function WatchScreen({ snapshot, attachVideo, onStop, onBack }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [muted, setMuted] = useState(false);

  const setVideo = useCallback(
    (element: HTMLVideoElement | null) => {
      videoRef.current = element;
      attachVideo(element);
    },
    [attachVideo],
  );

  const toggleFullscreen = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void video.requestFullscreen();
  }, []);

  const screenLine = formatScreen(snapshot.stats);
  const networkLine = formatNetwork(snapshot.stats);

  return (
    <>
      <video
        ref={setVideo}
        className="video"
        autoPlay
        playsInline
        muted={muted}
        onDoubleClick={toggleFullscreen}
      />

      {snapshot.message ? <div className="notice">{snapshot.message}</div> : null}

      <div className="readout">
        <span className="key">Assistindo</span>
        <span className="value">{snapshot.publisherName ?? "—"}</span>
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
        {/* Backing out keeps the stream running: the member list is where the
            user goes to start their own share while still watching. */}
        <Row icon="back" label="Voltar ao canal" shortcut="Esc" onClick={onBack} />
        <Row icon="stop" tone="danger" label="Parar de assistir" onClick={onStop} />
      </div>
    </>
  );
}
