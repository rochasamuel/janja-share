# Capture probe results

Date: 2026-08-17
Host: Windows 11, WebView2 / Edg 151.0.0.0, Tauri 2.11.5
Verdict: **capture and system audio both work. Build the sharer in TypeScript.**

## Measurements

Run inside the real ScreenShare window, not a browser. (An earlier run in
Firefox reported zero audio tracks and was discarded — Firefox has never
implemented audio in `getDisplayMedia`, so it cannot answer this question. The
probe now detects the engine and refuses to present such a run as a result.)

| | Entire screen | Single window |
|---|---|---|
| Picker shown | yes | yes |
| Video tracks | 1 (`screen:0:0`) | 1 (`window:1051672:0`) |
| Audio tracks | **0** | **1 (`System Audio`)** |
| Negotiated | 1920x1080 @ 60 fps | 1920x1080 @ 60 fps |
| H.264 available | yes | yes |

## What this settles

**System audio is available.** That was the open question and the answer is
yes. The design's plan holds: media stays in TypeScript, and Rust is confined
to the tray, windowing and packaging. No native capture path is needed.

**1080p60 is real, not aspirational.** Both runs negotiated the full target,
so the quality goal is achievable on this hardware rather than something to
degrade towards.

**H.264 is present**, so hardware encoding is available and the codec
preference in the design is satisfiable.

## What this corrects

The design doc predicted that whole-screen capture would carry audio and
window capture would not. **The observed behaviour was the reverse.**

The most likely cause is the picker's "share system audio" checkbox, which is
a per-selection choice rather than a property of the source kind: the run that
produced audio is the run where the box was ticked. Either way, the practical
consequence is the same and it is not what the design assumed:

> Whether audio arrives is the user's choice in the Windows picker, and the
> app cannot force it.

So the app must do two things, and neither depends on which source kind is
chosen:

1. Tell the user to tick the audio option **before** the picker appears, since
   afterwards it is too late.
2. Detect a missing audio track and say so plainly, then carry on video-only.

Guidance that names a specific source kind ("pick a whole screen to get
sound") would be wrong here, and has been removed.

## Follow-up worth doing once

Confirm whether the checkbox appears for both source kinds or only some. It
changes the wording of the hint, not the architecture, so it is not blocking.
