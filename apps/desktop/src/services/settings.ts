/**
 * The one preference the app has: how much of the link a share is allowed to
 * spend.
 *
 * A preset fixes resolution, frame rate and bitrate ceiling together, because
 * the three only make sense as a set — 4K at 60 fps inside a 2 Mbps ceiling is
 * a combination no one wants and every separate control invites.
 */

export type QualityPreset = "auto" | "smooth" | "video" | "game" | "thrifty" | "weak";

export interface QualityProfile {
  /** Hints, not demands. Real capture adapts to the monitor and the GPU. */
  width: number;
  height: number;
  frameRate: number;
  /** Ceiling, not a target. Congestion control decides the actual rate. */
  maxBitrateBps: number;
  /**
   * What to sacrifice when the link cannot carry the whole picture. Screen
   * content is usually unreadable without its pixels, so most presets drop
   * frames — but a preset named for motion has to do the opposite.
   */
  degradationPreference: RTCDegradationPreference;
  /**
   * What the encoder is looking at.
   *
   * "detail" tells it to protect sharpness, which is right for code and wrong
   * for a game: preserving every edge of a scene that changes completely each
   * frame is the most expensive thing you can ask of it.
   */
  contentHint: "detail" | "motion" | "text";
}

export interface QualityPresetInfo {
  label: string;
  detail: string;
  profile: QualityProfile;
}

export const QUALITY_PRESETS: Record<QualityPreset, QualityPresetInfo> = {
  auto: {
    label: "Automático",
    detail: "A conexão decide · até 5 Mbps",
    // Measured, not guessed: 1080p60 desktop content is already visually
    // transparent inside 2.5 Mbps (spikes/codec-probe). A ceiling is not a
    // target, but congestion control probes upward until it finds one, so
    // leaving it at 8 Mbps bought queueing delay rather than picture.
    profile: {
      width: 1920,
      height: 1080,
      frameRate: 60,
      maxBitrateBps: 5_000_000,
      degradationPreference: "maintain-resolution",
      contentHint: "detail",
    },
  },
  smooth: {
    label: "Movimento suave",
    detail: "1080p · 60 fps · até 8 Mbps",
    profile: {
      width: 1920,
      height: 1080,
      frameRate: 60,
      // Twice what the demanding case measured at, which is headroom for
      // motion rather than the 12 Mbps nothing was ever observed to use.
      maxBitrateBps: 8_000_000,
      // Would rather lose pixels than stutter.
      degradationPreference: "maintain-framerate",
      contentHint: "detail",
    },
  },
  video: {
    label: "Vídeo",
    // For a film or a stream playing on the shared screen: every frame, at a
    // size whose bitrate a residential uplink can actually carry. 720p60 costs
    // less than half the pixels of 1080p60 per second, which is what keeps
    // motion fluid where "Movimento suave" would be dropping to keep up.
    detail: "720p · 60 fps · até 5 Mbps",
    profile: {
      width: 1280,
      height: 720,
      frameRate: 60,
      maxBitrateBps: 5_000_000,
      // Video that stutters is worse than video that softens.
      degradationPreference: "maintain-framerate",
      // Film is motion, not edges: the same hint a game wants, for the same
      // reason.
      contentHint: "motion",
    },
  },
  game: {
    label: "Jogo",
    detail: "1080p · 30 fps · até 6 Mbps",
    profile: {
      width: 1920,
      height: 1080,
      // Half the frames is half the encoding work, and the sharer runs one
      // encoder per viewer. This is the single biggest lever there is.
      frameRate: 30,
      maxBitrateBps: 6_000_000,
      // A game that stutters is worse than a game that softens.
      degradationPreference: "maintain-framerate",
      contentHint: "motion",
    },
  },
  thrifty: {
    label: "Economia de banda",
    detail: "720p · 30 fps · até 2,5 Mbps",
    profile: {
      width: 1280,
      height: 720,
      frameRate: 30,
      maxBitrateBps: 2_500_000,
      degradationPreference: "maintain-resolution",
      contentHint: "detail",
    },
  },
  weak: {
    label: "Conexão fraca",
    // The floor of the list, for an uplink that cannot carry the one above it.
    // Named for when to pick it rather than for its bitrate: someone whose
    // share keeps stalling knows their connection is bad, not what 1,2 Mbps
    // buys. Resolution goes before frame rate here because a stalling picture
    // is what sent them looking for this preset in the first place.
    detail: "480p · 30 fps · até 1,2 Mbps",
    profile: {
      width: 854,
      height: 480,
      frameRate: 30,
      maxBitrateBps: 1_200_000,
      degradationPreference: "maintain-resolution",
      contentHint: "detail",
    },
  },
};

/** Just the slice of the Storage API this needs, so tests can hand it one. */
export interface PresetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "janja.quality";
const DEFAULT: QualityPreset = "auto";

function isPreset(value: string | null): value is QualityPreset {
  return value !== null && Object.hasOwn(QUALITY_PRESETS, value);
}

/**
 * Storage is optional everywhere below: WebView2 provides it, a bare test
 * runner does not, and neither case is worth a failure. Losing the preference
 * costs the user one click; throwing here would cost them the panel.
 */
function defaultStorage(): PresetStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function loadPreset(storage: PresetStorage | undefined = defaultStorage()): QualityPreset {
  try {
    const stored = storage?.getItem(KEY) ?? null;
    return isPreset(stored) ? stored : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function savePreset(
  preset: QualityPreset,
  storage: PresetStorage | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(KEY, preset);
  } catch {
    // Nothing to do and nothing to tell the user: the preset still applies to
    // this session, it just will not survive a restart.
  }
}
