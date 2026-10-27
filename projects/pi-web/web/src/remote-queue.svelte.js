import { SvelteMap } from 'svelte/reactivity';
import { request, createRefreshCoordinator } from './remote-api.js';
import { recoverQueuedMessage } from './remote-drafts.svelte.js';

const queues = new SvelteMap();

export function sessionQueue(id, composer) {
  if (queues.has(id)) return queues.get(id);
  const state = $state({ items: [], busy: '', error: '', revision: -1, instance: '' });
  const url = '/api/session/queue?id=' + encodeURIComponent(id);
  let observation = '';
  let generation = 0;
  const commit = (reply, instance) => {
    if (instance !== state.instance || reply.revision < state.revision) return;
    state.items = reply.items;
    state.revision = reply.revision;
  };
  const refresh = createRefreshCoordinator(async () => {
    const current = generation;
    const instance = state.instance;
    try {
      const reply = await request(url, { background: true });
      if (current === generation) {
        commit(reply, instance);
        state.error = '';
      }
    } catch (error) {
      if (current === generation) state.error = error.message;
    }
  });
  const queue = {
    state,
    refresh: () => refresh.run(),
    observe(instance, revision, count, available) {
      const next = JSON.stringify([instance, revision, count, available]);
      if (next === observation) return;
      observation = next;
      generation++;
      if (!available || typeof revision !== 'number') return;
      if (state.instance !== instance) {
        state.instance = instance;
        state.revision = -1;
      }
      if (count === 0 && revision >= state.revision) {
        state.items = [];
        state.revision = revision;
        state.error = '';
      } else if (revision > state.revision) refresh.run();
    },
    async remove(itemId, take) {
      if (state.busy || composer.sending) return false;
      state.busy = itemId;
      state.error = '';
      const instance = state.instance;
      let original;
      let removing = false;
      try {
        // Read image bytes before withdrawing, so a lost mutation receipt cannot lose the original.
        if (take) original = (await request(url + '&item=' + encodeURIComponent(itemId))).item;
        removing = true;
        const reply = await request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId }),
        });
        commit(reply, instance);
        return take && recoverQueuedMessage(composer, original);
      } catch (error) {
        state.error = error.message;
        if (original && removing) recoverQueuedMessage(composer, original, error.message);
        refresh.run();
        return false;
      } finally {
        state.busy = '';
      }
    },
  };
  queues.set(id, queue);
  return queue;
}
