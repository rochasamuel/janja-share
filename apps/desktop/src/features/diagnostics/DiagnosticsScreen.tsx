import { useCallback, useState } from "react";
import { probeCapture, summarize, type ProbeResult } from "./capture-probe.js";

interface Props {
  onBack: () => void;
}

type Source = "screen" | "window";

/**
 * The capture check. It exists because whether WebView2 hands this app a
 * system audio track is not documented anywhere — it has to be measured on
 * the machine that will actually do the sharing.
 */
export function DiagnosticsScreen({ onBack }: Props) {
  const [log, setLog] = useState<string>(
    "Run a check and pick a source when Windows asks.\n\n" +
      "Run it twice: once picking a whole screen, once picking a single\n" +
      "window. Windows treats those differently for audio.",
  );
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<ProbeResult | null>(null);

  const run = useCallback(async (source: Source) => {
    setBusy(true);
    setLog(`Requesting capture — choose ${source === "screen" ? "a whole screen" : "a single window"}...`);

    const result = await probeCapture();
    setLastResult(result);
    setLog(
      [
        `=== ${source === "screen" ? "ENTIRE SCREEN" : "SINGLE WINDOW"} ===`,
        summarize(result),
        "",
        `webview: ${result.userAgent}`,
      ].join("\n"),
    );
    setBusy(false);
  }, []);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(log);
  }, [log]);

  return (
    <div className="screen">
      <div>
        <h1 className="screen-title">Capture check</h1>
        <p className="screen-lede">
          Confirms this machine can capture its screen and its sound.
        </p>
      </div>

      <div className="button-row">
        <button className="button" onClick={() => void run("screen")} disabled={busy}>
          Check a screen
        </button>
        <button className="button" onClick={() => void run("window")} disabled={busy}>
          Check a window
        </button>
      </div>

      {lastResult && !lastResult.trustworthy ? (
        <div className="notice">
          This is a browser tab, not the app. Firefox and Chrome answer this
          question differently from the engine we ship on, so these numbers
          mean nothing. Run the check from the ScreenShare window.
        </div>
      ) : null}

      {lastResult?.ok === false && lastResult.permissionLikelyDenied ? (
        <div className="notice">
          Windows never showed a picker. The app itself is being refused screen
          access, which is a setting on our side rather than something you did.
        </div>
      ) : null}

      {lastResult?.ok === true && lastResult.trustworthy && !lastResult.hasSystemAudio ? (
        <div className="notice" data-tone="warn">
          Video works, but no sound came through. The Windows picker has an
          audio option that has to be ticked before you choose a source — run
          the check again and turn it on.
        </div>
      ) : null}

      <pre className="log">{log}</pre>

      <div className="footer">
        <button className="link" onClick={onBack}>
          Back
        </button>
        <div style={{ flex: 1 }} />
        <button className="link" onClick={copy}>
          Copy results
        </button>
      </div>
    </div>
  );
}
