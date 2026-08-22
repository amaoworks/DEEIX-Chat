#!/bin/sh
set -eu

BASE_URL=${1:-http://127.0.0.1:3001}

python3 - "$BASE_URL" <<'PY'
import json
import sys
import urllib.request

base = sys.argv[1].rstrip("/")

def get(path):
    with urllib.request.urlopen(base + path, timeout=10) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"{path}: HTTP {response.status}")
        return response.read()

get("/health")
spec = json.loads(get("/api/spec"))
paths = spec.get("paths", {})
required = {
    "/token/create_third_party_key": {"post"},
    "/token/login": {"post"},
    "/user": {"put"},
    "/user/{uid}/send": {"post"},
    "/user/{uid}/history": {"get"},
    "/user/events": {"get"},
    "/message/{mid}/reply": {"post"},
    "/message/{mid}/edit": {"put"},
    "/message/{mid}": {"delete"},
    "/resource/file/prepare": {"post"},
    "/resource/file/upload": {"post"},
    "/resource/file": {"get"},
}
missing = []
for path, methods in required.items():
    available = {method.lower() for method in paths.get(path, {})}
    for method in methods - available:
        missing.append(f"{method.upper()} /api{path}")
if missing:
    print("VoceChat compatibility check failed; missing:", file=sys.stderr)
    for item in missing:
        print(f"  - {item}", file=sys.stderr)
    raise SystemExit(1)

version = spec.get("info", {}).get("version", "unknown")
print(f"VoceChat {version} exposes every DEEIX-required endpoint.")
print("Run the authenticated two-user acceptance test on staging before production upgrade.")
PY
