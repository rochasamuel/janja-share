#!/usr/bin/env bash
# Publica o servidor de sinalização local num endereço temporário da Cloudflare
# e imprime o comando de build já com esse endereço dentro.
#
# É um "quick tunnel": não precisa de conta nem de domínio, e o endereço é
# sorteado a cada execução. Isso é o que o torna descartável — e também o que
# obriga a regerar o instalador toda vez, porque o endereço fica gravado no
# executável no momento do build.
set -euo pipefail

PORT="${SIGNALING_PORT:-8787}"

command -v cloudflared >/dev/null || {
  echo "[TÚNEL] cloudflared não encontrado." >&2
  echo "[TÚNEL] Instale com:" >&2
  echo "  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared" >&2
  echo "  chmod +x ~/.local/bin/cloudflared" >&2
  exit 1
}

# Sem o servidor no ar o túnel sobe do mesmo jeito e devolve 502 para todo
# mundo, o que parece problema de rede e não é.
curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1 || {
  echo "[TÚNEL] Nada respondendo em http://localhost:$PORT/healthz" >&2
  echo "[TÚNEL] Rode 'pnpm dev:signal' em outro terminal primeiro." >&2
  exit 1
}
echo "[TÚNEL] servidor local respondendo na porta $PORT"

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate >"$LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill "$TUNNEL_PID" 2>/dev/null || true; rm -f "$LOG"' EXIT INT TERM

echo "[TÚNEL] abrindo…"
URL=""
for _ in $(seq 1 40); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  # Se o cloudflared morreu, esperar mais não adianta.
  kill -0 "$TUNNEL_PID" 2>/dev/null || { echo "[TÚNEL] cloudflared saiu:" >&2; cat "$LOG" >&2; exit 1; }
  sleep 1
done

[ -n "$URL" ] || { echo "[TÚNEL] endereço não apareceu em 40s:" >&2; cat "$LOG" >&2; exit 1; }

WSS="wss://${URL#https://}"

# Confirma que o caminho inteiro funciona, não só que o cloudflared subiu. O
# endereço leva alguns segundos para propagar na borda da Cloudflare, então
# uma tentativa só dá falso negativo.
READY=""
for _ in $(seq 1 20); do
  if curl -fsS --max-time 5 "$URL/healthz" >/dev/null 2>&1; then
    READY="yes"
    break
  fi
  sleep 2
done

if [ -n "$READY" ]; then
  echo "[TÚNEL] $URL/healthz respondendo de fora"
else
  echo "[TÚNEL] AVISO: $URL/healthz não respondeu em 40s — confira antes de distribuir"
fi

cat <<EOF

  endereço temporário: $URL
  para o app:          $WSS

  No Windows (PowerShell), na pasta do projeto:

    \$env:VITE_SIGNALING_URL = "$WSS"
    pnpm install
    pnpm tauri build

  O instalador sai em:
    apps\\desktop\\src-tauri\\target\\release\\bundle\\nsis\\

  Deixe este terminal aberto. Se ele fechar, o endereço morre e todo
  instalador gerado com ele para de funcionar.

EOF

wait "$TUNNEL_PID"
