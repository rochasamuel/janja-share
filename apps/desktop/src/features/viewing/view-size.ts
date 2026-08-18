import type { ViewSize } from "@janja/signaling-protocol";

/** The two document facts that decide how much picture the viewer can show. */
export interface ViewSizeSource {
  fullscreenElement: Element | null;
  pictureInPictureElement: Element | null;
}

/**
 * Which tier of picture the publisher should send.
 *
 * "panel" is the fixed 320px popover; anything else — the monitor in
 * fullscreen, or a picture-in-picture window the user sizes as they like — is
 * "fullscreen". Picture-in-picture counts as out of the panel because there
 * is no way to ask for less picture that would not look like the panel: the
 * window can be dragged to any size, and the tier is a ceiling the encoder
 * adapts under, not a demand.
 *
 * Takes the facts rather than `document` so it can be tested in Node.
 */
export function viewSizeOf(source: ViewSizeSource): ViewSize {
  return source.fullscreenElement || source.pictureInPictureElement ? "fullscreen" : "panel";
}
