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
