#!/usr/bin/env python3
"""Empuja el /api/snapshot local al puente. No llama a Kalshi ni imprime el token."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

INTERVAL_SEC = 1.5
LOCAL_SNAPSHOT = "http://127.0.0.1:8771/api/snapshot"


def assert_local_source(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise SystemExit("la fuente tiene que ser el snapshot local")
    if parsed.path != "/api/snapshot":
        raise SystemExit("la fuente tiene que ser /api/snapshot")
    return url


def assert_bridge(url: str) -> str:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or host == "kalshi.com" or host.endswith(".kalshi.com"):
        raise SystemExit("el puente tiene que ser HTTPS y no Kalshi")
    if parsed.path.rstrip("/") != "/ingest":
        raise SystemExit("el puente tiene que terminar en /ingest")
    return url


def build_request(bridge: str, token: str, payload: bytes) -> urllib.request.Request:
    return urllib.request.Request(
        bridge,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )


def main() -> None:
    source = assert_local_source(os.environ.get("RADAR_LOCAL_SNAPSHOT_URL", LOCAL_SNAPSHOT))
    bridge = assert_bridge(os.environ["RADAR_BRIDGE_URL"])
    token = os.environ.get("RADAR_INGEST_TOKEN", "")
    if not token:
        raise SystemExit("falta RADAR_INGEST_TOKEN")
    while True:
        started = time.monotonic()
        try:
            with urllib.request.urlopen(source, timeout=2) as res:
                payload = res.read()
            urllib.request.urlopen(build_request(bridge, token, payload), timeout=5).read()
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            pass
        time.sleep(max(0.0, INTERVAL_SEC - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
