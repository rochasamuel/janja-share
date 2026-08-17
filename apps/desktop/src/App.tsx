import { useEffect, useState } from "react";
import { HomeScreen } from "./features/home/HomeScreen.js";
import { DiagnosticsScreen } from "./features/diagnostics/DiagnosticsScreen.js";

type Screen = "home" | "diagnostics" | "share" | "watch";
type Tally = "idle" | "live" | "watching" | "error";

const TALLY_LABEL: Record<Tally, string> = {
  idle: "idle",
  live: "live",
  watching: "watching",
  error: "error",
};

export function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [tally] = useState<Tally>("idle");

  // The tray forwards its clicks here rather than acting on them, because
  // capture and peer connections live in the webview.
  useEffect(() => {
    let dispose: (() => void) | undefined;

    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unlisten = await listen<string>("tray://action", (event) => {
          if (event.payload === "share") setScreen("share");
          if (event.payload === "watch") setScreen("watch");
          if (event.payload === "stop") setScreen("home");
        });
        dispose = unlisten;
      } catch {
        // Running in a plain browser during development: no tray to listen to.
      }
    })();

    return () => dispose?.();
  }, []);

  return (
    <div className="app">
      <header className="masthead">
        <span className="tally" data-state={tally} />
        <span className="wordmark">ScreenShare</span>
        <span className="spacer" />
        <span className="state">{TALLY_LABEL[tally]}</span>
      </header>

      {screen === "home" ? (
        <HomeScreen
          onShare={() => setScreen("share")}
          onWatch={() => setScreen("watch")}
          onDiagnostics={() => setScreen("diagnostics")}
        />
      ) : null}

      {screen === "diagnostics" ? (
        <DiagnosticsScreen onBack={() => setScreen("home")} />
      ) : null}

      {screen === "share" || screen === "watch" ? (
        <div className="screen">
          <div>
            <h1 className="screen-title">
              {screen === "share" ? "Share my screen" : "Watch a stream"}
            </h1>
            <p className="screen-lede">
              Not wired up yet. Run the capture check first — it decides how
              sharing gets built.
            </p>
          </div>
          <div className="grow" />
          <div className="footer">
            <button className="link" onClick={() => setScreen("home")}>
              Back
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
