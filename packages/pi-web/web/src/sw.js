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
    /^\/static\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname),
  async ({ request }) =>
    (await caches.match(request, { cacheName: cacheNames.precache, ignoreSearch: true })) ||
    fetch(request),
);
