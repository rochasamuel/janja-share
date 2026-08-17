import { useCallback, useEffect, useState } from "react";
import { Row } from "../../components/Row.js";
import { setAutoHide, setPickerMode } from "../../services/panel.js";
import { probeCapture, summarize, type ProbeResult } from "./capture-probe.js";
import { listSources, summarizeNamedSource, tryNamedSource } from "./named-source.js";

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

    // The picker renders inside the webview and takes focus, so the window
    // has to make room for it and stop hiding on blur.
    await setPickerMode(true);
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
      await setPickerMode(false);
      setBusy(false);
    }
  }, []);

  /**
   * Answers whether a custom picker is possible at all: can this webview
   * capture a source we choose, with no picker of its own?
   */
  const checkNamedSource = useCallback(async () => {
    setBusy(true);
    setLog("Listing windows and trying to capture one directly…");

    const sources = await listSources();
    const target = sources.find((source) => source.kind === "window") ?? sources[0];
    if (!target) {
      setLog("No capture sources found. This needs the desktop app.");
      setBusy(false);
      return;
    }

    const result = await tryNamedSource(target.id);
    setLog(summarizeNamedSource(result, sources));
    setBusy(false);
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
        <Row
          icon="share"
          label="Test custom picker"
          disabled={busy}
          onClick={() => void checkNamedSource()}
        />
        <Row icon="copy" label="Copy results" onClick={copy} />
        <Row icon="back" label="Back" shortcut="Esc" onClick={onBack} />
      </div>
    </>
  );
}
