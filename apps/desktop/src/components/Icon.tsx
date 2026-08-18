/**
 * Hand-drawn line icons on a 16px grid.
 *
 * Inline rather than a library: the artifact CSP blocks every external
 * request, and six glyphs are not worth a bundled icon font.
 */
export type IconName =
  | "share"
  | "watch"
  | "pulse"
  | "stop"
  | "copy"
  | "link"
  | "expand"
  | "volume"
  | "mute"
  | "back"
  | "settings"
  | "quality"
  | "status"
  | "quit";

const PATHS: Record<IconName, JSX.Element> = {
  /**
   * lucide's `circle-dot-dashed`, verbatim, and the app's own mark: the same
   * drawing is what the tray shows, in the same colours.
   *
   * `scripts/make-icons.py` redraws this geometry for the tray and the
   * installer. The two have to be changed together.
   */
  status: (
    <>
      <path d="M10.1 2.18a9.93 9.93 0 0 1 3.8 0" />
      <path d="M17.6 3.71a9.95 9.95 0 0 1 2.69 2.7" />
      <path d="M21.82 10.1a9.93 9.93 0 0 1 0 3.8" />
      <path d="M20.29 17.6a9.95 9.95 0 0 1-2.7 2.69" />
      <path d="M13.9 21.82a9.94 9.94 0 0 1-3.8 0" />
      <path d="M6.4 20.29a9.95 9.95 0 0 1-2.69-2.7" />
      <path d="M2.18 13.9a9.93 9.93 0 0 1 0-3.8" />
      <path d="M3.71 6.4a9.95 9.95 0 0 1 2.7-2.69" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  // monitor with an outgoing arrow
  share: (
    <>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 14h5M8 11.5V14" />
      <path d="M8 8.5V4.5M8 4.5L6.2 6.3M8 4.5l1.8 1.8" />
    </>
  ),
  // monitor with a play mark
  watch: (
    <>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 14h5M8 11.5V14" />
      <path d="M6.8 5.4v3.2l2.8-1.6z" />
    </>
  ),
  pulse: <path d="M1.5 8h3l2-4.5L9.5 12l1.6-4h3.4" />,
  stop: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <rect x="5.8" y="5.8" width="4.4" height="4.4" rx="0.8" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
      <path d="M10.5 5.5v-2a1.5 1.5 0 0 0-1.5-1.5H3a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 3 11h2" />
    </>
  ),
  link: (
    <>
      <path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8" />
      <path d="M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8" />
    </>
  ),
  expand: <path d="M6 2H2v4M10 2h4v4M10 14h4v-4M6 14H2v-4" />,
  volume: (
    <>
      <path d="M3 6h2.5L9 3v10L5.5 10H3z" />
      <path d="M11.5 6.2a2.6 2.6 0 0 1 0 3.6" />
    </>
  ),
  mute: (
    <>
      <path d="M3 6h2.5L9 3v10L5.5 10H3z" />
      <path d="M11.5 6.5l3 3M14.5 6.5l-3 3" />
    </>
  ),
  back: <path d="M9.5 3.5L5 8l4.5 4.5" />,
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7L3.4 3.4" />
    </>
  ),
  // two sliders, each broken around its knob
  quality: (
    <>
      <path d="M2 5h4M9.5 5H14" />
      <circle cx="7.75" cy="5" r="1.75" />
      <path d="M2 11h6.25M13.75 11H14" />
      <circle cx="10.25" cy="11" r="1.75" />
    </>
  ),
  quit: (
    <>
      <path d="M8 1.8v6" />
      <path d="M12.2 4.2a5.5 5.5 0 1 1-8.4 0" />
    </>
  ),
};

/**
 * Glyphs that are not drawn on the 16px grid.
 *
 * The status mark is lucide's own geometry and is kept on lucide's 24 grid
 * rather than rescaled by hand — at a 2 unit stroke on 24 it carries the same
 * weight as 1.3 on 16, so nothing looks heavier next to it.
 */
const GRIDS: Partial<Record<IconName, { viewBox: string; strokeWidth: number }>> = {
  status: { viewBox: "0 0 24 24", strokeWidth: 2 },
};

interface Props {
  name: IconName;
  className?: string;
  /** Rendered size in px. The grid it was drawn on does not change. */
  size?: number;
}

export function Icon({ name, className, size = 16 }: Props) {
  const grid = GRIDS[name] ?? { viewBox: "0 0 16 16", strokeWidth: 1.3 };

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={grid.viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={grid.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
