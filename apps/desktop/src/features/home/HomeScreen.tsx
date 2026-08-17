import { Row } from "../../components/Row.js";
import { quitApp } from "../../services/panel.js";

interface Props {
  onShare: () => void;
  onWatch: () => void;
  onDiagnostics: () => void;
  sharing: boolean;
  viewerCount: number;
  roomId: string | null;
  onStopSharing: () => void;
}

export function HomeScreen({
  onShare,
  onWatch,
  onDiagnostics,
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
            <div className="headline">Sharing to {viewerCount} of 6</div>
            <div className="code">{roomId}</div>
          </>
        ) : (
          <>
            <div className="headline">Nothing is being shared</div>
            <div className="sub">Start a room, or join one with a code</div>
          </>
        )}
      </div>

      <div className="rows">
        <Row icon="share" label="Share my screen" shortcut="Ctrl S" onClick={onShare} />
        <Row icon="watch" label="Watch a stream" shortcut="Ctrl W" onClick={onWatch} />
        {sharing ? (
          <Row
            icon="stop"
            label="Stop sharing"
            shortcut="Ctrl ."
            tone="danger"
            onClick={onStopSharing}
          />
        ) : null}
      </div>

      <div className="divider" />

      <div className="rows">
        <Row icon="pulse" label="Capture check" shortcut="Ctrl D" onClick={onDiagnostics} />
      </div>

      <div className="grow" />

      <div className="divider" />

      <div className="rows">
        <Row icon="quit" label="Quit" shortcut="Ctrl Q" onClick={() => void quitApp()} />
      </div>
    </>
  );
}
