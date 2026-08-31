#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
STATE_DIR=${DEEIX_DEV_STATE_DIR:-"$PROJECT_DIR/.deeix/deeix"}
VOCECHAT_PORT=${VOCECHAT_DEV_PORT:-3101}
API_PORT=${DEEIX_DEV_API_PORT:-8080}
WEB_PORT=${DEEIX_DEV_WEB_PORT:-3000}
WEB_BIND=0.0.0.0
KEEP_VOCECHAT=${DEEIX_DEV_KEEP_VOCECHAT:-false}
API_CONTAINER=${DEEIX_DEV_API_CONTAINER:-deeix-api-dev}
VOCECHAT_STARTED=false
DEV_PID=""

detect_host_address() {
  address=""
  if command -v ip >/dev/null 2>&1; then
    address=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{
      for (field = 1; field <= NF; field++) {
        if ($field == "src") {
          print $(field + 1)
          exit
        }
      }
    }')
  fi
  if [ -z "$address" ] && command -v hostname >/dev/null 2>&1; then
    address=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  printf '%s\n' "${address:-127.0.0.1}"
}

ADVERTISE_HOST=${DEEIX_DEV_ADVERTISE_HOST:-$(detect_host_address)}
API_URL=${DEEIX_DEV_API_URL:-"http://$ADVERTISE_HOST:$API_PORT"}
WEB_URL=${DEEIX_DEV_WEB_URL:-"http://$ADVERTISE_HOST:$WEB_PORT"}

usage() {
  cat <<'EOF'
usage: ./scripts/dev-deeix.sh [up]

Starts the local VoceChat dependency, then runs the DEEIX API and web app in
the foreground. Press Ctrl+C to stop DEEIX; VoceChat is stopped as well unless
DEEIX_DEV_KEEP_VOCECHAT=true is set.

Useful overrides:
  DEEIX_DEV_CONFIG=/absolute/path/config.yaml
  DEEIX_DEV_API_PORT=8080
  DEEIX_DEV_WEB_PORT=3000
  DEEIX_DEV_ADVERTISE_HOST=203.0.113.10
  DEEIX_NEXT_ALLOWED_DEV_ORIGINS=203.0.113.10
  DEEIX_DEV_API_URL=http://203.0.113.10:8080
  DEEIX_DEV_WEB_URL=http://203.0.113.10:3000
  VOCECHAT_DEV_PORT=3101
  DEEIX_DEV_SKIP_INSTALL=true
  DEEIX_DEV_KEEP_VOCECHAT=true
  DEEIX_DEV_WEB_ENGINE=turbopack|webpack
  DEEIX_DEV_NODE_HEAP_MB=1024
EOF
}

cleanup() {
  trap - EXIT HUP INT TERM

  # Removing the API container first unblocks its docker client. The lightweight
  # service supervisor runs in a separate process group so no Next, helper shell
  # or docker client can survive after this launcher exits.
  docker rm -f "$API_CONTAINER" >/dev/null 2>&1 || true
  if [ -n "$DEV_PID" ] && /bin/kill -0 -- "-$DEV_PID" >/dev/null 2>&1; then
    /bin/kill -TERM -- "-$DEV_PID" >/dev/null 2>&1 || true
    attempts=0
    while /bin/kill -0 -- "-$DEV_PID" >/dev/null 2>&1 && [ "$attempts" -lt 30 ]; do
      sleep 0.1
      attempts=$((attempts + 1))
    done
    /bin/kill -KILL -- "-$DEV_PID" >/dev/null 2>&1 || true
    wait "$DEV_PID" >/dev/null 2>&1 || true
  fi

  if [ "$VOCECHAT_STARTED" = true ] && [ "$KEEP_VOCECHAT" != true ]; then
    "$PROJECT_DIR/scripts/dev-vocechat.sh" down >/dev/null 2>&1 || true
    printf '%s\n' "VoceChat development container stopped; persistent data was preserved."
  fi
}

case "${1:-up}" in
  up) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

command -v node >/dev/null 2>&1 || {
  printf '%s\n' "Node.js is required to run the DEEIX web app." >&2
  exit 1
}
command -v docker >/dev/null 2>&1 || {
  printf '%s\n' "Docker is required to run the local VoceChat dependency." >&2
  exit 1
}
command -v setsid >/dev/null 2>&1 || {
  printf '%s\n' "setsid from util-linux is required for reliable development process cleanup." >&2
  exit 1
}

mkdir -p "$STATE_DIR/data" "$STATE_DIR/storage" "$STATE_DIR/corepack-bin" "$STATE_DIR/corepack-home"

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export TURBO_TELEMETRY_DISABLED=1

if ! command -v pnpm >/dev/null 2>&1; then
  command -v corepack >/dev/null 2>&1 || {
    printf '%s\n' "pnpm or Corepack is required to run the DEEIX workspace." >&2
    exit 1
  }
  export COREPACK_HOME="$STATE_DIR/corepack-home"
  corepack enable --install-directory "$STATE_DIR/corepack-bin" pnpm
  PATH="$STATE_DIR/corepack-bin:$PATH"
  export PATH
fi

if [ -n "${DEEIX_DEV_CONFIG:-}" ]; then
  CONFIG_FILE=$DEEIX_DEV_CONFIG
elif [ -f "$PROJECT_DIR/config.yaml" ]; then
  CONFIG_FILE="$PROJECT_DIR/config.yaml"
else
  CONFIG_FILE="$PROJECT_DIR/config.sqlite.example.yaml"
  export DATABASE_DRIVER=sqlite
  export SQLITE_PATH="$STATE_DIR/data/deeix.db"
  export CACHE_DRIVER=memory
  export STORAGE_BACKEND=local
  export STORAGE_ROOT_DIR="$STATE_DIR/storage"
  printf '%s\n' "No config.yaml found; using isolated SQLite development state at $STATE_DIR."
fi

if [ ! -r "$CONFIG_FILE" ]; then
  printf 'DEEIX configuration is not readable: %s\n' "$CONFIG_FILE" >&2
  exit 1
fi

export CONFIG_FILE
export HTTP_PORT="$API_PORT"
export PORT="$WEB_PORT"
export DEEIX_NEXT_ALLOWED_DEV_ORIGINS=${DEEIX_NEXT_ALLOWED_DEV_ORIGINS:-"$ADVERTISE_HOST"}
export DEEIX_DEV_WEB_ENGINE=${DEEIX_DEV_WEB_ENGINE:-turbopack}
if [ -n "${DEEIX_DEV_NODE_HEAP_MB:-}" ]; then
  export DEEIX_DEV_NODE_HEAP_MB
fi
export NEXT_PUBLIC_API_BASE_URL="$API_URL"
export PUBLIC_API_BASE_URL="$API_URL"
export PUBLIC_WEB_BASE_URL="$WEB_URL"
export CORS_ALLOW_ORIGIN=${DEEIX_DEV_CORS_ALLOW_ORIGIN:-"http://localhost:$WEB_PORT,http://127.0.0.1:$WEB_PORT,$WEB_URL"}
export INTERNAL_MESSAGING_ENABLED=true
export INTERNAL_MESSAGING_VOCECHAT_URL="http://127.0.0.1:$VOCECHAT_PORT"
export INTERNAL_MESSAGING_SECRET_FILE="$PROJECT_DIR/.deeix/vocechat/secrets/third-party-secret"

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

VOCECHAT_DEV_BIND=${VOCECHAT_DEV_BIND:-127.0.0.1} \
VOCECHAT_DEV_PORT="$VOCECHAT_PORT" \
  "$PROJECT_DIR/scripts/dev-vocechat.sh" up
VOCECHAT_STARTED=true

if [ "${DEEIX_DEV_SKIP_INSTALL:-false}" != true ]; then
  printf '%s\n' "Checking workspace dependencies..."
  (cd "$PROJECT_DIR" && pnpm install --frozen-lockfile)
fi

# Run the frontend preparation once, then launch the API and Next directly.
# Avoiding a persistent Turbo process and three pnpm wrappers saves hundreds of
# MiB in a long-running development session without changing application code.
(cd "$PROJECT_DIR/frontend" && pnpm run predev)

printf '%s\n' \
  "Starting DEEIX development services..." \
  "API toolchain: Docker, Go 1.26.5 (no host make/Go installation required)" \
  "Web listen: $WEB_BIND:$WEB_PORT" \
  "Web local: http://127.0.0.1:$WEB_PORT" \
  "Web external: $WEB_URL" \
  "API local: http://127.0.0.1:$API_PORT" \
  "API for browser: $API_URL" \
  "VoceChat: http://127.0.0.1:$VOCECHAT_PORT (internal dependency; do not log in here)" \
  "Web compiler: $DEEIX_DEV_WEB_ENGINE${DEEIX_DEV_NODE_HEAP_MB:+ (V8 heap limit: ${DEEIX_DEV_NODE_HEAP_MB} MiB)}" \
  "Warning: the DEEIX development Web/API ports are reachable from the network; stop with Ctrl+C immediately after testing." \
  "Press Ctrl+C to stop."

cd "$PROJECT_DIR"
setsid "$PROJECT_DIR/scripts/dev-services.sh" &
DEV_PID=$!
set +e
wait "$DEV_PID"
DEV_STATUS=$?
set -e
exit "$DEV_STATUS"
