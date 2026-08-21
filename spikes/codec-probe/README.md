# Codec probe (throwaway spike)

Answers three questions before we decide whether the runtime needs to change:

1. Does this Chromium offer H.264 **High** profile (`profile-level-id` starting `64`),
   the profile the reference app negotiates as `avc1.640028`?
2. Does the ranking the repo ships today
   (`services/webrtc/peer-connection.ts` → `applyCodecPreferences`) actually
   negotiate it? It filters on `/h264/i` and never reads `sdpFmtpLine`, so the
   expectation is **no** — it takes whatever H.264 entry Chromium lists first,
   which is Constrained Baseline.
3. What does High profile buy at a fixed 2.5 Mbps ceiling — the number the
   reference app pins with `q=2500000`?

This is disposable. Nothing in the product imports it, and it gets deleted once
the answer is recorded in `RESULTS.md`.

## Why a browser is enough this time

Unlike `capture-probe`, this does not need the Tauri shell. `getCapabilities`
and codec negotiation are not permission-gated — only `DisplayCapture` was, and
that question is already settled. WebView2 and Edge are the same Chromium build
from the same Evergreen runtime, so an Edge run is authoritative **as long as
the version matches**. The page prints its user agent for exactly that reason:
compare it against the `Edg/…` recorded in `capture-probe/RESULTS.md`. If the
majors differ, re-run inside the app window before trusting the result.

## Running it

From the synced Windows copy, in PowerShell:

```powershell
cd C:\Users\sams\source\janja-share\spikes\codec-probe
start msedge.exe (Resolve-Path .\index.html)
```

Then, in order:

- **1 · Codec inventory** — instant. This alone answers questions 1 and 2.
- **2 · A/B negotiation + quality** — ~50 s. Runs the two rankings back to back
  against *identical* synthetic 1080p frames at a 2.5 Mbps cap, so the
  comparison is not confounded by different screen content between runs.
- **3 · Real screen capture check** — ~25 s, optional. Confirms the shipping
  path: which encoder Chromium actually picks for a real `getDisplayMedia`
  stream, and what frame rate survives at 2.5 Mbps.

Then press **Copy results as Markdown** and paste into `RESULTS.md`.

## Reading the numbers

**`profile`** is the headline. `High` or `Constrained High` in run 2's
profile-aware row, where the repo-today row says `Constrained Baseline`, is the
finding we are after.

**`avg QP`** is the quality measurement, derived from `qpSum / framesEncoded`.
It is the quantiser the encoder settled on to hit the bitrate cap — **lower is
better**, and it is the honest way to compare two codecs at the same bitrate.
Roughly: under 25 looks clean, 30 is visibly soft, past 35 text stops being
readable. A 2–4 point drop at the same kbps is what High profile is worth.

**`encoder`** distinguishes hardware from software. Chromium's bundled
`OpenH264` software encoder is Constrained-Baseline-only, so if that is what
shows up, High profile was never reachable and the answer to "should we switch
runtime" changes. Anything naming MediaFoundation, NVENC, QSV, VAAPI or
`ExternalEncoder` is the hardware path.

**`limited by`** is `qualityLimitationReason`: `bandwidth` means the cap is
binding (expected, and what makes the QP comparison meaningful), `cpu` means the
machine could not keep up and the run should be discarded, `none` means the
encoder never even needed the whole 2.5 Mbps.

## What would change the recommendation

- High profile present **and** negotiated by the profile-aware ranking →
  fix `applyCodecPreferences`, keep Tauri. No Electron.
- High profile present but never negotiated even when ranked first → the
  answerer or the encoder is refusing it; worth one more look before any rewrite.
- High profile absent, and `encoder` says `OpenH264` → hardware encoding is not
  being used at all. That is a real problem, but a Chromium-flag problem, and
  *that* is the case where pinning the runtime with Electron becomes a genuine
  question rather than a guess.
