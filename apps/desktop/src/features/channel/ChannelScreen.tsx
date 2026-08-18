import { useCallback, useState } from "react";
import { Row } from "../../components/Row.js";
import type { SharingSnapshot } from "../sharing/sharing-manager.js";
import type { ViewingSnapshot } from "../viewing/viewing-manager.js";
import type { ChannelSnapshot } from "./channel-manager.js";

interface Props {
  channel: ChannelSnapshot;
  sharing: SharingSnapshot;
  viewing: ViewingSnapshot;
  onPublish: () => void;
  onStopPublishing: () => void;
  onShareDetails: () => void;
  onWatch: (publisherId: string) => void;
  onOpenStream: () => void;
  onLeave: () => void;
  onBack: () => void;
}

export function ChannelScreen({
  channel,
  sharing,
  viewing,
  onPublish,
  onStopPublishing,
  onShareDetails,
  onWatch,
  onOpenStream,
  onLeave,
  onBack,
}: Props) {
  const [copied, setCopied] = useState(false);

  const copyCode = useCallback(() => {
    void navigator.clipboard.writeText(channel.channelId ?? "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [channel.channelId]);

  const live = sharing.state === "sharing";
  const viewerCount = sharing.viewerIds.length;

  return (
    <>
      <div className="card">
        <div className="sub">
          {channel.selfName ? `Você é ${channel.selfName}` : "Código do canal"}
        </div>
        <div className="code">{channel.channelId}</div>
      </div>

      {channel.message ? <div className="notice">{channel.message}</div> : null}

      <div className="rows">
        {live ? (
          <>
            <Row
              icon="pulse"
              label={`Transmitindo para ${viewerCount} de ${sharing.maxViewers}`}
              onClick={onShareDetails}
            />
            {/* The global chord, not the in-app one. Ctrl+. still works, but
                the hint is worth spending on the shortcut that reaches a
                fullscreen game — the only place stopping is actually hard. */}
            <Row
              icon="stop"
              tone="danger"
              label="Parar de compartilhar"
              shortcut="Ctrl Alt S"
              onClick={onStopPublishing}
            />
          </>
        ) : (
          <Row
            icon="share"
            label="Compartilhar minha tela"
            shortcut="Ctrl Alt S"
            onClick={onPublish}
          />
        )}
      </div>

      <div className="divider" />

      <div className="rows members">
        {channel.members.length === 0 ? (
          <div className="empty">Ninguém mais no canal ainda</div>
        ) : null}

        {channel.members.map((member) => {
          const watched = viewing.publisherId === member.id;
          const connecting = watched && viewing.state === "connecting";

          return (
            <Row
              key={member.id}
              {...(member.publishing ? { icon: "watch" as const } : {})}
              // Only a publisher can be watched. Everyone else is here to be
              // seen in the list, which is the point of joining without
              // sharing anything.
              disabled={!member.publishing}
              onClick={() => (watched ? onOpenStream() : onWatch(member.id))}
              label={
                <span className="member">
                  <span className="member-name">{member.name}</span>
                  {member.publishing ? <span className="badge">ao vivo</span> : null}
                </span>
              }
              {...(connecting
                ? { shortcut: "conectando" }
                : watched
                  ? { shortcut: "assistindo" }
                  : {})}
            />
          );
        })}
      </div>

      <div className="grow" />
      <div className="divider" />

      <div className="rows">
        <Row
          icon="copy"
          label={copied ? "Copiado" : "Copiar código"}
          shortcut="Ctrl C"
          onClick={copyCode}
        />
        <Row icon="leave" tone="danger" label="Sair do canal" onClick={onLeave} />
        <Row icon="back" label="Voltar" shortcut="Esc" onClick={onBack} />
      </div>
    </>
  );
}
