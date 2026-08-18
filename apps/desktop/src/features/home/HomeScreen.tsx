import { Row } from "../../components/Row.js";
import { quitApp } from "../../services/panel.js";

interface Props {
  onShare: () => void;
  onWatch: () => void;
  onDiagnostics: () => void;
  onQuality: () => void;
  sharing: boolean;
  viewerCount: number;
  roomId: string | null;
  onStopSharing: () => void;
}

export function HomeScreen({
  onShare,
  onWatch,
  onDiagnostics,
  onQuality,
  sharing,
  viewerCount,
  roomId,
  onStopSharing,
}: Props) {
  return (
    <>
      <div className="card">
        {sharing ? (
          <>
            <div className="headline">
              Compartilhando para {viewerCount} de 6
            </div>
            <div className="code">{roomId}</div>
          </>
        ) : (
          <>
            <div className="headline">Nada sendo compartilhado</div>
            <div className="sub">Abra uma sala, ou entre em uma com o código</div>
          </>
        )}
      </div>

      <div className="rows">
        <Row icon="share" label="Compartilhar minha tela" shortcut="Ctrl S" onClick={onShare} />
        <Row icon="watch" label="Assistir a uma transmissão" shortcut="Ctrl W" onClick={onWatch} />
        {sharing ? (
          <Row
            icon="stop"
            label="Parar de compartilhar"
            shortcut="Ctrl ."
            tone="danger"
            onClick={onStopSharing}
          />
        ) : null}
      </div>

      <div className="divider" />

      <div className="rows">
        <Row icon="quality" label="Qualidade" shortcut="Ctrl ," onClick={onQuality} />
        <Row icon="pulse" label="Teste de captura" shortcut="Ctrl D" onClick={onDiagnostics} />
      </div>

      <div className="grow" />

      <div className="divider" />

      <div className="rows">
        <Row icon="quit" label="Sair" shortcut="Ctrl Q" onClick={() => void quitApp()} />
      </div>
    </>
  );
}
