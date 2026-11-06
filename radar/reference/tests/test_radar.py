import unittest, sys
from pathlib import Path
from datetime import datetime, timezone, timedelta
from decimal import Decimal
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fees import round_trip_conservative, suggested_qty
from signals import SignalEngine

class TestFees(unittest.TestCase):
    def test_win_50_plus5(self):
        r=round_trip_conservative('0.50','0.55',10)
        self.assertEqual(r['net'], '0.14')
    def test_stop_50_minus3(self):
        r=round_trip_conservative('0.50','0.47',10)
        self.assertEqual(r['net'], '-0.66')
    def test_qty_bounds(self):
        self.assertEqual(suggested_qty('0.50', '100'), 10)
        self.assertEqual(suggested_qty('0.50', '20'), 5)  # 25% of 20
        self.assertEqual(suggested_qty('0.80', '100'), 6)  # 5/0.8=6

class TestSignals(unittest.TestCase):
    def _pts(self, start, asks_bids):
        out=[]
        for i,(a,b) in enumerate(asks_bids):
            ts=start+timedelta(seconds=i)
            out.append({'receipt_utc':ts.isoformat().replace('+00:00','Z'),'bid':float(b),'ask':float(a),'bid_qty':50,'ask_qty':50})
        return out
    def test_stale_blocks(self):
        eng=SignalEngine()
        now=datetime(2026,11,6,12,0,tzinfo=timezone.utc)
        pts=self._pts(now-timedelta(seconds=20), [(0.52,0.50)]*5)
        s=eng.evaluate('T', pts, None, now=now, data_ok=False)
        self.assertEqual(s.state,'Bloqueada')
    def test_crossed_book(self):
        eng=SignalEngine()
        now=datetime(2026,11,6,12,0,tzinfo=timezone.utc)
        pts=[{'receipt_utc':now.isoformat().replace('+00:00','Z'),'bid':0.55,'ask':0.50,'bid_qty':50,'ask_qty':50}]
        s=eng.evaluate('T', pts, None, now=now, data_ok=True)
        self.assertEqual(s.state,'Bloqueada')
        self.assertIn('cruzado', s.reason)
    def test_drop_then_confirming(self):
        eng=SignalEngine()
        now=datetime(2026,11,6,12,0,0,tzinfo=timezone.utc)
        # 0..10s ask 0.55, then drop to 0.52 at t=11 (=3c), now at t=15 => preparing
        pairs=[(0.55,0.50)]*12 + [(0.52,0.50)]*4
        start=now-timedelta(seconds=len(pairs)-1)
        pts=self._pts(start, pairs)
        s=eng.evaluate('T', pts, (now+timedelta(hours=2)).isoformat().replace('+00:00','Z'), now=now, data_ok=True)
        self.assertEqual(s.state,'Preparando')
    def test_confirm_fail_bid_slip(self):
        eng=SignalEngine()
        now=datetime(2026,11,6,12,0,0,tzinfo=timezone.utc)
        # drop then bid slips 2c during confirm
        pairs=[(0.55,0.50)]*10 + [(0.52,0.50),(0.52,0.48),(0.52,0.48),(0.52,0.48)]
        start=now-timedelta(seconds=len(pairs)-1)
        pts=self._pts(start, pairs)
        s=eng.evaluate('T', pts, (now+timedelta(hours=2)).isoformat().replace('+00:00','Z'), now=now, data_ok=True)
        self.assertIn(s.state,('Esperar','Preparando','Bloqueada'))

if __name__=='__main__':
    unittest.main()
