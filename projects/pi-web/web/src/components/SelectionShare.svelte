<script>
  import { onDestroy } from 'svelte';
  import { icon, Share2, Download, Copy, X } from '../shared/icons.js';
  import { request } from '../remote-api.js';
  import { readBlock } from '../remote-cache.js';

  let { surface, sessionId, messages, blockViews, title, cwd } = $props();
  let dialog;
  let scope = $state('full');
  const heading = $derived(scope === 'loaded' ? '分享已加载上下文' : '分享完整会话');
  let selected = $state('');
  let quote = $state('');
  let left = $state(0);
  let top = $state(0);
  let file = $state(null);
  let preparing = $state(false);
  let sharing = $state(false);
  let error = $state('');
  let note = $state('');
  let canShare = $state(false);
  let controller;
  const prompt = '请结合附件中的会话记录，详细解释其中标注的选中片段。';

  $effect(() => {
    const root = surface;
    if (!root) return;
    let selecting = false;
    function update() {
      if (dialog?.open || selecting) return;
      const selection = window.getSelection();
      const inside = (node) => {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        return (
          element &&
          root.contains(element) &&
          element.closest('[data-message-id]') &&
          !element.closest('input, textarea, [contenteditable="true"]')
        );
      };
      if (
        !selection?.rangeCount ||
        selection.isCollapsed ||
        !inside(selection.anchorNode) ||
        !inside(selection.focusNode)
      ) {
        selected = '';
        return;
      }
      selected = selection.toString().trim();
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const bounds = root.getBoundingClientRect();
      const halfWidth = Math.min(280, innerWidth - 24) / 2;
      left = Math.max(
        12 + halfWidth,
        Math.min(innerWidth - 12 - halfWidth, rect.left + rect.width / 2),
      );
      const targetTop = rect.bottom + 104 <= bounds.bottom ? rect.bottom + 8 : rect.top - 104;
      top = Math.max(bounds.top + 8, Math.min(bounds.bottom - 104, targetTop));
    }
    const contextmenu = (event) => {
      update();
      // Only replace a context menu when a real conversation selection exists.
      // Mobile selection handles and the platform's native action bar stay intact.
      if (selected && matchMedia('(pointer: fine)').matches) event.preventDefault();
    };
    const startSelection = (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      selecting = true;
      selected = '';
    };
    const endSelection = () => {
      selecting = false;
      update();
    };
    document.addEventListener('selectionchange', update);
    root.addEventListener('pointerdown', startSelection);
    document.addEventListener('pointerup', endSelection);
    document.addEventListener('pointercancel', endSelection);
    root.addEventListener('contextmenu', contextmenu);
    root.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      document.removeEventListener('selectionchange', update);
      root.removeEventListener('pointerdown', startSelection);
      document.removeEventListener('pointerup', endSelection);
      document.removeEventListener('pointercancel', endSelection);
      root.removeEventListener('contextmenu', contextmenu);
      root.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  });

  function loadedContext() {
    const parts = [
      `# 会话：${title}\n\n项目：${cwd}`,
      '范围：当前页面已加载及后台预取的会话正文、工具摘要和已读取的工具正文。不保证覆盖完整会话；未额外补取折叠正文。',
      '不包含图片原件、思考、系统提示、未发送草稿或额外读取的项目文件。',
    ];
    for (const message of messages) {
      const body = [];
      for (const block of message.blocks) {
        if (block.type === 'text') body.push(block.text || '');
        else if (block.type === 'image') body.push('[图片未包含]');
        else if (block.type === 'tool') {
          const detail =
            blockViews[`${message.id}:${block.index}`]?.loadedBody() ||
            readBlock(sessionId, message.id, block.index);
          const loaded = detail
            ? [
                detail.input ? JSON.stringify(detail.input, null, 2) : '',
                detail.text || '',
                detail.details ? JSON.stringify(detail.details, null, 2) : '',
              ]
                .filter(Boolean)
                .join('\n\n')
            : '';
          body.push(`工具：${block.name}\n${loaded || `摘要：${block.summary || ''}`}`);
        }
      }
      if (message.error) body.push(`错误：${message.error}`);
      if (body.some((text) => text.trim()))
        parts.push(`## ${message.role === 'user' ? '用户' : 'Pi'}\n\n${body.join('\n\n')}`);
    }
    return parts.join('\n\n');
  }

  function setFile(text, title) {
    const name = title.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').slice(0, 60) || '会话';
    file = new File(
      [`${prompt}\n\n# 选中片段\n\n${quote}\n\n# 会话记录\n\n${text}`],
      `Pi-${name}-${scope === 'loaded' ? '已加载上下文' : '上下文'}.txt`,
      { type: 'text/plain' },
    );
    canShare = Boolean(navigator.share && navigator.canShare?.({ files: [file] }));
  }

  async function prepare() {
    controller?.abort();
    const pending = new AbortController();
    controller = pending;
    preparing = true;
    file = null;
    canShare = false;
    error = '';
    note = '';
    try {
      const context = await request(`/api/session/context?id=${encodeURIComponent(sessionId)}`, {
        signal: pending.signal,
      });
      if (pending.signal.aborted) return;
      setFile(context.text, context.name);
    } catch (err) {
      if (!pending.signal.aborted) error = `准备失败：${err.message}`;
    } finally {
      if (controller === pending) preparing = false;
    }
  }

  function open(value) {
    scope = value;
    quote = selected;
    selected = '';
    error = '';
    note = '';
    dialog.showModal();
    window.getSelection()?.removeAllRanges();
  }

  function shareLoaded() {
    open('loaded');
    try {
      setFile(loadedContext(), title);
      // The complete local snapshot and native share happen in this same click.
      if (canShare) share();
    } catch (err) {
      error = `准备失败：${err.message}`;
    }
  }

  function prepareFull() {
    open('full');
    prepare();
  }

  function close() {
    if (!sharing) dialog.close();
  }

  function reset() {
    controller?.abort();
    controller = null;
    file = null;
    quote = '';
    selected = '';
    preparing = false;
    error = '';
    note = '';
  }

  async function share() {
    if (!file || sharing) return;
    sharing = true;
    error = '';
    note = '';
    try {
      // No fetch/await before this call: native sharing needs this click's activation.
      await navigator.share({ files: [file], title: 'Pi 会话上下文', text: prompt });
    } catch (err) {
      if (err.name !== 'AbortError') error = `分享失败：${err.message}。可以下载 TXT 后手动添加。`;
    } finally {
      sharing = false;
    }
  }

  function download() {
    const url = URL.createObjectURL(file);
    const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      note = '提问已复制。';
    } catch {
      note = `请手动复制：${prompt}`;
    }
  }

  onDestroy(() => controller?.abort());
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
{#if selected}
  <div
    class="selection-share"
    role="group"
    aria-label="选区操作"
    style:left={`${left}px`}
    style:top={`${top}px`}
  >
    <button
      type="button"
      onpointerdown={(event) => event.preventDefault()}
      onclick={shareLoaded}
      aria-label="分享已加载上下文"
      >{@html icon(Share2, { size: 16 })}分享已加载上下文<small>立即</small></button
    >
    <button
      type="button"
      onpointerdown={(event) => event.preventDefault()}
      onclick={prepareFull}
      aria-label="分享完整会话"
      >{@html icon(Share2, { size: 16 })}分享完整会话<small>等待全量</small></button
    >
  </div>
{/if}

<dialog
  bind:this={dialog}
  class="context-share"
  aria-label={heading}
  onclose={reset}
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
>
  <header>
    <strong>{heading}</strong>
    <button type="button" aria-label="关闭分享" disabled={sharing} onclick={close}
      >{@html icon(X, { size: 18 })}</button
    >
  </header>
  {#if scope === 'loaded'}
    <p>TXT 包含选中片段与本页已加载、后台预取的会话文字；工具保留摘要和已读取正文，无需联网。</p>
  {:else}
    <p>TXT 包含选中片段与当前分支的完整会话文字、工具输入输出和历史摘要，不只是已加载的消息。</p>
  {/if}
  <p class="scope">不包含图片原件、思考、系统提示、未发送草稿，也不会额外读取项目文件。</p>
  <blockquote>{quote}</blockquote>
  {#if preparing}
    <p role="status">正在准备 TXT…</p>
  {:else if file}
    <p class="file">
      {file.name} · {Math.max(1, Math.ceil(file.size / 1024)).toLocaleString('zh-CN')} KB
    </p>
    {#if !canShare}
      <p>当前浏览器无法分享此文件。请下载 TXT，在 ChatGPT 中通过附件按钮添加。</p>
    {:else}
      <p>点击后由系统选择接收应用；若没有 ChatGPT，请下载后手动添加附件。</p>
    {/if}
    <div class="actions">
      {#if canShare}<button type="button" class="primary" disabled={sharing} onclick={share}
          >{@html icon(Share2, { size: 18 })}{sharing ? '分享中…' : '分享 TXT'}</button
        >{/if}
      <button type="button" disabled={sharing} onclick={download}
        >{@html icon(Download, { size: 18 })}下载 TXT</button
      >
      <button type="button" disabled={sharing} onclick={copyPrompt}
        >{@html icon(Copy, { size: 18 })}复制提问</button
      >
    </div>
  {:else}
    <button
      type="button"
      onclick={scope === 'loaded' ? () => setFile(loadedContext(), title) : prepare}
      >重新准备</button
    >
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if note}<p role="status">{note}</p>{/if}
</dialog>

<style>
  .selection-share {
    position: fixed;
    z-index: 30;
    display: flex;
    flex-direction: column;
    width: min(280px, calc(100vw - 24px));
    box-sizing: border-box;
    transform: translateX(-50%);
    padding: 4px;
    border: 1px solid var(--dim);
    border-radius: 12px;
    color: var(--text);
    background: var(--surface);
    box-shadow: 0 4px 16px #0002;
    white-space: nowrap;
  }
  .selection-share button {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 8px 10px;
    border: 0;
    background: transparent;
    white-space: nowrap;
    font-size: 14px;
  }
  .selection-share small {
    margin-left: auto;
    color: var(--muted);
    font-size: 12px;
  }
  .context-share {
    width: min(480px, calc(100vw - 24px));
    max-width: none;
    max-height: calc(var(--remote-height, 100dvh) - 24px);
    box-sizing: border-box;
    padding: 16px;
    overflow: auto;
    border: 1px solid var(--dim);
    border-radius: 20px;
    color: var(--text);
    background: var(--surface);
  }
  .context-share::backdrop {
    background: #0005;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  header button {
    display: grid;
    place-items: center;
    padding: 10px;
    border: 0;
    background: transparent;
  }
  p,
  blockquote {
    margin: 12px 0;
    font-size: 14px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .scope,
  .file {
    color: var(--muted);
    font-size: 12px;
  }
  blockquote {
    max-height: 20dvh;
    padding: 8px 12px;
    overflow: auto;
    border-left: 2px solid var(--dim);
    background: var(--surface-2);
    white-space: pre-wrap;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 44px;
    padding: 8px 12px;
    white-space: nowrap;
  }
  [role='alert'] {
    color: var(--danger);
  }
</style>
