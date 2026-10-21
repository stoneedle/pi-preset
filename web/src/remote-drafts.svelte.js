import { SvelteMap } from 'svelte/reactivity';

// A pending receipt may outlive the mounted conversation. All views share the same composer.
const composers = new SvelteMap();

export const newTaskDraft = $state({
  text: '',
  images: [],
  sending: false,
  error: '',
  notice: '',
  path: '',
  provider: '',
  model: '',
  thinking: '',
  fast: null,
  createdId: '',
  modelEdited: false,
  thinkingEdited: false,
});

export function lastSubmittedProject() {
  try {
    return localStorage.getItem('pi-web:last-project') || '';
  } catch {
    return '';
  }
}

export function rememberSubmittedProject(path) {
  if (!path) return;
  try {
    localStorage.setItem('pi-web:last-project', path);
  } catch {
    /* Optional preference. */
  }
}

export function sessionComposer(id) {
  if (!composers.has(id)) {
    const composer = $state({ text: '', images: [], sending: false, error: '', notice: '' });
    composers.set(id, composer);
  }
  return composers.get(id);
}
