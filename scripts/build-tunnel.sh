#!/usr/bin/env bash
# TEMPORÁRIO — atalho de teste, não faz parte do fluxo oficial.
#
# Faz sozinho, de ponta a ponta, o que a documentação manda fazer à mão:
# sobe o servidor de sinalização, abre o túnel da Cloudflare, espera o endereço
# propagar, espelha o código para o lado Windows, builda o instalador com esse
# endereço gravado dentro e depois segura o túnel aberto.
#
# O túnel tem que continuar vivo depois do build: o endereço fica gravado no
# executável, então fechar este terminal quebra todo instalador gerado por ele,
# inclusive os que já estão na mão dos seus amigos.
#
#   bash scripts/build-tunnel.sh              # build de release (instalador)
#   bash scripts/build-tunnel.sh --debug      # build de debug, bem mais rápido
#   bash scripts/build-tunnel.sh --no-build   # só o túnel, sem buildar nada
set -euo pipefail

PORT="${SIGNALING_PORT:-8787}"
WIN_DEST="${WIN_DEST:-/mnt/c/Users/sams/source/janja-share}"
WIN_PATH='C:\Users\sams\source\janja-share'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODE="release"
BUILD="yes"
for arg in "$@"; do
  case "$arg" in
    --debug) MODE="debug" ;;
    --no-build) BUILD="no" ;;
    *) echo "[BUILD] opção desconhecida: $arg" >&2; exit 1 ;;
  esac
done

say() { echo "[$1] ${*:2}"; }

# Tudo que este script sobe, este script derruba. Sem isto um Ctrl-C deixa
# servidor e túnel rodando soltos, e a próxima execução bate em EADDRINUSE.
SERVER_PID=""
TUNNEL_PID=""
LOG="$(mktemp)"
cleanup() {
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT INT TERM

# --- 1. dependências -------------------------------------------------------

command -v cloudflared >/dev/null || {
  say TÚNEL "cloudflared não encontrado. Instale com:" >&2
  echo "  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared" >&2
  echo "  chmod +x ~/.local/bin/cloudflared" >&2
  exit 1
}

WIN_PNPM="/mnt/c/Users/$USER/AppData/Roaming/npm/pnpm.cmd"
[ -f "$WIN_PNPM" ] || WIN_PNPM="/mnt/c/Users/sams/AppData/Roaming/npm/pnpm.cmd"
if [ "$BUILD" = "yes" ] && [ ! -f "$WIN_PNPM" ]; then
  say BUILD "pnpm não encontrado no lado Windows ($WIN_PNPM)." >&2
  say BUILD "Instale com 'npm i -g pnpm' no PowerShell, ou use --no-build." >&2
  exit 1
fi

# --- 2. servidor de sinalização --------------------------------------------

if curl -fsS --max-time 3 "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
  say SINAL "já tem um servidor respondendo na porta $PORT — reaproveitando"
else
  say SINAL "subindo o servidor na porta $PORT…"
  ( cd "$ROOT/apps/signaling" && exec node --import tsx src/main.ts ) &
  SERVER_PID=$!

  for _ in $(seq 1 30); do
    curl -fsS --max-time 2 "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break
    kill -0 "$SERVER_PID" 2>/dev/null || { say SINAL "o servidor saiu antes de escutar" >&2; exit 1; }
    sleep 1
  done

  curl -fsS --max-time 2 "http://localhost:$PORT/healthz" >/dev/null 2>&1 || {
    say SINAL "não respondeu em 30s" >&2
    exit 1
  }
  say SINAL "no ar"
fi

# --- 3. túnel ---------------------------------------------------------------

say TÚNEL "abrindo…"
cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate >"$LOG" 2>&1 &
TUNNEL_PID=$!

URL=""
for _ in $(seq 1 40); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || { say TÚNEL "cloudflared saiu:" >&2; cat "$LOG" >&2; exit 1; }
  sleep 1
done
[ -n "$URL" ] || { say TÚNEL "endereço não apareceu em 40s:" >&2; cat "$LOG" >&2; exit 1; }

WSS="wss://${URL#https://}"
say TÚNEL "$URL"

# Confere o caminho inteiro, não só que o cloudflared subiu. O endereço leva
# alguns segundos para propagar na borda, então uma tentativa só dá falso
# negativo — e um build feito contra um endereço morto só falha na casa do
# seu amigo.
say TÚNEL "esperando propagar…"
READY=""
for _ in $(seq 1 20); do
  if curl -fsS --max-time 5 "$URL/healthz" >/dev/null 2>&1; then READY="yes"; break; fi
  sleep 2
done
if [ -n "$READY" ]; then
  say TÚNEL "respondendo de fora"
else
  say TÚNEL "AVISO: não respondeu em 40s. O build vai sair, mas confira antes de distribuir."
fi

# --- 4. build ---------------------------------------------------------------

if [ "$BUILD" = "no" ]; then
  say BUILD "pulado (--no-build)"
else
  say SYNC "espelhando para $WIN_DEST…"
  bash "$ROOT/scripts/sync-windows.sh" >/dev/null
  say SYNC "pronto"

  # Um .ps1 gerado, em vez de um one-liner no powershell.exe: o endereço e os
  # caminhos passam por aspas do bash, do WSL e do PowerShell, e cada camada
  # come uma barra invertida.
  PS1="$WIN_DEST/.build-tunnel.ps1"
  TAURI_ARGS=""
  [ "$MODE" = "debug" ] && TAURI_ARGS=" --debug"

  # Marca d'água temporal: qualquer instalador mais velho que isto é de uma
  # execução anterior, e anunciar um deles como recém-saído já mandou um build
  # com o endereço errado para a casa de um amigo.
  STAMP="$(mktemp)"

  # BOM, e nada fora de ASCII no conteudo.
  #
  # powershell.exe e o Windows PowerShell 5.1, que le um .ps1 sem BOM usando o
  # codepage ANSI da maquina, nao UTF-8. Um travessao viraria tres bytes que o
  # parser le como lixo, e o erro que sai fala de aspas sem fechar, apontando
  # para qualquer lugar menos a causa. O BOM resolve a leitura; o ASCII resolve
  # tambem a renderizacao no console, que tem codepage proprio.
  printf '\xEF\xBB\xBF' > "$PS1"
  cat >> "$PS1" <<PS
# Generated by scripts/build-tunnel.sh. Disposable. ASCII only, see the script.
\$ErrorActionPreference = "Stop"

# Dependencies belong to the workspace, so the install runs at the root.
Set-Location "$WIN_PATH"
Write-Host "[BUILD] pnpm install"
pnpm install --prefer-offline
if (\$LASTEXITCODE -ne 0) { exit \$LASTEXITCODE }

# apps\\desktop, not src-tauri. Rust compiles inside src-tauri either way - the
# Tauri CLI goes in there itself - but pnpm needs a package.json to resolve
# binaries and src-tauri has none, so even 'pnpm exec' fails there with
# 'Command not found'. This is also where beforeBuildCommand finds Vite, which
# is what writes VITE_SIGNALING_URL into the executable.
Set-Location "$WIN_PATH\\apps\\desktop"
\$env:VITE_SIGNALING_URL = "$WSS"
Write-Host "[BUILD] pwd = \$(Get-Location)"
Write-Host "[BUILD] VITE_SIGNALING_URL = \$env:VITE_SIGNALING_URL"
Write-Host "[BUILD] tauri build$TAURI_ARGS - the first run is slow, Rust builds everything"
pnpm tauri build$TAURI_ARGS
exit \$LASTEXITCODE
PS

  say BUILD "compilando no Windows ($MODE), a partir de apps\\desktop…"
  if powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$PS1")"; then
    say BUILD "compilado"
  else
    say BUILD "falhou. O túnel continua aberto — o endereço não se perde." >&2
    say BUILD "Para tentar à mão, no PowerShell:" >&2
    echo "  cd $WIN_PATH\\apps\\desktop" >&2
    echo "  \$env:VITE_SIGNALING_URL = \"$WSS\"" >&2
    echo "  pnpm tauri build$TAURI_ARGS" >&2
    BUILD="failed"
  fi
  rm -f "$PS1"

  # O endereço realmente entrou no executável?
  #
  # Sem esta conferência o modo de falha é cruel: sem a variável o app cai no
  # padrão ws://localhost:8787, que funciona na SUA máquina — o servidor está
  # aqui — e falha em toda outra. O build "passa", você testa, e só descobre
  # na casa do seu amigo.
  if [ "$BUILD" = "yes" ]; then
    ASSETS="$WIN_DEST/apps/desktop/dist/assets"
    if grep -rqF "$WSS" "$ASSETS" 2>/dev/null; then
      say BUILD "endereço conferido dentro do bundle"
    else
      GRAVADO="$(grep -rohE 'wss?://[a-zA-Z0-9.:-]+' "$ASSETS" 2>/dev/null | sort -u | head -1)"
      say BUILD "ERRO: $WSS não está no bundle." >&2
      say BUILD "O que ficou gravado foi: ${GRAVADO:-nada}" >&2
      say BUILD "Isso conecta só nesta máquina. Não distribua este instalador." >&2
      BUILD="unstamped"
    fi
  fi
fi

# --- 5. onde ficou ----------------------------------------------------------

BUNDLE="$WIN_DEST/apps/desktop/src-tauri/target/$MODE/bundle"
INSTALLER=""
if [ "$BUILD" = "yes" ] && [ -n "${STAMP:-}" ]; then
  # -newer que a marca d'água: um .exe de uma execução anterior não conta.
  INSTALLER="$(find "$BUNDLE/nsis" -name '*-setup.exe' -newer "$STAMP" 2>/dev/null | head -1 || true)"
fi
rm -f "${STAMP:-}"

cat <<EOF

──────────────────────────────────────────────────────────────
  endereço:   $URL
  para o app: $WSS
EOF

case "$BUILD" in
  yes)
    if [ -n "$INSTALLER" ]; then
      echo "  instalador: $(wslpath -w "$INSTALLER")"
      echo "              $(du -h "$INSTALLER" | cut -f1)"
    else
      echo "  instalador: nenhum recém-gerado em $BUNDLE/nsis"
      echo "              (se houver um .exe lá, é de execução anterior)"
    fi
    ;;
  unstamped) echo "  instalador: NÃO DISTRIBUA — sem o endereço gravado dentro" ;;
  failed)    echo "  instalador: o build falhou" ;;
esac

cat <<EOF

  Deixe este terminal aberto. Fechando, o endereço morre e todo
  instalador gerado com ele para de funcionar.

  Ctrl-C encerra o túnel e o servidor.
──────────────────────────────────────────────────────────────

EOF

say TÚNEL "segurando o túnel. Ctrl-C para encerrar."
wait "$TUNNEL_PID"
