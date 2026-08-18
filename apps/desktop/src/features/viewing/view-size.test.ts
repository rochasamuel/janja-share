import { describe, expect, it } from "vitest";
import { viewSizeOf } from "./view-size.js";

const el = {} as Element;

describe("viewSizeOf", () => {
  it("is the panel when the video sits inside the popover", () => {
    expect(viewSizeOf({ fullscreenElement: null, pictureInPictureElement: null })).toBe("panel");
  });

  it("is fullscreen when the video fills the monitor", () => {
    expect(viewSizeOf({ fullscreenElement: el, pictureInPictureElement: null })).toBe(
      "fullscreen",
    );
  });

  it("is fullscreen in picture-in-picture: the user sizes that window, not the popover", () => {
    expect(viewSizeOf({ fullscreenElement: null, pictureInPictureElement: el })).toBe(
      "fullscreen",
    );
  });
});
