import { dollarsToTicks } from './money.js';

export function explainFetchError(message) {
  const m = String(message || '');
  if (/puente no configurado/.test(m)) {
    return 'No hay puente de lecturas. Esta página no pide Kalshi: con Origin https://oerodri.github.io esa API respondió HTTP 403 y sin permiso CORS. Sin libro no se marca como fresco.';
  }
  if (/failed to fetch|networkerror|load failed|typeerror/i.test(m)) {
    return 'No se pudo leer el puente de observaciones. No hay libro nuevo y no se marca como fresco.';
  }
  if (/HTTP \d+/.test(m)) return `El puente respondió ${m}. No hay libro nuevo y no se marca como fresco.`;
  if (/sin libros|incompleto|recibo/.test(m)) return 'La respuesta no trae un libro con hora de recepción. No se marca como fresco.';
  return 'No hay libro nuevo: ' + m;
}

export function allowedSnapshotUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  const host = url.hostname.toLowerCase();
  if (host === 'kalshi.com' || host.endsWith('.kalshi.com')) return '';
  if (url.protocol === 'https:') return url.toString();
  if (url.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost')) return url.toString();
  return '';
}

function receiptMsOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null || value === '') return null;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function pointFrom(raw, fallbackReceipt) {
  const bid = dollarsToTicks(raw.bid ?? raw.yes_bid);
  const ask = dollarsToTicks(raw.ask ?? raw.yes_ask);
  const receipt = receiptMsOf(raw.receipt_utc ?? raw.receipt_ms) ?? fallbackReceipt;
  if (bid == null || ask == null || receipt == null) return null;
  const bidQty = Number(raw.bid_qty ?? raw.yes_bid_size_fp);
  const askQty = Number(raw.ask_qty ?? raw.yes_ask_size_fp);
  return {
    bid_ticks: bid,
    ask_ticks: ask,
    bid_qty: Number.isFinite(bidQty) ? bidQty : null,
    ask_qty: Number.isFinite(askQty) ? askQty : null,
    yes_levels: Number(raw.yes_levels) || 0,
    no_levels: Number(raw.no_levels) || 0,
    receipt_ms: receipt,
    latency_ms: raw.latency_ms ?? raw.request_latency_ms ?? null,
  };
}

export function parseSnapshot(body) {
  const markets = body && Array.isArray(body.markets) ? body.markets : [];
  const parsed = [];
  for (const market of markets) {
    if (!market || !market.ticker) continue;
    const own = receiptMsOf(market.receipt_utc ?? market.receipt_ms);
    const series = [];
    for (const row of market.series || []) {
      const point = pointFrom(row, null);
      if (point) series.push(point);
    }
    if (!series.length) {
      const point = pointFrom(market, own);
      if (point) series.push(point);
    }
    if (!series.length) continue;
    series.sort((a, b) => a.receipt_ms - b.receipt_ms);
    parsed.push({
      meta: {
        ticker: market.ticker,
        event_ticker: market.event_ticker || '',
        strike: market.strike ?? market.floor_strike ?? '',
        title: market.title || '',
        close_time: market.close_time || '',
        presentation: {
          signal: market.signal || null,
          bilateral: market.bilateral || null,
          econ: market.economics_if_both_fill || null,
          stopEcon: market.economics_if_stop_fill || null,
          size: market.size_idea || null,
        },
      },
      points: series,
    });
  }
  if (!parsed.length) throw new Error('snapshot sin libros');
  return { markets: parsed };
}

export async function pollSnapshot(session, env) {
  if (!session.tryBegin()) return { skipped: true };
  const url = allowedSnapshotUrl(env.snapshotUrl);
  if (!url) {
    session.fail(new Error('puente no configurado'), env.now());
    return { ok: false, error: new Error('puente no configurado') };
  }
  try {
    const res = await env.fetch(url, {
      cache: 'no-store',
      mode: 'cors',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    const parsed = parseSnapshot(body);
    const now = env.now();
    for (const market of parsed.markets) {
      for (const point of market.points) {
        if (point.receipt_ms > now + 2000) throw new Error('recibo en el futuro');
      }
    }
    session.replaceFromSnapshot({ markets: parsed.markets, attemptMs: now });
    return { ok: true, n: parsed.markets.length };
  } catch (err) {
    session.fail(err, env.now());
    return { ok: false, error: err };
  }
}
