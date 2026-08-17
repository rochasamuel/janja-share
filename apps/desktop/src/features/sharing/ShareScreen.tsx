import { useCallback, useEffect, useState } from "react";
import { Row } from "../../components/Row.js";
import { setAutoHide, setPickerMode } from "../../services/panel.js";
import type { SharingSnapshot } from "./sharing-manager.js";

interface Props {
  snapshot: SharingSnapshot;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onBack: () => void;
}

export function ShareScreen({ snapshot, onStart, onStop, onBack }: Props) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback((text: string, label: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }, []);

  const [picking, setPicking] = useState(false);

  const start = useCallback(async () => {
    // Grow the window first: the picker renders inside the webview, so it has
    // to have somewhere to render before it opens. set_picker_mode also pins
    // the panel open, since the picker steals focus.
    setPicking(true);
    await setPickerMode(true);
    try {
      await onStart();
    } finally {
      await setPickerMode(false);
      setPicking(false);
    }
  }, [onStart]);

  useEffect(() => () => {
    void setPickerMode(false);
    void setAutoHide(true);
  }, []);

  if (picking) {
    // The picker paints over this. What shows around it is our own frame, so
    // the moment reads as part of the app rather than a browser interrupting.
    return (
      <div className="picking">
        <div className="picking-title">Choose what to share</div>
        <div className="picking-hint">
          Pick a window or a screen above, and turn on <strong>Share audio</strong>{" "}
          before you confirm.
        </div>
      </div>
    );
  }

  if (snapshot.state !== "sharing") {
    return (
      <>
        <div className="card">
          <div className="headline">Share your screen</div>
          <div className="sub">Windows will ask what to share</div>
        </div>

        <div className="notice" data-tone="warn">
          Turn on the audio option in the Windows picker before choosing, or
          your friends watch in silence. It can't be switched on afterwards.
        </div>

        {snapshot.state === "error" && snapshot.message ? (
          <div className="notice">{snapshot.message}</div>
        ) : null}

        <div className="grow" />
        <div className="divider" />

        <div className="rows">
          <Row
            icon="share"
            label={snapshot.state === "starting" ? "Waiting for you to choose…" : "Choose what to share"}
            disabled={snapshot.state === "starting"}
            onClick={() => void start()}
          />
          <Row icon="back" label="Back" shortcut="Esc" onClick={onBack} />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="card">
        <div className="sub">Room code</div>
        <div className="code">{snapshot.roomId}</div>
        <div className="meter">
          <span
            style={{
              width: `${(snapshot.viewerIds.length / Math.max(1, snapshot.maxViewers)) * 100}%`,
            }}
          />
        </div>
      </div>

      <div className="readout">
        <span className="key">Watching</span>
        <span className="value">
          {snapshot.viewerIds.length} / {snapshot.maxViewers}
        </span>
      </div>
      <div className="readout">
        <span className="key">Sound</span>
        <span
          className="value"
          data-tone={
            snapshot.audioSource === "app"
              ? "ok"
              : snapshot.audioSource === "none"
                ? "fault"
                : undefined
          }
        >
          {snapshot.audioSource === "app"
            ? (snapshot.audioProcess ?? "this app only")
            : snapshot.audioSource === "system"
              ? "whole computer"
              : "off"}
        </span>
      </div>

      {snapshot.message ? (
        <div className="notice" data-tone="warn">
          {snapshot.message}
        </div>
      ) : null}

      <div className="divider" />

      <div className="rows">
        <Row
          icon="copy"
          label={copied === "code" ? "Copied" : "Copy room code"}
          shortcut="Ctrl C"
          onClick={() => copy(snapshot.roomId ?? "", "code")}
        />
        <Row
          icon="link"
          label={copied === "link" ? "Copied" : "Copy viewer link"}
          onClick={() => copy(`screenshare://room/${snapshot.roomId}`, "link")}
        />
      </div>

      <div className="grow" />
      <div className="divider" />

      <div className="rows">
        <Row
          icon="stop"
          label="Stop sharing"
          shortcut="Ctrl ."
          tone="danger"
          onClick={() => void onStop()}
        />
        <Row icon="back" label="Back — keeps sharing" shortcut="Esc" onClick={onBack} />
      </div>
    </>
  );
}
