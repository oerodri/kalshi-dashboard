"""Bilateral relative-% observation detector (YES/NO). Separate from legacy SignalEngine.

Uses RELATIVE % of contract ask price (0–1 dollars), NOT absolute cents, NOT $/bbl oil.
Displays sample/validation status honestly — never invents hit rates.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
CAND_PATH = ROOT / "CANDIDATES.json"
EVAL_SUMMARY = ROOT / "backtest" / "relative_eval" / "out" / "summary.json"

def _load_cands() -> dict:
    return json.loads(CAND_PATH.read_text())

def _load_eval_status() -> dict:
    if not EVAL_SUMMARY.exists():
        return {"status": "Sin muestra suficiente", "per_candidate": {}}
    try:
        return json.loads(EVAL_SUMMARY.read_text())
    except Exception:
        return {"status": "Sin muestra suficiente", "per_candidate": {}}

# UI/API-facing labels only. Research JSON keeps raw tokens (algunos_estimables, etc.).
_STATUS_DISPLAY = {
    "algunos_estimables": "Exploratorio · no validado",
    "estimable_con_reserva": "Muestra limitada · probabilidad no validada",
    "Sin muestra suficiente": "Sin muestra suficiente",
    "Sin muestra suficiente (OOS)": "Sin muestra suficiente",
}


def _display_status(raw: str | None) -> str:
    if not raw:
        return "Sin muestra suficiente"
    return _STATUS_DISPLAY.get(raw, "Exploratorio · no validado" if "estimable" in raw or "algunos" in raw else raw)


def _safe_metric_display(status_raw: str | None, metric: str | None) -> str:
    """Never present Wilson/net figures as calibrated probabilities in the live UI."""
    st = status_raw or ""
    if st in ("estimable_con_reserva", "algunos_estimables") or "estimable" in st or "algunos" in st:
        return "Muestra limitada · probabilidad no validada"
    if not metric or metric == "Sin muestra suficiente":
        return "Sin muestra suficiente"
    # pass through only already-safe Spanish placeholders
    if "Sin muestra" in metric or "no validada" in metric or "Exploratorio" in metric or "Muestra limitada" in metric:
        return metric
    return "Muestra limitada · probabilidad no validada"



@dataclass
class BiSignal:
    state: str
    reason: str
    ticker: str | None = None
    candidate_id: str | None = None
    family: str | None = None  # rebound | continuation | legacy
    side: str | None = None  # YES | NO
    details: dict | None = None
    validation: dict | None = None


class BilateralEngine:
    """Observation-only: relative drop/rise on YES or NO ask; rebound vs continuation labeled."""

    def __init__(self, validation: dict | None = None):
        self.cfg = _load_cands()
        self.gates = self.cfg["gates_common"]
        self.candidates = self.cfg["candidates"]
        self.cooldown_until: dict[str, datetime] = {}
        self.validation = validation if validation is not None else _load_eval_status()

    def refresh_validation(self):
        self.validation = _load_eval_status()

    def _global_val(self) -> dict:
        raw = self.validation.get("status") or "Sin muestra suficiente"
        return {
            "status": _display_status(raw),
            "status_research": raw,  # raw research token; not for user confidence
            "hit_rate_display": "Sin muestra suficiente",
            "net_expectancy_display": "Sin muestra suficiente",
            "caveat": self.validation.get("global_caveat"),
            "tier": None,
            "label_note": "Exploratorio · no validado",
        }

    def _val_for(self, cid: str) -> dict:
        pc = (self.validation.get("per_candidate") or {}).get(cid) or {}
        status_raw = pc.get("status") or self.validation.get("status") or "Sin muestra suficiente"
        return {
            "status": _display_status(status_raw),
            "status_research": status_raw,
            "n_events_train": pc.get("n_events_train"),
            "n_events_oos": pc.get("n_events_oos"),
            "n_sessions_oos": pc.get("n_sessions_oos"),
            "hit_rate_display": _safe_metric_display(status_raw, pc.get("hit_rate_display")),
            "net_expectancy_display": _safe_metric_display(status_raw, pc.get("net_expectancy_display")),
            "tier": pc.get("tier"),
            "caveat": pc.get("caveat") or self.validation.get("global_caveat"),
            "label_note": "Exploratorio · no validado",
        }

    def evaluate(
        self,
        ticker: str,
        points: list[dict],
        close_time_utc: str | None,
        now: datetime | None = None,
        data_ok: bool = True,
    ) -> list[BiSignal]:
        """Return list of candidate observations (may be empty / blocked)."""
        now = now or datetime.now(timezone.utc)
        out: list[BiSignal] = []
        if not data_ok:
            return [BiSignal("Bloqueada", "datos atrasados o grabador caído", ticker, validation=self._global_val())]
        if not points:
            return [BiSignal("Esperar", "sin libros todavía", ticker, validation=self._global_val())]

        last = points[-1]
        bid, ask = last.get("bid"), last.get("ask")
        if bid is None or ask is None:
            return [BiSignal("Bloqueada", "libro incompleto", ticker)]
        bid_d, ask_d = Decimal(str(bid)), Decimal(str(ask))
        if ask_d < bid_d:
            return [BiSignal("Bloqueada", "libro cruzado", ticker)]
        spread = ask_d - bid_d
        mid = (bid_d + ask_d) / 2
        bq = Decimal(str(last.get("bid_qty") or 0))
        aq = Decimal(str(last.get("ask_qty") or 0))
        # NO prices: NO ask ≈ 1 - YES bid; NO bid ≈ 1 - YES ask
        no_ask = Decimal("1") - bid_d
        no_bid = Decimal("1") - ask_d

        if close_time_utc:
            try:
                close = datetime.fromisoformat(close_time_utc.replace("Z", "+00:00"))
                if close - now <= timedelta(minutes=int(self.gates["no_entry_min_to_close"])):
                    return [BiSignal("Bloqueada", f"≤{self.gates['no_entry_min_to_close']} min al cierre", ticker)]
            except Exception:
                pass

        mid_lo = Decimal(str(self.gates["mid_lo"]))
        mid_hi = Decimal(str(self.gates["mid_hi"]))
        if mid < mid_lo or mid > mid_hi:
            return [BiSignal("Bloqueada", f"mid fuera de {float(mid_lo)*100:.0f}–{float(mid_hi)*100:.0f}¢", ticker)]
        max_sp = Decimal(str(self.gates["max_spread"]))
        if spread > max_sp:
            return [BiSignal("Bloqueada", f"spread {spread*100:.1f}¢ > {float(max_sp)*100:.0f}¢", ticker)]
        min_depth = Decimal(str(self.gates["min_depth"]))
        if bq < min_depth or aq < min_depth:
            return [BiSignal("Bloqueada", f"profundidad < {min_depth}", ticker)]

        cd = self.cooldown_until.get(ticker)
        if cd and now < cd:
            return [BiSignal("Bloqueada", f"cooldown {int((cd-now).total_seconds())}s", ticker)]

        series = []
        gap_break = float(self.gates["gap_break_sec"])
        prev_ts = None
        for p in points:
            try:
                ts = datetime.fromisoformat(p["receipt_utc"].replace("Z", "+00:00"))
            except Exception:
                continue
            if p.get("bid") is None or p.get("ask") is None:
                continue
            y_ask = Decimal(str(p["ask"]))
            y_bid = Decimal(str(p["bid"]))
            bridged = False
            if prev_ts is not None and (ts - prev_ts).total_seconds() > gap_break:
                bridged = True
            series.append({
                "ts": ts,
                "yes_ask": y_ask,
                "yes_bid": y_bid,
                "no_ask": Decimal("1") - y_bid,
                "no_bid": Decimal("1") - y_ask,
                "bridged": bridged,
            })
            prev_ts = ts
        if len(series) < 3:
            return [BiSignal("Esperar", "pocos puntos", ticker)]

        min_px = Decimal(str(self.gates["min_side_price"]))
        confirm_sec = int(self.gates["confirm_sec"])

        for cand in self.candidates:
            sig = self._eval_one(ticker, series, cand, now, min_px, confirm_sec, bid_d, ask_d, no_bid, no_ask, bq, aq)
            if sig:
                out.append(sig)

        if not out:
            out.append(BiSignal("Esperar", "sin movimiento relativo 20/30% en lookbacks registrados", ticker, validation=self._global_val()))
        return out

    def _eval_one(
        self,
        ticker: str,
        series: list[dict],
        cand: dict,
        now: datetime,
        min_px: Decimal,
        confirm_sec: int,
        yes_bid: Decimal,
        yes_ask: Decimal,
        no_bid: Decimal,
        no_ask: Decimal,
        bq: Decimal,
        aq: Decimal,
    ) -> BiSignal | None:
        cid = cand["id"]
        family = cand["family"]
        side = cand["side"]
        lb = int(cand["lookback_sec"])
        window_start = now - timedelta(seconds=lb)
        recent = [x for x in series if x["ts"] >= window_start]
        if len(recent) < 2:
            return None
        # Never bridge gaps inside lookback for trigger
        if any(x["bridged"] for x in recent[1:]):
            # split at last gap — use contiguous suffix only
            for i in range(len(recent) - 1, 0, -1):
                if recent[i]["bridged"]:
                    recent = recent[i:]
                    break
            if len(recent) < 2:
                return None

        ask_key = "yes_ask" if side == "YES" else "no_ask"
        bid_key = "yes_bid" if side == "YES" else "no_bid"
        val = self._val_for(cid)

        if family == "rebound":
            drop_pct = Decimal(str(cand["drop_pct"]))
            target_pct = Decimal(str(cand["target_pct"]))
            stop_pct = Decimal(str(cand["stop_pct"]))
            # peak then later trough: relative drop
            peak = recent[0][ask_key]
            peak_ts = recent[0]["ts"]
            event = None
            for x in recent[1:]:
                a = x[ask_key]
                if a > peak:
                    peak, peak_ts = a, x["ts"]
                    continue
                if peak <= 0:
                    continue
                rel = (peak - a) / peak
                if rel >= drop_pct and a >= min_px:
                    event = {"peak": peak, "peak_ts": peak_ts, "trough": a, "trough_ts": x["ts"], "rel": rel}
            if not event:
                return None
            trough_ts = event["trough_ts"]
            confirm_end = trough_ts + timedelta(seconds=confirm_sec)
            entry_ask = yes_ask if side == "YES" else no_ask
            entry_bid = yes_bid if side == "YES" else no_bid
            # Price rebound target: trough * (1 + target_pct) — NOT restoring peak; NOT net ROI
            target_px = event["trough"] * (Decimal("1") + target_pct)
            stop_px = event["trough"] * (Decimal("1") - stop_pct)
            details = {
                "candidate_id": cid,
                "family": family,
                "side_to_buy": side,
                "peak_ask": str(event["peak"]),
                "trough_ask": str(event["trough"]),
                "rel_drop": float(event["rel"]),
                "entry_idea_ask_taker": str(entry_ask),
                "target_price_rebound": str(target_px),
                "stop_price": str(stop_px),
                "note_arithmetic": "target = trough*(1+pct); same % does NOT recover peak; not net ROI after fees",
                "max_hold_sec": cand["horizon_sec"],
                "depth_bid": str(bq if side == "YES" else aq),
            }
            if now < confirm_end:
                return BiSignal(
                    "Preparando",
                    f"{cid}: caída rel {float(event['rel'])*100:.0f}% {side}-ask — confirmando",
                    ticker, cid, family, side, details, val,
                )
            # armed
            return BiSignal(
                "Candidato observado (sin validar)",
                f"{cid}: rebote {side} tras caída rel ≥{float(drop_pct)*100:.0f}%",
                ticker, cid, family, side, details, val,
            )

        if family == "continuation":
            move_pct = Decimal(str(cand["move_pct"]))
            target_pct = Decimal(str(cand["target_pct"]))
            stop_pct = Decimal(str(cand["stop_pct"]))
            trough = recent[0][ask_key]
            trough_ts = recent[0]["ts"]
            event = None
            for x in recent[1:]:
                a = x[ask_key]
                if a < trough:
                    trough, trough_ts = a, x["ts"]
                    continue
                if trough <= 0:
                    continue
                rel = (a - trough) / trough
                if rel >= move_pct and a >= min_px:
                    event = {"trough": trough, "trough_ts": trough_ts, "peak": a, "peak_ts": x["ts"], "rel": rel}
            if not event:
                return None
            entry_ask = yes_ask if side == "YES" else no_ask
            target_px = event["peak"] * (Decimal("1") + target_pct)
            stop_px = event["peak"] * (Decimal("1") - stop_pct)
            details = {
                "candidate_id": cid,
                "family": family,
                "side_to_buy": side,
                "base_ask": str(event["trough"]),
                "move_ask": str(event["peak"]),
                "rel_up": float(event["rel"]),
                "entry_idea_ask_taker": str(entry_ask),
                "target_price_continue": str(target_px),
                "stop_price": str(stop_px),
                "note_arithmetic": "continuation ≠ mean reversion; target from post-move ask",
                "max_hold_sec": cand["horizon_sec"],
            }
            return BiSignal(
                "Candidato observado (sin validar)",
                f"{cid}: continuación {side} tras alza rel ≥{float(move_pct)*100:.0f}%",
                ticker, cid, family, side, details, val,
            )
        return None
