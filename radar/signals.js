import { dollarsToTicks } from './money.js';

export const LOOKBACK_MS = 30_000;
export const CONFIRM_MS = 10_000;
export const ASK_DROP = 300;
export const CONFIRM_MAX_BID_SLIP = 100;
export const MIN_DEPTH = 25;
export const MIN_SPREAD = 100;
export const MAX_SPREAD = 200;
export const TARGET = 500;
export const STOP = 300;
export const COOLDOWN_MS = 120_000;
export const NO_ENTRY_MS = 30 * 60 * 1000;
export const MID_LO = 2500;
export const MID_HI = 7500;
const FAMILY = 'legacy_yes_dip_3c';

function ticksOf(x) {
  if (x == null) return null;
  return dollarsToTicks(x);
}

function msOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function pack(state, reason, ticker, details) {
  return { state, reason, ticker, details: details || null, family: FAMILY, label: 'LEGACY (caída 3¢ YES)' };
}

export function createLegacyEngine() {
  const cooldownUntil = new Map();
  return {
    evaluate(ticker, points, closeTimeUtc, now, dataOk = true) {
      const nowMs = msOf(now);
      if (!dataOk) return pack('Bloqueada', 'datos atrasados o fuente caída', ticker);
      if (!points || !points.length) return pack('Esperar', 'sin libros todavía', ticker);
      const last = points[points.length - 1];
      const bid = ticksOf(last.bid);
      const ask = ticksOf(last.ask);
      if (bid == null || ask == null) return pack('Bloqueada', 'libro incompleto (falta bid o ask)', ticker);
      if (ask < bid) return pack('Bloqueada', 'libro cruzado', ticker);
      const spread = ask - bid;
      const bq = Number(last.bid_qty || 0);
      const aq = Number(last.ask_qty || 0);
      if (closeTimeUtc) {
        const close = Date.parse(String(closeTimeUtc));
        if (Number.isFinite(close) && close - nowMs <= NO_ENTRY_MS) {
          return pack('Bloqueada', 'faltan ≤30 min al cierre', ticker);
        }
      }
      if (bid + ask < MID_LO * 2 || bid + ask > MID_HI * 2) return pack('Bloqueada', 'mid fuera de 25–75¢', ticker);
      if (spread < MIN_SPREAD || spread > MAX_SPREAD) {
        return pack('Bloqueada', `spread ${(spread / 100).toFixed(1)}¢ fuera de 1–2¢`, ticker);
      }
      if (bq < MIN_DEPTH || aq < MIN_DEPTH) {
        return pack('Bloqueada', `profundidad insuficiente (bid ${bq}, ask ${aq}; min ${MIN_DEPTH})`, ticker);
      }
      const cd = cooldownUntil.get(ticker);
      if (cd && nowMs < cd) return pack('Bloqueada', `cooldown ${Math.trunc((cd - nowMs) / 1000)}s`, ticker);

      const series = [];
      for (const p of points) {
        const ts = msOf(p.receipt_utc ?? p.receipt_ms);
        const a = ticksOf(p.ask);
        const b = ticksOf(p.bid);
        if (ts == null || a == null || b == null) continue;
        series.push({ ts, ask: a, bid: b });
      }
      if (series.length < 3) return pack('Esperar', 'pocos puntos de libro', ticker);
      const recent = series.filter((x) => x.ts >= nowMs - LOOKBACK_MS);
      if (recent.length < 2) return pack('Esperar', 'ventana 30s incompleta', ticker);

      let maxAsk = recent[0].ask;
      let maxAskTime = recent[0].ts;
      let dropEvent = null;
      for (let i = 1; i < recent.length; i++) {
        const x = recent[i];
        if (x.ask > maxAsk) {
          maxAsk = x.ask;
          maxAskTime = x.ts;
        }
        const drop = maxAsk - x.ask;
        if (drop >= ASK_DROP) {
          dropEvent = {
            peak_ask: maxAsk,
            peak_ts: maxAskTime,
            trough_ask: x.ask,
            trough_ts: x.ts,
            drop,
            bid_at_trough: x.bid,
          };
        }
      }
      if (!dropEvent) return pack('Esperar', 'sin caída de ask ≥3¢ en 30s', ticker);

      const confirmEnd = dropEvent.trough_ts + CONFIRM_MS;
      const bid0 = dropEvent.bid_at_trough;
      if (nowMs < confirmEnd) {
        const conf = series.filter((x) => x.ts >= dropEvent.trough_ts && x.ts <= nowMs);
        for (const x of conf) {
          if (bid0 - x.bid > CONFIRM_MAX_BID_SLIP) {
            return pack('Esperar', 'confirmación fallida: bid resbaló >1¢', ticker);
          }
        }
        return pack(
          'Preparando',
          `caída ask ${(dropEvent.drop / 100).toFixed(0)}¢ — confirmando bid (${Math.trunc((confirmEnd - nowMs) / 1000)}s)`,
          ticker,
          { entry_idea: bid, target: bid + TARGET, stop: bid - STOP },
        );
      }
      const conf = series.filter((x) => x.ts >= dropEvent.trough_ts && x.ts <= confirmEnd);
      if (!conf.length) return pack('Esperar', 'sin puntos en ventana de confirmación', ticker);
      for (const x of conf) {
        if (bid0 - x.bid > CONFIRM_MAX_BID_SLIP) {
          return pack('Esperar', 'confirmación inválida (bid no estable)', ticker);
        }
      }
      cooldownUntil.set(ticker, nowMs + COOLDOWN_MS);
      return pack('Condición cumplida (sin validar)', 'caída ask confirmada + filtros OK — solo idea', ticker, {
        entry_idea_post_only_bid: bid,
        note: 'Condición de borrador cumplida ≠ edge validado ≠ fill garantizado',
      });
    },
  };
}
