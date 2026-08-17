import { useEffect, useState } from "react";
import { HomeScreen } from "./features/home/HomeScreen.js";
import { DiagnosticsScreen } from "./features/diagnostics/DiagnosticsScreen.js";
import { ShareScreen } from "./features/sharing/ShareScreen.js";
import { WatchScreen } from "./features/viewing/WatchScreen.js";
import { useSignaling } from "./hooks/use-signaling.js";

type Screen = "home" | "diagnostics" | "share" | "watch";
type Tally = "idle" | "live" | "watching" | "error";

export function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [tally, setTally] = useState<Tally>("idle");
  const { client, state: signalingState } = useSignaling();

  useEffect(() => {
    let dispose: (() => void) | undefined;

    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        dispose = await listen<string>("tray://action", (event) => {
          if (event.payload === "share") setScreen("share");
          if (event.payload === "watch") setScreen("watch");
          if (event.payload === "stop") setScreen("share");
        });
      } catch {
        // Running in a plain browser: no tray to listen to.
      }
    })();

    return () => dispose?.();
  }, []);

  useEffect(() => {
    if (screen === "share") setTally("live");
    else if (screen === "watch") setTally("watching");
    else setTally("idle");
  }, [screen]);

  const offline = signalingState === "failed" || signalingState === "reconnecting";

  return (
    <div className="app">
      <header className="masthead">
        <span className="tally" data-state={offline ? "error" : tally} />
        <span className="wordmark">ScreenShare</span>
        <span className="spacer" />
        <span className="state">{offline ? "offline" : signalingState}</span>
      </header>

      {offline ? (
        <div className="notice">
          {signalingState === "failed"
            ? "Can't reach the server. Check that it's running, then reopen the app."
            : "Reconnecting to the server..."}
        </div>
      ) : null}

      {screen === "home" ? (
        <HomeScreen
          onShare={() => setScreen("share")}
          onWatch={() => setScreen("watch")}
          onDiagnostics={() => setScreen("diagnostics")}
        />
      ) : null}

      {screen === "diagnostics" ? <DiagnosticsScreen onBack={() => setScreen("home")} /> : null}

      {screen === "share" && client ? (
        <ShareScreen signaling={client} onBack={() => setScreen("home")} />
      ) : null}

      {screen === "watch" && client ? (
        <WatchScreen signaling={client} onBack={() => setScreen("home")} />
      ) : null}
    </div>
  );
}
