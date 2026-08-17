# coturn (TURN relay)

TURN is the fallback for the minority of connections that cannot be made
directly. On a LAN it is never used. Between two ordinary home routers, STUN
hole-punching usually succeeds and it is never used. It earns its keep when one
side sits behind carrier-grade NAT, a symmetric NAT, or a corporate firewall —
roughly 10–20% of real-world attempts, which is exactly the fraction that would
otherwise just see "unable to connect".

When TURN is in use the media flows through this server, so it costs real
bandwidth: about 6 Mbps per relayed viewer, in and out.

## Running it locally

```bash
cp ../../.env.example ../../.env
# set TURN_SECRET to something random:
openssl rand -hex 32
```

```bash
pnpm dev:turn          # from the repo root
```

The signaling server needs the **same** `TURN_SECRET`; that shared secret is
what lets coturn validate credentials it has never seen before.

## How the credentials work

No user database. The signaling server issues a credential pair that carries
its own expiry:

```
username   = "<unix-expiry>:<sessionId>"
credential = base64(HMAC-SHA1(TURN_SECRET, username))
```

coturn recomputes the HMAC with its copy of the secret, checks the expiry, and
allows or refuses. The long-lived secret never leaves the two servers, and a
credential leaked from a client is worthless within the hour.

Verified behaviour (`turnutils_uclient` against a live container):

| Credential | Result |
|---|---|
| Issued by our server, current | Allocation succeeds, packets relay with no loss |
| Correct format, wrong secret | `Cannot complete Allocation` |
| Correct secret, expired timestamp | `Cannot complete Allocation` |

## Ports and firewall

| Port | Protocol | Purpose |
|---|---|---|
| 3478 | UDP | STUN/TURN. **The one that matters** — UDP is what media wants. |
| 3478 | TCP | Fallback for networks that block UDP |
| 5349 | TCP | TURN over TLS, for networks that only allow 443-like traffic |
| 49160–49200 | UDP | Relay range. One port per active relayed stream. |

All four must be open inbound. The relay range is the one people forget, and
the failure it produces is maddening: authentication succeeds, candidates
appear, and no media ever arrives.

```bash
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 5349/tcp
sudo ufw allow 49160:49200/udp
```

## Deploying to a server

`network_mode: host` is required, not a preference. coturn advertises the
addresses it sees on its own interfaces; behind Docker's bridge NAT those are
container-internal, so the relay candidates it hands out are unreachable. The
server looks healthy and relays nothing.

On a cloud VM whose NIC holds a private address (AWS, GCP, Azure, and most
VPS providers), set the public address explicitly, or coturn will advertise the
private one:

```yaml
- --external-ip=203.0.113.10
```

Sizing: bandwidth is the constraint, never CPU. A relay carrying one 6-viewer
session at worst case moves roughly 36 Mbps in and 36 Mbps out. Check what your
provider charges for egress before assuming a cheap box is cheap.

## TLS

Only needed for the `turns:` endpoint on port 5349, which exists for networks
that block everything except TLS. Point coturn at a real certificate:

```yaml
volumes:
  - /etc/letsencrypt/live/turn.example.com:/certs:ro
command:
  - --cert=/certs/fullchain.pem
  - --pkey=/certs/privkey.pem
```

Set `TURN_TLS_URL=turns:turn.example.com:5349` so the signaling server hands it
out alongside the UDP endpoint.

## Confirming it actually relays

Two checks, in order.

**1. Does the relay work at all?**

```bash
docker exec janja-coturn turnutils_uclient \
  -u "<username>" -w "<credential>" -p 3478 -n 2 -c -y <server-ip>
```

Get a live credential pair from `curl http://localhost:8787/api/ice-servers`.
Success looks like `tot_send_msgs=4, tot_recv_msgs=4` with zero lost packets.

**2. Does the app work when forced through it?**

The one that matters, because it tests the path a real stranded viewer takes.
Force relay in the client's `RTCPeerConnection` config:

```ts
{ iceServers, iceTransportPolicy: "relay" }
```

With that set, direct candidates are discarded, so if the picture still arrives
the relay path genuinely works. Confirm in `getStats()` that the selected
candidate pair has `candidateType: "relay"` — this is the only way to be sure
you are not quietly succeeding over a direct connection.

## Hardening already applied

An open TURN server gets found and abused as a proxy, so `turnserver.conf`
refuses to relay to loopback and link-local ranges, disables multicast peers,
disables the admin CLI, drops TLS 1.0/1.1, and caps per-user and total
bandwidth. Credentials are kept out of the logs.
