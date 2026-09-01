#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
API_PID=""
WEB_PID=""
API_KILLER_PID=""
WEB_KILLER_PID=""
SHUTDOWN_GRACE_SECONDS=${DEEIX_DEV_SHUTDOWN_GRACE_SECONDS:-3}
case "$SHUTDOWN_GRACE_SECONDS" in
  ''|*[!0-9]*) SHUTDOWN_GRACE_SECONDS=3 ;;
esac

cleanup() {
  trap - EXIT HUP INT TERM
  if [ -n "$WEB_PID" ] && kill -0 "$WEB_PID" >/dev/null 2>&1; then
    kill -TERM "$WEB_PID" >/dev/null 2>&1 || true
    (
      sleep "$SHUTDOWN_GRACE_SECONDS"
      kill -KILL "$WEB_PID" >/dev/null 2>&1 || true
    ) &
    WEB_KILLER_PID=$!
  fi
  if [ -n "$API_PID" ] && kill -0 "$API_PID" >/dev/null 2>&1; then
    kill -TERM "$API_PID" >/dev/null 2>&1 || true
    (
      sleep "$SHUTDOWN_GRACE_SECONDS"
      kill -KILL "$API_PID" >/dev/null 2>&1 || true
    ) &
    API_KILLER_PID=$!
  fi
  if [ -n "$WEB_PID" ]; then
    wait "$WEB_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$WEB_KILLER_PID" ]; then
    kill -TERM "$WEB_KILLER_PID" >/dev/null 2>&1 || true
    wait "$WEB_KILLER_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$API_PID" ]; then
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$API_KILLER_PID" ]; then
    kill -TERM "$API_KILLER_PID" >/dev/null 2>&1 || true
    wait "$API_KILLER_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

"$PROJECT_DIR/scripts/dev-api.sh" &
API_PID=$!

(
  cd "$PROJECT_DIR/frontend"
  PATH="$PROJECT_DIR/frontend/node_modules/.bin:$PATH"
  export PATH
  exec "$PROJECT_DIR/scripts/dev-web.sh"
) &
WEB_PID=$!

# POSIX sh has no portable wait-for-any-child operation. Polling once per
# second keeps the supervisor tiny while ensuring either service failure tears
# down the complete development stack.
while kill -0 "$API_PID" >/dev/null 2>&1 && kill -0 "$WEB_PID" >/dev/null 2>&1; do
  sleep 1
done

if ! kill -0 "$API_PID" >/dev/null 2>&1; then
  set +e
  wait "$API_PID"
  STATUS=$?
  set -e
else
  set +e
  wait "$WEB_PID"
  STATUS=$?
  set -e
fi

exit "$STATUS"
