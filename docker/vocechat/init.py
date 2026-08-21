#!/usr/bin/env python3
"""Idempotently provision VoceChat and publish its DEEIX third-party secret."""

from __future__ import annotations

import json
import os
import secrets
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


class APIError(RuntimeError):
    def __init__(self, method: str, path: str, status: int, body: str) -> None:
        body = body.strip()
        detail = f": {body[:300]}" if body else ""
        super().__init__(f"VoceChat {method} {path} returned HTTP {status}{detail}")
        self.status = status


class VoceChatAPI:
    def __init__(self, base_url: str, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def request(
        self,
        method: str,
        path: str,
        payload: Any | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        request_headers = dict(headers or {})
        data = None
        if payload is not None:
            data = json.dumps(payload, separators=(",", ":")).encode()
            request_headers["Content-Type"] = "application/json; charset=utf-8"
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            headers=request_headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode()
                content_type = response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as error:
            body = error.read().decode(errors="replace")
            raise APIError(method, path, error.code, body) from error
        if not body:
            return None
        if "application/json" in content_type:
            return json.loads(body)
        return body


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


def env_bool(name: str) -> bool:
    return env(name).lower() in {"1", "true", "yes", "on"}


def atomic_write(path: Path, value: str, mode: int, owner: tuple[int, int] | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(value)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        if owner is not None:
            os.chown(temporary, owner[0], owner[1])
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""


def read_credentials(path: Path) -> dict[str, str]:
    raw = read_text(path)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"invalid persisted VoceChat administrator credentials: {path}") from error
    return {key: str(parsed.get(key, "")).strip() for key in ("email", "name", "password")}


def wait_until_healthy(api: VoceChatAPI, seconds: int) -> None:
    deadline = time.monotonic() + seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            api.request("GET", "/health")
            return
        except Exception as error:  # The bounded retry reports the final cause.
            last_error = error
            time.sleep(2)
    raise RuntimeError(f"VoceChat did not become healthy within {seconds}s: {last_error}")


def secret_is_valid(api: VoceChatAPI, value: str) -> bool:
    if not value:
        return False
    try:
        key = api.request(
            "POST",
            "/api/token/create_third_party_key",
            {"userid": "deeix-init-probe", "username": "DEEIX Init Probe"},
            {"X-SECRET": value},
        )
        return isinstance(key, str) and bool(key)
    except (APIError, urllib.error.URLError, TimeoutError):
        return False


def output_owner() -> tuple[int, int] | None:
    uid = env("VOCECHAT_SECRET_UID")
    gid = env("VOCECHAT_SECRET_GID")
    if not uid and not gid:
        return None
    return int(uid or "0"), int(gid or "0")


def provision() -> None:
    base_url = env("VOCECHAT_URL", "http://vocechat:3000")
    secret_path = Path(env("VOCECHAT_SECRET_PATH", "/run/secrets/vocechat/third-party-secret"))
    credential_path = Path(
        env("VOCECHAT_CREDENTIAL_PATH", "/var/lib/deeix-vocechat-init/administrator.json")
    )
    api = VoceChatAPI(base_url, float(env("VOCECHAT_REQUEST_TIMEOUT_SECONDS", "10")))
    wait_until_healthy(api, int(env("VOCECHAT_WAIT_SECONDS", "120")))

    rotate_secret = env_bool("VOCECHAT_ROTATE_SECRET")
    existing_secret = read_text(secret_path)
    if not rotate_secret and secret_is_valid(api, existing_secret):
        print("VoceChat third-party secret is already provisioned and valid.")
        return

    persisted = read_credentials(credential_path)
    email = env("VOCECHAT_ADMIN_EMAIL", persisted.get("email", "deeix-im-bootstrap@example.invalid"))
    name = env("VOCECHAT_ADMIN_NAME", persisted.get("name", "DEEIX Messaging Bootstrap"))
    password = env("VOCECHAT_ADMIN_PASSWORD", persisted.get("password", ""))

    initialized = api.request("GET", "/api/admin/system/initialized")
    if initialized is False:
        password = password or secrets.token_urlsafe(36)
        api.request(
            "POST",
            "/api/admin/system/create_admin",
            {"email": email, "name": name, "password": password, "gender": 0},
        )
        credentials = json.dumps(
            {"email": email, "name": name, "password": password},
            separators=(",", ":"),
        )
        atomic_write(credential_path, credentials, 0o600)
        print("VoceChat administrator initialized for DEEIX messaging.")
    elif initialized is not True:
        raise RuntimeError(f"unexpected VoceChat initialization response: {initialized!r}")

    if not password:
        raise RuntimeError(
            "VoceChat is already initialized, but no bootstrap administrator credential is available. "
            "Restore the init-state volume or provide VOCECHAT_ADMIN_EMAIL and VOCECHAT_ADMIN_PASSWORD once."
        )

    login = api.request(
        "POST",
        "/api/token/login",
        {
            "credential": {"type": "password", "email": email, "password": password},
            "device": "deeix-vocechat-init",
        },
    )
    token = login.get("token", "") if isinstance(login, dict) else ""
    if not token:
        raise RuntimeError("VoceChat administrator login returned no access token")

    headers = {"X-API-Key": token}
    third_party_secret = api.request(
        "POST" if rotate_secret else "GET",
        "/api/admin/system/third_party_secret",
        headers=headers,
    )
    if not isinstance(third_party_secret, str) or not third_party_secret.strip():
        third_party_secret = api.request(
            "POST", "/api/admin/system/third_party_secret", headers=headers
        )
    if not isinstance(third_party_secret, str) or not third_party_secret.strip():
        raise RuntimeError("VoceChat returned an empty third-party secret")

    atomic_write(secret_path, third_party_secret.strip(), 0o400, output_owner())
    print(f"VoceChat third-party secret provisioned at {secret_path}.")


if __name__ == "__main__":
    try:
        provision()
    except Exception as error:
        print(f"VoceChat initialization failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
