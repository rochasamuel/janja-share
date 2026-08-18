import { useCallback, useEffect, useState } from "react";
import { Icon } from "./components/Icon.js";
import { HomeScreen } from "./features/home/HomeScreen.js";
import { DiagnosticsScreen } from "./features/diagnostics/DiagnosticsScreen.js";
import { QualityScreen } from "./features/settings/QualityScreen.js";
import { ShareScreen } from "./features/sharing/ShareScreen.js";
import { WatchScreen } from "./features/viewing/WatchScreen.js";
import { useSignaling } from "./hooks/use-signaling.js";
import { useSharing } from "./hooks/use-sharing.js";
import { hidePanel, quitApp } from "./services/panel.js";
import type { SignalingState } from "./services/signaling/signaling-client.js";

type Screen = "home" | "diagnostics" | "quality" | "share" | "watch";

/** The two failing states are handled separately, above the panel. */
const STATE_LABEL: Record<SignalingState, string> = {
  idle: "parado",
  connecting: "conectando",
  connected: "conectado",
  reconnecting: "reconectando",
  failed: "sem conexão",
};

export function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const { client, state: signalingState } = useSignaling();
  const sharing = useSharing(client);

  const home = useCallback(() => setScreen("home"), []);

  useEffect(() => {
    let dispose: (() => void) | undefined;

    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        dispose = await listen<string>("tray://action", (event) => {
          if (event.payload === "stop") void sharing.stop();
        });
      } catch {
        // Running in a plain browser: no tray to listen to.
      }
    })();

    return () => dispose?.();
  }, [sharing]);

  // The shortcut hints on each row have to actually do something, or they are
  // decoration pretending to be an affordance.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Escape backs out one level, and closes the panel from the top.
        if (screen === "home") void hidePanel();
        else home();
        return;
      }

      if (!event.ctrlKey) return;
      const key = event.key.toLowerCase();

      if (key === "s") {
        setScreen("share");
        if (!live) void sharing.start();
      }
      else if (key === "w") setScreen("watch");
      else if (key === "d") setScreen("diagnostics");
      else if (key === ",") setScreen("quality");
      else if (key === "q") void quitApp();
      else if (key === ".") void sharing.stop();
      else return;

      event.preventDefault();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, home, sharing]);

  const live = sharing.snapshot.state === "sharing";
  const offline = signalingState === "failed" || signalingState === "reconnecting";
  const tally = offline ? "error" : screen === "watch" ? "watching" : live ? "live" : "idle";

  return (
    <div className="panel">
      <header className="header">
        <span className="tally" data-state={tally}>
          <Icon name="status" size={15} />
        </span>
        <span className="wordmark">Janja Share</span>
        <span className="spacer" />
        <span className="state">
          {offline ? "sem conexão" : live ? "ao vivo" : STATE_LABEL[signalingState]}
        </span>
      </header>

      {offline ? (
        <div className="notice">
          {signalingState === "failed"
            ? "Não foi possível falar com o servidor. Confira se ele está no ar e abra de novo."
            : "Reconectando…"}
        </div>
      ) : null}

      {screen === "home" ? (
        <HomeScreen
          onShare={() => {
            // The click is the decision. Starting here rather than in the
            // screen's effect keeps capture off the component lifecycle, which
            // React remounts in development.
            setScreen("share");
            if (!live) void sharing.start();
          }}
          onWatch={() => setScreen("watch")}
          onDiagnostics={() => setScreen("diagnostics")}
          onQuality={() => setScreen("quality")}
          onStopSharing={() => void sharing.stop()}
          sharing={live}
          viewerCount={sharing.snapshot.viewerIds.length}
          roomId={sharing.snapshot.roomId}
        />
      ) : null}

      {screen === "diagnostics" ? <DiagnosticsScreen onBack={home} /> : null}

      {screen === "quality" ? (
        <QualityScreen
          preset={sharing.preset}
          sharing={live}
          onSelect={sharing.setPreset}
          onBack={home}
        />
      ) : null}

      {screen === "share" ? (
        <ShareScreen
          snapshot={sharing.snapshot}
          picking={sharing.picking}
          onStart={sharing.start}
          onStop={sharing.stop}
          onBack={home}
        />
      ) : null}

      {screen === "watch" && client ? <WatchScreen signaling={client} onBack={home} /> : null}
    </div>
  );
}
