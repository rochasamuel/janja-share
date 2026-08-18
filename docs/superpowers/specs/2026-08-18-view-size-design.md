# Sending the picture the viewer can actually show

## The problem

The panel is 320px wide (`src-tauri/tauri.conf.json`), and `.video` fills it at
`aspect-ratio: 16/9` (`styles.css:418`). Outside fullscreen a viewer is
displaying roughly **312×176**.

The publisher meanwhile captures 1080p or 1440p and hands every viewer the same
encoding parameters (`viewer-connection-manager.ts:242`), which set a bitrate
ceiling and a degradation preference and nothing else. `scaleResolutionDownBy`
appears nowhere in the app.

`maxBitrate` is a ceiling, not a target, so the waste is not "always 8 Mbps
per viewer". It is that the encoder spends **whatever budget it has** on pixels
nobody is displaying. That reads two ways depending on the link:

- On a good link, those are real bytes on the wire for detail the viewer
  cannot resolve.
- On a poor link, `maintain-resolution` holds 1440p and drops frames instead,
  so the viewer gets a stuttering slideshow where a clean 480p would have been
  fluid and readable.

One change fixes both.

## The approach

WebRTC has no mechanism for a receiver to ask for a smaller picture, so the
viewer has to say so over signaling, and the publisher acts on it per viewer.

The architecture already supports this. There is one `RTCRtpSender` per viewer,
and `setEncoding` already proves encoding parameters can change mid-share
without renegotiating and without anyone losing their picture.
`scaleResolutionDownBy` travels the same path.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| What the viewer reports | `"panel" \| "fullscreen"` | There are exactly two states: a fixed 320px popover and the monitor. A pixel count invites debounce, `devicePixelRatio` handling and churn for a window that cannot be resized. It also matches the line `settings.ts` already takes out loud — a preset fixes the variables together because every separate control invites a bad combination. |
| Scale for `panel` | `scaleResolutionDownBy: 3` | 1920/3 = 640 device pixels across. A 312px CSS element at `devicePixelRatio: 2` needs 624, so 640 covers the worst case with nothing to spare wasted. From the 2560-wide `sharp` preset it gives 853, and from the 1280-wide `thrifty` preset 427 — both still above 312. |
| Scale for `fullscreen` | `scaleResolutionDownBy: 1` | The full captured picture, exactly as today. |
| Default before any report | `panel` | The viewer always lands on `WatchScreen` inside the panel; fullscreen takes a deliberate action. Defaulting to panel is therefore correct *and* saves bandwidth from the first frame rather than after a round trip. |
| Authorization | `channels.isSubscribed(session.id, publisherId)` | Not `mayAddress`. That helper exists for the three messages carrying both `targetId` and `publisherId`, where two members watching each other makes the pair ambiguous. `view-size` only ever travels viewer → publisher, so the publisher *is* the target and one subscription check is the whole rule. |
| Refused message | Silent no-op | Follows `unwatch`. A `view-size` for a subscription the server already tore down is not something the person chose, and an error frame would be telling them off for it. |

## Wire shape

Client → server, alongside `watch`/`unwatch`, which likewise name only the
publisher:

```ts
{ type: "view-size", publisherId: sessionIdSchema, size: z.enum(["panel", "fullscreen"]) }
```

Server → publisher, following the `watch-request` and `unwatch` shape:

```ts
{ type: "view-size"; fromId: string; size: ViewSize }
```

No `publisherId` on the way out. The server only delivers this to the publisher
it was addressed to, so the recipient already knows it is theirs.

## Where each piece lives

- `ViewingManager.setViewSize(size)` stays DOM-free and testable: it remembers
  the size, sends it when subscribed, and does nothing when idle.
- The `fullscreenchange` listener lives in `use-channel.ts`, next to the poll
  timer. `WatchScreen` needs no change — it already toggles fullscreen through
  the browser, and the browser event is the source of truth.
- `ViewerConnectionManager` holds the size per viewer and folds it into
  `#applySendParameters`.

## Known limits

- A viewer whose `view-size` never arrives (socket blip during the send) stays
  at panel scale until it next changes. Accepted: the message is sent again on
  every fullscreen transition, and the cost of the failure is a soft picture,
  not a broken one.
- A publisher running an older build ignores the message entirely and behaves
  exactly as it does today.
