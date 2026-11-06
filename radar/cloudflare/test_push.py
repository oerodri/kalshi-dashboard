import os
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from push_snapshot import INTERVAL_SEC, USER_AGENT, assert_bridge, assert_local_source, build_request, local_request


class PushTest(unittest.TestCase):
    def test_only_local_snapshot_and_https_bridge(self):
        self.assertEqual(assert_local_source("http://127.0.0.1:8771/api/snapshot"), "http://127.0.0.1:8771/api/snapshot")
        with self.assertRaises(SystemExit):
            assert_local_source("https://external-api.kalshi.com/trade-api/v2/markets")
        with self.assertRaises(SystemExit):
            assert_bridge("https://api.elections.kalshi.com/ingest")
        self.assertTrue(assert_bridge("https://bridge.example/ingest").endswith("/ingest"))
        req = build_request("https://bridge.example/ingest", "local-token", b"{}")
        local = local_request("http://127.0.0.1:8771/api/snapshot")
        self.assertNotIn("local-token", req.full_url)
        self.assertNotIn("local-token", local.full_url)
        self.assertEqual(req.get_header("Authorization"), "Bearer local-token")
        self.assertIsNone(local.get_header("Authorization"))
        self.assertEqual(req.get_header("User-agent"), USER_AGENT)
        self.assertEqual(local.get_header("User-agent"), USER_AGENT)
        self.assertEqual(USER_AGENT, "WTI-Radar-Publisher/1.0")
        self.assertNotIn("Mozilla", USER_AGENT)
        self.assertEqual(INTERVAL_SEC, 1.5)
        self.assertNotIn("KALSHI", os.environ.get("RADAR_BRIDGE_URL", ""))


if __name__ == "__main__":
    unittest.main()
