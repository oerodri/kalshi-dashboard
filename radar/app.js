import { applyView, drawCharts } from './render.js';
import { createSession } from './session.js';
import { allowedSnapshotUrl, parseSnapshot, pollSnapshot } from './snapshot.js';

export const UI_INTERVAL_MS = 1000;
export const FALLBACK_POLL_MS = 5000;

export function liveSocketUrl(snapshotUrl) {
  const url = new URL(snapshotUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/live';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function startRadar(env) {
  const session = env.session || createSession();
  let polling = false;

  function paint() {
    const view = session.view(env.now());
    const root = env.render(view);
    if (root && view.markets) drawCharts(root, view.markets);
  }

  function ui() {
    session.noteUiTick(env.now());
    paint();
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      await pollSnapshot(session, env);
      paint();
    } finally {
      polling = false;
    }
  }

  async function applyMessage(raw) {
    try {
      const parsed = parseSnapshot(JSON.parse(raw));
      const now = env.now();
      for (const market of parsed.markets) {
        for (const point of market.points) {
          if (point.receipt_ms > now + 2000) return;
        }
      }
      const known = session.view(now).receiptMs;
      const incoming = parsed.markets.reduce((min, market) => {
        const last = market.points[market.points.length - 1];
        return last && (min == null || last.receipt_ms < min) ? last.receipt_ms : min;
      }, null);
      if (known != null && incoming != null && incoming <= known) return;
      session.replaceFromSnapshot({ markets: parsed.markets, attemptMs: now });
      paint();
    } catch {
      /* un mensaje malo no adelanta el recibo */
    }
  }

  let fallbackId = null;
  let socket;
  function startFallback() {
    if (fallbackId != null || !env.snapshotUrl) return;
    fallbackId = env.setInterval(() => { void poll(); }, FALLBACK_POLL_MS);
  }
  function stopFallback() {
    if (fallbackId != null) env.clearInterval(fallbackId);
    fallbackId = null;
  }

  ui();
  const uiId = env.setInterval(ui, UI_INTERVAL_MS);
  if (env.snapshotUrl) void poll();
  const WS = env.WebSocket;
  if (env.snapshotUrl && WS) {
    try {
      socket = new WS(liveSocketUrl(env.snapshotUrl));
      socket.onmessage = (ev) => { void applyMessage(ev.data); };
      socket.onopen = () => stopFallback();
      socket.onclose = () => startFallback();
      socket.onerror = () => {};
    } catch {
      startFallback();
    }
  } else if (env.snapshotUrl) {
    startFallback();
  }
  return {
    session,
    stop() {
      env.clearInterval(uiId);
      stopFallback();
      try { socket && socket.close(); } catch { /* ya cerrado */ }
    },
  };
}

async function loadSnapshotUrl() {
  try {
    const res = await fetch(new URL('./endpoint.json', import.meta.url), { cache: 'no-store' });
    if (!res.ok) return '';
    const data = await res.json();
    return allowedSnapshotUrl(data && data.snapshotUrl);
  } catch {
    return '';
  }
}

if (typeof document !== 'undefined' && document.getElementById('banner')) {
  const snapshotUrl = await loadSnapshotUrl();
  startRadar({
    snapshotUrl,
    now: () => Date.now(),
    fetch: (url, init) => globalThis.fetch(url, init),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
    render(view) {
      return applyView(document, view);
    },
  });
}
