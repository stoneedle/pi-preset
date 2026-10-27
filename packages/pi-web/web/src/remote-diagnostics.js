// Metadata only: never pass message bodies, drafts, file paths, raw URLs or error messages.
const prefix = 'pi-web:diagnostic-outbox:';
const maxQueuedBytes = 256 * 1024;
const maxQueuedBatches = 64;
const maxAge = 7 * 24 * 60 * 60 * 1000;
const identity = () =>
  Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16)).join('-');
const page = identity();
const build = new URL(import.meta.url).pathname.split('/').pop();
let client = identity();
try {
  client = localStorage.getItem('pi-web:diagnostic-client') || client;
  localStorage.setItem('pi-web:diagnostic-client', client);
} catch {
  // Storage is optional; online diagnostics still reach the server.
}
const memory = new Map();
const uploading = new Set();
let events = [];
let sequence = 0;
let flushTimer;
let uploadTimer;
let draining = false;
let urgent = false;
let failures = 0;
let started = false;

export function diagnosticId(value) {
  if (!value) return '';
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

function pendingBatches() {
  const batches = new Map(memory);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      try {
        const batch = JSON.parse(localStorage.getItem(key));
        if (Array.isArray(batch?.events)) batches.set(key, batch);
      } catch {
        // A corrupt diagnostic entry cannot interrupt communication or editing.
      }
    }
  } catch {
    // Use the bounded memory outbox when storage is unavailable.
  }
  return [...batches].sort((a, b) => b[1].created - a[1].created);
}

function forget(key) {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // A later page may retry this same immutable batch; the server deduplicates it.
  }
}

function trim() {
  let bytes = 0;
  let count = 0;
  for (const [key, batch] of pendingBatches()) {
    bytes += JSON.stringify(batch).length * 2;
    count++;
    if (batch.created < Date.now() - maxAge || count > maxQueuedBatches || bytes > maxQueuedBytes)
      forget(key);
  }
}

function scheduleUpload(delay = 5000) {
  if (!started || uploadTimer || document.hidden || navigator.onLine === false) return;
  uploadTimer = setTimeout(drain, delay);
}

async function upload(key, batch) {
  if (uploading.has(key) || navigator.onLine === false) return false;
  uploading.add(key);
  try {
    const response = await fetch('/api/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(batch),
      credentials: 'same-origin',
      priority: 'low',
      keepalive: true,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return false;
    forget(key);
    return true;
  } catch {
    // Diagnostics never enter the control/request counters or log their own retries.
    return false;
  } finally {
    uploading.delete(key);
  }
}

async function drain() {
  clearTimeout(uploadTimer);
  uploadTimer = null;
  if (draining || document.hidden || navigator.onLine === false) return;
  draining = true;
  try {
    const batches = pendingBatches()
      .reverse()
      .filter(([key]) => !uploading.has(key));
    for (const [key, batch] of batches.slice(0, 4)) {
      if (!(await upload(key, batch))) {
        failures++;
        return;
      }
      failures = 0;
    }
  } finally {
    draining = false;
    if (pendingBatches().length)
      scheduleUpload(failures ? Math.min(60000, 5000 * 2 ** Math.min(failures, 4)) : 1000);
  }
}

function flush(immediate = false) {
  clearTimeout(flushTimer);
  flushTimer = null;
  let latest;
  while (events.length) {
    const batch = {
      client,
      page,
      build,
      userAgent: navigator.userAgent.slice(0, 512),
      created: Date.now(),
      events: events.splice(0, 30),
    };
    const key = `${prefix}${page}:${batch.events[0].seq}`;
    // Immutable batches let old and new documents safely deliver the same outbox.
    memory.set(key, batch);
    try {
      localStorage.setItem(key, JSON.stringify(batch));
    } catch {
      // The memory outbox still works, without affecting the application.
    }
    latest = [key, batch];
  }
  trim();
  scheduleUpload();
  if (immediate && latest && !urgent && navigator.onLine !== false) {
    urgent = true;
    void upload(...latest).finally(() => {
      urgent = false;
      scheduleUpload();
    });
  }
}

export function trace(event, fields = {}, immediate = false) {
  events.push({
    ...fields,
    event,
    seq: ++sequence,
    time: Date.now(),
    elapsed: Math.round(performance.now()),
  });
  if (immediate) flush(true);
  else flushTimer ??= setTimeout(() => flush(), 1000);
}

// Save the intent synchronously before navigation; delivery survives a document replacement.
export function reloadDocument(reason) {
  trace('page.reload', { reason }, true);
  location.reload();
}

export function startDiagnostics() {
  if (started) return;
  started = true;
  const navigation = performance.getEntriesByType('navigation')[0];
  let previousPage = '';
  try {
    previousPage = sessionStorage.getItem('pi-web:diagnostic-page') || '';
    sessionStorage.setItem('pi-web:diagnostic-page', page);
  } catch {
    // Cross-document linkage is optional when the browser denies session storage.
  }
  trace(
    'page.start',
    {
      previousPage,
      navigation: navigation?.type || 'unknown',
      discarded: document.wasDiscarded ?? null,
      standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
      hidden: document.hidden,
      online: navigator.onLine,
    },
    true,
  );
  const resume = () => {
    if (document.hidden || navigator.onLine === false) return;
    clearTimeout(uploadTimer);
    uploadTimer = null;
    scheduleUpload(100);
  };
  document.addEventListener('visibilitychange', () => {
    trace('page.visibility', { hidden: document.hidden }, true);
    resume();
  });
  document.addEventListener('freeze', () => trace('page.freeze', {}, true));
  document.addEventListener('resume', () => {
    trace('page.resume', {}, true);
    resume();
  });
  for (const name of ['pageshow', 'pagehide'])
    window.addEventListener(name, (event) =>
      trace(`page.${name}`, { persisted: event.persisted }, true),
    );
  for (const name of ['focus', 'online', 'offline'])
    window.addEventListener(name, () => {
      trace(`page.${name}`, {}, true);
      resume();
    });
  window.addEventListener('error', (event) =>
    trace('page.error', { category: event.error?.name || 'resource', line: event.lineno }),
  );
  window.addEventListener('unhandledrejection', (event) =>
    trace('page.rejection', { category: event.reason?.name || 'unknown' }),
  );
  trim();
  resume();
}
