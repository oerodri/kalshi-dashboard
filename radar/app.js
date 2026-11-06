import { applyView, drawCharts } from './render.js';
import { createSession } from './session.js';
import { allowedSnapshotUrl, pollSnapshot } from './snapshot.js';

export const UI_INTERVAL_MS = 1000;
export const BOOK_INTERVAL_MS = 1500;

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

  ui();
  const uiId = env.setInterval(ui, UI_INTERVAL_MS);
  const pollId = env.setInterval(() => {
    void poll();
  }, BOOK_INTERVAL_MS);
  void poll();
  return {
    session,
    stop() {
      env.clearInterval(uiId);
      env.clearInterval(pollId);
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
