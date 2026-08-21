import { describe, expect, it, vi } from "vitest";
import { ORDER } from "../features/settings/QualityScreen.js";
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

  it("asks for the full picture, inside a ceiling measurement can justify", () => {
    // This used to pin 8 Mbps on the grounds that whoever never opens the
    // quality screen should get exactly the share they got before. That held
    // until the figure was measured: 1080p60 desktop content is visually
    // transparent inside 2.5 Mbps (spikes/codec-probe), so the extra five
    // megabits bought queueing delay rather than picture. Resolution and
    // frame rate are unchanged — only the ceiling moved.
    expect(QUALITY_PRESETS.auto.profile).toEqual({
      width: 1920,
      height: 1080,
      frameRate: 60,
      maxBitrateBps: 5_000_000,
      degradationPreference: "maintain-resolution",
      contentHint: "detail",
    });
  });

  it("keeps the default ceiling clear of the floor a panel viewer scales it to", () => {
    // A panel viewer gets the ceiling divided by nine, and
    // viewer-connection-manager refuses to go below 500 kbps. The thrifty
    // preset is deliberately low enough to land on that floor — that is what
    // the floor is for. The default is not allowed to, because a default that
    // clamps makes the scaling vacuous for everyone who never opens this
    // screen, which is most people.
    expect(QUALITY_PRESETS.auto.profile.maxBitrateBps / 9).toBeGreaterThan(500_000);
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

  it("shows every preset in the screen that lists them", () => {
    // A preset missing from ORDER is simply invisible: it type-checks, it
    // tests, and no one can ever pick it. Nothing else catches that.
    expect([...ORDER].sort()).toEqual(Object.keys(QUALITY_PRESETS).sort());
  });

  it("says what each preset costs, not only what it is for", () => {
    // The label names the use ("Jogo"); without the ceiling in the detail
    // line, nothing on screen tells you what picking it spends.
    for (const [name, preset] of Object.entries(QUALITY_PRESETS)) {
      expect(preset.detail, name).toMatch(/\d(,\d)? Mbps/);
    }
  });

  it("offers a rung below thrifty for a link that cannot carry it", () => {
    expect(QUALITY_PRESETS.weak.profile.maxBitrateBps).toBeLessThan(
      QUALITY_PRESETS.thrifty.profile.maxBitrateBps,
    );
    // Fewer pixels as well as fewer bits: 720p inside 1,2 Mbps would be a
    // ceiling the resolution cannot live under.
    expect(QUALITY_PRESETS.weak.profile.height).toBeLessThan(
      QUALITY_PRESETS.thrifty.profile.height,
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
