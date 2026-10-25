import { SvelteMap } from 'svelte/reactivity';
import { request } from './remote-api.js';

// A pending receipt may outlive the mounted conversation. All views share the same composer.
const composers = new SvelteMap();
let nextIdentity = 0;

export const newTaskDraft = $state({
  draftId: ++nextIdentity,
  text: '',
  revision: 0,
  images: [],
  recoveries: [],
  composing: false,
  picking: false,
  open: false,
  sending: false,
  error: '',
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
    const composer = $state({
      draftId: ++nextIdentity,
      text: '',
      revision: 0,
      images: [],
      recoveries: [],
      composing: false,
      picking: false,
      sending: false,
      settings: {},
    });
    composers.set(id, composer);
  }
  return composers.get(id);
}

export function hasUnsavedDrafts() {
  const hasContent = (draft) =>
    Boolean(
      draft.text.length ||
      draft.images.length ||
      draft.recoveries.length ||
      draft.sending ||
      draft.composing ||
      draft.picking,
    );
  if (
    hasContent(newTaskDraft) ||
    newTaskDraft.open ||
    newTaskDraft.createdId ||
    newTaskDraft.modelEdited ||
    newTaskDraft.thinkingEdited ||
    newTaskDraft.fast !== null
  )
    return true;
  for (const composer of composers.values()) {
    if (hasContent(composer) || Object.keys(composer.settings).length) return true;
  }
  return false;
}

export function editDraft(composer, text) {
  composer.revision++;
  composer.text = text;
}

export function captureDraft(composer, settings = composer.settings || {}) {
  return {
    draftId: composer.draftId,
    text: composer.text,
    revision: composer.revision,
    images: [...composer.images],
    settings: { ...settings },
  };
}

export function completeDraft(composer, submitted) {
  if (composer.revision === submitted.revision) editDraft(composer, '');
  composer.images = composer.images.filter((image) => !submitted.images.includes(image));
  if (composer.settings) {
    for (const [key, value] of Object.entries(submitted.settings)) {
      if (composer.settings[key] === value) delete composer.settings[key];
    }
  }
}

export function moveNewTaskDraft(id, settings = {}) {
  const target = sessionComposer(id);
  if (newTaskDraft.text)
    editDraft(target, [target.text, newTaskDraft.text].filter(Boolean).join('\n\n'));
  target.images = [...target.images, ...newTaskDraft.images];
  target.recoveries = [...target.recoveries, ...newTaskDraft.recoveries];
  target.settings = { ...target.settings, ...settings };
  editDraft(newTaskDraft, '');
  Object.assign(newTaskDraft, {
    images: [],
    recoveries: [],
    error: '',
    createdId: '',
    path: '',
    provider: '',
    model: '',
    thinking: '',
    fast: null,
    modelEdited: false,
    thinkingEdited: false,
  });
}

export function restoreSubmission(composer, id) {
  const item = composer.recoveries.find((item) => item.id === id);
  if (!item || composer.sending) return false;
  const unchanged =
    composer.draftId === item.draftId &&
    composer.revision === item.revision &&
    composer.images.length === item.images.length &&
    composer.images.every((image, index) => image === item.images[index]);
  const remaining = composer.recoveries.filter((item) => item.id !== id);
  if (!unchanged) {
    if (composer.text.length || composer.images.length)
      remaining.push({ ...captureDraft(composer), id: ++nextIdentity, state: 'draft' });
    editDraft(composer, item.text);
    composer.images = [...item.images];
  }
  composer.recoveries = remaining;
  return true;
}

export function discardRecovery(composer, id) {
  const item = composer.recoveries.find((item) => item.id === id);
  if (!item) return;
  const message =
    item.state === 'draft'
      ? '丢弃这份暂存草稿？不会影响输入框中正在编辑的内容。'
      : '忽略这条消息？保留的原文和图片将被移除，但不会取消 Pi 可能已接收的消息，也不会影响当前草稿。';
  if (window.confirm(message))
    composer.recoveries = composer.recoveries.filter((item) => item.id !== id);
}

export async function submitSessionMessage(id, submitted, composer, delivery = 'steer') {
  try {
    const form = new FormData();
    form.set('message', submitted.text);
    if (delivery === 'followUp') form.set('delivery', delivery);
    if (Object.keys(submitted.settings).length)
      form.set('settings', JSON.stringify(submitted.settings));
    for (const image of submitted.images) form.append('images', image);
    await request('/api/chat?id=' + encodeURIComponent(id), { method: 'POST', body: form });
    return true;
  } catch (error) {
    composer.recoveries.push({
      ...submitted,
      id: ++nextIdentity,
      state: error.status && error.status < 500 && !error.retryable ? 'failed' : 'uncertain',
      delivery,
      error: error.message,
    });
    return false;
  }
}
