// Reglas copiadas de CANDIDATES.json. No retocar umbrales para forzar señales.
export const CANDIDATES = {
  "pre_registered_utc": "2026-11-06T07:19:00Z",
  "pre_registered_et": "2026-11-06T02:19:00-05:00",
  "units": "RELATIVE percent of Kalshi YES/NO contract price (dollars 0-1), NOT cents absolute, NOT $/bbl oil",
  "note": "Same % rebound does NOT restore prior peak. High vol does not imply mean reversion. Momentum is a separate family.",
  "gates_common": {
    "mid_lo": 0.15,
    "mid_hi": 0.85,
    "max_spread": 0.03,
    "min_depth": 10,
    "min_side_price": 0.1,
    "confirm_sec": 10,
    "cooldown_sec": 120,
    "max_hold_sec": 180,
    "no_entry_min_to_close": 30,
    "gap_break_sec": 4.0,
    "max_contracts": 10,
    "max_premium_usd": 5
  },
  "candidates": [
    {
      "id": "RB_YES_20_20_L60",
      "family": "rebound",
      "side": "YES",
      "drop_pct": 0.2,
      "target_pct": 0.2,
      "lookback_sec": 60,
      "horizon_sec": 180,
      "stop_pct": 0.15
    },
    {
      "id": "RB_YES_30_30_L60",
      "family": "rebound",
      "side": "YES",
      "drop_pct": 0.3,
      "target_pct": 0.3,
      "lookback_sec": 60,
      "horizon_sec": 180,
      "stop_pct": 0.2
    },
    {
      "id": "RB_NO_20_20_L60",
      "family": "rebound",
      "side": "NO",
      "drop_pct": 0.2,
      "target_pct": 0.2,
      "lookback_sec": 60,
      "horizon_sec": 180,
      "stop_pct": 0.15
    },
    {
      "id": "RB_NO_30_30_L60",
      "family": "rebound",
      "side": "NO",
      "drop_pct": 0.3,
      "target_pct": 0.3,
      "lookback_sec": 60,
      "horizon_sec": 180,
      "stop_pct": 0.2
    },
    {
      "id": "CT_YES_20_L60",
      "family": "continuation",
      "side": "YES",
      "move_pct": 0.2,
      "target_pct": 0.2,
      "lookback_sec": 60,
      "horizon_sec": 180,
      "stop_pct": 0.15
    },
    {
      "id": "CT_NO_20_L60",
      "family": "continuation",
      "side": "NO",
      "move_pct": 0.2,
      "target_pct": 0.2,
      "lookback_sec": 60,
      "horizon_sec": 180,
      "stop_pct": 0.15
    },
    {
      "id": "RB_YES_20_20_L120",
      "family": "rebound",
      "side": "YES",
      "drop_pct": 0.2,
      "target_pct": 0.2,
      "lookback_sec": 120,
      "horizon_sec": 300,
      "stop_pct": 0.15
    },
    {
      "id": "RB_YES_30_30_L120",
      "family": "rebound",
      "side": "YES",
      "drop_pct": 0.3,
      "target_pct": 0.3,
      "lookback_sec": 120,
      "horizon_sec": 300,
      "stop_pct": 0.2
    }
  ],
  "legacy_kept_separate": {
    "id": "LEGACY_YES_DIP_3c_30s",
    "note": "Absolute 3¢ YES-ask drop in 30s — not retuned; labeled legacy"
  },
  "eval_tiers": {
    "A_subminute_books": "frozen_v2 recorder books ≤ cutoff; snapshot replay; queue not fully observable",
    "B_1m_history": "existing 1m OHLC; exploratory proxy ONLY; adverse-ordering bounds; NOT exact 30s backtest"
  }
}
