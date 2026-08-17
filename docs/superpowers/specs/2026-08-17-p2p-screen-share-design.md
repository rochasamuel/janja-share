# P2P Screen Sharing for Windows — Design

Date: 2026-08-17
Status: approved for planning

## 1. Goal

One lightweight Windows `.exe` that can either share its screen plus system audio,
or watch someone else's stream. Up to 6 simultaneous viewers. Media travels
peer-to-peer over WebRTC. A Node.js server handles signaling only. coturn relays
media only when direct connectivity fails.

The real deployment target is a small group of friends, each in their own house on
their own residential connection. Development and early testing happen on localhost
and LAN.

## 2. Decisions

These were settled during brainstorming and are not open questions.

| Decision | Choice | Reason |
|---|---|---|
| Repo location | `/home/sams/janja-share` (WSL), synced to `C:\Users\sams\source\janja-share` for Windows builds | Node, tests, and coturn run fast in WSL; cargo and Tauri need to run natively on Windows. Building over `\\wsl.localhost` is slow and breaks Rust builds. |
| Capture strategy | WebView2 `getDisplayMedia()` in TypeScript, gated behind a spike | Matches the brief. Keeps Rust confined to tray, windowing, and packaging. Native Rust capture is a documented contingency, not the plan. |
| Infrastructure | localhost and Docker for development; every endpoint configurable so the same build points at a VPS later | Friends on separate networks will eventually need a public signaling host and a working TURN relay. |
| Persistence | None. Rooms live in a `Map` in one process. | Brief forbids a database and Redis. Rooms are ephemeral by nature. |
| Topology | Full mesh from one sharer, one `RTCPeerConnection` per viewer | Brief forbids an SFU in this MVP. |

### 2.1 The upload ceiling

P2P means the sharer uploads roughly one copy of the stream per viewer.

```
6 viewers x 6 Mbps ~= 36 Mbps upload
```

On a typical asymmetric residential plan this is the binding constraint, not CPU
and not the codec. The app does not fight this: WebRTC congestion control lowers
the bitrate per viewer as upload saturates, and the viewer-facing quality
indicator will show the result. This is the concrete reason the WebRTC layer stays
modular enough for an SFU later.

## 3. Repository layout

```
janja-share/
├── apps/
│   ├── desktop/              # the one Tauri application
│   │   ├── src/              # React + TypeScript
│   │   └── src-tauri/        # Rust: tray, windows, packaging
│   └── signaling/            # Node + TypeScript WebSocket server
├── packages/
│   └── signaling-protocol/   # message types, zod schemas, shared enums
├── infra/
│   └── coturn/               # docker-compose, turnserver.conf, docs
├── scripts/
│   └── sync-windows.sh       # rsync WSL -> C:\Users\sams\source\janja-share
├── docs/
├── pnpm-workspace.yaml
└── README.md
```

One Tauri application, one repository. `packages/signaling-protocol` is imported by
both the desktop app and the server, which is what prevents the client and server
from drifting apart on the wire format.

### 3.1 The Windows sync

`scripts/sync-windows.sh` rsyncs the tree to `C:\Users\sams\source\janja-share`,
excluding `node_modules`, `src-tauri/target`, `dist`, and `.git`. The Windows copy
runs its own `pnpm install` and keeps its own Rust build cache, so the sync only
ever moves source. `.gitattributes` pins `eol=lf` so the round trip does not churn
line endings.

Prerequisite the user must install once: Rust on Windows via `rustup-init.exe`.
MSVC 14.44, WebView2 Runtime 151, Node, and Docker are already present.

## 4. Signaling protocol

Transport is a raw WebSocket carrying JSON. Every message is a member of a
discriminated union keyed on `type`, and every inbound message is validated
against a zod schema at the process boundary before anything touches it.

### 4.1 Client to server

| Type | Payload | Notes |
|---|---|---|
| `create-room` | none | Sender becomes that room's sharer |
| `join-room` | `roomId` | Sender becomes a viewer |
| `leave-room` | none | Explicit departure; disconnect is handled too |
| `offer` | `targetId`, `sdp` | Sharer to one viewer |
| `answer` | `targetId`, `sdp` | Viewer to sharer |
| `ice-candidate` | `targetId`, `candidate` | Either direction |

### 4.2 Server to client

| Type | Payload |
|---|---|
| `room-created` | `roomId`, `sessionId`, `iceServers`, `maxViewers` |
| `room-joined` | `roomId`, `sessionId`, `sharerId`, `iceServers` |
| `viewer-joined` | `viewerId` |
| `viewer-left` | `viewerId`, `reason` |
| `offer` | `fromId`, `sdp` |
| `answer` | `fromId`, `sdp` |
| `ice-candidate` | `fromId`, `candidate` |
| `room-ended` | `reason` |
| `error` | `code`, `message` |

Error codes: `ROOM_NOT_FOUND`, `ROOM_FULL`, `ALREADY_IN_ROOM`, `NOT_IN_ROOM`,
`INVALID_MESSAGE`, `RATE_LIMITED`, `NOT_AUTHORIZED`, `INTERNAL`.

### 4.3 Identity

Session IDs are generated server-side with `crypto.randomUUID()` and are never
accepted from a client. A client addresses a peer by `targetId`; the server
verifies that the target is in the same room and that the sender is allowed to
talk to it. A viewer may only address the sharer. A sharer may only address its
own viewers. This is what stops one viewer from injecting SDP into another
viewer's connection.

Room IDs are 6 characters of Crockford base32 (no I, L, O, or U) drawn from
`crypto.randomBytes`, giving about 1.07 billion possibilities. Combined with join
rate limiting, guessing is impractical. Rooms are never enumerable over any
endpoint.

## 5. Signaling server

A single Node process. State is one `Map<roomId, Room>`, where a room holds its id,
its sharer's session, its viewers, and a creation timestamp.

Lifecycle rules:

- A sharer disconnecting ends the room. Every viewer receives `room-ended` and the
  room is deleted.
- A viewer disconnecting notifies only the sharer via `viewer-left`. The room and
  every other viewer continue untouched.
- Joining a room already holding `MAX_VIEWERS` viewers is refused with `ROOM_FULL`
  before any peer connection is created.
- Empty rooms are swept periodically as a backstop against leaked state.

Robustness requirements: malformed JSON, unknown message types, oversized frames,
and schema violations all produce an `error` reply and never throw out of the
connection handler. Room creation, room joins, and per-connection message rate are
each rate limited. Heartbeats use native WebSocket ping and pong frames, and
unresponsive sockets are dropped.

`MAX_VIEWERS` defaults to 6 and is configurable.

## 6. ICE and TURN credentials

The client never ships a TURN secret. `iceServers` arrives from the server inside
`room-created` and `room-joined`, and `GET /api/ice-servers` exists for refresh
during long sessions.

Credentials follow coturn's REST convention:

```
username   = "<unix-expiry>:<sessionId>"
credential = base64(HMAC-SHA1(TURN_SECRET, username))
```

with a one hour TTL. The static secret stays in the server's environment and is
never logged. coturn is configured with `use-auth-secret` and the matching realm,
so it validates these without any shared user database.

coturn runs from `infra/coturn/` via docker-compose, listening on UDP and TCP 3478
plus TLS 5349, with a bounded relay port range. UDP is preferred; TCP and TLS are
fallbacks for restrictive networks. The deployment guide covers ports, firewall
rules, certificates, realm, and sizing.

## 7. Desktop application

### 7.1 Layering

React owns the UI and application state. It does not own media objects. A
`MediaStream`, an `RTCPeerConnection`, and a `WebSocket` all live in plain
TypeScript service classes held through refs, and surface to React only as
serializable state such as viewer counts, connection quality, and status enums.
Putting them in React state is what causes reconnection storms on re-render.

```
src/
├── features/
│   ├── home/
│   ├── sharing/     ScreenCapture.ts, SharingManager.ts, ViewerConnectionManager.ts
│   ├── viewing/     ViewingManager.ts
│   └── room/        RoomManager.ts
├── services/
│   ├── signaling/   SignalingClient.ts
│   └── webrtc/      PeerConnection.ts, PeerConnectionManager.ts, WebRTCStats.ts
├── components/  hooks/  stores/  types/  utils/
```

`SignalingClient` knows nothing about WebRTC. `PeerConnection` knows nothing about
React. `SharingManager` orchestrates the two. That separation is also what lets an
SFU replace the mesh later without touching the UI.

### 7.2 State

Explicit enums, not scattered booleans.

- Sharer: `idle`, `starting`, `sharing`, `stopping`, `error`
- Viewer: `idle`, `connecting`, `connected`, `reconnecting`, `disconnected`, `error`

### 7.3 Sharer

`getDisplayMedia()` requests roughly 1920x1080 at 60 fps with audio, as a hint
rather than a demand — actual capture adapts to the monitor, GPU, and what
WebView2 grants. The native picker chooses monitor or window; no custom picker is
built.

The captured track is tuned for screen content: `contentHint = 'detail'`,
`degradationPreference = 'maintain-resolution'` so text stays sharp when bandwidth
tightens, an H.264-then-VP9 codec preference, and a `maxBitrate` ceiling around
8 Mbps that acts as a cap rather than a target. Congestion control does the rest.

Viewers are held in `Map<viewerId, RTCPeerConnection>`. One capture stream feeds
every connection; its tracks are added to each peer connection separately. A
failure on one connection tears down only that entry. This isolation is mandatory
and gets an explicit test.

If Windows or WebView2 declines to provide a system audio track for the chosen
source, the session continues video-only and the UI says so plainly. It does not
crash and it does not silently pretend audio is flowing.

Microphone capture is not implemented and no microphone permission is requested.

### 7.4 Viewer

A room code, or a `screenshare://room/<id>` deep link if protocol registration
proves straightforward. The stream renders in a plain `<video>` element — no
canvas, no frame copying, no custom rendering, so WebView2's hardware path stays
intact. Fullscreen by button or double click. Volume and mute only.

### 7.5 Tray

The application behaves as a tray application. Closing the main window hides it
rather than quitting, so sharing survives minimizing and the user keeps working.
The tray menu offers Open, Share Screen, Watch Stream, Stop Sharing, and Quit, and
the icon and tooltip reflect idle, sharing, watching, or error state, including
live viewer count while sharing.

Rust is used for the tray, window lifecycle, single-instance behavior, packaging,
and deep link registration. Nothing else.

## 8. Quality and reconnection

`RTCPeerConnection.getStats()` is polled every two seconds and reduced to one of
four user-facing states. Round trip time, packet loss, and frame rate drive the
classification; raw statistics stay in the logs.

| Indicator | Roughly |
|---|---|
| Excellent | RTT under 100 ms, loss under 1% |
| Good | RTT under 250 ms, loss under 3% |
| Poor | worse than the above, or frame rate collapsing |
| Reconnecting | ICE state disconnected or failed |

Reconnection has two independent layers. The signaling socket reconnects with
exponential backoff and jitter. A peer connection that reaches `disconnected`
attempts an ICE restart; a viewer that cannot recover after a bounded number of
attempts shows `Unable to reconnect to the stream.` Throughout, the sharer stays
live for everyone else.

## 9. Errors and logging

Users see short sentences: unable to capture your screen, unable to connect to the
signaling server, trying a relay connection, this stream is full, the stream has
ended, unable to reconnect. Stack traces and WebRTC internals go to the log.

Logs are structured and categorized as `[APP]`, `[TAURI]`, `[SIGNALING]`,
`[ROOM]`, `[MEDIA]`, `[WEBRTC]`, and `[TURN]`. TURN credentials and secrets are
never logged.

## 10. Testing

The signaling server is the part that can be tested properly and automatically, so
it is tested properly: room creation, joining, invalid room, room full, duplicate
viewer, viewer disconnect, sharer disconnect, room cleanup, malformed messages, and
unauthorized cross-room or cross-viewer addressing. These run against a real
WebSocket server with real clients, in WSL, with no Windows involvement.

Pure client logic — state machines, the quality classifier, room code generation,
protocol encoding — is unit tested. WebRTC itself is verified by a documented
manual matrix, because a real peer connection is not meaningfully mockable:

- Two PCs on the same LAN
- Two PCs on different residential networks
- Forced relay via `iceTransportPolicy: "relay"`, confirming media flows through
  coturn
- One sharer with six viewers, confirming stable playback, audio sync, sharer
  responsiveness, and that killing one viewer disturbs nobody else

## 11. Packaging and deployment

Tauri produces both `.exe` and `.msi`. The end user needs no Node, no pnpm, no
Rust, no terminal, and no manual WebView2 setup.

`.env.example` carries `SIGNALING_URL`, `STUN_URL`, `TURN_URL`, `TURN_TLS_URL`,
`TURN_REALM`, `TURN_SECRET`, and `MAX_VIEWERS`. Development points at
`ws://localhost`; production points at `wss://`. Production secrets are never
committed.

Documentation covers local setup, running each piece, testing P2P, forcing TURN,
testing six viewers, building the installer, deploying signaling, deploying
coturn, known WebView2 limitations, known P2P limitations, and troubleshooting.

## 12. Risks

**Screen capture in WebView2 is the one unproven assumption.** WebView2 requires
the host application to grant the `DisplayCapture` permission, and Chromium
generally offers system audio loopback only when an entire screen is captured, not
an individual window. WebView2 Runtime 151 on this machine is recent enough that
this should work, but should is not verified.

Mitigation: the first implementation step is a throwaway spike — a minimal Tauri 2
window that calls `getDisplayMedia({ video: true, audio: true })` and reports what
actually comes back: whether the picker appears, whether an audio track exists for
full screen and for single window capture, and at what resolution and frame rate.
Nothing is built on top until that answer exists. If it fails, the contingency is
native capture in Rust through Windows Graphics Capture and WASAPI loopback, which
is a materially larger project and would be re-scoped with the user rather than
assumed.

Secondary risks: residential upload capping effective viewer count, which is
inherent to P2P and surfaced honestly rather than hidden; and deep linking, which
is deferred behind room codes if Windows protocol registration proves fiddly.

## 13. Milestones

Each milestone leaves the project runnable.

0. Capture spike — verify `getDisplayMedia` and system audio on the target machine
1. Monorepo skeleton, shared protocol package, Windows sync script
2. Signaling server with its full test suite
3. Tauri shell — home screen, tray, close to tray
4. Sharer — capture, room creation, per-viewer peer connections, isolation
5. Viewer — join by code, video, fullscreen, volume
6. Quality monitoring and reconnection
7. coturn with temporary credentials
8. Packaging, documentation, deployment guides

Milestones 1, 2, and 7 are verifiable entirely from WSL. Milestone 0 and 3 through
6 need the user at a Windows terminal.

## 14. Out of scope

Accounts, login, passwords, chat, webcam, microphone, recording, cloud storage,
remote desktop, remote input, file transfer, annotation, reactions, payments,
analytics, database, Redis, SFU, media server, transcoding, AI, mobile, macOS,
Linux, and a browser-based viewer. The viewer is the same Windows Tauri
application as the sharer.
