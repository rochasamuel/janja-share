import { describe, expect, it } from "vitest";
import { shareShortcutAction } from "./share-shortcut.js";

describe("shareShortcutAction", () => {
  it("starts a share when in a channel and idle", () => {
    // The case the shortcut exists for: pressed from inside a fullscreen game,
    // which never has to be left and so never gets minimised.
    expect(shareShortcutAction({ live: false, inChannel: true })).toBe("start");
  });

  it("stops a share that is running", () => {
    // Symmetric to starting: reaching the panel to stop would mean leaving the
    // game, which is the whole problem this shortcut is for.
    expect(shareShortcutAction({ live: true, inChannel: true })).toBe("stop");
  });

  it("asks for a channel rather than failing silently", () => {
    expect(shareShortcutAction({ live: false, inChannel: false })).toBe("needs-channel");
  });

  it("still stops a share whose channel has gone", () => {
    // A dropped channel must not strand a live capture: the person pressed the
    // key to end it, and the capture is real whatever the membership says.
    expect(shareShortcutAction({ live: true, inChannel: false })).toBe("stop");
  });
});
