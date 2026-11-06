import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBilateralEngine, displayStatus, safeMetric } from '../bilateral.js';
import { CANDIDATES } from '../candidates.js';
import { explainFetchError, parseOrderbook, pollOnce, selectMarkets } from '../kalshi.js';
import { roundTrip, suggestedQty } from '../money.js';
import { renderMarkets } from '../render.js';
import { createSession, STALE_SEC } from '../session.js';
import { createLegacyEngine } from '../signals.js';
import { fmtCloseET, fmtDataET, fmtNowET } from '../timefmt.js';
import { BOOK_INTERVAL_MS, startRadar, UI_INTERVAL_MS } from '../app.js';

const ref = JSON.parse(fs.readFileSync(new URL('../reference/CANDIDATES.json', import.meta.url), 'utf8'));

test('las reglas 20/30 copiadas no se retocaron', () => {
  assert.deepEqual(CANDIDATES, ref);
  assert.equal(STALE_SEC, 4);
  assert.equal(UI_INTERVAL_MS, 1000);
  assert.equal(BOOK_INTERVAL_MS, 1500);
  assert.equal(CANDIDATES.gates_common.gap_break_sec, 4);
  assert.ok(CANDIDATES.candidates.some((c) => c.id === 'RB_YES_20_20_L60' && c.drop_pct === 0.2));
  assert.equal(CANDIDATES.legacy_kept_separate.id, 'LEGACY_YES_DIP_3c_30s');
});

test('comisiones iguales a la fórmula original', () => {
  const win = roundTrip(5000, 5500, 10);
  assert.equal(win.net, '0.14');
  assert.equal(win.gross, '0.50');
  assert.equal(win.fee_in, '0.18');
  assert.equal(win.fee_out, '0.18');
  assert.equal(win.premium, '5.00');
  const stop = roundTrip(5000, 4700, 10);
  assert.equal(stop.net, '-0.66');
  assert.equal(stop.gross, '-0.30');
  assert.equal(roundTrip(5300, 5800, 9).net, '0.13');
  assert.equal(roundTrip(3800, 4300, 10).net, '0.15');
  assert.equal(suggestedQty(5000, 100), 10);
  assert.equal(suggestedQty(5000, 20), 5);
  assert.equal(suggestedQty(8000, 100), 6);
  assert.equal(suggestedQty(5300, 244), 9);
  assert.equal(suggestedQty(3800, 186.5), 10);
});

test('horas en español, zona Eastern, sin Z', () => {
  const est = Date.parse('2026-11-06T15:08:43Z');
  assert.equal(fmtNowET(est), 'Ahora 6 nov 2026, 10:08:43 a. m. EST');
  assert.equal(fmtDataET(est), '6 nov 2026, 10:08:43 a. m. EST');
  const edt = Date.parse('2026-07-06T15:08:43Z');
  assert.equal(fmtNowET(edt), 'Ahora 6 jul 2026, 11:08:43 a. m. EDT');
  assert.equal(fmtCloseET('2026-11-06T19:30:00Z'), 'Cierre 6 nov, 2:30 p. m. EST');
  for (const s of [fmtNowET(est), fmtDataET(est), fmtNowET(edt), fmtCloseET(est)]) {
    assert.doesNotMatch(s, /Z|UTC|GMT/);
  }
});

test('etiquetas de validación no publican una tasa', () => {
  assert.equal(displayStatus('algunos_estimables'), 'Exploratorio · no validado');
  assert.equal(displayStatus('estimable_con_reserva'), 'Muestra limitada · probabilidad no validada');
  assert.equal(displayStatus('Sin muestra suficiente'), 'Sin muestra suficiente');
  assert.equal(safeMetric('estimable_con_reserva', '2/24 = 8.3% (IC95 2.3%–25.8%)'), 'Muestra limitada · probabilidad no validada');
});

function pts(start, pairs, step) {
  return pairs.map(([ask, bid, bq = 50, aq = 50], i) => ({
    receipt_utc: new Date(start + i * step).toISOString(),
    bid,
    ask,
    bid_qty: bq,
    ask_qty: aq,
  }));
}

test('legacy: atraso, libro cruzado, caída de 3¢ y resbalón', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const close = new Date(now + 2 * 3600 * 1000).toISOString();
  const flat = pts(now - 4000, [[0.52, 0.5], [0.52, 0.5], [0.52, 0.5], [0.52, 0.5], [0.52, 0.5]], 1000);
  assert.equal(createLegacyEngine().evaluate('T', flat, null, now, false).state, 'Bloqueada');
  const crossed = [{ receipt_utc: new Date(now).toISOString(), bid: 0.55, ask: 0.5, bid_qty: 50, ask_qty: 50 }];
  const bad = createLegacyEngine().evaluate('T', crossed, null, now, true);
  assert.equal(bad.state, 'Bloqueada');
  assert.match(bad.reason, /cruzado/);
  const dropPairs = Array(12).fill([0.55, 0.5]).concat(Array(4).fill([0.52, 0.5]));
  const preparing = createLegacyEngine().evaluate('T', pts(now - 1000 * (dropPairs.length - 1), dropPairs, 1000), close, now, true);
  assert.equal(preparing.state, 'Preparando');
  assert.match(preparing.reason, /3¢/);
  const slipPairs = Array(10).fill([0.55, 0.53]).concat([[0.52, 0.51], [0.54, 0.49], [0.54, 0.53], [0.54, 0.53]]);
  const slipped = createLegacyEngine().evaluate('T', pts(now - 1000 * (slipPairs.length - 1), slipPairs, 1000), close, now, true);
  assert.equal(slipped.state, 'Esperar');
  assert.match(slipped.reason, /resbaló/);
});

test('20/30 es relativo al contrato y no restaura el pico', () => {
  const eng = createBilateralEngine();
  const now = Date.parse('2026-11-06T12:00:00Z');
  const close = new Date(now + 2 * 3600 * 1000).toISOString();
  const big = Array(20).fill([0.5, 0.48]).concat(Array(15).fill([0.4, 0.38]));
  const armed = eng.evaluate('T', pts(now - 1500 * (big.length - 1), big, 1500), close, now, true)
    .filter((s) => s.state === 'Preparando' || s.state.startsWith('Candidato'));
  assert.ok(armed.length);
  for (const s of armed) {
    assert.equal(s.validation.hit_rate_display, 'Sin muestra suficiente');
    assert.equal(s.validation.status, 'Exploratorio · no validado');
    assert.ok(s.side === 'YES' || s.side === 'NO');
    assert.doesNotMatch(JSON.stringify(s.validation), /%/);
  }
  const small = Array(25).fill([0.5, 0.48]).concat(Array(10).fill([0.47, 0.45]));
  const yesRb = eng.evaluate('T', pts(now - 1500 * (small.length - 1), small, 1500), close, now, true)
    .filter((s) => s.candidate_id && s.candidate_id.startsWith('RB_YES') && (s.state === 'Preparando' || s.state.startsWith('Candidato')));
  assert.equal(yesRb.length, 0);
  const now2 = Date.parse('2026-11-06T12:05:00Z');
  const seq = Array(30).fill([0.5, 0.48]).concat(Array(40).fill([0.4, 0.38]));
  const hit = eng.evaluate('T', pts(now2 - 1500 * (seq.length - 1), seq, 1500), close, now2, true)
    .find((s) => s.candidate_id === 'RB_YES_20_20_L60');
  assert.ok(hit);
  assert.equal(hit.details.target_ticks, 4800);
  assert.notEqual(hit.details.target_ticks, 5000);
  assert.equal(hit.details.target_price_rebound, '0.4800');
});

test('un hueco o poca profundidad no arma el 20/30', () => {
  const eng = createBilateralEngine();
  const now = Date.parse('2026-11-06T12:00:00Z');
  const close = new Date(now + 2 * 3600 * 1000).toISOString();
  const points = [];
  let t = now - 20000;
  for (let i = 0; i < 10; i++) {
    points.push({ receipt_utc: new Date(t).toISOString(), bid: 0.48, ask: 0.5, bid_qty: 50, ask_qty: 50 });
    t += 1000;
  }
  t += 5000;
  for (let i = 0; i < 6; i++) {
    points.push({ receipt_utc: new Date(t).toISOString(), bid: 0.38, ask: 0.4, bid_qty: 50, ask_qty: 50 });
    t += 1000;
  }
  const gapped = eng.evaluate('T', points, close, t - 1000, true);
  assert.equal(gapped.some((s) => s.candidate_id && s.candidate_id.startsWith('RB_YES')), false);
  const thin = Array(20).fill([0.5, 0.48, 5, 5]).concat(Array(15).fill([0.4, 0.38, 5, 5]));
  const blocked = eng.evaluate('T', pts(now - 1500 * (thin.length - 1), thin, 1500), close, now, true);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].state, 'Bloqueada');
  assert.match(blocked[0].reason, /profundidad/);
  const freshDrop = Array(20).fill([0.5, 0.48]).concat(Array(15).fill([0.4, 0.38]));
  const stale = eng.evaluate('T', pts(now - 1500 * (freshDrop.length - 1), freshDrop, 1500), close, now, false);
  assert.equal(stale[0].state, 'Bloqueada');
  assert.match(stale[0].reason, /fuente/);
});

test('el libro usa el mejor bid, no el orden del array', () => {
  const parsed = parseOrderbook({
    orderbook_fp: {
      yes_dollars: [['0.5300', '244.00'], ['0.0100', '5.00'], ['0.5200', '10.00']],
      no_dollars: [['0.2000', '3.00'], ['0.4600', '214.00'], ['0.1000', '9.00']],
    },
  });
  assert.equal(parsed.bid_ticks, 5300);
  assert.equal(parsed.bid_qty, 244);
  assert.equal(parsed.ask_ticks, 5400);
  assert.equal(parsed.ask_qty, 214);
  assert.equal(parsed.yes_levels, 3);
  assert.equal(parsed.no_levels, 3);
  assert.equal(parseOrderbook({ orderbook_fp: { yes_dollars: [], no_dollars: [['0.4000', '10']] } }).bid_ticks, null);
});

test('elige el evento que cierra antes y los 3 strikes más cerca de 50¢', () => {
  const now = Date.parse('2026-11-06T15:00:00Z');
  const soon = '2026-11-06T19:30:00Z';
  const later = '2026-11-09T19:30:00Z';
  const row = (event, ticker, strike, bid, ask, close, status = 'active') => ({
    ticker, event_ticker: event, floor_strike: strike, yes_bid_dollars: bid, yes_ask_dollars: ask, close_time: close, status, title: ticker,
  });
  const picked = selectMarkets([
    row('KXWTI-LATER', 'KXWTI-LATER-T50', 50, '0.4900', '0.5100', later),
    row('KXWTI-NOW', 'KXWTI-NOW-T1', 1, '0.0100', '0.0200', soon),
    row('KXWTI-NOW', 'KXWTI-NOW-T90.49', 90.49, '0.5300', '0.5400', soon),
    row('KXWTI-NOW', 'KXWTI-NOW-T90.99', 90.99, '0.3800', '0.4000', soon),
    row('KXWTI-NOW', 'KXWTI-NOW-T89.99', 89.99, '0.6700', '0.6800', soon),
    row('KXWTI-NOW', 'KXWTI-NOW-T99', 99, '0.0200', '0.0300', soon),
    row('OTHER-1', 'OTHER-1', 1, '0.5000', '0.5100', soon),
    row('KXWTI-NOW', 'KXWTI-NOW-GONE', 80, '0.5000', '0.5100', '2026-11-06T14:00:00Z'),
  ], now);
  assert.deepEqual(picked.map((m) => m.ticker), ['KXWTI-NOW-T90.49', 'KXWTI-NOW-T90.99', 'KXWTI-NOW-T89.99']);
});

function json(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return obj; } };
}

function marketList() {
  return {
    cursor: '',
    markets: [{
      ticker: 'KXWTI-26NOV0614-T90.49',
      event_ticker: 'KXWTI-26NOV0614',
      floor_strike: 90.49,
      title: 'WTI above 90.49',
      close_time: '2026-11-06T19:30:00Z',
      status: 'active',
      yes_bid_dollars: '0.5000',
      yes_ask_dollars: '0.5200',
    }],
  };
}

function book(bid, qty, noBid) {
  return {
    orderbook_fp: {
      yes_dollars: [['0.0100', '5.00'], [bid, qty]],
      no_dollars: [['0.0100', '5.00'], [noBid, '100.00']],
    },
  };
}

test('una vuelta buena avanza el libro; el redibujo y el fallo no', async () => {
  let t = Date.parse('2026-11-06T15:00:00.000Z');
  let books = 0;
  const urls = [];
  const session = createSession();
  const env = {
    now: () => t,
    fetch: async (url) => {
      urls.push(url);
      t += 25;
      if (url.includes('/orderbook')) {
        books += 1;
        if (books >= 3) throw new TypeError('Failed to fetch');
        if (books === 1) return json(book('0.5000', '100.00', '0.4800'));
        return json(book('0.5100', '80.00', '0.4700'));
      }
      if (url.includes('/series/')) return json({ series: { fee_type: 'quadratic', fee_multiplier: 1 } });
      if (url.includes('series_ticker=KXWTI')) return json(marketList());
      throw new Error(url);
    },
  };
  const first = await pollOnce(session, env);
  assert.equal(first.ok, true);
  const afterFirst = session.view(t);
  assert.equal(afterFirst.banner, 'DATOS FRESCOS');
  assert.equal(afterFirst.markets[0].bidText, '0.5000');
  assert.equal(afterFirst.markets[0].askText, '0.5200');
  assert.equal(afterFirst.markets[0].spreadText, '2.0 ¢');
  assert.equal(afterFirst.markets[0].econ.net, '0.14');
  assert.equal(afterFirst.markets[0].econ.fee_in, '0.18');
  assert.equal(afterFirst.markets[0].stopEcon.net, '-0.66');
  assert.equal(afterFirst.markets[0].econ.net, roundTrip(5000, 5500, 10).net);
  assert.equal(afterFirst.markets[0].stopEcon.net, roundTrip(5000, 4700, 10).net);
  assert.match(afterFirst.feeLine, /fee_multiplier=1/);
  assert.match(afterFirst.interfaceText, /a\. m\. EST/);
  assert.match(afterFirst.markets[0].receiptText, /a\. m\. EST/);
  const receipt = afterFirst.receiptMs;
  const cardReceipt = afterFirst.markets[0].receiptMs;
  assert.ok(cardReceipt < afterFirst.attemptMs);
  session.noteUiTick(t + 1000);
  const redraw = session.view(t + 1000);
  assert.equal(redraw.receiptMs, receipt);
  assert.equal(redraw.markets[0].receiptMs, cardReceipt);
  assert.equal(redraw.markets[0].bidText, '0.5000');
  assert.equal(redraw.banner, 'DATOS FRESCOS');
  assert.equal(redraw.uiTicks, 1);
  assert.equal(session.view(cardReceipt + 4000).stale, false);
  assert.equal(session.view(cardReceipt + 4001).stale, true);
  assert.equal(session.view(cardReceipt + 4001).markets[0].econ, null);
  assert.equal(session.view(cardReceipt + 4001).markets[0].legacy.state, 'Bloqueada');

  const second = await pollOnce(session, env);
  assert.equal(second.ok, true);
  const moved = session.view(t);
  assert.equal(moved.markets[0].bidText, '0.5100');
  assert.notEqual(moved.markets[0].receiptMs, cardReceipt);
  assert.equal(moved.banner, 'DATOS FRESCOS');
  assert.equal(urls.filter((u) => u.includes('series_ticker=KXWTI')).length, 1);
  const kept = moved.receiptMs;

  const third = await pollOnce(session, env);
  assert.equal(third.ok, false);
  const failed = session.view(t);
  assert.equal(failed.banner, 'DATOS ATRASADOS');
  assert.equal(failed.stale, true);
  assert.equal(failed.receiptMs, kept);
  assert.notEqual(failed.attemptMs, kept);
  assert.equal(failed.markets[0].bidText, '0.5100');
  assert.equal(failed.markets[0].econ, null);
  assert.equal(failed.markets[0].stopEcon, null);
  assert.equal(failed.markets[0].sizeText, 'bloqueado');
  assert.equal(failed.markets[0].legacy.state, 'Bloqueada');
  assert.match(failed.reason, /403/);
  assert.match(failed.reason, /GitHub Pages/);
  const html = renderMarkets(failed);
  assert.match(html, /Exploratorio · no validado/);
  assert.match(html, /Sin muestra suficiente/);
  assert.doesNotMatch(html, /neto /);
  assert.doesNotMatch(html, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/);
  const freshHtml = renderMarkets(moved);
  assert.match(freshHtml, /neto 0\.14|neto 0\.1/);
  assert.match(freshHtml, new RegExp(`neto ${moved.markets[0].econ.net}`));
  assert.match(freshHtml, new RegExp(`comisiones ${moved.markets[0].econ.fee_in}\\+${moved.markets[0].econ.fee_out}`));
  assert.doesNotMatch(freshHtml, /\d{4}-\d{2}-\d{2}T/);
});

test('no hay peticiones solapadas y un redibujo no pide libros', async () => {
  let release;
  const gate = new Promise((resolve, reject) => { release = reject; });
  const session = createSession();
  let calls = 0;
  const first = pollOnce(session, {
    now: () => 1_700_000_000_000,
    bases: ['https://example.test/v2', 'https://second.test/v2'],
    fetch: () => { calls += 1; return gate; },
  });
  const second = await pollOnce(session, { now: () => 1, fetch: () => { calls += 1; return gate; } });
  assert.equal(second.skipped, true);
  assert.equal(calls, 1);
  release(new TypeError('Failed to fetch'));
  const done = await first;
  assert.equal(done.ok, false);
  assert.equal(session.view(1).banner, 'DATOS ATRASADOS');
  assert.equal(explainFetchError('Failed to fetch').includes('403'), true);

  const intervals = [];
  let fetches = 0;
  let hung;
  const hold = new Promise((resolve) => { hung = resolve; });
  const banners = [];
  startRadar({
    now: () => Date.parse('2026-11-06T15:10:00Z'),
    session: createSession(),
    fetch: () => { fetches += 1; return hold; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval() {},
    render(view) { banners.push(view.banner); return null; },
  });
  assert.deepEqual(intervals.map((i) => i.ms).sort((a, b) => a - b), [1000, 1500]);
  assert.equal(fetches, 1);
  assert.equal(banners[0], 'DATOS ATRASADOS');
  intervals.find((i) => i.ms === 1000).fn();
  intervals.find((i) => i.ms === 1000).fn();
  intervals.find((i) => i.ms === 1500).fn();
  assert.equal(fetches, 1);
  assert.ok(banners.every((b) => b === 'DATOS ATRASADOS'));
  hung(json({ markets: [] }));
});

test('el panel y el enlace conservan el resto del dashboard', () => {
  const dash = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const page = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(dash, /href="radar\/index\.html"/);
  assert.match(dash, /Exploratorio · no validado/);
  assert.match(dash, /terry_real\.json/);
  assert.match(dash, /pm5m\.json/);
  assert.match(dash, /compass\.json/);
  assert.match(dash, /terry\.json/);
  assert.match(page, /Exploratorio · no validado/);
  assert.match(page, /Sin muestra suficiente/);
  assert.match(page, /cada 1 s/);
  assert.match(page, /1,5 s/);
  assert.match(page, /4 s/);
  assert.match(page, /DATOS ATRASADOS/);
  assert.doesNotMatch(page, /\/portfolio|api-key|KALSHI-ACCESS/i);
  assert.match(app, /if \(polling\) return/);
  assert.match(app, /UI_INTERVAL_MS/);
  assert.doesNotMatch(app, /noteUiTick[\s\S]{0,80}pollOnce/);
});
