import { dollarsToTicks } from './money.js';

export const KALSHI_BASES = [
  'https://external-api.kalshi.com/trade-api/v2',
  'https://api.elections.kalshi.com/trade-api/v2',
];

export const DISCOVERY_MS = 60_000;

function isOpaque(err) {
  const name = err && err.name;
  const msg = String((err && err.message) || err || '');
  return name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(msg);
}

export function explainFetchError(message) {
  const m = String(message || '');
  if (/failed to fetch|networkerror|load failed|typeerror/i.test(m)) {
    return 'El navegador no pudo leer la API pública de Kalshi. Si hay internet, la causa conocida es el origen de esta página: el 2026-11-06 Kalshi respondió HTTP 403, sin Access-Control-Allow-Origin, a https://oerodri.github.io, y 200 al origen https://kalshi.com. GitHub Pages no puede hacer de proxy.';
  }
  if (/HTTP 403/.test(m)) return 'Kalshi respondió HTTP 403. No hay libro nuevo y no se marca como fresco.';
  if (/libro incompleto/.test(m)) return 'La respuesta no trae bid y ask. No se usa como libro fresco.';
  if (/sin mercados/.test(m)) return 'No apareció un contrato KXWTI abierto en el listado público.';
  if (/listado KXWTI incompleto/.test(m)) return 'El listado público vino incompleto. No se eligen strikes a ciegas.';
  return 'No hay libro nuevo: ' + m;
}

async function fetchJson(fetchImpl, bases, path) {
  let last;
  for (const base of bases) {
    let res;
    try {
      res = await fetchImpl(base + path, {
        cache: 'no-store',
        mode: 'cors',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      if (isOpaque(err)) throw err;
      last = err;
      continue;
    }
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status);
      if (res.status >= 500) {
        last = err;
        continue;
      }
      throw err;
    }
    return res.json();
  }
  throw last || new Error('sin respuesta');
}

export function parseOrderbook(json) {
  const fp = json && json.orderbook_fp;
  if (!fp) throw new Error('libro sin orderbook_fp');
  const yes = Array.isArray(fp.yes_dollars) ? fp.yes_dollars : [];
  const no = Array.isArray(fp.no_dollars) ? fp.no_dollars : [];
  const best = (levels) => {
    let found = null;
    for (const row of levels) {
      if (!row || row.length < 2) continue;
      const price = dollarsToTicks(row[0]);
      const qty = Number(row[1]);
      if (price == null || !Number.isFinite(qty)) continue;
      if (!found || price > found.price) found = { price, qty };
    }
    return found;
  };
  const yb = best(yes);
  const nb = best(no);
  return {
    bid_ticks: yb ? yb.price : null,
    ask_ticks: nb ? 10000 - nb.price : null,
    bid_qty: yb ? yb.qty : null,
    ask_qty: nb ? nb.qty : null,
    yes_levels: yes.length,
    no_levels: no.length,
  };
}

export function selectMarkets(markets, nowMs) {
  const rows = (markets || []).filter((m) => {
    if (!m || !m.ticker || !m.event_ticker) return false;
    if (!String(m.ticker).startsWith('KXWTI-')) return false;
    if (m.status && m.status !== 'active' && m.status !== 'open') return false;
    const close = Date.parse(m.close_time);
    return Number.isFinite(close) && close > nowMs;
  });
  const byEvent = new Map();
  for (const m of rows) {
    const arr = byEvent.get(m.event_ticker) || [];
    arr.push(m);
    byEvent.set(m.event_ticker, arr);
  }
  let bestEvent = null;
  let bestClose = Infinity;
  for (const [event, arr] of byEvent) {
    const close = Math.min(...arr.map((m) => Date.parse(m.close_time)));
    if (close < bestClose) {
      bestClose = close;
      bestEvent = event;
    }
  }
  if (!bestEvent) return [];
  const ranked = [];
  for (const m of byEvent.get(bestEvent)) {
    const bid = dollarsToTicks(m.yes_bid_dollars);
    const ask = dollarsToTicks(m.yes_ask_dollars);
    if (bid == null || ask == null || ask < bid) continue;
    ranked.push({
      meta: {
        ticker: m.ticker,
        event_ticker: m.event_ticker,
        strike: m.floor_strike,
        title: m.title || '',
        close_time: m.close_time,
      },
      dist: Math.abs((bid + ask) / 2 - 5000),
    });
  }
  ranked.sort((a, b) => a.dist - b.dist || String(a.meta.strike).localeCompare(String(b.meta.strike)));
  return ranked.slice(0, 3).map((x) => x.meta);
}

async function fetchMarkets(fetchImpl, bases) {
  let cursor = '';
  const all = [];
  for (let page = 0; page < 5; page++) {
    const q = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const data = await fetchJson(fetchImpl, bases, `/markets?series_ticker=KXWTI&status=open&limit=200${q}`);
    all.push(...(data.markets || []));
    if (!data.cursor) return all;
    cursor = data.cursor;
  }
  throw new Error('listado KXWTI incompleto');
}

export async function pollOnce(session, env) {
  if (!session.tryBegin()) return { skipped: true };
  const bases = env.bases || KALSHI_BASES;
  try {
    let selection = session.currentSelection();
    if (session.needsDiscovery(env.now())) {
      const markets = await fetchMarkets(env.fetch, bases);
      selection = selectMarkets(markets, env.now());
      if (!selection.length) throw new Error('sin mercados KXWTI abiertos');
      session.markDiscovery(env.now());
    }
    const updates = [];
    for (const meta of selection) {
      if (!/^[A-Z0-9._-]+$/.test(meta.ticker)) throw new Error('ticker inesperado');
      const started = env.now();
      const body = await fetchJson(env.fetch, bases, `/markets/${meta.ticker}/orderbook`);
      const parsed = parseOrderbook(body);
      if (parsed.bid_ticks == null || parsed.ask_ticks == null) throw new Error('libro incompleto');
      const receiptMs = env.now();
      updates.push({
        meta,
        point: { ...parsed, receipt_ms: receiptMs, latency_ms: receiptMs - started },
      });
    }
    let seriesInfo = null;
    if (session.needsSeries(env.now())) {
      session.markSeriesAttempt(env.now());
      try {
        const body = await fetchJson(env.fetch, bases, '/series/KXWTI');
        seriesInfo = body.series || null;
      } catch {
        seriesInfo = null;
      }
    }
    session.commit({ selection, updates, attemptMs: env.now(), seriesInfo });
    return { ok: true, n: updates.length };
  } catch (err) {
    session.fail(err, env.now());
    return { ok: false, error: err };
  }
}
