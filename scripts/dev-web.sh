#!/bin/sh
set -eu

ENGINE=${DEEIX_DEV_WEB_ENGINE:-turbopack}

case "$ENGINE" in
  turbopack)
    ENGINE_FLAG=--turbopack
    ;;
  webpack)
    ENGINE_FLAG=--webpack
    ;;
  *)
    printf 'Unsupported DEEIX_DEV_WEB_ENGINE: %s (expected turbopack or webpack)\n' "$ENGINE" >&2
    exit 2
    ;;
esac

if [ -n "${DEEIX_DEV_NODE_HEAP_MB:-}" ]; then
  case "$DEEIX_DEV_NODE_HEAP_MB" in
    *[!0-9]*|'')
      printf 'DEEIX_DEV_NODE_HEAP_MB must be a positive integer.\n' >&2
      exit 2
      ;;
  esac
  if [ "$DEEIX_DEV_NODE_HEAP_MB" -lt 512 ]; then
    printf 'DEEIX_DEV_NODE_HEAP_MB must be at least 512.\n' >&2
    exit 2
  fi
  NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=$DEEIX_DEV_NODE_HEAP_MB"
  export NODE_OPTIONS
fi

exec next dev "$ENGINE_FLAG" --hostname 0.0.0.0
