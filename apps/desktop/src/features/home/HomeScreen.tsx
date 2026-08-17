interface Props {
  onShare: () => void;
  onWatch: () => void;
  onDiagnostics: () => void;
}

export function HomeScreen({ onShare, onWatch, onDiagnostics }: Props) {
  return (
    <div className="screen">
      <div className="grow stack" style={{ justifyContent: "center" }}>
        <button className="switch" onClick={onShare}>
          <span className="label">Share my screen</span>
          <span className="hint">Up to 6 people can watch</span>
        </button>

        <button className="switch" onClick={onWatch}>
          <span className="label">Watch a stream</span>
          <span className="hint">You'll need a room code</span>
        </button>
      </div>

      <div className="footer">
        <button className="link" onClick={onDiagnostics}>
          Capture check
        </button>
      </div>
    </div>
  );
}
