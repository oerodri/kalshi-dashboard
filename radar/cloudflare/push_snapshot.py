#!/usr/bin/env python3
"""Empuja el /api/snapshot local al puente. No llama a Kalshi ni imprime el token."""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

INTERVAL_SEC = 1.5
BACKOFF_CAP_SEC = 30.0
LOCAL_SNAPSHOT = "http://127.0.0.1:8771/api/snapshot"
USER_AGENT = "WTI-Radar-Publisher/1.0"
READ_TIMEOUT_SEC = 2


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


def local_request(url: str) -> urllib.request.Request:
    return urllib.request.Request(
        assert_local_source(url),
        method="GET",
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
    )


def build_request(bridge: str, token: str, payload: bytes) -> urllib.request.Request:
    return urllib.request.Request(
        assert_bridge(bridge),
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    )


def next_wait(current: float, failed: bool) -> float:
    if not failed:
        return INTERVAL_SEC
    return min(BACKOFF_CAP_SEC, max(INTERVAL_SEC * 2, current * 2))


def status_record(event: str, exc: BaseException | None, failures: int, last_success_age_s: float | None) -> dict:
    http_status = int(exc.code) if isinstance(exc, urllib.error.HTTPError) else None
    return {
        "event": event,
        "exc": type(exc).__name__ if exc is not None else "",
        "http_status": http_status,
        "failures": int(failures),
        "last_success_age_s": last_success_age_s,
    }


def emit_status(record: dict) -> None:
    sys.stderr.write(json.dumps(record, separators=(",", ":")) + "\n")


def main() -> None:
    source = assert_local_source(os.environ.get("RADAR_LOCAL_SNAPSHOT_URL", LOCAL_SNAPSHOT))
    bridge = assert_bridge(os.environ["RADAR_BRIDGE_URL"])
    token = os.environ.get("RADAR_INGEST_TOKEN", "")
    if not token:
        raise SystemExit("falta RADAR_INGEST_TOKEN")
    failures = 0
    last_success = None
    wait = INTERVAL_SEC
    while True:
        failed = False
        exc = None
        try:
            with urllib.request.urlopen(local_request(source), timeout=READ_TIMEOUT_SEC) as res:
                payload = res.read()
            urllib.request.urlopen(build_request(bridge, token, payload), timeout=5).read()
        except Exception as caught:
            failed = True
            exc = caught
            failures += 1
        else:
            failures = 0
            last_success = time.time()
        age = None if last_success is None else round(time.time() - last_success, 1)
        emit_status(status_record("publish_ok" if not failed else "publish_fail", exc, failures, age))
        wait = next_wait(wait, failed)
        time.sleep(wait)


if __name__ == "__main__":
    main()
