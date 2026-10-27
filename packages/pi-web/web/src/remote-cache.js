import { diagnosticId, trace } from './remote-diagnostics.js';

// Same-tab, same-origin memory only. A session's window and loaded blocks share one budget.
const views = new Map();
let bytes = 0;
const maxBytes = 64 * 1024 * 1024;
const listeners = new Set();
const sizeOf = (value) => JSON.stringify(value).length * 2;

function read(key, part) {
  const entry = views.get(key);
  const item = entry?.items.get(part);
  if (!item) return null;
  views.delete(key);
  views.set(key, entry);
  entry.items.delete(part);
  entry.items.set(part, item);
  return item.value;
}

function remember(key, part, value, prefetch = false) {
  if (prefetch && !canPrefetchView(key, value)) return false;
  const entry = views.get(key) || { items: new Map(), bytes: 0 };
  if (!prefetch) views.delete(key);
  const remove = (part) => {
    const item = entry.items.get(part);
    if (!item) return;
    bytes -= item.bytes;
    entry.bytes -= item.bytes;
    entry.items.delete(part);
  };
  remove(part);
  const size = sizeOf(value);
  if (size <= maxBytes) {
    entry.items.set(part, { value, bytes: size });
    entry.bytes += size;
    bytes += size;
  }
  // A large expanded body must not evict its own message window.
  for (const part of entry.items.keys()) {
    if (entry.bytes <= maxBytes) break;
    if (part !== 'view') remove(part);
  }
  if (entry.items.size) views.set(key, entry);
  while (bytes > maxBytes || views.size > 8) {
    const oldest = views.keys().next().value;
    trace('cache.evict', {
      key: diagnosticId(oldest),
      reason: bytes > maxBytes ? 'bytes' : 'count',
      bytes,
      count: views.size,
    });
    bytes -= views.get(oldest).bytes;
    views.delete(oldest);
  }
  for (const listener of listeners) listener();
  return true;
}

// Speculation never promotes a session or evicts anything the user has already read.
export function canPrefetchView(key, value) {
  const entry = views.get(key);
  const previous = entry?.items.get('view');
  if (!previous) return false;
  const size = sizeOf(value);
  return size <= 8 * 1024 * 1024 && bytes - previous.bytes + size <= maxBytes;
}

export function sessionViews() {
  return [...views]
    .reverse()
    .filter(([key, entry]) => key.startsWith('session:') && entry.items.has('view'))
    .map(([key, entry]) => ({ id: key.slice(8), view: entry.items.get('view').value }));
}

export function observeViews(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readView(key) {
  return read(key, 'view');
}

export function rememberView(key, value, { prefetch = false } = {}) {
  return remember(key, 'view', value, prefetch);
}

export function readBlock(sessionId, entryId, index) {
  return read(`session:${sessionId}`, `block:${entryId}:${index}`);
}

export function rememberBlock(sessionId, entryId, index, body) {
  remember(`session:${sessionId}`, `block:${entryId}:${index}`, body);
}
