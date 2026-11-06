/**
 * Un solo Durable Object SQLite para el feed WTI.
 * No llama a Kalshi. No escribe contadores en cada GET.
 * Cada observación aceptada reemplaza una fila.
 */
export const PAGES_ORIGIN = 'https://oerodri.github.io';
export const STALE_MS = 4000;
export const FUTURE_SKEW_MS = 2000;
export const MIN_ACCEPT_GAP_MS = 1200;
export const DO_NAME = 'wti';

const MARKET_KEYS = [
  'ticker', 'event_ticker', 'strike', 'title', 'close_time', 'yes_bid', 'yes_ask',
  'spread_cents', 'bid_qty', 'ask_qty', 'yes_levels', 'no_levels', 'receipt_utc',
  'receipt_et', 'request_latency_ms', 'series', 'signal', 'bilateral', 'size_idea',
  'economics_if_both_fill', 'economics_if_stop_fill',
];
const SERIES_KEYS = ['receipt_utc', 'receipt_et', 'bid', 'ask', 'spread_cents', 'bid_qty', 'ask_qty', 'latency_ms'];
const SIGNAL_KEYS = ['state', 'reason', 'details', 'family', 'label', 'candidate_id', 'side'];
const VALIDATION_KEYS = ['status', 'hit_rate_display', 'net_expectancy_display', 'caveat', 'label_note', 'tier'];
const ECON_KEYS = ['qty', 'entry', 'exit', 'gross', 'fee_in', 'fee_out', 'net', 'premium', 'worst_case_binary_loss', 'assumption'];

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

function cleanValidation(raw) {
  const val = pick(raw, VALIDATION_KEYS);
  return val && Object.keys(val).length ? val : null;
}

function cleanSignal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = pick(raw, SIGNAL_KEYS);
  if (raw.validation) out.validation = cleanValidation(raw.validation);
  if (Array.isArray(raw.all)) {
    out.all = raw.all.map((item) => cleanSignal(item)).filter(Boolean);
  }
  if (raw.details && typeof raw.details === 'object') out.details = raw.details;
  return out;
}

function cleanContext(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    settlement_underlying: src.settlement_underlying || 'ICE front-month WTI Light Sweet Crude Future (Kalshi WTIOIL terms)',
    settlement_doc: src.settlement_doc || 'https://kalshi-public-docs.s3.amazonaws.com/contract_terms/WTIOIL.pdf',
    eia_wpsr_next: src.eia_wpsr_next || '',
    eia_schedule_url: src.eia_schedule_url || 'https://www.eia.gov/petroleum/supply/weekly/schedule.php',
    live_ice_feed: src.live_ice_feed || 'NO integrado — no hay feed ICE subminuto gratis verificado',
    pct_basis: src.pct_basis || '% relativo del contrato YES/NO Kalshi (no $/barril)',
    validation_label: src.validation_label || 'Exploratorio · no validado',
  };
}

export function canonicalReceipt(body) {
  const fromFresh = body && body.freshness && body.freshness.last_book_ok_utc;
  if (typeof fromFresh === 'string' && fromFresh) return fromFresh;
  let best = '';
  let bestMs = Infinity;
  for (const market of (body && body.markets) || []) {
    const raw = market && market.receipt_utc;
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms) && ms < bestMs) {
      bestMs = ms;
      best = raw;
    }
  }
  return best;
}

export function projectSnapshot(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.markets) || !body.markets.length) {
    throw new Error('snapshot sin libros');
  }
  const receiptUtc = canonicalReceipt(body);
  const receiptMs = Date.parse(receiptUtc);
  if (!receiptUtc || Number.isNaN(receiptMs)) throw new Error('libro sin recibo');
  const markets = body.markets.map((market) => {
    if (!market || !market.ticker || !market.receipt_utc) throw new Error('libro incompleto');
    if (market.yes_bid == null || market.yes_ask == null) throw new Error('libro incompleto');
    const out = pick(market, MARKET_KEYS);
    out.series = (market.series || []).slice(-180).map((point) => pick(point, SERIES_KEYS));
    out.signal = cleanSignal(market.signal);
    out.bilateral = cleanSignal(market.bilateral);
    if (!out.signal || !out.bilateral) throw new Error('snapshot sin señales');
    return out;
  });
  const stored = {
    app: 'Radar WTI — Erick',
    mode: body.mode || 'Solo observación / estrategia NO validada / no coloca órdenes',
    context: cleanContext(body.context),
    receipt_utc: receiptUtc,
    receipt_et: (body.freshness && body.freshness.last_book_ok_et) || markets[0].receipt_et || '',
    recorder: {
      status: body.recorder && body.recorder.status || '',
      event_ticker: body.recorder && body.recorder.event_ticker || markets[0].event_ticker || '',
      poll_intervals: body.recorder && body.recorder.poll_intervals || null,
      limitations: Array.isArray(body.recorder && body.recorder.limitations) ? body.recorder.limitations : [],
    },
    markets,
    alerts: Array.isArray(body.alerts) ? body.alerts : [],
    disclaimer: Array.isArray(body.disclaimer) ? body.disclaimer : [],
  };
  const banned = JSON.stringify(stored);
  if (/recorder_pid|"pid"|validation_file|\/workspace|\/erick_algo|status_research|INGEST_TOKEN|Bearer /.test(banned)) {
    throw new Error('la proyección todavía tiene diagnóstico');
  }
  return { receiptUtc, receiptMs, stored };
}

export function publicView(stored, nowMs) {
  if (!stored) {
    return {
      app: 'Radar WTI — Erick',
      mode: 'Solo observación / estrategia NO validada / no coloca órdenes',
      markets: [],
      freshness: {
        stale: true,
        age_sec: null,
        stale_threshold_sec: STALE_MS / 1000,
        receipt_utc: '',
        banner: 'DATOS ATRASADOS',
        basis: 'sin observación',
      },
    };
  }
  const age = (nowMs - Date.parse(stored.receipt_utc)) / 1000;
  const stale = !Number.isFinite(age) || age >= STALE_MS / 1000;
  return {
    app: stored.app,
    mode: stored.mode,
    context: stored.context,
    recorder: stored.recorder,
    markets: stored.markets,
    alerts: stored.alerts,
    disclaimer: stored.disclaimer,
    freshness: {
      stale,
      age_sec: Number.isFinite(age) ? Math.round(age * 1000) / 1000 : null,
      stale_threshold_sec: STALE_MS / 1000,
      receipt_utc: stored.receipt_utc,
      receipt_et: stored.receipt_et,
      banner: stale ? 'DATOS ATRASADOS' : 'DATOS FRESCOS',
      basis: 'receipt_utc del snapshot de origen; no es la hora de esta respuesta',
    },
  };
}

export function tokenMatches(header, secret) {
  const match = /^Bearer\s+(\S+)$/.exec(String(header || ''));
  if (!secret || !match) return false;
  const got = match[1];
  const len = Math.max(got.length, secret.length);
  let diff = got.length ^ secret.length;
  for (let i = 0; i < len; i++) diff |= (got.charCodeAt(i) || 0) ^ (secret.charCodeAt(i) || 0);
  return diff === 0;
}

export function decideIngest({ stored, incoming, now, minGapMs = MIN_ACCEPT_GAP_MS }) {
  if (incoming.receiptMs > now + FUTURE_SKEW_MS) {
    return { action: 'reject', status: 422, reason: 'recibo en el futuro', write: false };
  }
  if (stored && incoming.receiptMs < stored.receiptMs) {
    return { action: 'reject', status: 409, reason: 'recibo más viejo', write: false };
  }
  if (stored && incoming.receiptMs === stored.receiptMs) {
    return { action: 'replay', status: 200, reason: 'mismo recibo', write: false };
  }
  if (stored && now - stored.acceptedMs < minGapMs) {
    return { action: 'reject', status: 429, reason: 'demasiado seguido', write: false };
  }
  return { action: 'store', status: 201, reason: 'guardado', write: true };
}

export function originAllowed(origin, requestUrl) {
  if (!origin) return false;
  if (origin === PAGES_ORIGIN) return true;
  try {
    return origin === new URL(requestUrl).origin;
  } catch {
    return false;
  }
}

export function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allow = originAllowed(origin, request.url) ? origin : '';
  const headers = {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type',
    Vary: 'Origin',
  };
  if (allow) headers['Access-Control-Allow-Origin'] = allow;
  return headers;
}

function jsonResponse(request, status, body) {
  return {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request) },
    body: JSON.stringify(body),
  };
}

export function handleIngest({ request, rawText, stored, secret, now }) {
  if (!secret) return { ...jsonResponse(request, 503, { error: 'ingesta no configurada' }), write: false, next: stored };
  if (!tokenMatches(request.headers.get('Authorization'), secret)) {
    return { ...jsonResponse(request, 401, { error: 'no autorizado' }), write: false, next: stored };
  }
  let parsed;
  try {
    parsed = projectSnapshot(JSON.parse(rawText));
  } catch (err) {
    return { ...jsonResponse(request, 422, { error: String(err.message || 'payload') }), write: false, next: stored };
  }
  const record = stored && stored.receiptMs != null ? stored : null;
  const inner = stored && stored.stored && stored.stored.receipt_utc
    ? stored.stored
    : (stored && stored.receipt_utc ? stored : null);
  const decision = decideIngest({
    stored: record,
    incoming: parsed,
    now,
  });
  if (!decision.write) {
    const view = publicView(inner, now);
    return {
      ...jsonResponse(request, decision.status, {
        result: decision.reason,
        freshness: view.freshness,
      }),
      write: false,
      next: stored,
    };
  }
  const next = { receiptMs: parsed.receiptMs, receiptUtc: parsed.receiptUtc, acceptedMs: now, stored: parsed.stored };
  return {
    ...jsonResponse(request, 201, publicView(next.stored, now)),
    write: true,
    next,
  };
}

export function handleGet(request, stored, now) {
  return jsonResponse(request, 200, publicView(stored, now));
}

export class RadarSnapshot {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const existing = ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'observation'").toArray();
      if (!existing.length) {
        ctx.storage.sql.exec(`CREATE TABLE observation (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          receipt_ms INTEGER NOT NULL,
          body TEXT NOT NULL,
          accepted_ms INTEGER NOT NULL
        )`);
      }
    });
  }

  load() {
    const rows = [...this.ctx.storage.sql.exec('SELECT receipt_ms, body, accepted_ms FROM observation WHERE id = 1')];
    if (!rows.length) return null;
    const row = rows[0];
    const stored = JSON.parse(row.body);
    return { receiptMs: row.receipt_ms, receiptUtc: stored.receipt_utc, acceptedMs: row.accepted_ms, stored };
  }

  save(next) {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO observation (id, receipt_ms, body, accepted_ms) VALUES (1, ?, ?, ?)',
      next.receiptMs,
      JSON.stringify(next.stored),
      next.acceptedMs,
    );
  }

  broadcast(text) {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(text); } catch { /* el cliente ya se fue */ }
    }
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') === 'websocket' && url.pathname === '/live') {
      if (!originAllowed(request.headers.get('Origin'), request.url)) {
        return new Response('origen no permitido', { status: 403 });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const stored = this.load();
      if (stored) pair[1].send(JSON.stringify(publicView(stored.stored, Date.now())));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    const now = Date.now();
    if (request.method === 'GET' && (url.pathname === '/snapshot' || url.pathname === '/health')) {
      const stored = this.load();
      const view = publicView(stored && stored.stored, now);
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ ok: true, freshness: view.freshness }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request) },
        });
      }
      return new Response(JSON.stringify(view), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(request) },
      });
    }
    if (request.method === 'POST' && url.pathname === '/ingest') {
      const result = handleIngest({
        request,
        rawText: await request.text(),
        stored: this.load(),
        secret: this.env.INGEST_TOKEN || '',
        now,
      });
      if (result.write) {
        this.save(result.next);
        this.broadcast(JSON.stringify(publicView(result.next.stored, now)));
      }
      console.log({
        event: 'wti_radar',
        op: 'ingest',
        status: result.status,
        write: result.write === true,
        receipt_utc: result.next && result.next.receiptUtc ? result.next.receiptUtc : '',
      });
      return new Response(result.body, { status: result.status, headers: result.headers });
    }
    return new Response('not found', { status: 404, headers: corsHeaders(request) });
  }

  async webSocketMessage() {}

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* ya cerrado */ }
  }
}

export default {
  async fetch(request, env) {
    const stub = env.RADAR.get(env.RADAR.idFromName(DO_NAME));
    return stub.fetch(request);
  },
};
