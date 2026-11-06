#!/usr/bin/env python3
"""Puente de solo lectura. No llama a Kalshi ni coloca órdenes.

Publica un snapshot que el radar local ya escribió. Las horas de recepción
salen del archivo; este proceso no las reescribe.
"""
from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

DEFAULT_ORIGIN = "https://oerodri.github.io"
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def allowed_local_snapshot_url(raw: str | None) -> str | None:
    if not raw:
        return None
    parsed = urlparse(raw)
    if parsed.scheme != "http" or parsed.hostname not in LOOPBACK:
        raise ValueError("solo se reenvía el radar local en 127.0.0.1")
    if parsed.port == 443 or (parsed.path or "/") != "/api/snapshot":
        raise ValueError("solo se reenvía http://127.0.0.1:<puerto>/api/snapshot")
    return raw


def load_snapshot_bytes(path: Path | None, local_url: str | None) -> bytes:
    if path is not None:
        if not path.is_file():
            raise FileNotFoundError(str(path))
        return path.read_bytes()
    if local_url:
        req = Request(local_url, headers={"Accept": "application/json"}, method="GET")
        with urlopen(req, timeout=2) as res:
            return res.read()
    raise FileNotFoundError("sin snapshot")


def validate_snapshot(raw: bytes) -> None:
    data = json.loads(raw)
    markets = data.get("markets") if isinstance(data, dict) else None
    if not isinstance(markets, list) or not markets:
        raise ValueError("snapshot sin libros")
    for market in markets:
        if not isinstance(market, dict) or not market.get("ticker"):
            raise ValueError("libro incompleto")
        if not market.get("receipt_utc"):
            raise ValueError("libro sin recibo")
        if market.get("yes_bid") is None or market.get("yes_ask") is None:
            raise ValueError("libro incompleto")


class Bridge:
    def __init__(self, path: Path | None, local_url: str | None, origin: str):
        self.path = path
        self.local_url = local_url
        self.origin = origin

    def response(self, method: str, target: str) -> tuple[int, bytes, str]:
        if method == "OPTIONS":
            return 204, b"", "text/plain"
        if method != "GET" or urlparse(target).path not in ("/snapshot", "/api/snapshot"):
            return 404, b'{"error":"not found"}\n', "application/json"
        try:
            raw = load_snapshot_bytes(self.path, self.local_url)
            validate_snapshot(raw)
        except FileNotFoundError:
            return 503, b'{"error":"sin snapshot","banner":"DATOS ATRASADOS"}\n', "application/json"
        except Exception:
            return 422, b'{"error":"snapshot invalido","banner":"DATOS ATRASADOS"}\n', "application/json"
        return 200, raw if raw.endswith(b"\n") else raw + b"\n", "application/json"


def make_handler(bridge: Bridge):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            return

        def _send(self, code: int, body: bytes, ctype: str):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", bridge.origin)
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Accept")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_GET(self):
            code, body, ctype = bridge.response("GET", self.path)
            self._send(code, body, ctype)

        def do_OPTIONS(self):
            code, body, ctype = bridge.response("OPTIONS", self.path)
            self._send(code, body, ctype)

        def do_POST(self):
            self._send(405, b'{"error":"solo lectura"}\n', "application/json")

    return Handler


def serve(host: str, port: int, bridge: Bridge) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), make_handler(bridge))
    httpd.bridge = bridge
    return httpd


def main() -> None:
    path_raw = os.environ.get("RADAR_SNAPSHOT", "").strip()
    local = allowed_local_snapshot_url(os.environ.get("RADAR_LOCAL_SNAPSHOT_URL", "").strip() or None)
    path = Path(path_raw) if path_raw else None
    if path is None and local is None:
        raise SystemExit("define RADAR_SNAPSHOT o RADAR_LOCAL_SNAPSHOT_URL")
    origin = os.environ.get("RADAR_BRIDGE_ORIGIN", DEFAULT_ORIGIN).strip() or DEFAULT_ORIGIN
    host = os.environ.get("RADAR_BRIDGE_HOST", "127.0.0.1")
    port = int(os.environ.get("RADAR_BRIDGE_PORT", "8780"))
    serve(host, port, Bridge(path, local, origin)).serve_forever()


if __name__ == "__main__":
    main()
