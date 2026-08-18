import { useCallback, useEffect, useState } from "react";
import { Icon } from "./components/Icon.js";
import { ChannelScreen } from "./features/channel/ChannelScreen.js";
import { CreatingScreen } from "./features/channel/CreatingScreen.js";
import { JoinScreen } from "./features/channel/JoinScreen.js";
import { HomeScreen } from "./features/home/HomeScreen.js";
import { DiagnosticsScreen } from "./features/diagnostics/DiagnosticsScreen.js";
import { QualityScreen } from "./features/settings/QualityScreen.js";
import { ShareScreen } from "./features/sharing/ShareScreen.js";
import { WatchScreen } from "./features/viewing/WatchScreen.js";
import { useSignaling } from "./hooks/use-signaling.js";
import { useChannel } from "./hooks/use-channel.js";
import {
  hidePanel,
  quitApp,
  setAutoHide,
  setFullscreenMode,
  showPanel,
} from "./services/panel.js";
import { shareShortcutAction } from "./services/share-shortcut.js";
import { setTrayStatus } from "./services/tray-status.js";
import type { SignalingState } from "./services/signaling/signaling-client.js";

type Screen =
  | "home"
  | "creating"
  | "join"
  | "channel"
  | "share"
  | "watch"
  | "quality"
  | "diagnostics";

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
  const { client, state: signalingState, retry } = useSignaling();
  const channel = useChannel(client);

  const { create, startPublishing, stopPublishing } = channel;

  const home = useCallback(() => setScreen("home"), []);
  const toChannel = useCallback(() => setScreen("channel"), []);

  const live = channel.sharing.state === "sharing";
  const watching =
    channel.viewing.state === "connected" || channel.viewing.state === "reconnecting";
  const inChannel = channel.channel.channelId !== null;
  const offline = signalingState === "failed" || signalingState === "reconnecting";

  // The user asked for a channel; landing them on the member list is the answer
  // to that. Only the two screens that asked navigate — a rejoin after a
  // reconnect reaches "joined" too, and must not yank anyone off what they
  // were looking at.
  useEffect(() => {
    if (channel.channel.state !== "joined") return;
    if (screen === "join" || screen === "creating") setScreen("channel");
  }, [channel.channel.state, screen]);

  /**
   * The single owner of whether a click elsewhere may close the panel.
   *
   * It must not close over a picture the user is watching, a share they are
   * running, or a picker they are choosing from. Nothing else may set this:
   * it used to be written from here, from leave(), from the diagnostics screen
   * and from the Rust picker command, and they overwrote each other — a live
   * share whose picker had just closed ended up hiding on the first alt-tab.
   *
   * `screen` is in the dependencies so every navigation re-asserts the
   * invariant, which is what covers a screen that opened a picker of its own.
   */
  useEffect(() => {
    void setAutoHide(!(watching || live || channel.picking));
  }, [watching, live, channel.picking, screen]);

  useEffect(() => {
    if (signalingState === "failed") {
      void setTrayStatus("error", "Sem conexão com o servidor");
      return;
    }

    const parts: string[] = [];
    if (live) {
      const count = channel.sharing.viewerIds.length;
      parts.push(`Compartilhando · ${count} ${count === 1 ? "espectador" : "espectadores"}`);
    }
    if (watching && channel.viewing.publisherName) {
      parts.push(`assistindo ${channel.viewing.publisherName}`);
    }

    // Error, then sharing, then watching: the icon shows the most consequential
    // thing that is true, and the tooltip carries the rest.
    void setTrayStatus(
      live ? "sharing" : watching ? "watching" : "idle",
      parts.join(" · ") || undefined,
    );
  }, [
    live,
    watching,
    signalingState,
    channel.sharing.viewerIds.length,
    channel.viewing.publisherName,
  ]);

  /**
   * A fullscreen stream must not seize the machine.
   *
   * This is a window concern rather than a channel one, which is why it lives
   * here and not next to the other fullscreen listener in use-channel: that
   * one tells the publisher how much picture to send, and this one decides how
   * the window behaves while it does.
   */
  useEffect(() => {
    const onFullscreenChange = () => {
      void setFullscreenMode(document.fullscreenElement !== null);
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      // Leaving the app mid-fullscreen must not strand the panel without its
      // popover rules; it would come back floating over everything.
      void setFullscreenMode(false);
    };
  }, []);

  useEffect(() => {
    let dispose: (() => void) | undefined;

    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        dispose = await listen<string>("tray://action", (event) => {
          if (event.payload === "stop") void stopPublishing();
        });
      } catch {
        // Running in a plain browser: no tray to listen to.
      }
    })();

    return () => dispose?.();
  }, [stopPublishing]);

  /**
   * The global shortcut, which is the only one that reaches a fullscreen game.
   *
   * Every other shortcut in this file needs the panel focused, and focusing
   * the panel is what minimises the window the person wanted to share.
   */
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen("shortcut://share-toggle", () => {
          switch (shareShortcutAction({ live, inChannel })) {
            case "stop":
              // No panel: stopping from inside a game must not drag the person
              // out of it, which is the whole point of the shortcut.
              void stopPublishing();
              return;
            case "start":
              setScreen("share");
              void startPublishing();
              return;
            case "needs-channel":
              void showPanel();
              setScreen("home");
              return;
          }
        });

        // This effect re-runs whenever live or inChannel change, so a
        // teardown can land while listen is still resolving.
        if (cancelled) off();
        else dispose = off;
      } catch {
        // Running in a plain browser: no shortcut to listen to.
      }
    })();

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [live, inChannel, startPublishing, stopPublishing]);

  // The shortcut hints on each row have to actually do something, or they are
  // decoration pretending to be an affordance.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Escape backs out one level, and closes the panel from the top.
        if (screen === "home") void hidePanel();
        else if (screen === "watch" || screen === "share") toChannel();
        else home();
        return;
      }

      if (!event.ctrlKey) return;
      const key = event.key.toLowerCase();

      if (key === "n" && !inChannel) {
        setScreen("creating");
        void create();
      } else if (key === "j" && !inChannel) setScreen("join");
      else if (key === "k" && inChannel) setScreen("channel");
      else if (key === "s" && inChannel) {
        setScreen("share");
        if (!live) void startPublishing();
      } else if (key === ".") void stopPublishing();
      else if (key === "d") setScreen("diagnostics");
      else if (key === ",") setScreen("quality");
      else if (key === "q") void quitApp();
      else return;

      event.preventDefault();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, home, toChannel, create, startPublishing, stopPublishing, inChannel, live]);

  const tally = offline ? "error" : live ? "live" : watching ? "watching" : "idle";

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

      {/* One scrolling column below the header. The panel itself stays
          overflow:hidden so it keeps clipping its rounded corners over the
          transparent window; a fixed 440px tray popover cannot show a long
          member list plus the rows under it, and what did not fit was simply
          unreachable. */}
      <div className="screen">
        {offline ? (
          <div className="notice">
            {signalingState === "failed" ? (
              <>
                Não foi possível falar com o servidor. Confira se ele está no ar.
                {/* Without this the only way back is restarting the app: the
                    backoff has spent its attempts and will not try again. */}
                <button className="inline-retry" type="button" onClick={retry}>
                  Tentar de novo
                </button>
              </>
            ) : (
              "Reconectando…"
            )}
          </div>
        ) : null}

        {screen === "home" ? (
          <HomeScreen
            onCreate={() => {
              // The click is the decision. The wait gets its own screen, and the
              // effect above moves on to the member list once the server answers.
              setScreen("creating");
              void channel.create();
            }}
            onJoin={() => setScreen("join")}
            onOpenChannel={toChannel}
            onDiagnostics={() => setScreen("diagnostics")}
            onQuality={() => setScreen("quality")}
            channelId={channel.channel.channelId}
            memberCount={channel.channel.members.length + 1}
            publishing={live}
            watchingName={watching ? channel.viewing.publisherName : null}
          />
        ) : null}

        {screen === "creating" ? (
          <CreatingScreen
            state={channel.channel.state}
            message={channel.channel.message}
            onRetry={() => void channel.create()}
            onBack={home}
          />
        ) : null}

        {screen === "join" ? (
          <JoinScreen
            state={channel.channel.state}
            message={channel.channel.message}
            onJoin={(code) => void channel.join(code)}
            onBack={home}
          />
        ) : null}

        {screen === "channel" ? (
          <ChannelScreen
            channel={channel.channel}
            sharing={channel.sharing}
            viewing={channel.viewing}
            onPublish={() => {
              // The picker is painted by ShareScreen, so the move has to happen
              // before capture starts or the user chooses against a blank panel.
              setScreen("share");
              void channel.startPublishing();
            }}
            onStopPublishing={() => void channel.stopPublishing()}
            onShareDetails={() => setScreen("share")}
            onWatch={(publisherId) => {
              channel.watch(publisherId);
              setScreen("watch");
            }}
            onOpenStream={() => setScreen("watch")}
            onLeave={() => {
              channel.leave();
              home();
            }}
            onBack={home}
          />
        ) : null}

        {screen === "share" ? (
          <ShareScreen
            snapshot={channel.sharing}
            channelId={channel.channel.channelId}
            picking={channel.picking}
            onStart={channel.startPublishing}
            onStop={channel.stopPublishing}
            onBack={toChannel}
          />
        ) : null}

        {screen === "watch" ? (
          <WatchScreen
            snapshot={channel.viewing}
            attachVideo={channel.attachVideo}
            onStop={() => {
              channel.stopWatching();
              toChannel();
            }}
            onBack={toChannel}
          />
        ) : null}

        {screen === "diagnostics" ? <DiagnosticsScreen onBack={home} /> : null}

        {screen === "quality" ? (
          <QualityScreen
            preset={channel.preset}
            sharing={live}
            onSelect={channel.setPreset}
            onBack={home}
          />
        ) : null}
      </div>
    </div>
  );
}
