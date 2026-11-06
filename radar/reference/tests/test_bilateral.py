import unittest, sys
from pathlib import Path
from datetime import datetime, timezone, timedelta
from decimal import Decimal
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bilateral import BilateralEngine

class TestBilateral(unittest.TestCase):
    def _pts(self, start, asks_bids):
        out=[]
        for i,(a,b) in enumerate(asks_bids):
            ts=start+timedelta(seconds=i*1.5)
            out.append({'receipt_utc':ts.isoformat().replace('+00:00','Z'),'bid':float(b),'ask':float(a),'bid_qty':50,'ask_qty':50})
        return out

    def test_no_invented_validation_without_file_ok(self):
        eng=BilateralEngine(validation={"status":"Sin muestra suficiente","per_candidate":{}})
        now=datetime(2026,11,6,12,0,tzinfo=timezone.utc)
        # 20% drop: 0.50 -> 0.40
        pairs=[(0.50,0.48)]*20 + [(0.40,0.38)]*15
        start=now-timedelta(seconds=1.5*(len(pairs)-1))
        pts=self._pts(start, pairs)
        sigs=eng.evaluate('T', pts, (now+timedelta(hours=2)).isoformat().replace('+00:00','Z'), now=now, data_ok=True)
        armed=[s for s in sigs if s.state.startswith('Candidato') or s.state=='Preparando']
        self.assertTrue(armed, msg=str([(s.state,s.reason) for s in sigs]))
        for s in armed:
            self.assertEqual(s.validation['hit_rate_display'], 'Sin muestra suficiente')
            self.assertIn(s.side, ('YES','NO'))

    def test_relative_not_absolute_cents(self):
        # 3¢ drop on 0.50 = 6% — should NOT arm 20% rebound YES
        eng=BilateralEngine(validation={"status":"Sin muestra suficiente","per_candidate":{}})
        now=datetime(2026,11,6,12,0,tzinfo=timezone.utc)
        pairs=[(0.50,0.48)]*25 + [(0.47,0.45)]*10
        start=now-timedelta(seconds=1.5*(len(pairs)-1))
        pts=self._pts(start, pairs)
        sigs=eng.evaluate('T', pts, (now+timedelta(hours=2)).isoformat().replace('+00:00','Z'), now=now, data_ok=True)
        yes_rb=[s for s in sigs if s.candidate_id and s.candidate_id.startswith('RB_YES') and (s.state.startswith('Candidato') or s.state=='Preparando')]
        self.assertEqual(yes_rb, [])

    def test_target_arithmetic_not_peak_restore(self):
        eng=BilateralEngine(validation={"status":"Sin muestra suficiente","per_candidate":{}})
        now=datetime(2026,11,6,12,5,tzinfo=timezone.utc)
        # peak 0.50, trough 0.40 (=20%); target should be 0.40*1.2=0.48 not 0.50
        pairs=[(0.50,0.48)]*30 + [(0.40,0.38)]*40
        start=now-timedelta(seconds=1.5*(len(pairs)-1))
        pts=self._pts(start, pairs)
        sigs=eng.evaluate('T', pts, (now+timedelta(hours=2)).isoformat().replace('+00:00','Z'), now=now, data_ok=True)
        hit=[s for s in sigs if s.candidate_id=='RB_YES_20_20_L60' and s.details]
        self.assertTrue(hit)
        tgt=Decimal(hit[0].details['target_price_rebound'])
        self.assertEqual(tgt, Decimal('0.40')*Decimal('1.20'))

    def test_status_tokens_sanitized(self):
        from bilateral import BilateralEngine, _display_status, _safe_metric_display
        self.assertEqual(_display_status('algunos_estimables'), 'Exploratorio · no validado')
        self.assertEqual(_display_status('estimable_con_reserva'), 'Muestra limitada · probabilidad no validada')
        self.assertEqual(_display_status('Sin muestra suficiente'), 'Sin muestra suficiente')
        self.assertEqual(
            _safe_metric_display('estimable_con_reserva', '2/24 = 8.3% (IC95 2.3%–25.8%)'),
            'Muestra limitada · probabilidad no validada',
        )
        eng=BilateralEngine(validation={
            "status":"algunos_estimables",
            "per_candidate":{
                "RB_YES_20_20_L60":{
                    "status":"estimable_con_reserva",
                    "hit_rate_display":"2/24 = 8.3% (IC95 2.3%–25.8%)",
                    "net_expectancy_display":"mean net $-0.69/evento",
                    "tier":"B_1m_history_proxy",
                }
            },
            "global_caveat":"test",
        })
        g=eng._global_val()
        self.assertEqual(g['status'], 'Exploratorio · no validado')
        self.assertNotIn('algunos_estimables', g['status'])
        v=eng._val_for('RB_YES_20_20_L60')
        self.assertEqual(v['status'], 'Muestra limitada · probabilidad no validada')
        self.assertEqual(v['hit_rate_display'], 'Muestra limitada · probabilidad no validada')
        self.assertEqual(v['net_expectancy_display'], 'Muestra limitada · probabilidad no validada')
        self.assertEqual(v['status_research'], 'estimable_con_reserva')

if __name__=='__main__':
    unittest.main()
