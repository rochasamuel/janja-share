import { useState } from "react";
import { CHANNEL_ID_LENGTH } from "@janja/signaling-protocol";
import { Row } from "../../components/Row.js";
import type { ChannelState } from "./channel-manager.js";

interface Props {
  state: ChannelState;
  message: string | null;
  onJoin: (channelId: string) => void;
  onBack: () => void;
}

export function JoinScreen({ state, message, onJoin, onBack }: Props) {
  const [code, setCode] = useState("");
  const ready = code.trim().length === CHANNEL_ID_LENGTH;
  const joining = state === "joining";

  return (
    <>
      <div className="card">
        <div className="sub">Código do canal</div>
        <input
          className="code-input"
          value={code}
          onChange={(event) =>
            setCode(event.target.value.toUpperCase().slice(0, CHANNEL_ID_LENGTH))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && ready && !joining) onJoin(code.trim());
          }}
          placeholder="––––––"
          spellCheck={false}
          autoFocus
        />
      </div>

      {message ? <div className="notice">{message}</div> : null}

      <div className="grow" />
      <div className="divider" />

      <div className="rows">
        <Row
          icon="watch"
          label={joining ? "Entrando…" : "Entrar"}
          shortcut="Enter"
          disabled={!ready || joining}
          onClick={() => onJoin(code.trim())}
        />
        <Row icon="back" label="Voltar" shortcut="Esc" onClick={onBack} />
      </div>
    </>
  );
}
