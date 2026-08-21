import { Row } from "../../components/Row.js";
import { QUALITY_PRESETS, type QualityPreset } from "../../services/settings.js";

interface Props {
  preset: QualityPreset;
  /** True while a share is running, which is when a change takes effect now. */
  sharing: boolean;
  onSelect: (preset: QualityPreset) => void;
  onBack: () => void;
}

/** Fixed order, cheapest last: the list reads as a scale rather than a set. */
const ORDER: QualityPreset[] = ["auto", "smooth", "video", "game", "thrifty"];

export function QualityScreen({ preset, sharing, onSelect, onBack }: Props) {
  return (
    <>
      <div className="card">
        <div className="headline">{QUALITY_PRESETS[preset].label}</div>
        <div className="sub">
          {sharing
            ? "Vale para este compartilhamento na hora"
            : "Vale a partir do próximo compartilhamento"}
        </div>
      </div>

      <div className="rows">
        {ORDER.map((name) => {
          const info = QUALITY_PRESETS[name];
          return (
            <button
              key={name}
              type="button"
              className="row choice"
              onClick={() => onSelect(name)}
              {...(name === preset ? { "data-selected": "true" } : {})}
            >
              <span className="choice-mark" />
              <span className="label">{info.label}</span>
              <span className="shortcut">{info.detail}</span>
            </button>
          );
        })}
      </div>

      <div className="grow" />
      <div className="divider" />

      <div className="rows">
        <Row icon="back" label="Voltar" shortcut="Esc" onClick={onBack} />
      </div>
    </>
  );
}
