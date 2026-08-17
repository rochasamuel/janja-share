import { useCallback, useEffect, useState } from "react";
import { Row } from "../../components/Row.js";
import { setAutoHide } from "../../services/panel.js";
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

  const start = useCallback(async () => {
    // The Windows picker steals focus, and a popover that hides on blur would
    // vanish mid-flow. Pin it open until the picker is done.
    await setAutoHide(false);
    try {
      await onStart();
    } finally {
      await setAutoHide(true);
    }
  }, [onStart]);

  useEffect(() => () => void setAutoHide(true), []);

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
        <span className="value" data-tone={snapshot.hasSystemAudio ? "ok" : "fault"}>
          {snapshot.hasSystemAudio ? "on" : "off"}
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
