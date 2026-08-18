# Channels — Acceptance

Date: 2026-08-18
Plan: `2026-08-18-channels.md`
Spec: `../specs/2026-08-18-channels-design.md`

Each line is §9 of the spec. Automated coverage is named where it exists; the
manual column is what still has to be seen on real machines.

| # | Acceptance line | Automated | Manual |
|---|---|---|---|
| 1 | Three machines join one channel; each sees the others by PC name | `server.test.ts` "hands a joiner the members already present"; `channel-manager.test.ts` "records the roster" | not run |
| 2 | Joining with nobody publishing builds zero peer connections | `sharing-manager.test.ts` "builds nothing until somebody asks to watch" | not run |
| 3 | A publishes; others see the badge; still zero connections | `server.test.ts` "announces publishing to the other members" | not run |
| 4 | A clicks B: exactly one connection is built, A sees B's screen | `sharing-manager.test.ts` "builds exactly one connection per watcher" | not run |
| 5 | A publishes **while** watching B; C watches A | `server.test.ts` "supports two members watching each other at once"; `channel-manager.test.ts` routing tests | **not run — the case the old room model made impossible** |
| 6 | A clicks C while watching B: refused, and the UI says why | `channel-manager.test.ts` "holds a member to one stream at a time" (server), error routed to the viewing manager | not run |
| 7 | B stops publishing: A's picture ends with a message, A stays in the channel | `viewing-manager.test.ts` "says plainly when the publisher stops" | not run |
| 8 | B closes the app: B disappears from both lists within the heartbeat | `server.test.ts` "announces a dropped socket the same way" | not run |
| 9 | A's socket drops and recovers: A rejoins the same channel | `channel-manager.test.ts` "rejoins the same channel after the socket comes back" | **not run** |
| 10 | Sharing system audio while watching produces no echo | none — needs Windows | **blocked on Task 0 spike** |

## How to run the manual pass

Two Windows machines, or one machine running a debug build twice (debug builds
allow multiple instances precisely so this is testable on one PC).

```bash
pnpm dev:signal          # terminal 1
pnpm dev:tunnel          # terminal 2, if the second machine is elsewhere
pnpm sync:win
```

Then in PowerShell on each machine:

```powershell
cd C:\Users\sams\source\janja-share\apps\desktop
$env:VITE_SIGNALING_URL = "ws://<host>:8787"
pnpm tauri dev
```

Line 9 is exercised by stopping the signaling server, waiting for the header to
read `reconectando`, and starting it again. Everyone should reappear in each
other's list, and clicking a live member should still work.

## Still open

- **Task 0** — the exclude-self loopback spike. Runs on Windows only.
- **Task 12** — the audio change it gates. Until then, sharing *system* audio
  while watching a stream will echo that stream back into the channel. Per-app
  audio (the default when sharing a single window) is unaffected and already
  correct.
