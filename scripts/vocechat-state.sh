#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
STATE_DIR=${DEEIX_VOCECHAT_DEV_DIR:-"$PROJECT_DIR/.deeix/vocechat"}
CONTAINER_NAME=${VOCECHAT_DEV_CONTAINER:-deeix-vocechat-dev}

usage() {
  printf 'usage: %s backup ARCHIVE | restore ARCHIVE\n' "$0" >&2
  exit 2
}

require_stopped() {
  running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)
  if [ "$running" = "true" ]; then
    printf 'stop %s before backup or restore: ./scripts/dev-vocechat.sh down\n' "$CONTAINER_NAME" >&2
    exit 1
  fi
}

validate_archive() {
  tar -tzf "$1" | awk '
    /^\// || /(^|\/)\.\.($|\/)/ { bad = 1 }
    !/^(data|secrets|init-state)(\/|$)/ { bad = 1 }
    END { exit bad }
  ' || {
    printf 'archive contains an unsafe or unexpected path\n' >&2
    exit 1
  }
}

case "${1:-}" in
  backup)
    [ "$#" -eq 2 ] || usage
    require_stopped
    archive=$2
    [ ! -e "$archive" ] || {
      printf 'refusing to overwrite existing archive: %s\n' "$archive" >&2
      exit 1
    }
    [ -d "$STATE_DIR/data" ] && [ -d "$STATE_DIR/secrets" ] && [ -d "$STATE_DIR/init-state" ] || {
      printf 'VoceChat state is incomplete: %s\n' "$STATE_DIR" >&2
      exit 1
    }
    tar -C "$STATE_DIR" -czf "$archive" data secrets init-state
    printf 'VoceChat state backup created: %s\n' "$archive"
    ;;
  restore)
    [ "$#" -eq 2 ] || usage
    require_stopped
    archive=$2
    [ -f "$archive" ] || {
      printf 'backup archive not found: %s\n' "$archive" >&2
      exit 1
    }
    validate_archive "$archive"
    if [ -e "$STATE_DIR" ]; then
      previous="${STATE_DIR}.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
      mv "$STATE_DIR" "$previous"
      printf 'previous state preserved at: %s\n' "$previous"
    fi
    mkdir -p "$STATE_DIR"
    tar -C "$STATE_DIR" -xzf "$archive"
    printf 'VoceChat state restored to: %s\n' "$STATE_DIR"
    ;;
  *) usage ;;
esac
