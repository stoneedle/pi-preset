import { SvelteURL } from 'svelte/reactivity';

const initialName = document.querySelector('meta[name="application-name"]')?.content || '';

export const appName = $state({
  name: initialName,
  hostname: '',
  override: '',
  revision: -1,
});

// POST replies and SSE may arrive out of order; the persisted revision owns ordering.
export function applyAppName(value) {
  if (value.revision < appName.revision) return;
  const renamed = value.name !== appName.name;
  Object.assign(appName, value);
  for (const key of ['application-name', 'apple-mobile-web-app-title']) {
    const meta = document.querySelector(`meta[name="${key}"]`);
    if (meta) meta.content = value.name;
  }
  // Ask the browser to re-read metadata without replacing the document or app identity.
  const manifest = document.querySelector('link[rel="manifest"]');
  if (renamed && manifest) {
    const url = new SvelteURL(manifest.href);
    url.searchParams.set('revision', String(value.revision));
    manifest.href = url.href;
  }
}
