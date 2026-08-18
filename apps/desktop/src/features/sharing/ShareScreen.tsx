import { useCallback, useState } from "react";
import { Row } from "../../components/Row.js";
import type { ConnectionQuality } from "../../services/webrtc/connection-quality.js";
import {
  formatEncoder,
  formatLimit,
  formatNetwork,
  formatScreen,
} from "../../services/webrtc/stream-stats.js";
import type { SharingSnapshot } from "./sharing-manager.js";

/**
 * Colours the network line by the worst viewer, matching the rule the grading
 * itself uses: one person with an unusable picture is not a healthy share.
 */
function networkTone(quality: Map<string, ConnectionQuality>): "ok" | "fault" | undefined {
  const grades = [...quality.values()];
  if (grades.length === 0) return undefined;
  return grades.some((grade) => grade === "poor" || grade === "reconnecting") ? "fault" : "ok";
}

interface Props {
  snapshot: SharingSnapshot;
  /** The code belongs to the channel, not to this share. */
  channelId: string | null;
  /** True while Chromium's picker is on screen. */
  picking: boolean;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onBack: () => void;
}

export function ShareScreen({ snapshot, channelId, picking, onStart, onStop, onBack }: Props) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback((text: string, label: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }, []);

  if (picking || snapshot.state === "starting") {
    // Chromium paints its picker over this. What shows around it is our own
    // frame, so the moment reads as part of the app.
    return (
      <div className="picking">
        <div className="picking-title">Escolha o que compartilhar</div>
        <div className="picking-hint">
          Selecione uma janela ou uma tela acima e marque{" "}
          <strong>Compartilhar áudio</strong> antes de confirmar.
        </div>
      </div>
    );
  }

  if (snapshot.state !== "sharing") {
    // Only reached after a cancel or a failure, never as a first step.
    return (
      <>
        <div className="card">
          <div className="headline">
            {snapshot.state === "error" ? "Não deu certo" : "Nada selecionado"}
          </div>
          {snapshot.state === "error" ? null : (
            <div className="sub">Você fechou o seletor sem escolher nada</div>
          )}
        </div>

        {snapshot.state === "error" && snapshot.message ? (
          <div className="notice">{snapshot.message}</div>
        ) : null}

        <div className="grow" />
        <div className="divider" />

        <div className="rows">
          <Row icon="share" label="Tentar de novo" onClick={() => void onStart()} />
          <Row icon="back" label="Voltar" shortcut="Esc" onClick={onBack} />
        </div>
      </>
    );
  }

  const screenLine = formatScreen(snapshot.stats);
  const networkLine = formatNetwork(snapshot.stats);
  const encoderLine = formatEncoder(snapshot.stats);
  // Only ever present when something is actually wrong, which is what makes it
  // worth a line of its own.
  const limitLine = formatLimit(snapshot.stats);

  return (
    <>
      <div className="card">
        <div className="sub">Código do canal</div>
        <div className="code">{channelId}</div>
        <div className="meter">
          <span
            style={{
              width: `${(snapshot.viewerIds.length / Math.max(1, snapshot.maxViewers)) * 100}%`,
            }}
          />
        </div>
      </div>

      <div className="readout">
        <span className="key">Assistindo</span>
        <span className="value">
          {snapshot.viewerIds.length} / {snapshot.maxViewers}
        </span>
      </div>
      <div className="readout">
        <span className="key">Som</span>
        <span
          className="value"
          data-tone={
            snapshot.audioSource === "app"
              ? "ok"
              : snapshot.audioSource === "none"
                ? "fault"
                : undefined
          }
        >
          {snapshot.audioSource === "app"
            ? (snapshot.audioProcess ?? "só deste app")
            : snapshot.audioSource === "system"
              ? "computador inteiro"
              : "sem som"}
        </span>
      </div>

      {limitLine ? (
        <div className="readout">
          <span className="key">Limite</span>
          <span className="value" data-tone="fault">
            {limitLine}
          </span>
        </div>
      ) : null}

      {screenLine ? (
        <div className="readout">
          <span className="key">Imagem</span>
          <span className="value">{screenLine}</span>
        </div>
      ) : null}
      {encoderLine ? (
        <div className="readout">
          <span className="key">Encoder</span>
          {/* The one reading that explains a busy CPU. Software encoding is
              worth flagging in red: it is the difference between the GPU
              doing this work and your game losing frames to it. */}
          <span
            className="value"
            data-tone={snapshot.stats?.powerEfficient === false ? "fault" : undefined}
          >
            {encoderLine}
          </span>
        </div>
      ) : null}
      {networkLine ? (
        <div className="readout">
          <span className="key">Rede</span>
          <span className="value" data-tone={networkTone(snapshot.quality)}>
            {networkLine}
          </span>
        </div>
      ) : null}

      {snapshot.message ? (
        <div className="notice" data-tone="warn">
          {snapshot.message}
        </div>
      ) : null}

      <div className="divider" />

      <div className="rows">
        <Row
          icon="copy"
          label={copied === "code" ? "Copiado" : "Copiar código do canal"}
          shortcut="Ctrl C"
          onClick={() => copy(channelId ?? "", "code")}
        />
        <Row
          icon="link"
          label={copied === "link" ? "Copiado" : "Copiar link do canal"}
          onClick={() => copy(`janjashare://channel/${channelId}`, "link")}
        />
      </div>

      <div className="grow" />
      <div className="divider" />

      <div className="rows">
        <Row
          icon="stop"
          label="Parar de compartilhar"
          shortcut="Ctrl ."
          tone="danger"
          onClick={() => void onStop()}
        />
        <Row
          icon="back"
          label="Voltar — continua compartilhando"
          shortcut="Esc"
          onClick={onBack}
        />
      </div>
    </>
  );
}
