#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
STATE_DIR=${DEEIX_DEV_STATE_DIR:-"$PROJECT_DIR/.deeix/deeix"}
IMAGE=${DEEIX_DEV_API_IMAGE:-deeix-chat-dev-api:go1.26.8}
CONTAINER_NAME=${DEEIX_DEV_API_CONTAINER:-deeix-api-dev}

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

mkdir -p "$STATE_DIR/go-mod" "$STATE_DIR/go-build"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  printf '%s\n' "Building the pinned Go 1.26.8 DEEIX development toolchain..."
  docker build -t "$IMAGE" "$PROJECT_DIR/docker/deeix-dev-api"
fi

# Remove a container left by an interrupted previous debug session. All
# persistent application and Go cache data is bind-mounted outside it.
cleanup

docker run --rm \
  --name "$CONTAINER_NAME" \
  --network host \
  -e CONFIG_FILE \
  -e APP_ENV \
  -e HTTP_PORT \
  -e CORS_ALLOW_ORIGIN \
  -e PUBLIC_API_BASE_URL \
  -e PUBLIC_WEB_BASE_URL \
  -e DATABASE_DRIVER \
  -e POSTGRES_DSN \
  -e SQLITE_PATH \
  -e SQLITE_DSN \
  -e CACHE_DRIVER \
  -e REDIS_ADDR \
  -e REDIS_USERNAME \
  -e REDIS_PASSWORD \
  -e REDIS_DB \
  -e STORAGE_BACKEND \
  -e STORAGE_ROOT_DIR \
  -e INTERNAL_MESSAGING_ENABLED \
  -e INTERNAL_MESSAGING_VOCECHAT_URL \
  -e INTERNAL_MESSAGING_SECRET_FILE \
  -e INTERNAL_MESSAGING_TIMEOUT_MS \
  -v "$PROJECT_DIR:$PROJECT_DIR" \
  -v "$STATE_DIR/go-mod:/go/pkg/mod" \
  -v "$STATE_DIR/go-build:/root/.cache/go-build" \
  -w "$PROJECT_DIR/backend" \
  "$IMAGE" \
  go run ./cmd/server
