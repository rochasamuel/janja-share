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

### Option A — a small VPS (what you want for anything lasting)

Any 1 GB box will do; the signaling process is tiny. What actually costs money
is TURN bandwidth, and only when it is used.

```bash
git clone <your repo> && cd janja-share/infra
cp ../.env.example .env
```

Fill in `.env`:

```
TURN_REALM=screenshare.example.com
TURN_SECRET=<openssl rand -hex 32>
TURN_URL=turn:screenshare.example.com:3478
TURN_TLS_URL=turns:screenshare.example.com:5349
```

```bash
docker compose up -d
```

Signaling binds to `127.0.0.1:8787` on purpose — put a reverse proxy in front
of it for TLS, because browsers and WebView2 refuse `ws://` from a secure
context, and because the room codes should not travel in the clear.

Caddy is two lines and gets a certificate on its own:

```
screenshare.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Then open the firewall. The relay port range is the one people forget, and it
fails in the worst way: authentication succeeds, candidates appear, and no
picture ever arrives.

```bash
sudo ufw allow 443/tcp
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 49160:49200/udp
```

If the VPS has a private NIC address (most do), uncomment `--external-ip` in
`infra/docker-compose.yml` and set the public address. Without it coturn hands
out addresses nobody can reach.

### Option B — a tunnel (for one evening's test, no server)

Good enough to prove the thing works with a real friend on a real connection,
with nothing to rent or maintain.

```bash
pnpm dev:signal                          # your machine
cloudflared tunnel --url http://localhost:8787
```

That prints an `https://something.trycloudflare.com` address. Build the app
with `wss://something.trycloudflare.com`.

Two honest limits. The address changes every restart, so every rebuild needs a
new one. And a tunnel carries signaling only, not TURN — TURN needs UDP that a
HTTP tunnel cannot pass. So friends behind strict NAT will fail to connect
while the rest work fine. Roughly 8 in 10 succeed.

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
