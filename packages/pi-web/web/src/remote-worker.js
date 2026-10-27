import { trace } from './remote-diagnostics.js';

// Registration never owns the current document's lifetime. Updates wait for old clients.
export function registerWorker() {
  if (!('serviceWorker' in navigator) || !isSecureContext) return;
  navigator.serviceWorker
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .then((registration) => trace('worker.registered', { waiting: Boolean(registration.waiting) }))
    .catch((error) => trace('worker.error', { category: error.name }));
}
