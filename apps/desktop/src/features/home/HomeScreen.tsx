import { Row } from "../../components/Row.js";
import { quitApp } from "../../services/panel.js";

interface Props {
  onCreate: () => void;
  onJoin: () => void;
  onOpenChannel: () => void;
  onDiagnostics: () => void;
  onQuality: () => void;
  /** Null when not in a channel. */
  channelId: string | null;
  memberCount: number;
  publishing: boolean;
  watchingName: string | null;
}

export function HomeScreen({
  onCreate,
  onJoin,
  onOpenChannel,
  onDiagnostics,
  onQuality,
  channelId,
  memberCount,
  publishing,
  watchingName,
}: Props) {
  return (
    <>
      <div className="card">
        {channelId ? (
          <>
            <div className="headline">
              {memberCount === 1
                ? "Você está sozinho no canal"
                : `${memberCount} pessoas no canal`}
            </div>
            <div className="code">{channelId}</div>
          </>
        ) : (
          <>
            <div className="headline">Você não está em nenhum canal</div>
            <div className="sub">Crie um canal, ou entre em um com o código</div>
          </>
        )}
      </div>

      <div className="rows">
        {channelId ? (
          <Row
            icon="watch"
            label={
              publishing && watchingName
                ? `Abrir o canal · ao vivo, vendo ${watchingName}`
                : publishing
                  ? "Abrir o canal · ao vivo"
                  : watchingName
                    ? `Abrir o canal · vendo ${watchingName}`
                    : "Abrir o canal"
            }
            shortcut="Ctrl K"
            onClick={onOpenChannel}
          />
        ) : (
          <>
            <Row icon="share" label="Criar um canal" shortcut="Ctrl N" onClick={onCreate} />
            <Row icon="watch" label="Entrar em um canal" shortcut="Ctrl J" onClick={onJoin} />
          </>
        )}
      </div>

      <div className="divider" />

      <div className="rows">
        <Row icon="quality" label="Qualidade" shortcut="Ctrl ," onClick={onQuality} />
        <Row icon="pulse" label="Teste de captura" shortcut="Ctrl D" onClick={onDiagnostics} />
      </div>

      <div className="grow" />

      <div className="divider" />

      <div className="rows">
        <Row icon="quit" label="Sair" shortcut="Ctrl Q" onClick={() => void quitApp()} />
      </div>
    </>
  );
}
