import { Row } from "../../components/Row.js";
import type { ChannelState } from "./channel-manager.js";

interface Props {
  state: ChannelState;
  message: string | null;
  onRetry: () => void;
  onBack: () => void;
}

/**
 * The wait between asking for a channel and having one.
 *
 * It exists because creating and joining are different acts: joining needs a
 * code typed in, creating needs nothing at all. Sending someone to the code
 * input to create a channel asks them for the very thing they came here to be
 * given.
 */
export function CreatingScreen({ state, message, onRetry, onBack }: Props) {
  const failed = state === "error";

  return (
    <>
      <div className="card">
        <div className="headline">{failed ? "Não deu certo" : "Criando o canal…"}</div>
        <div className="sub">
          {failed ? "Nada foi criado" : "Pedindo um código ao servidor"}
        </div>
      </div>

      {failed && message ? <div className="notice">{message}</div> : null}

      <div className="grow" />
      <div className="divider" />

      <div className="rows">
        {failed ? <Row icon="share" label="Tentar de novo" onClick={onRetry} /> : null}
        <Row icon="back" label="Voltar" shortcut="Esc" onClick={onBack} />
      </div>
    </>
  );
}
