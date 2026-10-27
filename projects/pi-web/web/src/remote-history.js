import { request } from './remote-api.js';
import { observeTraffic } from './remote-activity.js';
import { canPrefetchView, observeViews, rememberView, sessionViews } from './remote-cache.js';
import { createMessageWindow } from './remote-messages.svelte.js';

let active = null;
const listeners = new Set();

export function activateHistory(id, load) {
  const reader = { id, load };
  active = reader;
  for (const listener of listeners) listener();
  return () => {
    if (active !== reader) return;
    active = null;
    for (const listener of listeners) listener();
  };
}

export function startHistoryPrefetch() {
  let traffic = 0;
  let timer;
  let pending;
  let disposed = false;
  let last = '';
  const cooldowns = new WeakMap();
  const connection = navigator.connection;
  const blocked = () =>
    disposed ||
    traffic > 0 ||
    document.hidden ||
    navigator.onLine === false ||
    connection?.saveData;
  const delay = () => (/^[23]g$|^slow-2g$/.test(connection?.effectiveType) ? 5000 : 1500);

  function schedule() {
    clearTimeout(timer);
    if (blocked()) pending?.abort();
    else if (!pending) timer = setTimeout(run, delay());
  }

  async function run() {
    if (blocked() || pending) return;
    let retryAt = Infinity;
    const candidates = sessionViews().filter(({ id, view }) => {
      if (!view.before || !canPrefetchView(`session:${id}`, view)) return false;
      const until = cooldowns.get(view) || 0;
      if (until <= Date.now()) return true;
      retryAt = Math.min(retryAt, until);
      return false;
    });
    if (!candidates.length) {
      // Retry only retained, unfinished windows; never keep an old view alive for its cooldown.
      if (Number.isFinite(retryAt))
        timer = setTimeout(schedule, Math.max(delay(), retryAt - Date.now()));
      return;
    }
    const index = candidates.findIndex(({ id }) => id === last);
    const { id, view } = candidates[(index + 1) % candidates.length];
    last = id;
    const controller = new AbortController();
    pending = controller;
    let updated = false;
    try {
      if (active?.id === id) updated = await active.load(controller.signal);
      else {
        const window = createMessageWindow(view, id);
        const read = window.read(true);
        const data = await request(`/api/session?id=${encodeURIComponent(id)}${read.query}`, {
          signal: controller.signal,
          background: true,
          retries: 0,
        });
        // Navigation, a newer read or eviction must win over this detached response.
        if (
          !controller.signal.aborted &&
          active?.id !== id &&
          sessionViews().find((entry) => entry.id === id)?.view === view &&
          !data.window.reset &&
          read.commit(data.window) === 'updated'
        ) {
          updated =
            rememberView(
              `session:${id}`,
              { ...view, messages: window.state.messages, before: window.state.before },
              { prefetch: true },
            ) || 'full';
        }
      }
    } catch {
      // Speculation is silent; foreground reads own visible errors and retries.
    } finally {
      if (!controller.signal.aborted) {
        if (updated === true) cooldowns.delete(view);
        else cooldowns.set(view, updated === 'full' ? Infinity : Date.now() + 30000);
      }
      pending = null;
      schedule();
    }
  }

  const interrupt = () => {
    pending?.abort();
    schedule();
  };
  listeners.add(interrupt);
  const stopTraffic = observeTraffic((count) => {
    traffic = count;
    schedule();
  });
  const stopViews = observeViews(schedule);
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('online', schedule);
  window.addEventListener('offline', schedule);
  connection?.addEventListener('change', schedule);
  schedule();
  return () => {
    disposed = true;
    clearTimeout(timer);
    pending?.abort();
    listeners.delete(interrupt);
    stopTraffic();
    stopViews();
    document.removeEventListener('visibilitychange', schedule);
    window.removeEventListener('online', schedule);
    window.removeEventListener('offline', schedule);
    connection?.removeEventListener('change', schedule);
  };
}
