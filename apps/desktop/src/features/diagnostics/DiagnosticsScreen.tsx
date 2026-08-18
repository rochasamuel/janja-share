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
    "Rode um teste e escolha uma fonte quando o Windows perguntar.\n\n" +
      "Marque a opção de áudio no seletor, senão o resultado vai dizer que\n" +
      "não há som quando poderia haver.",
  );
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<ProbeResult | null>(null);

  useEffect(() => () => void setAutoHide(true), []);

  const run = useCallback(async (source: Source) => {
    setBusy(true);
    setLog(
      `Pedindo a captura — escolha ${source === "screen" ? "uma tela inteira" : "uma janela"}…`,
    );

    // The picker renders inside the webview and takes focus, so the window
    // has to make room for it and stop hiding on blur.
    await setPickerMode(true);
    try {
      const result = await probeCapture();
      setLastResult(result);
      setLog(
        [
          `=== ${source === "screen" ? "TELA INTEIRA" : "UMA JANELA"} ===`,
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
    setLog("Listando janelas e tentando capturar uma direto…");

    const sources = await listSources();
    const target = sources.find((source) => source.kind === "window") ?? sources[0];
    if (!target) {
      setLog("Nenhuma fonte de captura encontrada. Isso precisa do app desktop.");
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
          Isto é uma aba de navegador, não o app. Firefox e Chrome respondem
          isto de um jeito diferente do motor que a gente usa, então estes
          números não valem nada.
        </div>
      ) : null}

      {lastResult?.ok === true && lastResult.trustworthy && !lastResult.hasSystemAudio ? (
        <div className="notice" data-tone="warn">
          O vídeo funciona, mas não veio som. A opção de áudio do seletor
          precisa estar marcada antes de você escolher a fonte.
        </div>
      ) : null}

      {lastResult?.ok === false && lastResult.permissionLikelyDenied ? (
        <div className="notice">
          O Windows nem mostrou o seletor. O acesso à tela está sendo negado ao
          app — é configuração do nosso lado, não algo que você fez.
        </div>
      ) : null}

      <pre className="log">{log}</pre>

      <div className="divider" />

      <div className="rows">
        <Row icon="pulse" label="Testar uma tela" disabled={busy} onClick={() => void run("screen")} />
        <Row
          icon="pulse"
          label="Testar uma janela"
          disabled={busy}
          onClick={() => void run("window")}
        />
        <Row
          icon="share"
          label="Testar seletor próprio"
          disabled={busy}
          onClick={() => void checkNamedSource()}
        />
        <Row icon="copy" label="Copiar resultados" onClick={copy} />
        <Row icon="back" label="Voltar" shortcut="Esc" onClick={onBack} />
      </div>
    </>
  );
}
