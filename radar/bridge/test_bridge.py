import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve_snapshot import Bridge, allowed_local_snapshot_url, serve

SAMPLE = {
    "markets": [{
        "ticker": "KXWTI-26NOV0614-T90.49",
        "event_ticker": "KXWTI-26NOV0614",
        "strike": 90.49,
        "close_time": "2026-11-06T19:30:00Z",
        "yes_bid": "0.5100",
        "yes_ask": "0.5300",
        "bid_qty": "100",
        "ask_qty": "20",
        "receipt_utc": "2026-11-06T15:00:01.250Z",
    }]
}


class BridgeTest(unittest.TestCase):
    def test_rejects_remote_upstream(self):
        with self.assertRaises(ValueError):
            allowed_local_snapshot_url("https://external-api.kalshi.com/trade-api/v2/markets")
        with self.assertRaises(ValueError):
            allowed_local_snapshot_url("http://127.0.0.1:8771/")
        self.assertEqual(
            allowed_local_snapshot_url("http://127.0.0.1:8771/api/snapshot"),
            "http://127.0.0.1:8771/api/snapshot",
        )

    def test_serves_receipt_unchanged_and_blocks_writes(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "snapshot.json"
            raw = json.dumps(SAMPLE).encode()
            path.write_bytes(raw)
            bridge = Bridge(path, None, "https://oerodri.github.io")
            httpd = serve("127.0.0.1", 0, bridge)
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            port = httpd.server_address[1]
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/snapshot", timeout=2) as res:
                    body = res.read()
                    self.assertEqual(res.status, 200)
                    self.assertEqual(res.headers["Access-Control-Allow-Origin"], "https://oerodri.github.io")
                    self.assertEqual(res.headers["Cache-Control"], "no-store")
                got = json.loads(body)
                self.assertEqual(got["markets"][0]["receipt_utc"], "2026-11-06T15:00:01.250Z")
                self.assertEqual(got["markets"][0]["yes_bid"], "0.5100")
                self.assertEqual(path.read_bytes(), raw)
                req = urllib.request.Request(f"http://127.0.0.1:{port}/snapshot", data=b"{}", method="POST")
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(req, timeout=2)
                self.assertEqual(caught.exception.code, 405)
            finally:
                httpd.shutdown()

    def test_missing_or_timeless_snapshot_fail_closed(self):
        bridge = Bridge(Path("/tmp/radar-snapshot-que-no-existe.json"), None, "https://oerodri.github.io")
        code, body, _ = bridge.response("GET", "/snapshot")
        self.assertEqual(code, 503)
        self.assertIn(b"DATOS ATRASADOS", body)
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text(json.dumps({"markets": [{"ticker": "KXWTI-X", "yes_bid": "0.5", "yes_ask": "0.52"}]}))
            code, body, _ = Bridge(path, None, "https://oerodri.github.io").response("GET", "/snapshot")
            self.assertEqual(code, 422)
            self.assertNotIn(b"receipt_utc", body)


if __name__ == "__main__":
    unittest.main()
