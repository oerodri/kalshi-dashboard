import { createBilateralEngine } from './bilateral.js';
import { explainFetchError } from './snapshot.js';
import { formatTicks4, roundTrip, suggestedQty } from './money.js';
import { createLegacyEngine } from './signals.js';
import { fmtCloseET, fmtDataET, fmtNowET } from './timefmt.js';

export const STALE_SEC = 4;
export const DISCOVERY_MS = 60_000;
const SERIES_MS = 60_000;

function enginePoint(p) {
  return {
    receipt_ms: p.receipt_ms,
    bid: formatTicks4(p.bid_ticks),
    ask: formatTicks4(p.ask_ticks),
    bid_qty: p.bid_qty,
    ask_qty: p.ask_qty,
  };
}

function pickPrimary(list) {
  if (!list || !list.length) return null;
  return list.find((s) => s.state.startsWith('Candidato') || s.state === 'Preparando') || list[0];
}

export function createSession() {
  const legacy = createLegacyEngine();
  const bilateral = createBilateralEngine();
  let inFlight = false;
  let lastRoundOk = false;
  let lastError = '';
  let lastAttemptMs = null;
  let uiTickMs = null;
  let uiTicks = 0;
  let selection = [];
  let nextDiscoveryMs = 0;
  let nextSeriesMs = 0;
  let seriesInfo = null;
  const books = new Map();

  function oldestReceipt() {
    if (!selection.length) return null;
    let min = null;
    for (const meta of selection) {
      const arr = books.get(meta.ticker) || [];
      const last = arr[arr.length - 1];
      if (!last) return null;
      if (min == null || last.receipt_ms < min) min = last.receipt_ms;
    }
    return min;
  }

  return {
    tryBegin() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    fail(err, attemptMs) {
      inFlight = false;
      lastRoundOk = false;
      lastError = String((err && err.message) || err || 'error');
      lastAttemptMs = attemptMs;
    },
    commit({ selection: sel, updates, attemptMs, seriesInfo: info }) {
      inFlight = false;
      lastRoundOk = true;
      lastError = '';
      lastAttemptMs = attemptMs;
      selection = sel;
      if (info) seriesInfo = info;
      for (const u of updates) {
        const arr = books.get(u.meta.ticker) || [];
        arr.push(u.point);
        const cut = u.point.receipt_ms - 30 * 60 * 1000;
        books.set(
          u.meta.ticker,
          arr.filter((p) => p.receipt_ms >= cut).slice(-2000),
        );
      }
    },
    noteUiTick(ms) {
      uiTickMs = ms;
      uiTicks += 1;
    },
    markDiscovery(nowMs) {
      nextDiscoveryMs = nowMs + DISCOVERY_MS;
    },
    needsDiscovery(nowMs) {
      return !selection.length || nowMs >= nextDiscoveryMs;
    },
    needsSeries(nowMs) {
      return nowMs >= nextSeriesMs;
    },
    markSeriesAttempt(nowMs) {
      nextSeriesMs = nowMs + SERIES_MS;
    },
    replaceFromSnapshot({ markets, attemptMs }) {
      inFlight = false;
      lastRoundOk = true;
      lastError = '';
      lastAttemptMs = attemptMs;
      selection = markets.map((market) => market.meta);
      for (const market of markets) {
        books.set(market.meta.ticker, market.points.slice(-2000));
      }
    },
    currentSelection() {
      return selection;
    },
    uiTicks() {
      return uiTicks;
    },
    view(nowMs) {
      const oldest = oldestReceipt();
      const ageSec = oldest == null ? null : (nowMs - oldest) / 1000;
      const stale = !lastRoundOk || oldest == null || ageSec > STALE_SEC;
      let reason;
      if (!lastRoundOk) reason = lastError ? explainFetchError(lastError) : 'Todavía no llegó un libro. No se marca como fresco.';
      else if (stale) reason = `El último libro bueno tiene ${ageSec.toFixed(1)} s. El umbral es ${STALE_SEC} s.`;
      else reason = 'Llegó una observación del puente. La edad es la hora de recepción original, no la de esta descarga.';
      const dataOk = !stale;
      const markets = selection.map((meta) => {
        const series = books.get(meta.ticker) || [];
        const last = series[series.length - 1] || null;
        const points = series.map(enginePoint);
        const leg = legacy.evaluate(meta.ticker, points, meta.close_time, nowMs, dataOk && !!last);
        const all = bilateral.evaluate(meta.ticker, points, meta.close_time, nowMs, dataOk && !!last);
        const primary = pickPrimary(all);
        let qty = 0;
        let econ = null;
        let stopEcon = null;
        if (dataOk && last && last.bid_ticks != null && last.bid_qty != null) {
          qty = suggestedQty(last.bid_ticks, last.bid_qty);
          if (qty > 0) {
            econ = roundTrip(last.bid_ticks, last.bid_ticks + 500, qty);
            stopEcon = roundTrip(last.bid_ticks, last.bid_ticks - 300, qty);
          }
        }
        return {
          ticker: meta.ticker,
          event_ticker: meta.event_ticker,
          strike: meta.strike,
          title: meta.title,
          closeText: fmtCloseET(meta.close_time),
          bidText: last ? formatTicks4(last.bid_ticks) : '—',
          askText: last ? formatTicks4(last.ask_ticks) : '—',
          bidQtyText: last && last.bid_qty != null ? String(last.bid_qty) : '—',
          askQtyText: last && last.ask_qty != null ? String(last.ask_qty) : '—',
          spreadText: last && last.bid_ticks != null && last.ask_ticks != null ? `${((last.ask_ticks - last.bid_ticks) / 100).toFixed(1)} ¢` : '—',
          levelsText: last ? `${last.yes_levels}/${last.no_levels}` : '—',
          latencyText: last && last.latency_ms != null ? `${Math.round(last.latency_ms)} ms` : '—',
          receiptText: last ? fmtDataET(last.receipt_ms) : '—',
          receiptMs: last ? last.receipt_ms : null,
          legacy: leg,
          bilateral: primary,
          bilateralAll: all,
          sizeText: dataOk && last ? `${qty} / $5` : 'bloqueado',
          econ,
          stopEcon,
          series: series.map((p) => ({ bid_ticks: p.bid_ticks, ask_ticks: p.ask_ticks })),
          bookStale: stale,
        };
      });
      const feeLine = seriesInfo
        ? `La serie KXWTI declaró fee_type=${seriesInfo.fee_type || '—'} y fee_multiplier=${seriesInfo.fee_multiplier}. El estrés usa la fórmula original 0.07 (coincide si el multiplicador es 1).`
        : 'El estrés usa la fórmula original: 0.07 × contratos × precio × (1 − precio), techo al centavo. No se reescribió.';
      return {
        banner: stale ? 'DATOS ATRASADOS' : 'DATOS FRESCOS',
        stale,
        ageSec,
        reason,
        interfaceText: fmtNowET(nowMs),
        attemptText: lastAttemptMs == null ? '' : fmtDataET(lastAttemptMs),
        attemptMs: lastAttemptMs,
        receiptText: oldest == null ? '' : fmtDataET(oldest),
        receiptMs: oldest,
        uiTickMs,
        uiTicks,
        markets,
        feeLine,
        eventTicker: selection[0] ? selection[0].event_ticker : '',
        lastError,
      };
    },
  };
}
