import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { IDBFactory } from 'fake-indexeddb';

const source = readFileSync(fileURLToPath(new URL('../../web/src/push-worker.js', import.meta.url)), 'utf8');

function workerHarness() {
  const indexedDB = new IDBFactory();
  const shown = new Map();
  const opened = [], fetches = [];
  let windows = [], active = true, subscribed = null;
  const origin = 'https://computer.tailnet.ts.net';
  function boot() {
    const handlers = new Map();
    const self = {
      location: { origin },
      addEventListener: (type, handler) => handlers.set(type, handler),
      skipWaiting: async () => {},
      clients: { claim: async () => {}, matchAll: async () => windows,
        openWindow: async (url) => { opened.push(url); } },
      registration: {
        async showNotification(title, options) {
          const notification = { title, ...options, close: () => shown.delete(options.tag) };
          shown.set(options.tag, notification);
        },
        getNotifications: async () => [...shown.values()],
        pushManager: { subscribe: async () => subscribed },
      },
    };
    const context = vm.createContext({ self, URL, indexedDB, console, Uint8Array,
      fetch: async (url, options) => {
        fetches.push({ url, options });
        if (url.startsWith('/api/push/eligibility?')) return { ok: true, json: async () => ({ active }) };
        if (url === '/api/push/subscription' && options.method === 'POST') return { ok: true };
        throw new Error(`Unexpected worker network request: ${url}`);
      },
    });
    vm.runInContext(source, context);
    return async (type, value) => {
      const pending = [];
      const event = { ...value, waitUntil: (promise) => pending.push(promise) };
      handlers.get(type)(event);
      await Promise.all(pending);
    };
  }
  return { boot, shown, opened, fetches, origin,
    setActive: (value) => { active = value; },
    setWindows: (value) => { windows = value; },
    setSubscription: (value) => { subscribed = value; },
  };
}

test('production worker persists dedup, ignores reordered/read events, and clicking opens only its own exact session', async () => {
  const harness = workerHarness();
  let dispatch = harness.boot();
  const data = { eventId: 'one', kind: 'completed', sessionId: 'session one.jsonl', identity: 'r1',
    sequence: 1, tag: 'session-tag', title: 'Reply ready', body: '',
    url: 'https://untrusted.invalid/api/chat' };
  await dispatch('push', { data: { json: () => data } });
  assert.equal(harness.shown.size, 1);
  assert.equal(harness.shown.get(data.tag).body, '');
  let focused = 0, navigated = 0;
  harness.setWindows([{ url: harness.origin + '/session?id=other.jsonl', focus: async () => focused++, navigate: async () => navigated++ }]);
  await dispatch('notificationclick', { notification: harness.shown.get(data.tag) });
  assert.equal(harness.shown.size, 0);
  assert.deepEqual(harness.opened, [harness.origin + '/session?id=session+one.jsonl']);
  assert.equal(navigated, 0, 'another conversation and its draft must not be replaced');
  assert.equal(focused, 0);
  dispatch = harness.boot();
  await dispatch('push', { data: { json: () => data } });
  assert.equal(harness.shown.size, 0, 'worker restart must not repeat a dismissed event');
  const newer = { ...data, eventId: 'two', identity: 'r2', sequence: 2 };
  await dispatch('push', { data: { json: () => newer } });
  assert.equal(harness.shown.size, 1);
  harness.shown.get(data.tag).close();
  await dispatch('push', { data: { json: () => ({ ...data, eventId: 'old-reordered' }) } });
  assert.equal(harness.shown.size, 0);
  harness.setActive(false);
  await dispatch('push', { data: { json: () => ({ ...data, eventId: 'read', sequence: 3 }) } });
  assert.equal(harness.shown.size, 0, 'receipts are checked without downloading replies');
  harness.setActive(true);
  await dispatch('push', { data: { json: () => ({ ...data, eventId: 'three', sequence: 4 }) } });
  harness.setWindows([{ url: harness.opened[0], focus: async () => focused++ }]);
  await dispatch('notificationclick', { notification: harness.shown.get(data.tag) });
  assert.equal(focused, 1);
  assert.equal(harness.opened.length, 1);
  assert.ok(harness.fetches.every((request) => request.url.startsWith('/api/push/eligibility?') && !request.options?.method));
});

test('production worker closes only the exact confirmed result and renews subscriptions without reply data', async () => {
  const harness = workerHarness();
  const dispatch = harness.boot();
  const data = { eventId: 'result', kind: 'completed', sessionId: 'session.jsonl', identity: 'r2', sequence: 1, tag: 'tag', title: 'Ready', body: 'Metadata' };
  await dispatch('push', { data: { json: () => data } });
  await dispatch('message', { data: { type: 'pi-web:read', sessionId: data.sessionId, replyId: 'r1' } });
  assert.equal(harness.shown.size, 1);
  await dispatch('message', { data: { type: 'pi-web:read', sessionId: data.sessionId, replyId: 'r2' } });
  assert.equal(harness.shown.size, 0);
  let saved = false;
  const value = { endpoint: 'https://web.push.apple.com/old', publicKey: new Uint8Array(65) };
  await dispatch('message', { data: { type: 'pi-web:push-settings', value }, ports: [{ postMessage: (data) => { saved = data.saved; } }] });
  assert.equal(saved, true);
  harness.setSubscription({ endpoint: 'https://web.push.apple.com/new', toJSON: () => ({ endpoint: 'https://web.push.apple.com/new', keys: { auth: 'auth', p256dh: 'public' } }) });
  await dispatch('pushsubscriptionchange', { oldSubscription: { endpoint: value.endpoint, options: { userVisibleOnly: true } } });
  const renewal = harness.fetches.find((request) => request.url === '/api/push/subscription');
  const body = JSON.parse(renewal.options.body);
  assert.equal(body.previousEndpoint, value.endpoint);
  assert.equal(body.subscription.endpoint, 'https://web.push.apple.com/new');
  assert.deepEqual(Object.keys(body).sort(), ['previousEndpoint', 'subscription']);
  await dispatch('message', { data: { type: 'pi-web:push-settings', value: null }, ports: [] });
  const count = harness.fetches.length;
  await dispatch('pushsubscriptionchange', {});
  assert.equal(harness.fetches.length, count, 'a disabled browser must not silently resubscribe');
});
