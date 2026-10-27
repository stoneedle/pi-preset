import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { subscribeEvents } from './remote-events.js';
import { applyAppName } from './remote-app-name.svelte.js';

// Live facts belong to the page, not to the currently mounted conversation or list.
const states = new SvelteMap();
const listeners = new SvelteSet();
const connection = $state({ connected: false });
let epoch = 0;
let connectionEpoch = 0;

function emit(event) {
  for (const listener of listeners) listener(event);
}

function snapshot(id) {
  const entry = states.get(id);
  if (entry && entry.epoch >= connectionEpoch) return entry.value;
  return {
    ...entry?.value,
    id,
    state: 'unknown',
    availability: 'unknown',
    canControl: false,
    canQueue: false,
    mainRunning: false,
  };
}

export const runtime = {
  get connected() {
    return connection.connected;
  },
  get: snapshot,
  has(id) {
    const entry = states.get(id);
    return Boolean(entry && entry.epoch >= connectionEpoch);
  },
  mark: () => epoch,
  merge(incoming, readEpoch = epoch) {
    if (!incoming?.id) return snapshot('');
    const entry = states.get(incoming.id);
    const previous = snapshot(incoming.id);
    if (
      readEpoch < connectionEpoch ||
      (entry &&
        (entry.epoch > readEpoch ||
          (entry.value.instanceId === incoming.instanceId &&
            incoming.revision < entry.value.revision)))
    )
      return previous;
    states.set(incoming.id, { value: incoming, epoch: ++epoch });
    emit({ type: 'status', snapshot: incoming, previous });
    return incoming;
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function startRuntime() {
  let opened = false;
  return subscribeEvents('/events?id=__all__', {
    open() {
      connection.connected = true;
      if (opened) emit({ type: 'reconnect' });
      opened = true;
    },
    error() {
      connection.connected = false;
      connectionEpoch = ++epoch;
      emit({ type: 'disconnect' });
    },
    message(event) {
      if (event.data === 'reload' || event.data === 'new-session') emit({ type: 'reload' });
    },
    'app-name'(event) {
      applyAppName(JSON.parse(event.data));
    },
    'status-snapshot'(event) {
      for (const value of Object.values(JSON.parse(event.data))) runtime.merge(value);
    },
    'status-delta'(event) {
      runtime.merge(JSON.parse(event.data));
    },
  });
}
