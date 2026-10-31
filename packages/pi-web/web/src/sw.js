import './push-worker.js';
import { cacheNames, clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';

// Native waiting keeps old clients' assets alive; there is no forced activation or reload.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();

// A freshly loaded page can be newer than its controller. Both releases share this
// immutable asset cache, so the old controller can also serve the waiting release.
registerRoute(
  ({ url }) =>
    url.origin === self.location.origin &&
    /^\/static\/assets\/[^/]+\.(?:js|css|woff2)$/.test(url.pathname),
  async ({ request }) => {
    const cache = await caches.open(cacheNames.precache);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(request);
    // Lazy editor resources become available offline only after they are used.
    if (response.ok) {
      try {
        await cache.put(request, response.clone());
      } catch {
        // Storage pressure must not turn a successful asset load into a failure.
      }
    }
    return response;
  },
);
