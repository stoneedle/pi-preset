import { beginControl, beginRead } from './remote-activity.js';

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(), ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function request(url, options = {}) {
  const safe = !options.method || options.method === 'GET' || options.method === 'HEAD';
  const {
    signal,
    timeout = safe ? 12000 : 45000,
    retries = safe ? 2 : 0,
    background = false,
    ...init
  } = options;
  const finish = safe ? (background ? () => {} : beginRead()) : beginControl();
  try {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timeoutError = Object.assign(
        new Error(safe ? '读取超时，正在重新连接。' : '请求超时，结果尚未确认；请查看会话后再试。'),
        { retryable: true },
      );
      const timer = setTimeout(() => controller.abort(timeoutError), timeout);
      let retryAfter = 0;
      try {
        // The deadline also covers body download and interrupted browser/network adapters.
        const operation = (async () => {
          const response = await fetch(url, {
            priority: background ? 'low' : 'auto',
            ...init,
            signal: controller.signal,
            headers: { Accept: 'application/json', ...init.headers },
          });
          retryAfter = Math.min(
            30000,
            Math.max(0, Number(response.headers.get('Retry-After')) * 1000),
          );
          const data = response.headers.get('content-type')?.includes('application/json')
            ? await response.json()
            : { error: await response.text() };
          if (!response.ok)
            throw Object.assign(new Error(data.error || `HTTP ${response.status}`), {
              retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
              status: response.status,
            });
          return data;
        })();
        return await Promise.race([
          operation,
          new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
              once: true,
            });
          }),
        ]);
      } catch (error) {
        signal?.throwIfAborted();
        error.retryable ??= error instanceof TypeError || error instanceof SyntaxError;
        if (!safe || !error.retryable || attempt >= retries) throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
      await wait(Math.max(retryAfter, 400 * 2 ** attempt * (0.8 + Math.random() * 0.4)), signal);
    }
  } finally {
    finish();
  }
}

export function createRefreshCoordinator(refresh, onError = () => {}, { minInterval = 0 } = {}) {
  let inflight = null;
  let dirty = false;
  let disposed = false;
  let lastRun = -Infinity;
  let failures = 0;
  let retryTimer;
  const controller = new AbortController();
  const coordinator = {
    run() {
      if (disposed) return Promise.resolve();
      clearTimeout(retryTimer);
      dirty = true;
      if (!inflight) {
        inflight = (async () => {
          await Promise.resolve();
          try {
            while (dirty && !disposed) {
              await wait(Math.max(0, lastRun + minInterval - Date.now()), controller.signal);
              dirty = false;
              lastRun = Date.now();
              try {
                await refresh(controller.signal);
                failures = 0;
                clearTimeout(retryTimer);
              } catch (error) {
                if (disposed) return;
                onError(error);
                if (error.retryable) {
                  retryTimer = setTimeout(
                    () => coordinator.run(),
                    Math.min(15000, 1500 * 2 ** failures++) * (0.8 + Math.random() * 0.4),
                  );
                }
              }
            }
          } catch (error) {
            if (!disposed) onError(error);
          } finally {
            inflight = null;
          }
        })();
      }
      return inflight;
    },
    dispose() {
      disposed = true;
      clearTimeout(retryTimer);
      controller.abort();
    },
  };
  return coordinator;
}

export function createRuntimeStateStore() {
  const states = new Map();
  let epoch = 0;
  let connectionEpoch = 0;
  const unavailable = (value) => ({
    ...value,
    state: 'unknown',
    availability: 'disconnected',
    canControl: false,
  });
  return {
    mark: () => epoch,
    get: (id) => states.get(id)?.value,
    disconnect() {
      connectionEpoch = ++epoch;
      for (const [id, entry] of states) {
        states.set(id, { value: unavailable(entry.value), epoch });
      }
    },
    merge(incoming, readEpoch = epoch) {
      const previous = states.get(incoming.id);
      if (
        previous &&
        (previous.epoch > readEpoch ||
          (previous.value.instanceId === incoming.instanceId &&
            incoming.revision < previous.value.revision))
      )
        return previous.value;
      const value = readEpoch < connectionEpoch ? unavailable(incoming) : incoming;
      states.set(incoming.id, { value, epoch: ++epoch });
      return value;
    },
  };
}
