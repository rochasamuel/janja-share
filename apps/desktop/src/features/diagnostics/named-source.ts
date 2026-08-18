/**
 * Tests whether this webview will capture a source we name ourselves.
 *
 * This is the question behind "why can Discord do a custom picker and we
 * can't". Discord is Electron, which exposes `desktopCapturer` and
 * `setDisplayMediaRequestHandler`, so the app hands Chromium an already-chosen
 * source and no picker ever opens. WebView2 exposes neither.
 *
 * What might still work is the legacy constraint Chromium accepted before
 * those APIs existed. Plain Chromium gates it — the id has to come from the
 * `desktopCapture` extension API — but Electron skips that check, and it costs
 * an hour to find out whether WebView2 does too.
 *
 * If it works, we get a custom picker without leaving Tauri. If it does not,
 * the only routes left are switching the shell to Electron or capturing video
 * natively in Rust.
 */

export interface CaptureSource {
  id: string;
  title: string;
  process: string;
  kind: "window" | "screen";
}

export interface NamedSourceResult {
  supported: boolean;
  /** What we tried to capture. */
  sourceId: string;
  errorName?: string;
  errorMessage?: string;
  width?: number;
  height?: number;
}

export async function listSources(): Promise<CaptureSource[]> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<CaptureSource[]>("list_capture_sources");
  } catch {
    return [];
  }
}

/**
 * Attempts capture of one specific source, with no picker.
 *
 * Stops the stream immediately: this answers a question, it does not start a
 * session.
 */
export async function tryNamedSource(sourceId: string): Promise<NamedSourceResult> {
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 60,
      },
    },
  } as unknown as MediaStreamConstraints;

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings();

    for (const t of stream.getTracks()) t.stop();

    return {
      supported: true,
      sourceId,
      width: settings?.width ?? undefined,
      height: settings?.height ?? undefined,
    };
  } catch (error) {
    return {
      supported: false,
      sourceId,
      errorName: error instanceof Error ? error.name : "Error",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export function summarizeNamedSource(
  result: NamedSourceResult,
  sources: CaptureSource[],
): string {
  const lines = [
    `fontes encontradas: ${sources.length}`,
    `tentada:            ${result.sourceId}`,
    "",
  ];

  if (result.supported) {
    lines.push(
      "CAPTURA DE FONTE NOMEADA FUNCIONA.",
      `capturou ${result.width ?? "?"}x${result.height ?? "?"} sem nenhum seletor.`,
      "",
      "Dá para ter um seletor próprio sem sair do Tauri.",
    );
  } else {
    lines.push(
      "Captura de fonte nomeada recusada.",
      `${result.errorName}: ${result.errorMessage}`,
      "",
      "Esperado: o WebView2 bloqueia a constraint antiga do mesmo jeito que o",
      "Chromium puro. Um seletor próprio exigiria ou uma casca Electron ou",
      "captura de vídeo nativa em Rust.",
    );
  }

  lines.push("", "--- fontes ---");
  for (const source of sources.slice(0, 12)) {
    lines.push(`${source.id.padEnd(22)} ${source.process.padEnd(18)} ${source.title.slice(0, 40)}`);
  }
  if (sources.length > 12) lines.push(`… e mais ${sources.length - 12}`);

  return lines.join("\n");
}
