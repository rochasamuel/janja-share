# janja-share

A small Windows desktop app for sharing your screen with a handful of friends.
Video and audio travel peer-to-peer over WebRTC. The server only introduces
peers to each other; it never carries the stream.

**Status:** signaling foundation complete and tested. The desktop app is not
built yet — it is gated on the WebView2 capture spike (see below).

## Layout

```
apps/signaling/                Node WebSocket signaling server
packages/signaling-protocol/   wire types shared by server and client
spikes/capture-probe/          throwaway WebView2 capture probe
infra/coturn/                  TURN relay (not built yet)
docs/superpowers/              design and implementation plans
```

## Running the signaling server

```bash
pnpm install
cp .env.example .env
pnpm dev:signal
```

It listens on `8787` by default.

```bash
curl http://localhost:8787/healthz
curl http://localhost:8787/api/ice-servers
```

Leave `TURN_URL` and `TURN_SECRET` blank for LAN testing — STUN alone is enough
when both machines are on the same network. Set both together when you deploy
somewhere friends on other networks will connect from; setting only one is
rejected at startup, because half a TURN configuration fails opaquely at ICE
time rather than loudly at boot.

## Tests

```bash
pnpm test          # 58 tests
pnpm typecheck
```

The signaling server is covered end to end against a real WebSocket server:
room lifecycle, the viewer cap, authorization between peers, disconnect
handling, malformed input, and rate limiting.

## Building the Windows app

The Tauri build cannot run from WSL. Sync the source to the Windows filesystem
and build there:

```bash
pnpm sync:win     # -> C:\Users\sams\source\janja-share
```

Then in PowerShell:

```powershell
cd C:\Users\sams\source\janja-share
pnpm install
```

Requires Rust on Windows: `winget install Rustlang.Rustup`.

## Why P2P, and what it costs

The sharer sends one copy of the stream to each viewer. Six viewers at 6 Mbps
is roughly 36 Mbps of upload from the sharer's connection — that ceiling, not
CPU, is what limits viewer count. WebRTC lowers quality as upload saturates
rather than dropping viewers. Moving past it means an SFU, which this MVP
deliberately does not build, but the WebRTC layer stays modular enough to add
one later.

TURN only matters when two peers cannot reach each other directly, which is
common enough on residential CGNAT and corporate networks to be worth having.
On a LAN it is never used.
