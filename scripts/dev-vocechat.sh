#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
STATE_DIR=${DEEIX_VOCECHAT_DEV_DIR:-"$PROJECT_DIR/.deeix/vocechat"}
CONTAINER_NAME=${VOCECHAT_DEV_CONTAINER:-deeix-vocechat-dev}
BIND_ADDRESS=${VOCECHAT_DEV_BIND:-127.0.0.1}
HOST_PORT=${VOCECHAT_DEV_PORT:-3001}
VOCECHAT_IMAGE=${VOCECHAT_IMAGE:-privoce/vocechat-server@sha256:dc3ad835c05e997852d0327aba958e11e46730ae89e249faa0b760931ac9eb87}
INIT_IMAGE=${VOCECHAT_INIT_IMAGE:-python:3.13.7-alpine3.22}

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

container_exists() {
  docker inspect "$CONTAINER_NAME" >/dev/null 2>&1
}

start() {
  mkdir -p "$STATE_DIR/data" "$STATE_DIR/secrets" "$STATE_DIR/init-state"

  ADVERTISE_ADDRESS=${VOCECHAT_DEV_ADVERTISE_HOST:-}
  if [ -z "$ADVERTISE_ADDRESS" ]; then
    if [ "$BIND_ADDRESS" = "0.0.0.0" ]; then
      ADVERTISE_ADDRESS=$(detect_host_address)
    else
      ADVERTISE_ADDRESS=$BIND_ADDRESS
    fi
  fi

  # The container is disposable; all durable state lives under STATE_DIR.
  # Recreating it also reapplies bind mounts, port changes, image changes and
  # configuration changes. Merely calling `docker start` can leave a running
  # container attached to an old directory inode after the host path has been
  # replaced, while the initializer sees a newly created empty directory.
  if container_exists; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi
  docker run -d \
    --name "$CONTAINER_NAME" \
    -p "$BIND_ADDRESS:$HOST_PORT:3000" \
    -v "$STATE_DIR/data:/home/vocechat-server/data" \
    -v "$PROJECT_DIR/docker/vocechat/config.toml:/home/vocechat-server/config/config.toml:ro" \
    "$VOCECHAT_IMAGE" \
    --network.bind 0.0.0.0:3000 >/dev/null

  docker run --rm \
    --network "container:$CONTAINER_NAME" \
    -e VOCECHAT_URL=http://127.0.0.1:3000 \
    -e VOCECHAT_SECRET_PATH=/run/secrets/vocechat/third-party-secret \
    -e VOCECHAT_CREDENTIAL_PATH=/var/lib/deeix-vocechat-init/administrator.json \
    -e "VOCECHAT_ROTATE_SECRET=${VOCECHAT_ROTATE_SECRET:-false}" \
    -e "VOCECHAT_ADMIN_EMAIL=${VOCECHAT_ADMIN_EMAIL:-}" \
    -e "VOCECHAT_ADMIN_PASSWORD=${VOCECHAT_ADMIN_PASSWORD:-}" \
    -e "VOCECHAT_SECRET_UID=$(id -u)" \
    -e "VOCECHAT_SECRET_GID=$(id -g)" \
    -v "$PROJECT_DIR/docker/vocechat/init.py:/opt/deeix/vocechat-init.py:ro" \
    -v "$STATE_DIR/secrets:/run/secrets/vocechat" \
    -v "$STATE_DIR/init-state:/var/lib/deeix-vocechat-init" \
    "$INIT_IMAGE" python3 /opt/deeix/vocechat-init.py

  printf '%s\n' \
    "VoceChat development service is listening on $BIND_ADDRESS:$HOST_PORT" \
    "VoceChat reachable URL: http://$ADVERTISE_ADDRESS:$HOST_PORT" \
    "Use this DEEIX configuration:" \
    "internal_messaging:" \
    "  enabled: true" \
    "  vocechat_url: \"http://$ADVERTISE_ADDRESS:$HOST_PORT\"" \
    "  secret_file: \".deeix/vocechat/secrets/third-party-secret\"" \
    "  timeout_ms: 10000"

  if [ "$BIND_ADDRESS" = "0.0.0.0" ]; then
    printf '%s\n' "Warning: VoceChat is listening on all network interfaces; restrict access with a firewall or security group."
  fi
}

stop() {
  if container_exists; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi
  printf '%s\n' "VoceChat development container stopped; data and secrets were preserved in $STATE_DIR."
}

status() {
  if container_exists; then
    docker inspect -f '{{.Name}} {{.State.Status}}' "$CONTAINER_NAME"
  else
    printf '%s\n' "VoceChat development container does not exist."
  fi
}

case "${1:-up}" in
  up) start ;;
  down) stop ;;
  logs) docker logs -f "$CONTAINER_NAME" ;;
  status) status ;;
  *)
    printf 'usage: %s {up|down|logs|status}\n' "$0" >&2
    exit 2
    ;;
esac
