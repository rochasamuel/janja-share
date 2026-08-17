# Capture probe (throwaway spike)

Answers the one unproven assumption in the design: does `getDisplayMedia()` work
inside **WebView2**, and does it hand us a **system audio** track?

This is disposable. Nothing in the product imports it, and it gets deleted once
the answer is recorded.

## Why not just open it in a browser

Because a browser result proves nothing. Chromium grants screen capture on its
own; WebView2 requires the **host application** to grant the `DisplayCapture`
permission, and it is entirely possible for this page to work perfectly in Edge
and fail inside our Tauri window. The whole point is to test the environment we
actually ship.

## Prerequisite

Rust on Windows, which is the one missing piece of the toolchain:

```powershell
winget install Rustlang.Rustup
# then restart the terminal
rustc --version
```

## Running it

From the synced Windows copy (`C:\Users\sams\source\janja-share`), in PowerShell:

```powershell
cd C:\Users\sams\source\janja-share
pnpm dlx create-tauri-app@latest spike-shell --template vanilla --manager pnpm
# point the generated app's frontendDist at ../capture-probe, or simply copy
# index.html over the generated index.html
cd spike-shell
pnpm tauri dev
```

Then click **Probe capture (pick ENTIRE SCREEN)**, and afterwards
**Probe capture (pick a WINDOW)**.

## What to record

Copy the page output into `RESULTS.md` and answer these five questions:

1. Did a source picker appear at all?
2. Entire screen capture — how many **audio** tracks came back? (0 means no system audio)
3. Single window capture — how many **audio** tracks came back?
4. What did the video track actually negotiate: width, height, frameRate?
5. Is H.264 in the codec list?

The expected failure mode, if there is one, is `NotAllowedError` with no picker,
which means the host never granted `DisplayCapture`. The second most likely is a
picker that works but returns zero audio tracks for window capture — that one is
survivable and is already handled in the design (video-only session with a clear
message), but it needs to be known before the sharer is built.
