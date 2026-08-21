import { describe, expect, it, vi } from "vitest";
import {
  QUALITY_PRESETS,
  loadPreset,
  savePreset,
  type PresetStorage,
  type QualityPreset,
} from "./settings.js";

function storage(initial: Record<string, string> = {}): PresetStorage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

const hostile: PresetStorage = {
  getItem: () => {
    throw new Error("storage is gone");
  },
  setItem: () => {
    throw new Error("storage is gone");
  },
};

describe("quality presets", () => {
  it("describes every preset with a usable profile", () => {
    for (const [name, preset] of Object.entries(QUALITY_PRESETS)) {
      expect(preset.label, name).toBeTruthy();
      expect(preset.detail, name).toBeTruthy();
      expect(preset.profile.width, name).toBeGreaterThan(0);
      expect(preset.profile.height, name).toBeGreaterThan(0);
      expect(preset.profile.frameRate, name).toBeGreaterThan(0);
      expect(preset.profile.maxBitrateBps, name).toBeGreaterThan(0);
    }
  });

  it("leaves automatic on the numbers the app already used", () => {
    // Naming the existing behaviour must not change it: anyone who never
    // opens this screen has to get exactly the share they got before.
    expect(QUALITY_PRESETS.auto.profile).toEqual({
      width: 1920,
      height: 1080,
      frameRate: 60,
      maxBitrateBps: 8_000_000,
      degradationPreference: "maintain-resolution",
      contentHint: "detail",
    });
  });

  it("lets only the motion presets give up pixels to keep frames", () => {
    for (const name of ["smooth", "video", "game"] as const) {
      expect(QUALITY_PRESETS[name].profile.degradationPreference, name).toBe(
        "maintain-framerate",
      );
    }
    for (const name of ["auto", "thrifty"] as const) {
      expect(QUALITY_PRESETS[name].profile.degradationPreference, name).toBe(
        "maintain-resolution",
      );
    }
  });

  it("tells the encoder it is watching motion only for a game or a video", () => {
    // The hint is what stops the encoder from spending its budget preserving
    // every edge of a scene that changes completely each frame.
    for (const name of ["game", "video"] as const) {
      expect(QUALITY_PRESETS[name].profile.contentHint, name).toBe("motion");
    }
    for (const name of ["auto", "smooth", "thrifty"] as const) {
      expect(QUALITY_PRESETS[name].profile.contentHint, name).toBe("detail");
    }
  });

  it("costs less to encode than every preset it competes with", () => {
    // Half the frames of automatic, and the sharer runs one encoder per viewer.
    expect(QUALITY_PRESETS.game.profile.frameRate).toBeLessThan(
      QUALITY_PRESETS.auto.profile.frameRate,
    );
    expect(QUALITY_PRESETS.game.profile.frameRate).toBeLessThan(
      QUALITY_PRESETS.smooth.profile.frameRate,
    );
  });

  it("spends less on bandwidth than automatic when asked to", () => {
    expect(QUALITY_PRESETS.thrifty.profile.maxBitrateBps).toBeLessThan(
      QUALITY_PRESETS.auto.profile.maxBitrateBps,
    );
  });

  it("keeps every frame of a video, at a size the link can afford", () => {
    expect(QUALITY_PRESETS.video.profile.frameRate).toBe(60);
    expect(QUALITY_PRESETS.video.profile.height).toBe(720);
    // Fewer pixels per second than smooth motion at 1080p, so the ceiling can
    // sit lower without the picture falling apart.
    expect(QUALITY_PRESETS.video.profile.maxBitrateBps).toBeLessThan(
      QUALITY_PRESETS.smooth.profile.maxBitrateBps,
    );
  });
});

describe("loadPreset", () => {
  it("starts on automatic when nothing was ever chosen", () => {
    expect(loadPreset(storage())).toBe("auto");
  });

  it("returns what was saved", () => {
    const store = storage();
    savePreset("thrifty", store);
    expect(loadPreset(store)).toBe("thrifty");
  });

  it("falls back to automatic on a value it does not recognise", () => {
    // A hand-edited or outdated entry must not strand the user on a preset
    // that no longer exists.
    expect(loadPreset(storage({ "janja.quality": "ultra" }))).toBe("auto");
  });

  it("survives a storage that throws", () => {
    expect(loadPreset(hostile)).toBe("auto");
  });

  it("survives having no storage at all", () => {
    expect(loadPreset(undefined)).toBe("auto");
  });
});

describe("savePreset", () => {
  it("survives a storage that throws", () => {
    // Losing the preference is annoying; taking down the panel over it is not
    // an option.
    expect(() => savePreset("smooth", hostile)).not.toThrow();
  });

  it("survives having no storage at all", () => {
    expect(() => savePreset("smooth", undefined)).not.toThrow();
  });

  it("round trips every preset", () => {
    const store = storage();
    for (const name of Object.keys(QUALITY_PRESETS) as QualityPreset[]) {
      savePreset(name, store);
      expect(loadPreset(store)).toBe(name);
    }
  });
});

describe("storage access", () => {
  it("reads through the injected storage rather than a global", () => {
    const store = storage({ "janja.quality": "video" });
    const spy = vi.spyOn(store, "getItem");
    expect(loadPreset(store)).toBe("video");
    expect(spy).toHaveBeenCalledWith("janja.quality");
  });
});
