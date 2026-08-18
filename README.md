# Janja Share

A small Windows desktop app for watching each other's screens. A handful of
friends join a **channel** with a six-character code; any of them can share a
screen, and each of them picks whose screen to watch. Video and audio travel
peer-to-peer over WebRTC. The server only introduces peers to each other; it
never carries the stream.

The interface is in Brazilian Portuguese; the code and these notes are in
English.

**Status:** signaling and the desktop app both work. Channels, per-app audio
capture, quality presets and live connection statistics are in.

## Layout

```
apps/desktop/                  Tauri + React tray popover
apps/signaling/                Node WebSocket signaling server
packages/signaling-protocol/   wire types shared by server and client
spikes/capture-probe/          throwaway WebView2 capture probe
infra/coturn/                  TURN relay, for the VPS deployment
scripts/make-icons.py          redraws every app and tray icon
scripts/tunnel.sh              temporary public address via Cloudflare
docs/superpowers/              design and implementation plans
```

To put a build in a friend's hands, see
[docs/enviando-para-um-amigo.md](docs/enviando-para-um-amigo.md).

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
pnpm test          # 320 tests
pnpm typecheck
bash scripts/check-rust.sh   # drives the Windows cargo over interop
```

The signaling server is covered end to end against a real WebSocket server:
channel lifecycle, both caps, authorization between peers, disconnect
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

The signaling address is compiled in, so set it before building:

```powershell
cd apps\desktop
$env:VITE_SIGNALING_URL = "wss://your-server"
pnpm tauri build
```

`pnpm dev:tunnel` prints that address for a throwaway Cloudflare tunnel, along
with the exact build command.

## Why P2P, and what it costs

Joining a channel builds nothing. A peer connection appears only when someone
clicks a member who is sharing, which is what keeps a channel of eight people
from becoming fifty-six connections.

Each publisher sends one copy of its stream to each of its viewers, so the
uplink — not CPU — is what limits viewer count. WebRTC lowers quality as upload
saturates rather than dropping viewers.

A copy is not always a whole stream, though. Every viewer tells its publisher
whether it is showing the picture in the 320px panel or in fullscreen, and the
publisher scales that one sender to match: a viewer in the panel costs roughly
a ninth of the pixels of one in fullscreen. Since the panel is where everyone
starts, the common case is far cheaper than the worst case.

Moving past the uplink ceiling entirely means an SFU, which this MVP
deliberately does not build, but the WebRTC layer stays modular enough to add
one later.

TURN only matters when two peers cannot reach each other directly, which is
common enough on residential CGNAT and corporate networks to be worth having.
On a LAN it is never used.
