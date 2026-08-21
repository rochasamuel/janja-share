# Codec probe results

Date: 2026-08-21
Host: Windows 11, Edge / WebView2 **151.0.4129.93** (same build for both — the
Edge run is authoritative for the app window)
Verdict: **keep Tauri. Rank H.264 by profile in `applyCodecPreferences`.**

## 1 · Is High profile available?

**Yes, on both sides.**

| side | H.264 entries offered |
|---|---|
| sender | `42001F` Baseline, `42E01F` Constrained Baseline, `4D001F` Main, **`640032` High 5.0** |
| receiver | `42001F`, `42E01F`, `4D001F`, `F4001F` High 4:4:4, **`64001F` High 3.1** |

## 2 · Does the shipping ranking negotiate it?

**No.** `applyCodecPreferences` filters on `/h264/i` and never reads
`sdpFmtpLine`, so it keeps Chromium's own order — which lists plain Baseline
first.

| ranking | codec it puts first |
|---|---|
| repo today | `video/H264 42001F` (Baseline) |
| profile-aware | `video/H264 640032` (High) |

## 3 · What is High profile worth?

Two A/B runs, each negotiating via the two rankings against **identical**
deterministic 1080p content at a **2.5 Mbps** cap (the `q=2500000` the
reference app pins). `avg QP` = `qpSum / framesEncoded`; lower is better.

### Desktop / screen content — near-static, text-heavy

| ranking | negotiated | kbps | fps | res | avg QP |
|---|---|---|---|---|---|
| repo today | `42001F` Baseline | 2502 | 60 | 1920x1080 | **17.5** |
| profile-aware | `64001F` High | 2507 | 60 | 1920x1080 | **17.3** |

**No meaningful difference.** At QP 17 the encoder is already visually
transparent — 2.5 Mbps is simply more than ordinary screen content needs at
1080p60, in either profile. `qualityLimitationReason` was `none` throughout.

### Game-like content — full-frame motion, sharp sprites, 1080p pinned

| ranking | negotiated | kbps | fps | res | avg QP | ms/frame |
|---|---|---|---|---|---|---|
| repo today | `42001F` Baseline | 2499 | 56.9 | 1920x1080 | **41.1** | 7.88 |
| profile-aware | `64001F` High | 2497 | 55.4 | 1920x1080 | **38.8** | 7.74 |

**2.3 QP lower at the same bitrate.** As a rule of thumb 6 QP steps ≈ a
doubling of bitrate, so 2.3 ≈ `2^(2.3/6)` ≈ **1.3× — Baseline needs roughly 30%
more bits to match**, or High saves about 23%. Encode cost did not increase.

## What this settles

**Do not rewrite in Electron.** Every capability the reference app uses is
already reachable from the current runtime. The gap was never the runtime; it
was a codec preference list that never looked at `profile-level-id`.

**The reference app's "1080p60 on almost nothing" is not magic.** Its own URL
says `q=2500000&fps=30`. Run 1 shows why it looks fine: ordinary screen content
at 1080p60 fits inside 2.5 Mbps with quality to spare *even on Baseline*. The
claim is true for desktop content and false for a fast game.

**High profile is worth having anyway**, because the game case is exactly where
Janja Share currently hurts, and ~23% is a free 23% — same encode time, one
ranking change, no renegotiation, no protocol change.

## 4 · Every codec, compared

Same 2.5 Mbps cap, same deterministic 1080p frames, resolution pinned. Quality
is **PSNR against the exact source frame**, recovered by stamping a 16-bit
counter into the picture and reading it back off the decoded frame — QP cannot
be compared across codecs, because H.264 quantises on 0–51 and VP9/AV1 on 0–255.
Every sample had to beat its own neighbouring frames or be discarded; all runs
below are 25 accepted samples with 0 rejected.

| codec | PSNR dB | kbps | fps | ms/frame | CPU per viewer |
|---|---|---|---|---|---|
| **H.264 High** (negotiated `64001F`) | **35.28** | 2479 | 50.2 | 8.14 | ~41% |
| H.264 High 5.0 (forced `640032`) | 35.28 | 2515 | 51.9 | 8.11 | ~42% |
| H.264 High 4.0 (forced `640028`) | 35.16 | 2476 | 51.1 | 7.98 | ~41% |
| H.264 High 3.1 (forced `64001F`) | 35.09 | 2478 | 53.0 | 8.18 | ~43% |
| VP9 | 34.76 | 2472 | 37.0 | 6.93 | ~26% |
| VP8 | 34.43 | 2485 | 34.4 | 5.05 | ~17% |
| H.264 Main | 34.32 | 2489 | 54.2 | 8.07 | ~44% |
| AV1 | 33.94 | 2477 | **15.8** | 10.61 | ~17% |
| H.264 Baseline (**shipped until now**) | 33.16 | 2494 | 50.3 | 8.14 | ~41% |

### H.264 High wins, and it is not close on the axis that matters

It is both the best quality *and* among the highest frame rates. Nothing else
manages both: VP9 gives up 0.5 dB **and** a third of the frames, AV1 gives up
quality *and* two thirds of the frames.

### The level is irrelevant — `avc1.640028` is not the point

3.1, 4.0 and 5.0 measured 35.09 / 35.16 / 35.28, a 0.2 dB spread that is inside
the run-to-run noise. The reference app's `avc1.640028` is simply whatever its
receiver happened to negotiate. **Only the profile is worth asking for**, which
is why `rankVideoCodecs` scores `profile_idc` and ignores `level_idc` entirely.

### AV1 is disqualified, despite being the newest codec here

15.8 fps at 1080p on a software encoder, *and* worse quality than H.264 High.
The sharer runs one encoder per viewer, so this is the one result that would get
dramatically worse with an audience.

## Caveats

- **Hardware vs software encoding is still undetermined.** `encoderImplementation`
  is absent from Chromium 151's `outbound-rtp` stats (full key list is in the
  probe log). 8 ms/frame is slower than a dedicated NVENC path would suggest,
  but High profile working at all rules out Chromium's bundled OpenH264, which
  is Constrained-Baseline-only. Read `edge://gpu` → "Video Encode" to settle it.
- **Loopback on one machine has no network**: no loss, no RTT, no congestion
  control doing anything real. These are encoder-efficiency numbers only.
- The `CPU per viewer` column is `ms/frame × fps`, i.e. fraction of one core.
  It is arithmetic from the two measured columns, not an independent measurement.
- Two earlier attempts produced numbers that looked plausible and were wrong: a
  14-bit counter wrapped at frame 16384 mid-session, and a `display:none` video
  sink was never painted. Both failures returned ~17.5 dB — the PSNR of two
  unrelated frames of this content. The neighbour check now rejects any sample
  whose identified frame does not beat its own neighbours, which is what makes
  the table above trustworthy.

## Appendix — earlier caveats


- **Hardware vs software encoding is undetermined.** `encoderImplementation` is
  not present in Chromium 151's `outbound-rtp` stats (full key list captured in
  the probe log), so getStats cannot answer it. 7.9 ms/frame at 1080p60 *hints*
  at hardware, but that is inference, not proof. If it matters, read
  `edge://gpu` → "Video Encode" directly.
- **Negotiated level was 3.1, not the sender's advertised 5.0**, because the
  receiver only offers `64001F`. It still carried 1080p60 fine
  (`level-asymmetry-allowed=1`), but it is the reason the reference app's
  `640028` (level 4.0) differs from what we get.
- Loopback on one machine has no real network: no loss, no RTT, no congestion
  control doing anything interesting. These numbers are encoder efficiency
  only, not end-to-end behaviour.
- An earlier "hard content" run used near-white noise, which is incompressible;
  the encoder abandoned resolution (collapsed to 480x270) and the run was
  discarded. Replaced by the game-like source above.


## 5 · What sharing costs the sharer (`perf.html`)

A heavy WebGL workload stands in for the game; a heavy JS loop stands in for its
CPU side. Both are measured in the same window, before and during sharing.
Machine reports **16 cores**.

| configuration | GPU ms | GPU cost | CPU ms | CPU cost | encoder ms/s | enc res |
|---|---|---|---|---|---|---|
| nothing shared | 9.6 | — | 2.6 | — | 0 | — |
| 1080p60 · 1 viewer | 9.7 | 0% | 2.6 | 0% | 221 | 1920x1080 |
| 1080p60 · 3 viewers | 9.7 | 0% | 2.6 | 0% | **2646** | 1920x1080 |
| 1080p30 · 3 viewers (Jogo) | 10.6 | **+9.3%** | 2.6 | 0% | 1355 | 960x540 |
| 480p30 · 3 viewers (Conexão fraca) | 10.5 | **+8.2%** | 2.7 | 0% | 133 | 853x480 |
| 1080p60 · 3 viewers, panel scale | 10.6 | **+9.3%** | 2.6 | 0% | 885 | 640x360 |

### On this machine, sharing costs the game nothing measurable

Neither stand-in lost anything to CPU contention. 2646 ms/s of encoding is 2.6
cores — spread across 16, it never touches a single-threaded workload.

### Scaling the picture down costs GPU that sending it whole does not

The three configurations that scale (`960x540`, `853x480`, `640x360`) each cost
~9% GPU; the two that send native 1080p cost 0%. `scaleResolutionDownBy` is a
per-viewer GPU resample, so asking for a smaller picture buys lower CPU and
bitrate at the price of GPU work. **Panel scale is where every viewer starts**,
so this is the common path, not an edge case.

### The number that will not survive weaker hardware

2.6 cores for three viewers at 1080p60 is comfortable on 16 cores and is most
of a 4-core laptop. Core count, not the preset, is what decides whether sharing
costs a game its frame rate — and this probe cannot test the machines where the
answer changes.

## Caveats on section 5

- **The `frames/s encoded` column is not trustworthy**, and a later run showed
  why. One viewer reported 15 fps while three reported 45 fps *each*, and the
  same configuration gave 43 then 135 across two runs. A long single-stream run
  (`warm.html`, 10 000+ frames) held a clean **60 fps at 1920x1080** throughout,
  so the low figures were rate-control ramp over near-noise content, not a
  throughput ceiling. Nothing above is built on that column.
- **The stand-in is not a game.** It is one GPU-bound and one CPU-bound loop in
  the same process as the encoders. A real game is a separate process with its
  own GPU context and its own vsync.
- **The rendered content is close to noise**, which is far harder to encode than
  real game footage, so the encoder CPU figures are pessimistic.
- Hardware encode is **enabled** — see section 6. An earlier note here inferred
  software encoding from "8 ms/frame is too slow for hardware". That inference
  was wrong and has been withdrawn: `totalEncodeTime` is submit-to-complete
  latency, not CPU occupancy, so it says nothing about which encoder ran.


## 6 · Hardware or software encoding? (settled)

Read from Chromium's own `SystemInfo.getInfo` over the DevTools protocol —
the data source behind `edge://gpu` — rather than by eye:

```
video_encode      enabled
video_decode      enabled
gpu_compositing   enabled
AMD Radeon RX 9070 XT   0x1002:0x7550
ANGLE (AMD, ... Direct3D11 vs_5_0 ps_5_0, D3D11-32.0.31035.1003)
```

**Hardware video encode is available and not blocklisted on this machine.**

### A withdrawn inference

Section 5 previously argued that 8 ms/frame was "too slow for a hardware
encoder", implying software. That was unsound. `totalEncodeTime` measures
submit-to-complete **latency**, and an asynchronous hardware encoder has fixed
queue latency that has nothing to do with CPU occupancy. The same reasoning
made VP8 (5 ms/frame, software-only everywhere) look "faster" than H.264, which
should have been the clue that the metric was being misread.

### What is still not determinable from here

Whether a *given* WebRTC stream actually used the hardware path. Two routes
were tried and both are dead ends on Edge 151:

- `RTCOutboundRtpStreamStats.encoderImplementation` and `powerEfficientEncoder`
  are absent from this build's stats entirely (full key dump in the probe log).
- `SystemInfo.getInfo`'s `videoEncoding` profile array stays empty even after
  the browser has encoded real H.264 frames, so its emptiness is not evidence.

The practical answer is nonetheless good: hardware encode enabled, no
measurable CPU cost to a CPU-bound workload, and ~9% GPU cost only on the
configurations that rescale.

### How it was read, for whoever needs it again

`edge://gpu` cannot be fetched by a page or by curl, and WSL cannot reach the
Windows loopback where Edge binds its debug port. What works:

```bash
# the profile directory's parent must exist, or Edge silently hands the URL
# to the already-running instance and no debug port is ever opened
msedge.exe --remote-debugging-port=9225 \
  --user-data-dir='C:\Users\<you>\AppData\Local\Temp\cdp' \
  --no-first-run --new-window about:blank
# then drive it from the Windows side, which can reach its own loopback:
powershell.exe -File cdp-gpu.ps1   # ClientWebSocket -> SystemInfo.getInfo
```


## 7 · Long-run confirmation (`warm.html`)

One viewer, 1080p, 5 Mbps, 10 000+ frames:

```
frames=10039 1920x1080 codec=video/H264 64001f impl=(absent) power=(absent)
```

- **High profile is negotiated and stays negotiated** over a long stream, not
  just at offer time. The shipped `rankVideoCodecs` holds.
- **60 fps sustained at 1080p** (120 frames per 2 s tick, unbroken). Content is
  easy — flat fills and one moving rect — so this shows the pipeline has no
  inherent cap, not that a game would hold 60.
- `encoderImplementation` / `powerEfficientEncoder` absent on a live sustained
  stream, confirming section 6's dead end rather than inferring it.

### One artifact worth not misreading

Mid-run, `frames` froze and `frameWidth`/`frameHeight` became `undefined` for
~46 s, then recovered. That is the probe, not the product: `warm.html` drives
its canvas from `requestAnimationFrame`, which Chromium throttles to zero in a
hidden window, so the *source* stopped and Chromium dropped the frame-size
fields while nothing was being encoded.

The app does not share this failure mode — `getDisplayMedia` frames come from
the OS capture pipeline and WebRTC encodes on native threads, neither of which
depends on the popover being visible. Worth proving on two machines with the
panel closed before relying on it, since sharing while the panel is hidden is
the app's main use.
