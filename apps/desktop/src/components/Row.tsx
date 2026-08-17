import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon.js";

interface Props {
  icon?: IconName;
  label: ReactNode;
  shortcut?: string;
  tone?: "danger";
  disabled?: boolean;
  onClick: () => void;
}

/** One line of the popover menu: icon, label, and its shortcut hint. */
export function Row({ icon, label, shortcut, tone, disabled, onClick }: Props) {
  return (
    <button
      className="row"
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...(tone ? { "data-tone": tone } : {})}
      {...(icon ? {} : { "data-plain": "true" })}
    >
      {icon ? <Icon name={icon} /> : null}
      <span className="label">{label}</span>
      {shortcut ? <span className="shortcut">{shortcut}</span> : null}
    </button>
  );
}
