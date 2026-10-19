export async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  });
  const data = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : { error: await response.text() };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function createRefreshCoordinator(refresh, onError = () => {}) {
  let inflight = null;
  let dirty = false;
  let disposed = false;
  return {
    run() {
      if (disposed) return Promise.resolve();
      dirty = true;
      if (!inflight) {
        inflight = (async () => {
          await Promise.resolve();
          try {
            while (dirty && !disposed) {
              dirty = false;
              try {
                await refresh();
              } catch (error) {
                onError(error);
              }
            }
          } finally {
            inflight = null;
          }
        })();
      }
      return inflight;
    },
    dispose() {
      disposed = true;
    },
  };
}

export function mergeMessages(current, incoming) {
  const updates = new Map(incoming.map((message) => [message.id, message]));
  const merged = current.map((message) => {
    const next = updates.get(message.id);
    updates.delete(message.id);
    return next || message;
  });
  return [...merged, ...updates.values()];
}

export function readSeenReplies(storage) {
  try {
    return (
      JSON.parse((storage || globalThis.localStorage).getItem('pi-web:seen-replies') || '{}') || {}
    );
  } catch {
    return {};
  }
}

export function markSeen(id, replyId, storage) {
  try {
    storage ||= globalThis.localStorage;
    storage.setItem(
      'pi-web:seen-replies',
      JSON.stringify({ ...readSeenReplies(storage), [id]: replyId }),
    );
  } catch {
    // Reading remains available when browser storage is disabled.
  }
}
