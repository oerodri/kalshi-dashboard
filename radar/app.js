import { pollOnce } from './kalshi.js';
import { applyView, drawCharts } from './render.js';
import { createSession } from './session.js';

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
      await pollOnce(session, env);
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

if (typeof document !== 'undefined' && document.getElementById('banner')) {
  startRadar({
    now: () => Date.now(),
    fetch: (url, init) => globalThis.fetch(url, init),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
    render(view) {
      return applyView(document, view);
    },
  });
}
