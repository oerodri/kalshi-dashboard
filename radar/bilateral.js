import { CANDIDATES } from './candidates.js';
import { dollarsToTicks, formatTicks4 } from './money.js';

export const PUBLIC_VALIDATION = {
  status: 'Exploratorio · no validado',
  hit_rate_display: 'Sin muestra suficiente',
  net_expectancy_display: 'Sin muestra suficiente',
  label_note: 'Exploratorio · no validado',
};

const STATUS_DISPLAY = {
  algunos_estimables: 'Exploratorio · no validado',
  estimable_con_reserva: 'Muestra limitada · probabilidad no validada',
  'Sin muestra suficiente': 'Sin muestra suficiente',
  'Sin muestra suficiente (OOS)': 'Sin muestra suficiente',
};

export function displayStatus(raw) {
  if (!raw) return 'Sin muestra suficiente';
  if (STATUS_DISPLAY[raw]) return STATUS_DISPLAY[raw];
  if (String(raw).includes('estimable') || String(raw).includes('algunos')) return 'Exploratorio · no validado';
  return raw;
}

export function safeMetric(statusRaw, metric) {
  const st = statusRaw || '';
  if (
    st === 'estimable_con_reserva' ||
    st === 'algunos_estimables' ||
    st.includes('estimable') ||
    st.includes('algunos')
  ) {
    return 'Muestra limitada · probabilidad no validada';
  }
  if (!metric || metric === 'Sin muestra suficiente') return 'Sin muestra suficiente';
  if (
    metric.includes('Sin muestra') ||
    metric.includes('no validada') ||
    metric.includes('Exploratorio') ||
    metric.includes('Muestra limitada')
  ) {
    return metric;
  }
  return 'Muestra limitada · probabilidad no validada';
}

function ticksOf(x) {
  if (x == null) return null;
  return dollarsToTicks(x);
}

function msOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function relAtLeast(base, other, pct, up) {
  if (base <= 0) return false;
  const units = Math.round(pct * 1_000_000);
  const num = up ? other - base : base - other;
  return num * 1_000_000 >= units * base;
}

function scale(ticks, factor) {
  return Math.round(ticks * factor);
}

export function createBilateralEngine(cfg = CANDIDATES) {
  const gates = cfg.gates_common;
  const candidates = cfg.candidates;
  const gapMs = Number(gates.gap_break_sec) * 1000;
  const cooldownUntil = new Map();

  function one(state, reason, ticker, extra = {}) {
    return {
      state,
      reason,
      ticker,
      candidate_id: extra.candidate_id || null,
      family: extra.family || null,
      side: extra.side || null,
      details: extra.details || null,
      validation: PUBLIC_VALIDATION,
    };
  }

  function evalOne(ticker, series, cand, nowMs, yesBid, yesAsk, noBid, noAsk, bq, aq) {
    const lb = cand.lookback_sec * 1000;
    let recent = series.filter((x) => x.ts >= nowMs - lb);
    if (recent.length < 2) return null;
    if (recent.slice(1).some((x) => x.bridged)) {
      for (let i = recent.length - 1; i > 0; i--) {
        if (recent[i].bridged) {
          recent = recent.slice(i);
          break;
        }
      }
      if (recent.length < 2) return null;
    }
    const side = cand.side;
    const askKey = side === 'YES' ? 'yes_ask' : 'no_ask';
    const minPx = Math.round(Number(gates.min_side_price) * 10000);
    const confirmMs = Number(gates.confirm_sec) * 1000;
    const entryAsk = side === 'YES' ? yesAsk : noAsk;
    const depth = side === 'YES' ? bq : aq;

    if (cand.family === 'rebound') {
      let peak = recent[0][askKey];
      let peakTs = recent[0].ts;
      let event = null;
      for (let i = 1; i < recent.length; i++) {
        const x = recent[i];
        const a = x[askKey];
        if (a > peak) {
          peak = a;
          peakTs = x.ts;
          continue;
        }
        if (peak <= 0) continue;
        if (relAtLeast(peak, a, cand.drop_pct, false) && a >= minPx) {
          event = { peak, peakTs, trough: a, troughTs: x.ts };
        }
      }
      if (!event) return null;
      const target = scale(event.trough, 1 + cand.target_pct);
      const stop = scale(event.trough, 1 - cand.stop_pct);
      const rel = (event.peak - event.trough) / event.peak;
      const details = {
        candidate_id: cand.id,
        family: cand.family,
        side_to_buy: side,
        peak_ask: formatTicks4(event.peak),
        trough_ask: formatTicks4(event.trough),
        rel_drop: rel,
        entry_idea_ask_taker: formatTicks4(entryAsk),
        target_price_rebound: formatTicks4(target),
        target_ticks: target,
        stop_price: formatTicks4(stop),
        note_arithmetic: 'target = trough*(1+pct); same % does NOT recover peak; not net ROI after fees',
        max_hold_sec: cand.horizon_sec,
        depth_bid: String(depth),
      };
      if (nowMs < event.troughTs + confirmMs) {
        return one(
          'Preparando',
          `${cand.id}: caída rel ${(rel * 100).toFixed(0)}% ${side}-ask — confirmando`,
          ticker,
          { candidate_id: cand.id, family: cand.family, side, details },
        );
      }
      return one(
        'Candidato observado (sin validar)',
        `${cand.id}: rebote ${side} tras caída rel ≥${Math.round(cand.drop_pct * 100)}%`,
        ticker,
        { candidate_id: cand.id, family: cand.family, side, details },
      );
    }

    if (cand.family === 'continuation') {
      let trough = recent[0][askKey];
      let troughTs = recent[0].ts;
      let event = null;
      for (let i = 1; i < recent.length; i++) {
        const x = recent[i];
        const a = x[askKey];
        if (a < trough) {
          trough = a;
          troughTs = x.ts;
          continue;
        }
        if (trough <= 0) continue;
        if (relAtLeast(trough, a, cand.move_pct, true) && a >= minPx) {
          event = { trough, troughTs, peak: a, peakTs: x.ts };
        }
      }
      if (!event) return null;
      const rel = (event.peak - event.trough) / event.trough;
      const target = scale(event.peak, 1 + cand.target_pct);
      const stop = scale(event.peak, 1 - cand.stop_pct);
      const details = {
        candidate_id: cand.id,
        family: cand.family,
        side_to_buy: side,
        base_ask: formatTicks4(event.trough),
        move_ask: formatTicks4(event.peak),
        rel_up: rel,
        entry_idea_ask_taker: formatTicks4(entryAsk),
        target_price_continue: formatTicks4(target),
        target_ticks: target,
        stop_price: formatTicks4(stop),
        note_arithmetic: 'continuation ≠ mean reversion; target from post-move ask',
        max_hold_sec: cand.horizon_sec,
      };
      return one(
        'Candidato observado (sin validar)',
        `${cand.id}: continuación ${side} tras alza rel ≥${Math.round(cand.move_pct * 100)}%`,
        ticker,
        { candidate_id: cand.id, family: cand.family, side, details },
      );
    }
    return null;
  }

  return {
    evaluate(ticker, points, closeTimeUtc, now, dataOk = true) {
      const nowMs = msOf(now);
      if (!dataOk) return [one('Bloqueada', 'datos atrasados o fuente caída', ticker)];
      if (!points || !points.length) return [one('Esperar', 'sin libros todavía', ticker)];
      const last = points[points.length - 1];
      const bid = ticksOf(last.bid);
      const ask = ticksOf(last.ask);
      if (bid == null || ask == null) return [one('Bloqueada', 'libro incompleto', ticker)];
      if (ask < bid) return [one('Bloqueada', 'libro cruzado', ticker)];
      const spread = ask - bid;
      const bq = Number(last.bid_qty || 0);
      const aq = Number(last.ask_qty || 0);
      const noAsk = 10000 - bid;
      const noBid = 10000 - ask;
      if (closeTimeUtc) {
        const close = Date.parse(String(closeTimeUtc));
        if (Number.isFinite(close) && close - nowMs <= Number(gates.no_entry_min_to_close) * 60 * 1000) {
          return [one('Bloqueada', `≤${gates.no_entry_min_to_close} min al cierre`, ticker)];
        }
      }
      const midLo = Math.round(Number(gates.mid_lo) * 10000);
      const midHi = Math.round(Number(gates.mid_hi) * 10000);
      if (bid + ask < midLo * 2 || bid + ask > midHi * 2) {
        return [one('Bloqueada', `mid fuera de ${Math.round(Number(gates.mid_lo) * 100)}–${Math.round(Number(gates.mid_hi) * 100)}¢`, ticker)];
      }
      const maxSp = Math.round(Number(gates.max_spread) * 10000);
      if (spread > maxSp) {
        return [one('Bloqueada', `spread ${(spread / 100).toFixed(1)}¢ > ${Math.round(Number(gates.max_spread) * 100)}¢`, ticker)];
      }
      const minDepth = Number(gates.min_depth);
      if (bq < minDepth || aq < minDepth) return [one('Bloqueada', `profundidad < ${minDepth}`, ticker)];
      const cd = cooldownUntil.get(ticker);
      if (cd && nowMs < cd) return [one('Bloqueada', `cooldown ${Math.trunc((cd - nowMs) / 1000)}s`, ticker)];

      const series = [];
      let prev = null;
      for (const p of points) {
        const ts = msOf(p.receipt_utc ?? p.receipt_ms);
        const yb = ticksOf(p.bid);
        const ya = ticksOf(p.ask);
        if (ts == null || yb == null || ya == null) continue;
        const bridged = prev != null && ts - prev > gapMs;
        series.push({ ts, yes_ask: ya, yes_bid: yb, no_ask: 10000 - yb, no_bid: 10000 - ya, bridged });
        prev = ts;
      }
      if (series.length < 3) return [one('Esperar', 'pocos puntos', ticker)];

      const out = [];
      for (const cand of candidates) {
        const sig = evalOne(ticker, series, cand, nowMs, bid, ask, noBid, noAsk, bq, aq);
        if (sig) out.push(sig);
      }
      if (!out.length) return [one('Esperar', 'sin movimiento relativo 20/30% en lookbacks registrados', ticker)];
      return out;
    },
  };
}
