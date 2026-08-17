# Sending the app to a friend

Three things have to be true before a friend in another house can watch your
screen. The installer is the easy one.

1. A signaling server both of you can reach over the internet
2. The app built with that server's address baked in
3. TURN, for the friends whose network won't allow a direct connection

## 1. The server

`localhost` is the blocker. On your friend's machine `localhost` is their own
PC, so two copies of the app pointing there will never find each other. The
signaling server has to live somewhere with a public address.

### What to rent

Any 1 GB box. The signaling process is tiny — it relays a few kilobytes per
connection. What actually costs money is TURN bandwidth, and only for the
connections that need relaying.

| Provider | Rough cost | Note |
|---|---|---|
| Hetzner CX22 | ~€4/month | 20 TB traffic included; the value pick |
| Contabo VPS S | ~€5/month | Generous traffic |
| DigitalOcean | ~$6/month | 1 TB, then billed per GB |

Watch the **traffic allowance**, not the CPU. A relayed 6-viewer session moves
around 36 Mbps each way; an evening of that is tens of gigabytes.

### DNS first

Point an A record at the VPS before deploying. Caddy cannot obtain a
certificate until the name resolves to the box, and everything else waits on
that certificate.

```
screenshare.example.com.   A   <vps ip>
```

### Deploy

On a fresh Ubuntu box:

```bash
curl -fsSL https://get.docker.com | sh
git clone <your repo> janja-share
cd janja-share/infra
./deploy.sh screenshare.example.com
```

That script does the whole thing: detects the public IP, warns you if DNS does
not point at it yet, generates a TURN secret, writes `.env`, opens the firewall
including the relay port range, starts Caddy, signaling and coturn, then waits
for the certificate and prints the exact build command.

It is safe to re-run. It keeps the existing `TURN_SECRET` rather than
generating a new one, because rotating that secret invalidates every credential
already handed out.

### If you would rather not rent anything yet

A tunnel proves the thing works with a real friend tonight, with nothing to
maintain:

```bash
pnpm dev:signal
cloudflared tunnel --url http://localhost:8787
```

Build against the `wss://...trycloudflare.com` address it prints. Two honest
limits: the address changes on every restart, and a HTTP tunnel cannot carry
TURN's UDP — so friends behind strict NAT will fail while the rest work. Around
8 in 10 succeed.

## 2. Building the installer

The signaling address is compiled in at build time, so build **after** you know
the server's address.

```powershell
cd C:\Users\sams\source\janja-share\apps\desktop
$env:VITE_SIGNALING_URL = "wss://screenshare.example.com"
pnpm tauri build
```

Output lands in `src-tauri\target\release\bundle\`:

| File | Use |
|---|---|
| `nsis\ScreenShare_0.1.0_x64-setup.exe` | Send this one. Normal Windows installer. |
| `msi\ScreenShare_0.1.0_x64_en-US.msi` | For managed machines and group policy |

Your friend needs nothing else installed. No Node, no Rust, no terminal.
WebView2 is already on every Windows 11 machine and current Windows 10; the
installer fetches it if it is somehow missing.

### The unsigned-executable warning

The installer is not code-signed, so Windows SmartScreen will show a blue
"Windows protected your PC" box. Your friend has to click **More info** then
**Run anyway**. Tell them beforehand, or they will assume it is a virus and
they will be right to.

Signing certificates run a few hundred dollars a year. Worth it only if this
goes past friends.

## 3. Checking it actually works

Test in this order. Each step rules out a different failure.

**Is the server reachable?**

```bash
curl https://screenshare.example.com/healthz
```

Expect `{"ok":true,"rooms":0}`. If this fails, nothing else can work.

**Does the app reach it?** Open the app. The header says `connected`. If it
says `offline`, the address was wrong at build time, and no amount of retrying
on your friend's side will fix it.

**Does a direct connection work?** Share, have your friend join. If the picture
arrives, you never needed TURN.

**Does the relay work?** This one has to be forced, because a connection that
quietly succeeded peer-to-peer looks exactly like a working relay:

```powershell
$env:VITE_FORCE_RELAY = "1"
pnpm tauri build
```

That build discards direct candidates entirely. If the picture still arrives,
TURN genuinely works, and the friends behind strict NAT will be fine. Throw
that build away afterwards — it forces every connection through your server's
bandwidth.

## What your friend should expect

Six viewers is the ceiling, and it is set by **your** upload, not by their
connection. Each viewer receives a separate copy of the stream from your
machine: six of them at 6 Mbps is around 36 Mbps of upload. On a typical
asymmetric plan (say 300 down, 30 up) three or four viewers will be the real
limit, and the app will lower quality rather than drop anyone.

If sharing feels fine for you but your friends see a slideshow, upload is
almost always the reason, not their download.
