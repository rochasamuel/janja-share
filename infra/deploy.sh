#!/usr/bin/env bash
# One-shot setup for a fresh VPS. Safe to re-run: it never overwrites an
# existing secret, because rotating TURN_SECRET silently breaks every client
# holding a credential issued under the old one.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "usage: ./deploy.sh screenshare.example.com" >&2
  exit 1
fi

command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin is missing" >&2; exit 1; }

PUBLIC_IP="$(curl -fsS https://api.ipify.org)"
echo "[APP] public ip: $PUBLIC_IP"

RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
if [ "$RESOLVED" != "$PUBLIC_IP" ]; then
  echo
  echo "[APP] WARNING: $DOMAIN resolves to '${RESOLVED:-nothing}', not $PUBLIC_IP."
  echo "[APP] Caddy cannot get a certificate until the A record points here."
  echo "[APP] Fix DNS first, or the stack will start and TLS will keep failing."
  echo
  read -r -p "continue anyway? [y/N] " answer
  [ "$answer" = "y" ] || exit 1
fi

if [ -f .env ]; then
  echo "[APP] .env already exists, keeping its secret"
  # shellcheck disable=SC1091
  TURN_SECRET="$(grep '^TURN_SECRET=' .env | cut -d= -f2-)"
else
  TURN_SECRET="$(openssl rand -hex 32)"
fi

cat > .env <<EOF
DOMAIN=$DOMAIN
PUBLIC_IP=$PUBLIC_IP

MAX_VIEWERS=6
STUN_URL=stun:stun.l.google.com:19302

TURN_REALM=$DOMAIN
TURN_URL=turn:$DOMAIN:3478
TURN_TLS_URL=turns:$DOMAIN:5349
TURN_SECRET=$TURN_SECRET
TURN_TTL_SECONDS=3600
EOF
chmod 600 .env
echo "[APP] wrote .env"

if command -v ufw >/dev/null; then
  echo "[APP] opening firewall ports"
  ufw allow 80/tcp    >/dev/null
  ufw allow 443/tcp   >/dev/null
  ufw allow 3478/udp  >/dev/null
  ufw allow 3478/tcp  >/dev/null
  ufw allow 5349/tcp  >/dev/null
  # The relay range is the one people forget. Without it, authentication
  # succeeds, candidates appear, and no media ever arrives.
  ufw allow 49160:49200/udp >/dev/null
else
  echo "[APP] no ufw found — open 80,443,3478,5349 and UDP 49160-49200 yourself"
fi

docker compose up -d --build

echo
echo "[APP] waiting for the certificate..."
for _ in $(seq 1 30); do
  if curl -fsS "https://$DOMAIN/healthz" >/dev/null 2>&1; then
    echo "[APP] https://$DOMAIN/healthz is live"
    echo
    echo "Build the Windows app against it:"
    echo "  \$env:VITE_SIGNALING_URL = \"wss://$DOMAIN\""
    echo "  pnpm tauri build"
    exit 0
  fi
  sleep 4
done

echo "[APP] still no certificate after 2 minutes. Check: docker compose logs caddy"
exit 1
