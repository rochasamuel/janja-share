import { useCallback, useEffect, useState } from "react";
import { Row } from "../../components/Row.js";
import { setAutoHide } from "../../services/panel.js";
import { probeCapture, summarize, type ProbeResult } from "./capture-probe.js";

interface Props {
  onBack: () => void;
}

type Source = "screen" | "window";

/**
 * The capture check. It exists because whether WebView2 hands this app a
 * system audio track is not documented anywhere — it has to be measured on
 * the machine that will do the sharing.
 */
export function DiagnosticsScreen({ onBack }: Props) {
  const [log, setLog] = useState<string>(
    "Run a check and pick a source when Windows asks.\n\n" +
      "Tick the audio option in the picker, or the result will say there is\n" +
      "no sound when there could have been.",
  );
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<ProbeResult | null>(null);

  useEffect(() => () => void setAutoHide(true), []);

  const run = useCallback(async (source: Source) => {
    setBusy(true);
    setLog(`Requesting capture — choose ${source === "screen" ? "a whole screen" : "a window"}…`);

    // The picker takes focus; without this the panel would hide mid-check.
    await setAutoHide(false);
    try {
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
    } finally {
      await setAutoHide(true);
      setBusy(false);
    }
  }, []);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(log);
  }, [log]);

  return (
    <>
      {lastResult && !lastResult.trustworthy ? (
        <div className="notice">
          This is a browser tab, not the app. Firefox and Chrome answer this
          differently from the engine we ship on, so these numbers mean nothing.
        </div>
      ) : null}

      {lastResult?.ok === true && lastResult.trustworthy && !lastResult.hasSystemAudio ? (
        <div className="notice" data-tone="warn">
          Video works, no sound came through. The picker's audio option has to
          be ticked before you choose a source.
        </div>
      ) : null}

      {lastResult?.ok === false && lastResult.permissionLikelyDenied ? (
        <div className="notice">
          Windows never showed a picker. The app is being refused screen access,
          which is a setting on our side rather than anything you did.
        </div>
      ) : null}

      <pre className="log">{log}</pre>

      <div className="divider" />

      <div className="rows">
        <Row icon="pulse" label="Check a screen" disabled={busy} onClick={() => void run("screen")} />
        <Row icon="pulse" label="Check a window" disabled={busy} onClick={() => void run("window")} />
        <Row icon="copy" label="Copy results" onClick={copy} />
        <Row icon="back" label="Back" shortcut="Esc" onClick={onBack} />
      </div>
    </>
  );
}
