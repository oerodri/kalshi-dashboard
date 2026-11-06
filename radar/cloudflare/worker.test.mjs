import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalReceipt,
  corsHeaders,
  decideIngest,
  handleIngest,
  originAllowed,
  projectSnapshot,
  publicView,
  tokenMatches,
} from './worker.js';

const SECRET = 'test-token-not-a-real-secret';
const NOW = Date.parse('2026-11-06T16:41:00.000Z');

function sample(receipt, extra = {}) {
  return {
    mode: 'Solo observación / estrategia NO validada / no coloca órdenes',
    context: {
      validation_label: 'Exploratorio · no validado',
      validation_file: '/workspace/erick_algo/wti/radar/backtest/relative_eval/out/summary.json',
      pct_basis: '% relativo del contrato YES/NO Kalshi (no $/barril)',
      live_ice_feed: 'NO integrado — no hay feed ICE subminuto gratis verificado',
    },
    freshness: {
      recorder_pid: 2215108,
      last_book_ok_utc: receipt,
      last_book_ok_et: '2026-11-06T11:41:00.000-05:00',
      banner: 'DATOS FRESCOS',
    },
    recorder: { pid: 2215108, status: 'running', event_ticker: 'KXWTI-26NOV0614' },
    markets: [{
      ticker: 'KXWTI-26NOV0614-T90.49',
      event_ticker: 'KXWTI-26NOV0614',
      strike: 90.49,
      title: 'WTI',
      close_time: '2026-11-06T19:30:00Z',
      yes_bid: '0.5100',
      yes_ask: '0.5300',
      spread_cents: 2,
      bid_qty: '100',
      ask_qty: '20',
      yes_levels: 4,
      no_levels: 5,
      receipt_utc: receipt,
      receipt_et: '2026-11-06T11:41:00.000-05:00',
      series: [{ receipt_utc: receipt, receipt_et: '2026-11-06T11:41:00.000-05:00', bid: 0.51, ask: 0.53, bid_qty: 100, ask_qty: 20 }],
      signal: { state: 'Esperar', reason: 'sin caída de ask ≥3¢ en 30s', details: null, family: 'legacy_yes_dip_3c', label: 'LEGACY (caída 3¢ YES)' },
      bilateral: {
        state: 'Esperar',
        reason: 'sin movimiento relativo 20/30% en lookbacks registrados',
        validation: {
          status: 'Exploratorio · no validado',
          status_research: 'algunos_estimables',
          hit_rate_display: 'Sin muestra suficiente',
          net_expectancy_display: 'Sin muestra suficiente',
          caveat: 'Sin feed ICE subminuto.',
          label_note: 'Exploratorio · no validado',
        },
      },
      size_idea: { qty: 9, max_contracts: 10, max_premium_usd: 5, note: 'Calculadora visual — no envía órdenes' },
      economics_if_both_fill: { qty: '9', entry: '0.5100', exit: '0.5600', gross: '0.45', fee_in: '0.16', fee_out: '0.16', net: '0.13', premium: '4.59', worst_case_binary_loss: '4.59', assumption: 'taker' },
      economics_if_stop_fill: { qty: '9', net: '-0.59' },
    }],
    alerts: [],
    disclaimer: ['Exploratorio · no validado'],
    errors_recent: ['read:/workspace/erick_algo/wti/recorder/data/books.jsonl.gz'],
    ...extra,
  };
}

function req(origin, auth) {
  return {
    url: 'https://worker.example/ingest',
    headers: { get: (name) => (name === 'Origin' ? origin : name === 'Authorization' ? auth : null) },
  };
}

test('la proyección conserva señales y quita pid y rutas', () => {
  const raw = sample('2026-11-06T16:40:58.000Z');
  const projected = projectSnapshot(raw);
  const text = JSON.stringify(projected.stored);
  assert.equal(projected.receiptUtc, '2026-11-06T16:40:58.000Z');
  assert.equal(projected.stored.markets[0].signal.state, 'Esperar');
  assert.equal(projected.stored.markets[0].signal.family, 'legacy_yes_dip_3c');
  assert.equal(projected.stored.markets[0].bilateral.validation.status, 'Exploratorio · no validado');
  assert.equal(projected.stored.markets[0].bilateral.validation.hit_rate_display, 'Sin muestra suficiente');
  assert.equal(projected.stored.markets[0].economics_if_both_fill.net, '0.13');
  assert.equal(projected.stored.markets[0].economics_if_stop_fill.net, '-0.59');
  assert.equal(projected.stored.context.validation_label, 'Exploratorio · no validado');
  assert.doesNotMatch(text, /2215108|recorder_pid|validation_file|\/workspace|status_research|errors_recent/);
  assert.equal(canonicalReceipt(raw), '2026-11-06T16:40:58.000Z');
});

test('auth, payload, replay, orden, futuro y recibo intacto', () => {
  const receipt = '2026-11-06T16:40:58.000Z';
  const incoming = projectSnapshot(sample(receipt));
  const none = handleIngest({ request: req(null, ''), rawText: '{}', stored: null, secret: '', now: NOW });
  assert.equal(none.status, 503);
  assert.equal(none.write, false);
  const anon = handleIngest({ request: req(null, ''), rawText: JSON.stringify(sample(receipt)), stored: null, secret: SECRET, now: NOW });
  assert.equal(anon.status, 401);
  assert.equal(anon.write, false);
  assert.equal(tokenMatches('Bearer otra-cosa', SECRET), false);
  const bad = handleIngest({ request: req(null, `Bearer ${SECRET}`), rawText: '{"markets":[]}', stored: null, secret: SECRET, now: NOW });
  assert.equal(bad.status, 422);
  assert.equal(bad.write, false);
  const ok = handleIngest({ request: req(null, `Bearer ${SECRET}`), rawText: JSON.stringify(sample(receipt)), stored: null, secret: SECRET, now: NOW });
  assert.equal(ok.status, 201);
  assert.equal(ok.write, true);
  assert.equal(ok.next.receiptUtc, receipt);
  const stored = ok.next;
  const replayBody = sample(receipt);
  replayBody.markets[0].yes_bid = '0.9900';
  replayBody.markets[0].signal.state = 'Condición cumplida (sin validar)';
  const replay = handleIngest({ request: req(null, `Bearer ${SECRET}`), rawText: JSON.stringify(replayBody), stored, secret: SECRET, now: NOW + 2000 });
  assert.equal(replay.status, 200);
  assert.equal(replay.write, false);
  assert.equal(replay.next.stored.markets[0].yes_bid, '0.5100');
  assert.equal(replay.next.stored.markets[0].signal.state, 'Esperar');
  assert.equal(replay.next.receiptUtc, receipt);
  const older = handleIngest({
    request: req(null, `Bearer ${SECRET}`),
    rawText: JSON.stringify(sample('2026-11-06T16:40:50.000Z')),
    stored,
    secret: SECRET,
    now: NOW + 3000,
  });
  assert.equal(older.status, 409);
  assert.equal(older.write, false);
  assert.equal(older.next.receiptUtc, receipt);
  const future = handleIngest({
    request: req(null, `Bearer ${SECRET}`),
    rawText: JSON.stringify(sample('2026-11-06T16:41:30.000Z')),
    stored,
    secret: SECRET,
    now: NOW,
  });
  assert.equal(future.status, 422);
  assert.equal(future.write, false);
  assert.equal(future.next.receiptUtc, receipt);
  const decision = decideIngest({ stored, incoming: projectSnapshot(sample('2026-11-06T16:40:59.100Z')), now: NOW + 500 });
  assert.equal(decision.status, 429);
  assert.equal(decision.write, false);
});

test('exactamente 4 s ya está atrasado y el recibo no se reescribe', () => {
  const receipt = '2026-11-06T16:40:58.945664+00:00';
  const at = Date.parse(receipt);
  const stored = projectSnapshot(sample(receipt)).stored;
  const under = publicView(stored, at + 3999);
  const exact = publicView(stored, at + 4000);
  assert.equal(under.freshness.stale, false);
  assert.equal(exact.freshness.stale, true);
  assert.equal(exact.freshness.banner, 'DATOS ATRASADOS');
  assert.equal(exact.freshness.receipt_utc, receipt);
  assert.notEqual(exact.freshness.receipt_utc, new Date(at).toISOString());
  assert.equal(stored.receipt_utc, receipt);
});

test('un rechazo devuelve el recibo guardado, no el del intento', () => {
  const receipt = '2026-11-06T16:40:58.945664+00:00';
  const headers = new Headers();
  headers.set('authorization', `Bearer ${SECRET}`);
  headers.set('origin', 'https://oerodri.github.io');
  const request = { url: 'https://wti-radar-snapshot.oerodri-radar.workers.dev/ingest', headers };
  const saved = handleIngest({
    request,
    rawText: JSON.stringify(sample(receipt)),
    stored: null,
    secret: SECRET,
    now: Date.parse(receipt) + 500,
  });
  assert.equal(saved.status, 201);
  assert.equal(corsHeaders(request)['Access-Control-Allow-Origin'], 'https://oerodri.github.io');
  const wrapper = saved.next;
  const mutated = sample(receipt);
  mutated.markets[0].yes_bid = '0.9900';
  mutated.markets[0].signal.state = 'Condición cumplida (sin validar)';
  const replay = handleIngest({
    request,
    rawText: JSON.stringify(mutated),
    stored: wrapper,
    secret: SECRET,
    now: Date.parse(receipt) + 1000,
  });
  const replayBody = JSON.parse(replay.body);
  assert.equal(replay.write, false);
  assert.equal(replayBody.freshness.receipt_utc, receipt);
  assert.equal(replayBody.freshness.stale, false);
  assert.equal(replayBody.freshness.age_sec, 1);
  const older = handleIngest({
    request,
    rawText: JSON.stringify(sample('2026-11-06T16:40:50.945664+00:00')),
    stored: wrapper,
    secret: SECRET,
    now: Date.parse(receipt) + 1000,
  });
  const olderBody = JSON.parse(older.body);
  assert.equal(older.status, 409);
  assert.equal(older.write, false);
  assert.equal(olderBody.freshness.receipt_utc, receipt);
  assert.equal(older.next, wrapper);
  const emptyFuture = handleIngest({
    request,
    rawText: JSON.stringify(sample('2026-11-06T16:42:00.945664+00:00')),
    stored: null,
    secret: SECRET,
    now: Date.parse(receipt),
  });
  const emptyBody = JSON.parse(emptyFuture.body);
  assert.equal(emptyFuture.status, 422);
  assert.equal(emptyFuture.write, false);
  assert.equal(emptyBody.freshness.receipt_utc, '');
  assert.equal(emptyBody.freshness.stale, true);
  assert.equal(emptyBody.freshness.banner, 'DATOS ATRASADOS');
});

test('una observación vieja no se vuelve fresca al leerla', () => {
  const stored = projectSnapshot(sample('2026-11-06T16:40:00.000Z')).stored;
  const view = publicView(stored, NOW);
  assert.equal(view.freshness.stale, true);
  assert.equal(view.freshness.banner, 'DATOS ATRASADOS');
  assert.equal(view.freshness.receipt_utc, '2026-11-06T16:40:00.000Z');
  assert.equal(view.markets[0].signal.state, 'Esperar');
  const again = publicView(stored, NOW + 10000);
  assert.equal(again.freshness.receipt_utc, stored.receipt_utc);
});

test('CORS solo refleja el origen permitido', () => {
  const pages = corsHeaders(req('https://oerodri.github.io', ''));
  assert.equal(pages['Access-Control-Allow-Origin'], 'https://oerodri.github.io');
  assert.equal(pages['Cache-Control'], 'no-store');
  const evil = corsHeaders(req('https://evil.example', ''));
  assert.equal(evil['Access-Control-Allow-Origin'], undefined);
  assert.equal(originAllowed('https://worker.example', 'https://worker.example/snapshot'), true);
  assert.equal(originAllowed('https://evil.example', 'https://worker.example/snapshot'), false);
});
