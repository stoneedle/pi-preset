import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { diagnosticId, trace } from './remote-diagnostics.js';

function mergeMessages(current, incoming) {
  const updates = new SvelteMap(incoming.map((message) => [message.id, message]));
  const merged = current.map((message) => {
    const next = updates.get(message.id);
    updates.delete(message.id);
    return next || message;
  });
  return [...merged, ...updates.values()];
}

export function createMessageWindow(cached, sessionId) {
  const session = diagnosticId(sessionId);
  const state = $state({
    messages: cached?.messages || [],
    cursor: cached?.cursor || '',
    before: cached?.before || '',
    ready: Boolean(cached),
  });
  let epoch = 0;
  let observation = 0;
  let fullRequired = false;
  return {
    state,
    invalidate(reason) {
      observation++;
      trace('session.invalidate', { session, reason, epoch, observation });
    },
    read(earlier = false) {
      const readEpoch = epoch;
      const readObservation = observation;
      const cursor = earlier ? state.before : fullRequired ? '' : state.cursor;
      const current = () => readEpoch === epoch && readObservation === observation;
      const mode = cursor ? (earlier ? 'before' : 'after') : 'full';
      const started = performance.now();
      trace('session.read', { session, mode, cursor: diagnosticId(cursor), epoch, observation });
      return {
        query: cursor ? `&${earlier ? 'before' : 'after'}=${encodeURIComponent(cursor)}` : '',
        current,
        commit(window) {
          const finish = (result) => {
            trace('session.commit', {
              session,
              mode,
              result,
              reset: Boolean(window.reset),
              received: window.messages.length,
              retained: state.messages.length,
              cursor: diagnosticId(window.cursor),
              epoch,
              observation,
              duration: Math.round(performance.now() - started),
            });
            return result;
          };
          if (readEpoch !== epoch) return finish('stale');
          // New activity must not starve safe append-only reads on a high-latency link.
          // Replacing an existing window or prepending history needs a current observation.
          if ((earlier || window.reset || (!cursor && state.messages.length)) && !current())
            return finish('stale');
          if (earlier) {
            if (window.reset) {
              // Invalidate *all* in-flight reads without destroying the last readable window.
              epoch++;
              fullRequired = true;
              return finish('reset');
            }
            const ids = new SvelteSet(state.messages.map((message) => message.id));
            state.messages = [
              ...window.messages.filter((message) => !ids.has(message.id)),
              ...state.messages,
            ];
            state.before = window.before;
          } else {
            // The request's cursor determines its meaning, never a mutable shared cursor.
            if (!cursor || window.reset) {
              epoch++;
              if (state.ready && state.cursor === window.cursor) {
                state.messages = mergeMessages(state.messages, window.messages);
              } else {
                state.messages = window.messages;
                state.before = window.before;
              }
            } else if (window.messages.length) {
              state.messages = mergeMessages(state.messages, window.messages);
            }
            state.cursor = window.cursor;
            state.ready = true;
            fullRequired = false;
          }
          return finish('updated');
        },
      };
    },
  };
}
