# Signaling Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the monorepo skeleton, the shared signaling protocol package, and a fully tested Node WebSocket signaling server that manages rooms, enforces authorization, and issues temporary TURN credentials.

**Architecture:** A pnpm workspace with `packages/signaling-protocol` as the single source of truth for wire types, imported by both the server and (later) the desktop app. The server keeps all state in one in-memory `Map<roomId, Room>`. Room logic lives in a transport-free `RoomManager` class so it can be unit tested without sockets; the WebSocket layer is a thin adapter over it.

**Tech Stack:** Node 22, TypeScript 5 (strict), `ws`, `zod`, `vitest`, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-17-p2p-screen-share-design.md`

## Global Constraints

- TypeScript `strict: true` everywhere. No `any` unless unavoidable and commented.
- Every inbound WebSocket message is validated with zod before use. A malformed message must never throw out of the connection handler.
- Session IDs are generated server-side with `crypto.randomUUID()` and are never read from client input.
- Room IDs are 6 characters of Crockford base32 (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, excluding I/L/O/U) drawn from `crypto.randomBytes`.
- `MAX_VIEWERS` defaults to 6 and is read from the environment.
- A viewer may only address the sharer. A sharer may only address its own viewers. Cross-room addressing is rejected with `NOT_AUTHORIZED`.
- TURN secrets and credentials are never logged.
- Log lines are prefixed with a category: `[APP]`, `[SIGNALING]`, `[ROOM]`, `[TURN]`.
- Repo lives at `/home/sams/janja-share` (WSL). Windows builds use a synced copy at `C:\Users\sams\source\janja-share`.

---

### Task 0: WebView2 capture spike (throwaway, runs on Windows)

Gates the entire desktop application. Its output is an answer, not code we keep.

**Files:**
- Create: `spikes/capture-probe/index.html`
- Create: `spikes/capture-probe/README.md`

**Interfaces:**
- Consumes: nothing
- Produces: a written answer recorded in `spikes/capture-probe/RESULTS.md` — whether the picker appears, whether an audio track is present for full-screen vs window capture, and the negotiated width/height/frameRate.

- [ ] **Step 1: Write the probe page**

`spikes/capture-probe/index.html` calls `getDisplayMedia({ video: { width: 1920, height: 1080, frameRate: 60 }, audio: true })`, then dumps `track.getSettings()` and the track list into the page and into the console for both video and audio.

- [ ] **Step 2: Run it in the WebView2 runtime, not just a browser**

A browser result proves nothing — Chromium and WebView2 differ on exactly this API. Run inside a minimal Tauri 2 window.

- [ ] **Step 3: Record results**

Write `spikes/capture-probe/RESULTS.md` answering: picker shown (y/n), audio track present for entire-screen capture (y/n), audio track present for single-window capture (y/n), negotiated video settings, WebView2 version.

- [ ] **Step 4: Commit**

```bash
git add spikes/capture-probe
git commit -m "spike: probe WebView2 getDisplayMedia capabilities"
```

---

### Task 1: Monorepo skeleton and Windows sync

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc`
- Create: `scripts/sync-windows.sh`
- Create: `.env.example`

**Interfaces:**
- Produces: workspace packages resolvable as `@janja/signaling-protocol`; root scripts `dev:signal`, `test`, `sync:win`.

- [ ] **Step 1: Root `package.json`**

```json
{
  "name": "janja-share",
  "private": true,
  "packageManager": "pnpm@10.28.2",
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "dev:signal": "pnpm --filter @janja/signaling dev",
    "dev:turn": "docker compose -f infra/coturn/docker-compose.yml up",
    "sync:win": "bash scripts/sync-windows.sh"
  }
}
```

- [ ] **Step 2: `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  }
}
```

- [ ] **Step 4: `scripts/sync-windows.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
DEST="${WIN_DEST:-/mnt/c/Users/sams/source/janja-share}"
mkdir -p "$DEST"
rsync -a --delete \
  --exclude 'node_modules' --exclude '.git' \
  --exclude 'dist' --exclude 'target' --exclude '.env' \
  ./ "$DEST/"
echo "[APP] synced to $DEST"
```

- [ ] **Step 5: `.env.example`**

```
SIGNALING_PORT=8787
SIGNALING_URL=ws://localhost:8787
STUN_URL=stun:stun.l.google.com:19302
TURN_URL=
TURN_TLS_URL=
TURN_REALM=janja.local
TURN_SECRET=
TURN_TTL_SECONDS=3600
MAX_VIEWERS=6
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm install`
Expected: workspace resolves with no errors.

```bash
git add -A && git commit -m "chore: monorepo skeleton and windows sync script"
```

---

### Task 2: Signaling protocol package — room IDs

**Files:**
- Create: `packages/signaling-protocol/package.json`, `tsconfig.json`
- Create: `packages/signaling-protocol/src/room-id.ts`
- Test: `packages/signaling-protocol/src/room-id.test.ts`

**Interfaces:**
- Produces: `generateRoomId(): string`, `ROOM_ID_ALPHABET`, `ROOM_ID_LENGTH`, `roomIdSchema` (zod).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { generateRoomId, ROOM_ID_ALPHABET, roomIdSchema } from "./room-id.js";

describe("generateRoomId", () => {
  it("returns 6 characters from the Crockford alphabet", () => {
    const id = generateRoomId();
    expect(id).toHaveLength(6);
    for (const ch of id) expect(ROOM_ID_ALPHABET).toContain(ch);
  });

  it("never emits the ambiguous characters I, L, O, or U", () => {
    const ids = Array.from({ length: 500 }, generateRoomId).join("");
    expect(ids).not.toMatch(/[ILOU]/);
  });

  it("produces distinct ids", () => {
    const ids = new Set(Array.from({ length: 200 }, generateRoomId));
    expect(ids.size).toBeGreaterThan(190);
  });

  it("accepts generated ids and rejects malformed ones", () => {
    expect(roomIdSchema.safeParse(generateRoomId()).success).toBe(true);
    expect(roomIdSchema.safeParse("ABC").success).toBe(false);
    expect(roomIdSchema.safeParse("ABCDEI").success).toBe(false);
    expect(roomIdSchema.safeParse("abcdef").success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @janja/signaling-protocol test`
Expected: FAIL, cannot resolve `./room-id.js`.

- [ ] **Step 3: Implement**

```ts
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const ROOM_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ROOM_ID_LENGTH = 6;

export const roomIdSchema = z
  .string()
  .length(ROOM_ID_LENGTH)
  .regex(/^[0-9A-HJKMNP-TV-Z]{6}$/);

export function generateRoomId(): string {
  const bytes = randomBytes(ROOM_ID_LENGTH);
  let out = "";
  for (let i = 0; i < ROOM_ID_LENGTH; i += 1) {
    out += ROOM_ID_ALPHABET[bytes[i]! % ROOM_ID_ALPHABET.length];
  }
  return out;
}
```

Note: modulo over a 32-character alphabet and a 256-value byte divides evenly, so there is no modulo bias here.

- [ ] **Step 4: Run and confirm green**

Run: `pnpm --filter @janja/signaling-protocol test`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/signaling-protocol && git commit -m "feat: room id generation and validation"
```

---

### Task 3: Signaling protocol package — message schemas

**Files:**
- Create: `packages/signaling-protocol/src/messages.ts`
- Create: `packages/signaling-protocol/src/index.ts`
- Test: `packages/signaling-protocol/src/messages.test.ts`

**Interfaces:**
- Consumes: `roomIdSchema` from Task 2.
- Produces: `clientMessageSchema`, `ClientMessage`, `ServerMessage`, `ErrorCode`, `IceServer`, and the `parseClientMessage(raw: string)` helper returning `{ ok: true, message } | { ok: false, code: "INVALID_MESSAGE" }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseClientMessage } from "./messages.js";

describe("parseClientMessage", () => {
  it("accepts a well-formed join-room", () => {
    const result = parseClientMessage(JSON.stringify({ type: "join-room", roomId: "7DS4B2" }));
    expect(result.ok).toBe(true);
  });

  it("rejects invalid JSON without throwing", () => {
    expect(parseClientMessage("{not json").ok).toBe(false);
  });

  it("rejects an unknown message type", () => {
    expect(parseClientMessage(JSON.stringify({ type: "shutdown" })).ok).toBe(false);
  });

  it("rejects a join-room carrying a malformed room id", () => {
    expect(parseClientMessage(JSON.stringify({ type: "join-room", roomId: "!!" })).ok).toBe(false);
  });

  it("rejects an offer whose targetId is not a uuid", () => {
    const raw = JSON.stringify({ type: "offer", targetId: "viewer-1", sdp: "v=0" });
    expect(parseClientMessage(raw).ok).toBe(false);
  });

  it("rejects an oversized sdp", () => {
    const raw = JSON.stringify({
      type: "offer",
      targetId: crypto.randomUUID(),
      sdp: "x".repeat(70_000),
    });
    expect(parseClientMessage(raw).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @janja/signaling-protocol test`
Expected: FAIL, cannot resolve `./messages.js`.

- [ ] **Step 3: Implement the schemas**

```ts
import { z } from "zod";
import { roomIdSchema } from "./room-id.js";

const MAX_SDP_BYTES = 64 * 1024;
const sessionIdSchema = z.string().uuid();

const iceCandidateInitSchema = z.object({
  candidate: z.string().max(1024),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(16).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create-room") }),
  z.object({ type: z.literal("join-room"), roomId: roomIdSchema }),
  z.object({ type: z.literal("leave-room") }),
  z.object({ type: z.literal("offer"), targetId: sessionIdSchema, sdp: z.string().max(MAX_SDP_BYTES) }),
  z.object({ type: z.literal("answer"), targetId: sessionIdSchema, sdp: z.string().max(MAX_SDP_BYTES) }),
  z.object({ type: z.literal("ice-candidate"), targetId: sessionIdSchema, candidate: iceCandidateInitSchema }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "ALREADY_IN_ROOM"
  | "NOT_IN_ROOM"
  | "INVALID_MESSAGE"
  | "RATE_LIMITED"
  | "NOT_AUTHORIZED"
  | "INTERNAL";

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export type ServerMessage =
  | { type: "room-created"; roomId: string; sessionId: string; iceServers: IceServer[]; maxViewers: number }
  | { type: "room-joined"; roomId: string; sessionId: string; sharerId: string; iceServers: IceServer[] }
  | { type: "viewer-joined"; viewerId: string }
  | { type: "viewer-left"; viewerId: string; reason: "left" | "disconnected" }
  | { type: "offer"; fromId: string; sdp: string }
  | { type: "answer"; fromId: string; sdp: string }
  | { type: "ice-candidate"; fromId: string; candidate: z.infer<typeof iceCandidateInitSchema> }
  | { type: "room-ended"; reason: "sharer-left" }
  | { type: "error"; code: ErrorCode; message: string };

export function parseClientMessage(
  raw: string,
): { ok: true; message: ClientMessage } | { ok: false; code: "INVALID_MESSAGE" } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, code: "INVALID_MESSAGE" };
  }
  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) return { ok: false, code: "INVALID_MESSAGE" };
  return { ok: true, message: parsed.data };
}
```

- [ ] **Step 4: Re-export from the package entrypoint**

```ts
export * from "./room-id.js";
export * from "./messages.js";
```

- [ ] **Step 5: Run and confirm green**

Run: `pnpm --filter @janja/signaling-protocol test`
Expected: PASS, 10 tests total across both files.

- [ ] **Step 6: Commit**

```bash
git add packages/signaling-protocol && git commit -m "feat: typed and validated signaling protocol"
```

---

### Task 4: RoomManager — transport-free room state

**Files:**
- Create: `apps/signaling/package.json`, `tsconfig.json`
- Create: `apps/signaling/src/room-manager.ts`
- Test: `apps/signaling/src/room-manager.test.ts`

**Interfaces:**
- Consumes: `generateRoomId` from Task 2.
- Produces:

```ts
interface Room { roomId: string; sharerId: string; viewers: Set<string>; createdAt: number }
type JoinResult =
  | { ok: true; room: Room }
  | { ok: false; code: "ROOM_NOT_FOUND" | "ROOM_FULL" | "ALREADY_IN_ROOM" };
type RemovalEffect =
  | { kind: "none" }
  | { kind: "room-ended"; room: Room }
  | { kind: "viewer-left"; room: Room; viewerId: string };

class RoomManager {
  constructor(maxViewers: number);
  createRoom(sharerId: string): Room;
  joinRoom(roomId: string, viewerId: string): JoinResult;
  removeSession(sessionId: string): RemovalEffect;
  getRoom(roomId: string): Room | undefined;
  getRoomForSession(sessionId: string): Room | undefined;
  get roomCount(): number;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { RoomManager } from "./room-manager.js";

describe("RoomManager", () => {
  let rooms: RoomManager;
  beforeEach(() => { rooms = new RoomManager(6); });

  it("creates a room owned by the sharer", () => {
    const room = rooms.createRoom("sharer-1");
    expect(room.sharerId).toBe("sharer-1");
    expect(room.viewers.size).toBe(0);
    expect(rooms.getRoom(room.roomId)).toBe(room);
  });

  it("admits a viewer", () => {
    const room = rooms.createRoom("sharer-1");
    const result = rooms.joinRoom(room.roomId, "viewer-1");
    expect(result.ok).toBe(true);
    expect(room.viewers.has("viewer-1")).toBe(true);
  });

  it("refuses an unknown room", () => {
    const result = rooms.joinRoom("ZZZZZZ", "viewer-1");
    expect(result).toEqual({ ok: false, code: "ROOM_NOT_FOUND" });
  });

  it("refuses the seventh viewer", () => {
    const room = rooms.createRoom("sharer-1");
    for (let i = 0; i < 6; i += 1) {
      expect(rooms.joinRoom(room.roomId, `viewer-${i}`).ok).toBe(true);
    }
    expect(rooms.joinRoom(room.roomId, "viewer-6")).toEqual({ ok: false, code: "ROOM_FULL" });
    expect(room.viewers.size).toBe(6);
  });

  it("refuses a viewer that is already in the room", () => {
    const room = rooms.createRoom("sharer-1");
    rooms.joinRoom(room.roomId, "viewer-1");
    expect(rooms.joinRoom(room.roomId, "viewer-1")).toEqual({ ok: false, code: "ALREADY_IN_ROOM" });
  });

  it("removing a viewer leaves the room and its other viewers intact", () => {
    const room = rooms.createRoom("sharer-1");
    rooms.joinRoom(room.roomId, "viewer-1");
    rooms.joinRoom(room.roomId, "viewer-2");
    const effect = rooms.removeSession("viewer-1");
    expect(effect).toEqual({ kind: "viewer-left", room, viewerId: "viewer-1" });
    expect(room.viewers.has("viewer-2")).toBe(true);
    expect(rooms.getRoom(room.roomId)).toBe(room);
  });

  it("removing the sharer ends the room", () => {
    const room = rooms.createRoom("sharer-1");
    rooms.joinRoom(room.roomId, "viewer-1");
    const effect = rooms.removeSession("sharer-1");
    expect(effect).toEqual({ kind: "room-ended", room });
    expect(rooms.getRoom(room.roomId)).toBeUndefined();
    expect(rooms.roomCount).toBe(0);
  });

  it("removing an unknown session does nothing", () => {
    expect(rooms.removeSession("nobody")).toEqual({ kind: "none" });
  });

  it("maps a session back to its room", () => {
    const room = rooms.createRoom("sharer-1");
    rooms.joinRoom(room.roomId, "viewer-1");
    expect(rooms.getRoomForSession("viewer-1")).toBe(room);
    expect(rooms.getRoomForSession("sharer-1")).toBe(room);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @janja/signaling test`
Expected: FAIL, cannot resolve `./room-manager.js`.

- [ ] **Step 3: Implement**

Back the class with two maps: `rooms: Map<roomId, Room>` and `sessionRooms: Map<sessionId, roomId>`, so `removeSession` is O(1) and cannot leave a dangling session. `createRoom` regenerates on the astronomically unlikely id collision.

- [ ] **Step 4: Run and confirm green**

Run: `pnpm --filter @janja/signaling test`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/signaling && git commit -m "feat: in-memory room manager with viewer isolation"
```

---

### Task 5: TURN credential issuer

**Files:**
- Create: `apps/signaling/src/ice-servers.ts`
- Test: `apps/signaling/src/ice-servers.test.ts`

**Interfaces:**
- Produces: `buildIceServers(config: IceConfig, sessionId: string, now?: number): IceServer[]` where `IceConfig` is `{ stunUrl?: string; turnUrl?: string; turnTlsUrl?: string; turnSecret?: string; ttlSeconds: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildIceServers } from "./ice-servers.js";

const NOW = 1_700_000_000_000;

describe("buildIceServers", () => {
  it("returns only STUN when no TURN secret is configured", () => {
    const servers = buildIceServers(
      { stunUrl: "stun:stun.example.com:3478", ttlSeconds: 3600 }, "s1", NOW);
    expect(servers).toEqual([{ urls: ["stun:stun.example.com:3478"] }]);
  });

  it("derives a coturn REST credential that expires", () => {
    const servers = buildIceServers({
      stunUrl: "stun:stun.example.com:3478",
      turnUrl: "turn:turn.example.com:3478",
      turnSecret: "s3cr3t",
      ttlSeconds: 3600,
    }, "session-abc", NOW);

    const turn = servers.find((s) => s.urls[0]!.startsWith("turn:"))!;
    const expiry = Math.floor(NOW / 1000) + 3600;
    expect(turn.username).toBe(`${expiry}:session-abc`);
    expect(turn.credential).toBe(
      createHmac("sha1", "s3cr3t").update(turn.username!).digest("base64"));
  });

  it("includes the TLS url in the same credential entry", () => {
    const servers = buildIceServers({
      turnUrl: "turn:turn.example.com:3478",
      turnTlsUrl: "turns:turn.example.com:5349",
      turnSecret: "s3cr3t",
      ttlSeconds: 60,
    }, "s1", NOW);
    const turn = servers.find((s) => s.username)!;
    expect(turn.urls).toEqual(["turn:turn.example.com:3478", "turns:turn.example.com:5349"]);
  });

  it("omits TURN entirely when a url is set but the secret is missing", () => {
    const servers = buildIceServers(
      { turnUrl: "turn:turn.example.com:3478", ttlSeconds: 60 }, "s1", NOW);
    expect(servers.every((s) => !s.username)).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @janja/signaling test -- ice-servers`
Expected: FAIL, cannot resolve `./ice-servers.js`.

- [ ] **Step 3: Implement**

```ts
import { createHmac } from "node:crypto";
import type { IceServer } from "@janja/signaling-protocol";

export interface IceConfig {
  stunUrl?: string;
  turnUrl?: string;
  turnTlsUrl?: string;
  turnSecret?: string;
  ttlSeconds: number;
}

export function buildIceServers(config: IceConfig, sessionId: string, now = Date.now()): IceServer[] {
  const servers: IceServer[] = [];
  if (config.stunUrl) servers.push({ urls: [config.stunUrl] });

  const turnUrls = [config.turnUrl, config.turnTlsUrl].filter((u): u is string => Boolean(u));
  if (turnUrls.length > 0 && config.turnSecret) {
    const expiry = Math.floor(now / 1000) + config.ttlSeconds;
    const username = `${expiry}:${sessionId}`;
    servers.push({
      urls: turnUrls,
      username,
      credential: createHmac("sha1", config.turnSecret).update(username).digest("base64"),
    });
  }
  return servers;
}
```

- [ ] **Step 4: Run and confirm green**

Run: `pnpm --filter @janja/signaling test -- ice-servers`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/signaling && git commit -m "feat: temporary coturn REST credentials"
```

---

### Task 6: WebSocket server — connection lifecycle and routing

**Files:**
- Create: `apps/signaling/src/server.ts` (createServer factory, no side effects on import)
- Create: `apps/signaling/src/config.ts`
- Create: `apps/signaling/src/main.ts` (entrypoint, reads env, starts server)
- Test: `apps/signaling/src/server.test.ts`

**Interfaces:**
- Consumes: `RoomManager` (Task 4), `buildIceServers` (Task 5), `parseClientMessage` (Task 3).
- Produces: `createSignalingServer(options): { port: number; close(): Promise<void> }`.

- [ ] **Step 1: Write the failing integration tests**

Tests drive a real server on an ephemeral port with real `ws` clients and a small `connect()` / `nextMessage()` helper. Cover, at minimum:

```
- a sharer receives room-created with a room id, a session id, and iceServers
- a viewer joining receives room-joined carrying the sharer's id
- the sharer receives viewer-joined when a viewer arrives
- joining an unknown room yields error ROOM_NOT_FOUND
- the seventh viewer is rejected with ROOM_FULL and receives no room-joined
- an offer from the sharer reaches only its target viewer, not the others
- an answer from a viewer reaches the sharer
- ice candidates relay in both directions
- a viewer addressing another viewer is rejected with NOT_AUTHORIZED
- a viewer addressing a session in a different room is rejected with NOT_AUTHORIZED
- a viewer disconnecting produces viewer-left on the sharer and nothing on other viewers
- a sharer disconnecting produces room-ended on every viewer
- a malformed frame yields error INVALID_MESSAGE and keeps the socket open
- exceeding the message rate limit yields error RATE_LIMITED
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm --filter @janja/signaling test -- server`
Expected: FAIL, cannot resolve `./server.js`.

- [ ] **Step 3: Implement the server**

Each socket gets a server-generated `sessionId` and a token-bucket rate limiter. The handler resolves the sender's room via `getRoomForSession`, checks the sender-to-target authorization rule, and forwards. Unknown targets, cross-room targets, and viewer-to-viewer attempts all return `NOT_AUTHORIZED`. The whole handler body sits inside a try/catch that replies `INTERNAL` rather than throwing. Heartbeats use `ws` ping/pong with a 30 s interval and terminate silent sockets.

- [ ] **Step 4: Run and confirm green**

Run: `pnpm --filter @janja/signaling test`
Expected: PASS, all suites.

- [ ] **Step 5: Add the `/api/ice-servers` HTTP route**

Same HTTP server that hosts the WebSocket upgrade. Returns `{ iceServers }` for a fresh session id. Rate limited by IP.

- [ ] **Step 6: Manual smoke test**

Run: `pnpm dev:signal`, then connect with `websocat` or a scratch script; confirm a room is created and its id looks like `7DS4B2`.

- [ ] **Step 7: Commit**

```bash
git add apps/signaling && git commit -m "feat: websocket signaling server with authorization and rate limiting"
```

---

## Self-Review

**Spec coverage:** §4 protocol → Tasks 2, 3. §5 server, room lifecycle, rate limiting, malformed input → Tasks 4, 6. §6 ICE and TURN credentials → Task 5 plus Task 6 step 5. §3 layout and sync → Task 1. §10 server testing (all ten listed cases) → Tasks 4 and 6. §12 capture risk → Task 0. Deferred to later plans: §7 desktop application, §8 quality and reconnection, §11 packaging, and the coturn container in `infra/coturn/`.

**Placeholders:** none. Task 6's test list is enumerated behaviour rather than inline code because the suite shares one harness; the harness and assertions are written during that task.

**Type consistency:** `IceServer` is defined once in Task 3 and imported by Task 5. `Room`, `JoinResult`, and `RemovalEffect` are defined in Task 4 and consumed by Task 6. `parseClientMessage`'s return shape matches the `INVALID_MESSAGE` path used in Task 6.

## Follow-on plans

2. **Desktop application** — written after Task 0 reports back, since its result decides whether capture stays in TypeScript.
3. **coturn, packaging, and deployment** — `infra/coturn/`, the MSI build, and the operations documentation.
