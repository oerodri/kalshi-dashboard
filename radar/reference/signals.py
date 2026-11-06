"""Signal state machine from strategy_draft.md — ideas only, not validated edge."""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Any

LOOKBACK_SEC = 30
CONFIRM_SEC = 10
ASK_DROP_CENTS = Decimal("0.03")
CONFIRM_MAX_BID_SLIP = Decimal("0.01")
MIN_DEPTH = 25
MIN_SPREAD = Decimal("0.01")
MAX_SPREAD = Decimal("0.02")
TARGET_CENTS = Decimal("0.05")
STOP_CENTS = Decimal("0.03")
MAX_HOLD_SEC = 120
COOLDOWN_SEC = 120
NO_ENTRY_MIN_TO_CLOSE = 30
MID_LO = Decimal("0.25")
MID_HI = Decimal("0.75")

@dataclass
class SignalState:
    state: str
    reason: str
    ticker: str | None = None
    details: dict | None = None

class SignalEngine:
    def __init__(self):
        self.cooldown_until: dict[str, datetime] = {}
        self.last_alert_id: str | None = None
        self.pending: dict[str, dict] = {}  # ticker -> setup start

    def evaluate(self, ticker: str, points: list[dict], close_time_utc: str | None, now: datetime | None = None, data_ok: bool = True) -> SignalState:
        now = now or datetime.now(timezone.utc)
        if not data_ok:
            return SignalState("Bloqueada", "datos atrasados o grabador caído", ticker)
        if not points:
            return SignalState("Esperar", "sin libros todavía", ticker)
        last = points[-1]
        bid, ask = last.get("bid"), last.get("ask")
        if bid is None or ask is None:
            return SignalState("Bloqueada", "libro incompleto (falta bid o ask)", ticker)
        bid_d, ask_d = Decimal(str(bid)), Decimal(str(ask))
        if ask_d < bid_d:
            return SignalState("Bloqueada", "libro cruzado", ticker)
        spread = ask_d - bid_d
        mid = (bid_d + ask_d) / 2
        bq = Decimal(str(last.get("bid_qty") or 0))
        aq = Decimal(str(last.get("ask_qty") or 0))

        if close_time_utc:
            try:
                close = datetime.fromisoformat(close_time_utc.replace("Z", "+00:00"))
                if close - now <= timedelta(minutes=NO_ENTRY_MIN_TO_CLOSE):
                    return SignalState("Bloqueada", f"faltan ≤{NO_ENTRY_MIN_TO_CLOSE} min al cierre", ticker)
            except Exception:
                pass

        if mid < MID_LO or mid > MID_HI:
            return SignalState("Bloqueada", "mid fuera de 25–75¢", ticker)
        if spread < MIN_SPREAD or spread > MAX_SPREAD:
            return SignalState("Bloqueada", f"spread {spread*100:.1f}¢ fuera de 1–2¢", ticker)
        if bq < MIN_DEPTH or aq < MIN_DEPTH:
            return SignalState("Bloqueada", f"profundidad insuficiente (bid {bq}, ask {aq}; min {MIN_DEPTH})", ticker)

        cd = self.cooldown_until.get(ticker)
        if cd and now < cd:
            return SignalState("Bloqueada", f"cooldown {int((cd-now).total_seconds())}s", ticker)

        # Build time series of ask/bid
        series = []
        for p in points:
            try:
                ts = datetime.fromisoformat(p["receipt_utc"].replace("Z", "+00:00"))
            except Exception:
                continue
            if p.get("bid") is None or p.get("ask") is None:
                continue
            series.append((ts, Decimal(str(p["ask"])), Decimal(str(p["bid"]))))
        if len(series) < 3:
            return SignalState("Esperar", "pocos puntos de libro", ticker)

        # Find ask drop >= 3¢ within last LOOKBACK_SEC (temporal, same book)
        window_start = now - timedelta(seconds=LOOKBACK_SEC)
        recent = [x for x in series if x[0] >= window_start]
        if len(recent) < 2:
            return SignalState("Esperar", "ventana 30s incompleta", ticker)

        # high ask then later lower ask: drop = max_ask_before - min_ask_after style sequential
        drop_event = None
        max_ask = recent[0][1]
        max_ask_time = recent[0][0]
        for ts, ask_i, bid_i in recent[1:]:
            if ask_i > max_ask:
                max_ask = ask_i
                max_ask_time = ts
            drop = max_ask - ask_i
            if drop >= ASK_DROP_CENTS:
                drop_event = {
                    "peak_ask": max_ask,
                    "peak_ts": max_ask_time,
                    "trough_ask": ask_i,
                    "trough_ts": ts,
                    "drop": drop,
                    "bid_at_trough": bid_i,
                }
                # keep last such event in window
        if not drop_event:
            return SignalState("Esperar", "sin caída de ask ≥3¢ en 30s", ticker)

        # Confirmation window: CONFIRM_SEC after trough — must not use future beyond now
        trough_ts = drop_event["trough_ts"]
        confirm_end = trough_ts + timedelta(seconds=CONFIRM_SEC)
        if now < confirm_end:
            # still confirming — check so far
            conf = [x for x in series if trough_ts <= x[0] <= now]
            bid0 = drop_event["bid_at_trough"]
            for ts, ask_i, bid_i in conf:
                if bid0 - bid_i > CONFIRM_MAX_BID_SLIP:
                    self.pending.pop(ticker, None)
                    return SignalState("Esperar", "confirmación fallida: bid resbaló >1¢", ticker)
                # additional ask drop during confirm invalidates? draft: confirm bid stable; if ask drops more during confirm we still allow if bid holds — draft says "Confirmación... Best bid does not fall more than 1¢". Reset if new larger adverse.
            self.pending[ticker] = drop_event
            return SignalState(
                "Preparando",
                f"caída ask {drop_event['drop']*100:.0f}¢ — confirmando bid ({int((confirm_end-now).total_seconds())}s)",
                ticker,
                {"drop_event": _ser(drop_event), "entry_idea": str(bid_d), "target": str(bid_d + TARGET_CENTS), "stop": str(bid_d - STOP_CENTS)},
            )

        # After confirm window: verify all points in [trough, trough+confirm]
        conf = [x for x in series if trough_ts <= x[0] <= confirm_end]
        if not conf:
            return SignalState("Esperar", "sin puntos en ventana de confirmación", ticker)
        bid0 = drop_event["bid_at_trough"]
        for ts, ask_i, bid_i in conf:
            if bid0 - bid_i > CONFIRM_MAX_BID_SLIP:
                return SignalState("Esperar", "confirmación inválida (bid no estable)", ticker)

        # Condition met — idea only
        alert_id = f"{ticker}:{trough_ts.isoformat()}:{drop_event['peak_ask']}"
        details = {
            "alert_id": alert_id,
            "entry_idea_post_only_bid": str(bid_d),
            "target_post_only_offer": str(bid_d + TARGET_CENTS),
            "stop_ioc_bid": str(bid_d - STOP_CENTS),
            "max_hold_sec": MAX_HOLD_SEC,
            "drop_cents": float(drop_event["drop"] * 100),
            "note": "Condición de borrador cumplida ≠ edge validado ≠ fill garantizado",
        }
        self.cooldown_until[ticker] = now + timedelta(seconds=COOLDOWN_SEC)
        self.last_alert_id = alert_id
        return SignalState("Condición cumplida (sin validar)", "caída ask confirmada + filtros OK — solo idea", ticker, details)


def _ser(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        elif isinstance(v, Decimal):
            out[k] = str(v)
        else:
            out[k] = v
    return out
