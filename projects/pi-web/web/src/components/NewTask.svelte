<script>
  import { onDestroy, flushSync } from 'svelte';
  import { icon, X, Folder, ChevronsUpDown } from '../shared/icons.js';
  import { request } from '../remote-api.js';
  import { beginControl } from '../remote-activity.js';
  import {
    newTaskDraft as draft,
    lastSubmittedProject,
    rememberSubmittedProject,
    moveNewTaskDraft,
    captureDraft,
    completeDraft,
    submitSessionMessage,
  } from '../remote-drafts.svelte.js';
  import RemoteComposer from './RemoteComposer.svelte';
  import SkillSuggestions from './SkillSuggestions.svelte';
  import ProjectPicker from './ProjectPicker.svelte';
  import RefreshError from './RefreshError.svelte';
  let dialog = $state(null);
  let opened = $state(false);
  let closing = $state(false);
  let closeTimer;
  let projects = $state(null);
  let textarea = $state(null);
  let models = $state([]);
  let modelsLoading = $state(false);
  let modelsError = $state('');
  let optionsEpoch = 0;
  let optionsController;
  let disposed = false;
  const post = (url, body) =>
    request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  export function isOpen() {
    return dialog?.open || false;
  }
  export function open(path) {
    if (typeof path === 'string' && path && !draft.createdId) draft.path = path;
    if (!draft.path) draft.path = lastSubmittedProject();
    draft.error = '';
    closing = false;
    clearTimeout(closeTimer);
    draft.open = true;
    flushSync(() => (opened = true));
    dialog.showModal();
    textarea?.focus({ preventScroll: true });
    loadOptions();
  }
  function close() {
    if (draft.sending || closing) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      dialog.close();
      return;
    }
    closing = true;
    closeTimer = setTimeout(() => dialog.close(), 160);
  }
  async function loadOptions() {
    optionsController?.abort();
    optionsController = new AbortController();
    const epoch = ++optionsEpoch;
    modelsLoading = true;
    modelsError = '';
    try {
      const data = await request('/api/project-options?path=' + encodeURIComponent(draft.path), {
        signal: optionsController.signal,
      });
      if (epoch !== optionsEpoch) return;
      models = data.models || [];
      if (!draft.modelEdited) {
        draft.model = data.model || '';
        draft.provider = data.provider || '';
      }
      if (!draft.thinkingEdited) {
        const selected = models.find(
          (item) => item.id === draft.model && item.provider === draft.provider,
        );
        draft.thinking = selected?.thinking || data.thinking || '';
      }
    } catch (err) {
      if (epoch === optionsEpoch && err.name !== 'AbortError') modelsError = err.message;
    } finally {
      if (epoch === optionsEpoch) modelsLoading = false;
    }
  }
  function navigate(id) {
    if (disposed || !dialog?.open) return;
    dialog.close();
    history.pushState(null, '', '/session?id=' + encodeURIComponent(id));
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  function selectedSettings() {
    return {
      ...(draft.provider && draft.model ? { provider: draft.provider, modelId: draft.model } : {}),
      ...(draft.thinking ? { thinking: draft.thinking } : {}),
      ...(draft.fast?.mode ? { speed: draft.fast.mode } : {}),
    };
  }
  function recover() {
    const id = draft.createdId;
    moveNewTaskDraft(id, selectedSettings());
    navigate(id);
  }
  async function send(event) {
    event.preventDefault();
    if (draft.sending || !draft.path || (!draft.text.trim() && !draft.images.length)) return;
    draft.sending = true;
    draft.error = '';
    const submitted = captureDraft(draft, selectedSettings());
    const finish = beginControl();
    try {
      if (!draft.createdId)
        draft.createdId = (await post('/api/new-session', { path: draft.path })).id;
      if (!(await submitSessionMessage(draft.createdId, submitted, draft))) return;
      rememberSubmittedProject(draft.path);
      const id = draft.createdId;
      completeDraft(draft, submitted);
      moveNewTaskDraft(id);
      navigate(id);
    } catch (err) {
      draft.error = err.message;
    } finally {
      draft.sending = false;
      finish();
    }
  }
  onDestroy(() => {
    disposed = true;
    draft.open = false;
    optionsEpoch++;
    clearTimeout(closeTimer);
    optionsController?.abort();
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<dialog
  class="new-task"
  class:closing
  aria-label="新对话"
  bind:this={dialog}
  onclose={() => {
    if (dialog.open) return;
    draft.open = false;
    opened = false;
    closing = false;
    optionsEpoch++;
    optionsController?.abort();
    modelsLoading = false;
  }}
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
>
  {#if opened}
    <header>
      <button type="button" aria-label="关闭新对话" disabled={draft.sending} onclick={close}
        >{@html icon(X, { size: 22 })}</button
      ><strong>新对话</strong><span></span>
    </header>
    <div class="new-task-body">
      <div class="new-task-space"></div>
      <div class="new-task-context">
        <button
          class="new-task-project"
          type="button"
          aria-label="选择项目"
          disabled={draft.sending || Boolean(draft.createdId)}
          onclick={() => projects.open(draft.path)}
        >
          {@html icon(Folder, { size: 21 })}<span
            >{draft.path.split(/[\\/]/).filter(Boolean).at(-1) || '选择项目'}</span
          >{@html icon(ChevronsUpDown, { size: 16 })}
        </button>
      </div>
      <RefreshError />
      {#if draft.error}<p class="new-task-error" role="alert">{draft.error}</p>{/if}
      {#if draft.createdId && (draft.error || draft.recoveries.length)}<p class="new-task-recovery">
          会话已创建，内容仍保留。<button type="button" onclick={recover}>打开会话继续</button>
        </p>{/if}
      <SkillSuggestions
        composer={draft}
        url={draft.createdId
          ? '/api/commands?id=' + encodeURIComponent(draft.createdId)
          : draft.path
            ? '/api/commands?path=' + encodeURIComponent(draft.path)
            : ''}
        onselect={() => textarea?.focus({ preventScroll: true })}
      />
      <RemoteComposer
        composer={draft}
        canSend={Boolean(draft.path)}
        onsend={send}
        status={{
          model: draft.model,
          provider: draft.provider,
          thinking: draft.thinking,
          fast: draft.fast,
        }}
        {models}
        {modelsLoading}
        {modelsError}
        onmodelopen={loadOptions}
        onmodel={(model) => {
          draft.modelEdited = true;
          draft.thinkingEdited = false;
          draft.model = model.id;
          draft.provider = model.provider;
          draft.thinking = model.thinking || '';
        }}
        onthinking={(level) => {
          draft.thinkingEdited = true;
          draft.thinking = level;
        }}
        onspeed={(mode) => (draft.fast = mode === null ? null : { mode })}
        bind:textarea
        draftMode
      />
    </div>
  {/if}
</dialog>
<ProjectPicker
  bind:this={projects}
  onselect={(path) => {
    draft.path = path;
    draft.modelEdited = false;
    draft.thinkingEdited = false;
    draft.model = '';
    draft.provider = '';
    draft.thinking = '';
    draft.fast = null;
    loadOptions();
    textarea?.focus({ preventScroll: true });
  }}
/>

<style>
  .new-task {
    position: fixed;
    inset: 0;
    width: 100vw;
    max-width: none;
    height: var(--remote-height, 100dvh);
    max-height: var(--remote-height, 100dvh);
    margin: 0;
    padding: env(safe-area-inset-top) 0 0;
    border: 0;
    border-radius: 0;
    color: var(--text);
    background: var(--body-bg);
    overflow: hidden;
  }
  .new-task[open] {
    display: flex;
    flex-direction: column;
    animation: new-task-in 280ms var(--ease-out);
  }
  .new-task.closing {
    animation: new-task-out 160ms ease-in forwards;
  }
  @keyframes new-task-out {
    to {
      opacity: 0;
      transform: translateY(18px);
    }
  }
  .new-task::backdrop {
    background: var(--body-bg);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    max-width: 800px;
    padding: 10px 16px;
    margin: 0 auto;
    flex: none;
  }
  header button {
    display: grid;
    place-items: center;
    flex: none;
    width: 42px;
    min-height: 42px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--surface-2);
  }
  header strong {
    font-size: 16px;
    font-weight: 550;
  }
  header > span {
    width: 42px;
  }
  .new-task-body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    width: 100%;
    max-width: 800px;
    padding: 0 12px max(12px, env(safe-area-inset-bottom));
    margin: 0 auto;
  }
  .new-task-space {
    flex: 1;
    min-height: 12px;
  }
  .new-task-context {
    flex: none;
    min-height: 0;
    overflow: auto;
    margin: 0 12px 16px;
  }
  .new-task-project {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    min-height: 48px;
    padding: 10px 6px;
    color: var(--muted);
    border: 0;
    border-radius: 12px;
    background: transparent;
    text-align: left;
    font-size: 17px;
  }
  .new-task-project:hover {
    background: var(--surface-2);
  }
  .new-task-context span {
    min-width: 0;
    max-width: calc(100% - 68px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .new-task-context :global(svg) {
    flex: none;
  }
  .new-task-error,
  .new-task-recovery {
    flex: 0 1 auto;
    min-height: 0;
    max-height: 80px;
    overflow: auto;
    font-size: 12px;
    padding: 0 10px;
    margin: 0 0 8px;
    overflow-wrap: anywhere;
  }
  .new-task-error {
    color: var(--danger);
  }
  .new-task-recovery button {
    color: var(--link);
    border: 0;
    background: transparent;
    padding: 2px 0;
    min-height: 32px;
    font-size: inherit;
  }
  .new-task-recovery {
    color: var(--muted);
  }
  @keyframes new-task-in {
    from {
      opacity: 0.6;
      transform: translateY(24px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .new-task[open] {
      animation: none;
    }
  }
</style>
