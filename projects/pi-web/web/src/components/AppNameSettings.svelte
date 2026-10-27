<script>
  import { onDestroy, tick } from 'svelte';
  import { icon, X } from '../shared/icons.js';
  import { request } from '../remote-api.js';
  import { appName, applyAppName } from '../remote-app-name.svelte.js';

  let dialog = $state(null);
  let input = $state(null);
  let value = $state('');
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let edited = false;
  let readController;

  function stopReading() {
    readController?.abort();
    readController = null;
    loading = false;
  }

  export async function open() {
    stopReading();
    value = appName.override;
    edited = false;
    error = '';
    dialog.showModal();
    await tick();
    input?.focus();
    const controller = new AbortController();
    readController = controller;
    loading = true;
    try {
      const data = await request('/api/app-name', { signal: controller.signal });
      if (controller.signal.aborted) return;
      applyAppName(data);
      if (!edited) value = appName.override;
    } catch (err) {
      if (!controller.signal.aborted) error = err.message;
    } finally {
      if (readController === controller) {
        loading = false;
        readController = null;
      }
    }
  }

  async function save() {
    if (saving || loading) return;
    saving = true;
    error = '';
    try {
      const data = await request('/api/app-name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value }),
      });
      applyAppName(data);
      dialog?.close();
    } catch (err) {
      error = err.message;
    } finally {
      saving = false;
    }
  }

  onDestroy(stopReading);
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<dialog class="app-name-dialog" aria-label="应用名称" bind:this={dialog} onclose={stopReading}>
  <header>
    <h2>应用名称</h2>
    <button type="button" aria-label="关闭应用名称" onclick={() => dialog.close()}
      >{@html icon(X)}</button
    >
  </header>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      save();
    }}
  >
    <label for="app-name-input">自定义名称</label>
    <input
      id="app-name-input"
      type="text"
      autocomplete="off"
      placeholder={appName.hostname || '留空使用主机名'}
      bind:this={input}
      bind:value
      disabled={saving}
      oninput={() => (edited = true)}
      aria-describedby="app-name-help"
    />
    <p id="app-name-help">留空并保存即可恢复主机名。此电脑的手机和 PC 共用同一名称。</p>
    {#if appName.hostname}<p>主机名：{appName.hostname}</p>{/if}
    <p>网页中的名称立即更新；已安装图标的名称由手机系统更新，可能需要重新添加。</p>
    {#if error}<p role="alert">{error}</p>{/if}
    <footer>
      <button type="button" disabled={saving} onclick={() => dialog.close()}>取消</button>
      <button type="submit" disabled={saving || loading}
        >{saving ? '保存中…' : loading ? '读取中…' : '保存'}</button
      >
    </footer>
  </form>
</dialog>

<style>
  .app-name-dialog {
    width: min(460px, calc(100vw - 24px));
    max-height: calc(var(--remote-height, 100dvh) - 24px);
    overflow: auto;
    padding: 20px;
    border: 1px solid var(--dim);
    border-radius: 24px;
    background: var(--surface);
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .app-name-dialog::backdrop {
    background: #0009;
  }
  header,
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-size: 16px;
  }
  form {
    margin-top: 16px;
  }
  input {
    display: block;
    width: 100%;
    min-width: 0;
    margin-top: 8px;
  }
  p {
    color: var(--muted);
    font-size: 13px;
  }
  [role='alert'] {
    color: var(--danger);
  }
  footer {
    justify-content: flex-end;
    flex-wrap: wrap;
    margin-top: 20px;
  }
</style>
