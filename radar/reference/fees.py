"""Conservative Kalshi fee helpers for radar display (not trading)."""
from __future__ import annotations
from decimal import Decimal, ROUND_UP

def taker_raw(C: Decimal | int | str, P: Decimal | str, M: Decimal | str = "1") -> Decimal:
    C, P, M = Decimal(str(C)), Decimal(str(P)), Decimal(str(M))
    return M * Decimal("0.07") * C * P * (Decimal("1") - P)

def ceil_cent(x: Decimal) -> Decimal:
    q = Decimal("0.01")
    return (Decimal(x) / q).to_integral_value(rounding=ROUND_UP) * q

def round_trip_conservative(entry: str | Decimal, exitp: str | Decimal, qty: int | Decimal) -> dict:
    entry, exitp, qty = Decimal(str(entry)), Decimal(str(exitp)), Decimal(str(qty))
    gross = (exitp - entry) * qty
    fee_in = ceil_cent(taker_raw(qty, entry))
    fee_out = ceil_cent(taker_raw(qty, exitp))
    net = gross - fee_in - fee_out
    premium = entry * qty
    return {
        "qty": str(qty),
        "entry": str(entry),
        "exit": str(exitp),
        "gross": str(gross),
        "fee_in": str(fee_in),
        "fee_out": str(fee_out),
        "net": str(net),
        "premium": str(premium),
        "worst_case_binary_loss": str(premium),  # full premium if settles against
        "assumption": "taker-equivalent both legs, ceil $0.01/order; maker not assumed free",
    }

def suggested_qty(entry: Decimal | str, best_bid_qty: Decimal | str, max_contracts: int = 10, max_premium: Decimal = Decimal("5"), depth_frac: Decimal = Decimal("0.25")) -> int:
    entry = Decimal(str(entry))
    best_bid_qty = Decimal(str(best_bid_qty))
    if entry <= 0:
        return 0
    by_prem = int(max_premium / entry)
    by_depth = int(best_bid_qty * depth_frac)
    return max(0, min(max_contracts, by_prem, by_depth))
