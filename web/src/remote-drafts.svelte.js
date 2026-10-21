import { SvelteMap } from 'svelte/reactivity';

// A pending receipt may outlive the mounted conversation. All views share the same composer.
const composers = new SvelteMap();

export function sessionComposer(id) {
  if (!composers.has(id)) {
    const composer = $state({ text: '', images: [], sending: false, error: '', notice: '' });
    composers.set(id, composer);
  }
  return composers.get(id);
}
