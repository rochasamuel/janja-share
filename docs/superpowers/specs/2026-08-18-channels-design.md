# Channels — Design

Date: 2026-08-18
Status: approved for planning
Supersedes: the room model in `2026-08-17-p2p-screen-share-design.md` §4

## 1. Goal

Replace the one-sharer room with a **channel**: a code several people join, where
every member may publish their screen and every member chooses whose screen to
watch. Publishing and watching are independent, so a member can be sharing their
own screen while watching someone else's.

A connection is only built when someone clicks. Joining a channel costs nothing
but a WebSocket; the mesh stays as small as the group actually asked for.

## 2. Decisions

Settled during brainstorming. Not open questions.

| Decision | Choice | Reason |
|---|---|---|
| Channels vs rooms | Channels **replace** rooms outright | Keeping both doubles the protocol, the server and the UI for a case a channel already covers: a 1:1 share is a channel where one person publishes. |
| Stream addressing | Add `publisherId` to `offer` / `answer` / `ice-candidate` | A and B can watch each other, which is two peer connections between the same pair in opposite directions. `targetId` alone cannot tell them apart. Reusing the publisher's session id means no new id space to generate or garbage-collect. |
| Watching at once | **One** stream per member, enforced on the server | The panel is a 320px tray popover, and decoding a second stream while encoding your own is the fastest way to starve the encoder. The limit is one named constant, so raising it later is a one-line change. |
| Member name | The PC's hostname, read natively; deduplicated per channel by the server | Nobody wants to type a name into a tray popover, and the machine name is what the group already uses to refer to each other. |
| Signaling reconnect | Client re-sends `join-channel` and takes a new session id | A session-resume token means server-side session state with its own expiry. Rejoining is a blink in the member list and costs nothing else, since peer connections are rebuilt on click anyway. |
| Echo when sharing system audio | Native loopback in **exclude-self** mode | Windows' `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` captures everything the machine plays *except* our own process tree — so the stream we are watching is not rebroadcast into the stream we are publishing. |
| Channel lifetime | Ephemeral. The channel dies when the last member leaves. | Same as rooms today. No persistence, per the original brief. |

### 2.1 What the mesh costs

Lazy connect is the whole reason this stays P2P. With `M` members, the worst case
is `M x (M-1)` connections, but the actual case is one connection per *click*.
Four friends in a channel where one person is presenting is three connections —
identical to today's room.

The per-publisher upload ceiling from the original design is unchanged and still
binding: `viewers x bitrate` of upload, out of one residential connection. The
existing `MAX_VIEWERS` cap now reads as **viewers per publisher**.

## 3. Protocol

`packages/signaling-protocol` remains the single source of truth. Channel codes
keep the 6-character Crockford base32 alphabet, renamed from room to channel.

### 3.1 Client to server

| Type | Payload | Notes |
|---|---|---|
| `create-channel` | `displayName` | Sender opens a channel and joins it |
| `join-channel` | `channelId`, `displayName` | Sender joins an existing channel |
| `leave-channel` | none | Explicit departure; a dropped socket does the same |
| `publish-start` | none | "My screen is available." Builds nothing. |
| `publish-stop` | none | Drops every watcher of this member |
| `watch` | `publisherId` | The click. Asks that member to offer a stream. |
| `unwatch` | `publisherId` | Stop watching; tears the one connection down |
| `offer` | `targetId`, `publisherId`, `sdp` | Only a publisher sends this |
| `answer` | `targetId`, `publisherId`, `sdp` | Only a watcher sends this |
| `ice-candidate` | `targetId`, `publisherId`, `candidate` | Either end |

### 3.2 Server to client

| Type | Payload |
|---|---|
| `channel-joined` | `channelId`, `sessionId`, `displayName`, `members[]`, `iceServers`, `maxViewersPerPublisher` |
| `member-joined` | `member` |
| `member-left` | `memberId`, `reason` |
| `member-publishing` | `memberId`, `publishing` |
| `watch-request` | `fromId` |
| `unwatch` | `fromId` |
| `offer` / `answer` / `ice-candidate` | `fromId`, `publisherId`, payload |
| `error` | `code`, `message` |

`Member` is `{ id, name, publishing }`. `displayName` comes back from
`channel-joined` because the server may have deduplicated it.

Removed: `create-room`, `join-room`, `leave-room`, `room-created`, `room-joined`,
`viewer-joined`, `viewer-left`, `room-ended`.

### 3.3 Authorization

The rule that replaces "a viewer may only address its sharer":

1. Both sessions must be in the same channel.
2. An `offer` is only forwarded when the target has an **outstanding `watch`** for
   that `publisherId`. Without this, any member could push SDP at any other
   member's peer connection just by being in the channel.
3. `answer` and `ice-candidate` are forwarded when a subscription exists in
   either direction between the two sessions for that `publisherId`.

The server therefore tracks subscriptions, not just membership. That is also what
enforces the two caps.

### 3.4 New error codes

`CHANNEL_NOT_FOUND`, `CHANNEL_FULL`, `PUBLISHER_FULL`, `ALREADY_WATCHING`,
`NOT_PUBLISHING`. `ROOM_NOT_FOUND`, `ROOM_FULL` and `ALREADY_IN_ROOM` are removed.

## 4. Limits

| Constant | Default | Env | Meaning |
|---|---|---|---|
| `MAX_MEMBERS` | 8 | `MAX_MEMBERS` | People in one channel |
| `MAX_VIEWERS_PER_PUBLISHER` | 6 | `MAX_VIEWERS` | Unchanged economics, renamed meaning |
| `MAX_WATCHING_PER_MEMBER` | 1 | — | Compile-time. Decision 4. |
| `MAX_NAME_LENGTH` | 32 | — | Hostnames are 15 on NetBIOS, 63 on DNS |

## 5. Member names

`machine_name()` is a new Tauri command returning the Windows computer name. In a
plain browser — `pnpm dev` without Tauri — it falls back to `"PC"`.

The server sanitizes: strips control characters, trims, truncates to 32, and
rejects an empty result with `INVALID_MESSAGE`. Within a channel, a name already
taken gets ` (2)`, ` (3)` appended. Names are rendered as text by React, never as
markup.

## 6. Audio

Two paths, and the channel makes the second one matter.

**Per-app (preferred, already built).** Process loopback in *include* mode on the
shared window's process. Only that app's sound leaves the machine — which is
exactly the "do not send Discord's voice" outcome, and it is better than
filtering Discord out, because it also keeps out notifications and every other
app.

**System audio (fallback).** Today this is `getDisplayMedia`'s loopback mix, which
in a channel would capture the stream we are *watching* and send it back out — an
echo, and with two people watching each other, a loop. This changes to native
process loopback in **exclude** mode targeting our own PID, so the mix carries
everything except Janja Share.

`app_audio::start` gains a mode parameter; `capture_inner` stops hardcoding
`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`.

**Open risk, gated by a spike.** WebView2 renders audio in `msedgewebview2.exe`
processes that our app launches. They should fall inside our process *tree*, but
that is an assumption about how Windows walks the tree, not a documented promise.
Task 0 of the plan proves or disproves it before anything depends on it.

If the spike fails, the fallback is blunt and correct: while publishing system
audio, the incoming stream plays muted, and the UI says so.

## 7. User interface

The panel keeps its shape. Screens change.

**Home.** "Criar um canal" and "Entrar em um canal" replace the share and watch
rows. Quality and the capture test stay.

**Channel.** The new main screen: the code with a copy affordance, then the member
list. Each row is a name, a live badge, and its state — `ao vivo`, `assistindo`,
`conectando`. Clicking a live member starts watching. The first row is you, with
"Compartilhar minha tela" or "Parar de compartilhar".

**Watch.** What `WatchScreen` is today, minus the code input, plus "Voltar para o
canal". The channel connection survives it, so backing out of a stream does not
leave the channel.

**Tray.** States now combine. Icon priority is error, then sharing, then watching,
then idle; the tooltip carries both, e.g. `Compartilhando · 3 espectadores ·
assistindo NOTEBOOK-ANA`.

**Auto-hide.** Owned centrally now: the panel stays pinned while watching *or*
publishing, and the watch screen stops deciding it alone.

## 8. What does not change

`peer-connection.ts`, `stats-tracker.ts`, `connection-quality.ts`,
`stream-stats.ts`, `screen-capture.ts`'s video path, the quality presets, the
reconnect and backoff in `SignalingClient`, the rate limiter, and the ICE
credential issuer. The WebRTC layer was built one-connection-at-a-time and
survives the change intact.

## 9. Acceptance

- Three machines join one channel with a code; each sees the other two by PC name.
- A joins with nobody publishing: zero peer connections exist.
- B publishes; A and C see the live badge; still zero peer connections.
- A clicks B: exactly one connection is built, A sees B's screen.
- A publishes while watching B; C clicks A and sees A's screen. A is now encoding
  and decoding at once.
- A clicks C while watching B: A is refused, or A's stream from B is dropped
  first. One at a time, and the UI says which.
- B stops publishing: A's picture ends with a message, A stays in the channel.
- B closes the app: B disappears from both member lists within the heartbeat.
- A's signaling socket drops and recovers: A rejoins the same channel and its
  members reappear.
- Sharing system audio while watching produces no echo at the other end.
