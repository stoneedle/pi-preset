<script>
  import { onMount, tick, untrack } from 'svelte';
  import { Marked } from 'marked';
  import { icon, ArrowDown, Menu, Plus, Paperclip, Send, Square, X } from '../shared/icons.js';
  import { escapeHtml } from '../shared/escape.js';
  import RemoteBlock from '../components/RemoteBlock.svelte';
  import SessionList from '../components/SessionList.svelte';
  import HostSwitcher from '../components/HostSwitcher.svelte';
  import PushSettings from '../components/PushSettings.svelte';
  import { localFileReference, fileLinksHTML, fileDownloadURL, fileName } from '../remote-files.js';
  import { subscribeEvents } from '../remote-events.js';
  import { readView, rememberView } from '../remote-cache.js';
  import { sessionComposer } from '../remote-drafts.svelte.js';
  import {
    request,
    createRefreshCoordinator,
    createRuntimeStateStore,
    mergeMessages,
  } from '../remote-api.js';

  let { sessionId } = $props();
  const cached = untrack(() => readView(`session:${sessionId}`));
  const composer = untrack(() => sessionComposer(sessionId));
  const markdown = new Marked({ breaks: true, gfm: true });
  markdown.use({
    renderer: {
      html(token) {
        return escapeHtml(token.text);
      },
      link(token) {
        const path = localFileReference(token.href);
        if (path) return fileLinksHTML(sessionId, path, this.parser.parseInline(token.tokens));
        if (!/^(https?:|mailto:|#)/i.test(token.href || ''))
          return this.parser.parseInline(token.tokens);
        return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noreferrer">${this.parser.parseInline(token.tokens)}</a>`;
      },
      image(token) {
        const path = localFileReference(token.href);
        if (path) return fileLinksHTML(sessionId, path, escapeHtml(token.text || '打开图片'));
        if (!/^https?:\/\//i.test(token.href || '')) return escapeHtml(token.text || '打开图片');
        return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noreferrer">${escapeHtml(token.text || '打开图片')}</a>`;
      },
    },
  });

  let title = $state(cached?.title || 'Pi');
  let cwd = $state(cached?.cwd || '');
  let branch = $state(cached?.branch || '');
  let messages = $state(cached?.messages || []);
  let cursor = cached?.cursor || '';
  let windowEpoch = 0;
  const runtimeStates = createRuntimeStateStore();
  let before = $state(cached?.before || '');
  let status = $state({ state: 'unknown', canControl: false });
  let connected = $state(false);
  let loading = $state(!cached);
  let historyLoading = $state(false);
  let error = $state('');
  let contentError = $state('');
  let notice = $state('');
  let chatAvailable = $state(false);
  let chatDisabledReason = $state('');
  let viewport = $state(null);
  let awayFromBottom = $state(cached?.awayFromBottom || false);
  let observedViewportHeight = 0;
  let textarea = $state(null);
  let drawerTrigger = $state(null);
  let drawer = $state(null);
  let drawerOpen = $state(false);
  let newDialog = $state(null);
  let previewDialog = $state(null);
  let preview = $state(null);
  let previewPath = $state('');
  let previewError = $state('');
  let previewLoading = $state(false);
  let previewEpoch = 0;
  let newPath = $state('');
  let recent = $state([]);
  let models = $state([]);
  let skills = $state([]);
  let skillsLoaded = false;
  let refreshSession;
  let refreshStatus;
  let refreshAcknowledgement;
  let disposed = false;

  const activeState = $derived(connected ? status.state : 'unknown');
  const runtimeKnown = $derived(connected && status.availability === 'connected');
  const skillQuery = $derived(composer.text.match(/^\/(\S*)$/)?.[1]?.toLowerCase());
  const matchingSkills = $derived(
    skillQuery === undefined
      ? []
      : skills.filter((skill) => skill.name.toLowerCase().includes(skillQuery)).slice(0, 6),
  );
  const canSend = $derived(chatAvailable && status.canControl && connected && !composer.sending);
  const atBottom = () =>
    !viewport || viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 100;
  const bottom = () => {
    awayFromBottom = false;
    viewport?.scrollTo({ top: viewport.scrollHeight });
  };
  const stateLabels = {
    unknown: '未知',
    running: '运行中',
    background: '后台运行',
    'needs-you': '待你处理',
    idle: '空闲',
    error: '出错',
  };
  const fastLabels = { off: '关闭', fast: '快速', ultrafast: '极速' };
  const endpoint = (path) => `${path}?id=${encodeURIComponent(sessionId)}`;
  const post = (url, body) =>
    request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  function rememberSession() {
    if (!sessionId || !cursor) return;
    rememberView(`session:${sessionId}`, {
      title,
      cwd,
      branch,
      cursor,
      before,
      messages: $state.snapshot(messages),
      scrollTop: viewport?.scrollTop || 0,
      awayFromBottom,
    });
  }

  async function loadSession(signal) {
    const data = await request(
      endpoint('/api/session') + (cursor ? `&after=${encodeURIComponent(cursor)}` : ''),
      { signal },
    );
    if (disposed) return;
    const follow = loading || atBottom();
    title = data.name;
    document.title = title;
    cwd = data.cwd;
    chatAvailable = data.chatAvailable || status.canControl;
    chatDisabledReason = data.chatDisabledReason;
    const window = data.window;
    if (!cursor || window.reset) {
      windowEpoch++;
      messages = window.messages;
      before = window.before;
    } else if (window.messages.length) {
      messages = mergeMessages(messages, window.messages);
    }
    cursor = window.cursor;
    loading = false;
    contentError = '';
    await tick();
    if (follow) bottom();
    rememberSession();
  }

  function applyStatus(incoming, readEpoch) {
    if (disposed) return;
    const data = runtimeStates.merge(incoming, readEpoch);
    const changed = status.replyId !== data.replyId || status.leafId !== data.leafId;
    status = data;
    if (data.replyId && data.unread === false) {
      try {
        navigator.serviceWorker?.controller?.postMessage({
          type: 'pi-web:read',
          sessionId,
          replyId: data.replyId,
        });
      } catch {
        /* Notification cleanup cannot interrupt native state/control. */
      }
    }
    chatAvailable = data.chatAvailable ?? chatAvailable;
    cwd = data.cwd || cwd;
    if (changed) refreshSession.run();
    if (!drawerOpen && !document.hidden && document.hasFocus() && status.replyId && status.unread)
      refreshAcknowledgement.run();
  }

  function disconnectRuntime() {
    runtimeStates.disconnect();
    status = runtimeStates.get(sessionId) || status;
  }

  async function loadStatus(signal) {
    const readEpoch = runtimeStates.mark();
    const data = await request(endpoint('/api/status'), { signal });
    applyStatus(data, readEpoch);
  }

  async function acknowledgeCurrent() {
    if (drawerOpen || document.hidden || !document.hasFocus() || !status.replyId || !status.unread)
      return;
    const replyId = status.replyId;
    await post(endpoint('/api/session/acknowledge'), { replyId });
    if (!disposed && status.replyId === replyId) applyStatus({ ...status, unread: false });
  }

  async function loadEarlier() {
    if (historyLoading || !before) return;
    historyLoading = true;
    const epoch = windowEpoch;
    const anchor = viewport?.querySelector('[data-message-id]');
    const oldTop = anchor?.getBoundingClientRect().top;
    try {
      const data = await request(
        endpoint('/api/session') + `&before=${encodeURIComponent(before)}`,
      );
      if (disposed || epoch !== windowEpoch) return;
      if (data.window.reset) {
        cursor = '';
        await refreshSession.run();
        return;
      }
      const ids = new Set(messages.map((message) => message.id));
      messages = [...data.window.messages.filter((message) => !ids.has(message.id)), ...messages];
      before = data.window.before;
      await tick();
      if (anchor && viewport) viewport.scrollTop += anchor.getBoundingClientRect().top - oldTop;
    } catch (err) {
      contentError = err.message;
    } finally {
      historyLoading = false;
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!canSend || (!composer.text.trim() && !composer.images.length)) return;
    composer.sending = true;
    composer.error = '';
    composer.notice = '';
    const submittedDraft = composer.text;
    const submittedImages = composer.images;
    const form = new FormData();
    form.set('message', submittedDraft);
    for (const image of submittedImages) form.append('images', image);
    try {
      await request(endpoint('/api/chat'), { method: 'POST', body: form });
      if (composer.text === submittedDraft) composer.text = '';
      composer.images = composer.images.filter((image) => !submittedImages.includes(image));
      composer.notice = '已接受 — 尚未确认处理';
      refreshSession.run();
      refreshStatus.run();
    } catch (err) {
      composer.error = err.message;
    } finally {
      composer.sending = false;
    }
  }

  async function control(path, body) {
    error = '';
    try {
      await post(endpoint(path), body);
      notice = '已接受 — 尚未确认处理';
      refreshStatus.run();
    } catch (err) {
      error = err.message;
    }
  }

  async function loadModels(event) {
    if (!event.currentTarget.open || models.length || !status.canControl) return;
    try {
      models = (await request(endpoint('/api/models'))).models || [];
    } catch (err) {
      error = err.message;
    }
  }

  async function searchSkills() {
    if (!composer.text.startsWith('/') || skillsLoaded || !status.canControl) return;
    skillsLoaded = true;
    try {
      skills = (await request(endpoint('/api/commands'))).commands || [];
    } catch {
      skillsLoaded = false;
    }
  }

  function revokePreview(key) {
    request(endpoint('/api/session/preview'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      keepalive: true,
    }).catch(() => {});
  }

  function clearPreview() {
    previewEpoch++;
    if (preview) revokePreview(preview.key);
    preview = null;
    previewLoading = false;
  }

  async function openPreview(path) {
    clearPreview();
    const epoch = previewEpoch;
    previewPath = path;
    previewError = '';
    previewLoading = true;
    if (!previewDialog.open) previewDialog.showModal();
    try {
      const data = await post(endpoint('/api/session/preview'), { path });
      if (disposed || epoch !== previewEpoch) {
        revokePreview(data.key);
        return;
      }
      preview = data;
    } catch (err) {
      if (!disposed && epoch === previewEpoch) previewError = err.message;
    } finally {
      if (epoch === previewEpoch) previewLoading = false;
    }
  }

  async function openNew() {
    newPath = cwd;
    newDialog.showModal();
    try {
      recent = (await request('/api/recent-locations')).locations || [];
    } catch {
      recent = [];
    }
  }

  async function createSession(event) {
    event.preventDefault();
    if (!newPath.trim() || composer.sending) return;
    composer.sending = true;
    try {
      const data = await post('/api/new-session', { path: newPath.trim() });
      window.location.assign(`/session?id=${encodeURIComponent(data.id)}`);
    } catch (err) {
      error = err.message;
      composer.sending = false;
    }
  }

  function growTextarea(node) {
    const resize = () => {
      const scrollTop = node.scrollTop;
      const atEnd = node.selectionEnd === node.value.length;
      node.style.height = 'auto';
      node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`;
      node.scrollTop = atEnd ? node.scrollHeight : scrollTop;
    };
    let width;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      resize();
    });
    observer.observe(node);
    resize();
    return { update: resize, destroy: () => observer.disconnect() };
  }

  onMount(() => {
    disposed = false;
    const fail = (err) => {
      if (!disposed) {
        contentError = err.retryable ? `连接不稳定，正在自动重试 — ${err.message}` : err.message;
        loading = false;
      }
    };
    document.title = title;
    if (cached)
      tick().then(() => {
        if (disposed || !viewport) return;
        if (cached.awayFromBottom) viewport.scrollTop = cached.scrollTop;
        else bottom();
      });
    refreshSession = createRefreshCoordinator(loadSession, fail, { minInterval: 200 });
    refreshStatus = createRefreshCoordinator(loadStatus);
    refreshAcknowledgement = createRefreshCoordinator(acknowledgeCurrent, fail);
    if (sessionId) {
      refreshSession.run();
      refreshStatus.run();
      request(endpoint('/api/git/info'))
        .then((data) => {
          if (!disposed) branch = data.branch || '';
        })
        .catch(() => {});
    }
    let opened = false;
    const unsubscribe = sessionId
      ? subscribeEvents(`/events?id=${encodeURIComponent(sessionId)}`, {
          open() {
            disconnectRuntime();
            connected = true;
            if (opened) {
              refreshSession.run();
              refreshStatus.run();
            }
            opened = true;
          },
          error() {
            connected = false;
            disconnectRuntime();
          },
          message(event) {
            if (event.data === 'reload' || event.data === 'new-session') refreshSession.run();
          },
          'status-snapshot'(event) {
            const states = JSON.parse(event.data);
            if (states[sessionId]) applyStatus(states[sessionId]);
          },
          'status-delta'(event) {
            const data = JSON.parse(event.data);
            if (sessionId === data.id) applyStatus(data);
          },
        })
      : null;
    const onVisible = () => {
      if (document.hidden || !sessionId) return;
      refreshSession.run();
      refreshStatus.run();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    window.addEventListener('focus', onVisible);
    const onFilePreview = (event) => {
      const button = event.target.closest?.('button[data-preview-path]');
      if (button) openPreview(button.dataset.previewPath);
    };
    window.addEventListener('click', onFilePreview);
    const onViewport = () =>
      document.documentElement.style.setProperty(
        '--remote-height',
        `${window.visualViewport?.height || window.innerHeight}px`,
      );
    window.visualViewport?.addEventListener('resize', onViewport);
    onViewport();
    const resizeObserver = new ResizeObserver(() => {
      observedViewportHeight = viewport.clientHeight;
      if (!awayFromBottom) bottom();
    });
    if (viewport) resizeObserver.observe(viewport);
    return () => {
      rememberSession();
      disposed = true;
      clearPreview();
      unsubscribe?.();
      refreshSession.dispose();
      refreshStatus.dispose();
      refreshAcknowledgement.dispose();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('click', onFilePreview);
      window.visualViewport?.removeEventListener('resize', onViewport);
      resizeObserver.disconnect();
      document.documentElement.style.removeProperty('--remote-height');
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons and escaped Markdown renderer -->
<div class="remote-app">
  <header class="remote-header">
    {#if sessionId}<button
        type="button"
        class="remote-menu"
        bind:this={drawerTrigger}
        aria-label="会话列表"
        aria-haspopup="dialog"
        aria-controls="remote-sessions-drawer"
        aria-expanded={drawerOpen}
        onclick={() => {
          drawerOpen = true;
          drawer.showModal();
        }}>{@html icon(Menu)}</button
      >{/if}
    <div class="remote-heading"><HostSwitcher {title} /></div>
    {#if sessionId}<span class="remote-state" data-state={activeState}
        >{stateLabels[activeState] || '未知'}</span
      >{/if}
    <PushSettings />
    <button type="button" onclick={openNew} aria-label="新建会话">{@html icon(Plus)}</button>
  </header>

  {#if !sessionId}
    <SessionList {stateLabels} />
  {:else}
    <details class="remote-info" ontoggle={loadModels}>
      <summary
        >{branch || cwd?.split(/[\\/]/).at(-1) || '会话信息'}
        <span>{runtimeKnown ? status.model || '未知' : '未知'}</span></summary
      >
      <dl>
        <dt>项目</dt>
        <dd>{cwd}</dd>
        <dt>分支</dt>
        <dd>{branch || '未知'}</dd>
        <dt>缓存命中</dt>
        <dd>
          {runtimeKnown && status.cacheHit != null ? `${Math.round(status.cacheHit)}%` : '未知'}
        </dd>
        <dt>上下文</dt>
        <dd>
          {runtimeKnown && status.context?.tokens != null
            ? status.context.tokens.toLocaleString('zh-CN')
            : '未知'} / {runtimeKnown && status.context?.contextWindow
            ? status.context.contextWindow.toLocaleString('zh-CN')
            : '未知'}
        </dd>
        <dt>加速</dt>
        <dd>
          {#if runtimeKnown && ['off', 'fast', 'ultrafast'].includes(status.fast?.mode)}
            {fastLabels[status.fast.mode] || '未知'}
            {#if status.fast.mode !== 'off' && status.fast.serviceTier == null}
              — 对此模型不生效
            {/if}
          {:else}未知{/if}
        </dd>
        <dt>模型</dt>
        <dd>{runtimeKnown ? status.model || '未知' : '未知'}</dd>
        <dt>思考</dt>
        <dd>{runtimeKnown ? status.thinking || '未知' : '未知'}</dd>
      </dl>
      {#if status.canControl && runtimeKnown}
        <label
          >模型<select
            value={`${status.provider}/${status.model}`}
            onchange={(event) => {
              const model = models.find(
                (item) => `${item.provider}/${item.id}` === event.currentTarget.value,
              );
              if (model) control('/api/set-model', { provider: model.provider, modelId: model.id });
            }}
          >
            <option value={`${status.provider}/${status.model}`}>{status.model || '未知'}</option>
            {#each models.filter((model) => model.id !== status.model || model.provider !== status.provider) as model (model.provider + '/' + model.id)}<option
                value={`${model.provider}/${model.id}`}
                >{model.provider}/{model.name || model.id}</option
              >{/each}
          </select></label
        >
        <label
          >思考<select
            value={status.thinking || 'off'}
            onchange={(event) =>
              control('/api/set-thinking-level', { level: event.currentTarget.value })}
            >{#each ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as level (level)}<option
                value={level}>{level}</option
              >{/each}</select
          ></label
        >
        <small>模型和思考设置的更改对后续请求生效。</small>
      {/if}
    </details>

    <main
      class="remote-main"
      aria-busy={loading || historyLoading}
      bind:this={viewport}
      onscroll={() => {
        if (viewport.clientHeight === observedViewportHeight) awayFromBottom = !atBottom();
      }}
    >
      {#if !connected}<p class="remote-warning" role="status">已断开连接 — 状态未知</p>{/if}
      {#if activeState === 'needs-you'}<p class="remote-warning">
          Pi 需要终端交互，请在电脑上处理原生对话框。
        </p>{/if}
      {#if contentError}<p class="remote-error" role="alert">
          {contentError}<button type="button" onclick={() => refreshSession.run()}>重试</button>
        </p>{/if}
      {#if error || composer.error}<p class="remote-error" role="alert">
          {composer.error || error}<button
            type="button"
            aria-label="关闭错误提示"
            onclick={() => {
              error = '';
              composer.error = '';
            }}>关闭</button
          >
        </p>{/if}
      {#if loading && !messages.length}<p role="status">加载中…</p>{/if}
      {#if before}<button
          type="button"
          class="remote-earlier"
          disabled={historyLoading}
          onclick={loadEarlier}>{historyLoading ? '加载中…' : '加载更早的消息'}</button
        >{/if}
      {#each messages as message (message.id)}
        <article
          class:remote-user={message.role === 'user'}
          data-message-id={message.id}
          aria-label={message.role === 'user' ? '你' : 'Pi'}
        >
          {#each message.blocks as block (block.index)}
            {#if block.type === 'text'}<div class="remote-markdown">
                {@html markdown.parse(typeof block.text === 'string' ? block.text : '')}
              </div>
            {:else}<RemoteBlock {sessionId} entryId={message.id} {block} />{/if}
          {/each}
          {#if message.error}<p class="remote-error">{message.error}</p>{/if}
        </article>
      {/each}
      {#if awayFromBottom}<button
          type="button"
          class="remote-bottom"
          aria-label="最新消息"
          onclick={bottom}>{@html icon(ArrowDown, { size: 16 })}</button
        >{/if}
    </main>

    <div class="remote-compose-context">
      {#if chatAvailable && !status.canControl}
        <p>
          {status.diagnostic || '控制桥接未连接。现有终端会话需要使用当前版本的 pi-web 扩展。'}
        </p>
        <button type="button" onclick={() => control('/api/session/continue', {})}
          >在后台继续</button
        >
      {:else if !chatAvailable && !loading}<p>{chatDisabledReason}</p>{/if}
      {#if composer.notice || notice}<small role="status">{composer.notice || notice}</small>{/if}
      {#if matchingSkills.length}<div class="remote-skills">
          {#each matchingSkills as skill (skill.name)}<button
              type="button"
              onclick={() => {
                composer.text = `/${skill.name} `;
                textarea?.focus();
              }}>{skill.name}<small>{skill.description}</small></button
            >{/each}
        </div>{/if}
      {#if composer.images.length}<div class="remote-images">
          {#each composer.images as image, i (image)}<button
              type="button"
              title={image.name}
              aria-label={`移除 ${image.name}`}
              onclick={() => (composer.images = composer.images.filter((_, index) => index !== i))}
              ><span>{image.name}</span> {@html icon(X, { size: 14 })}</button
            >{/each}
        </div>{/if}
    </div>
    <footer class="remote-composer">
      <form onsubmit={sendMessage}>
        <textarea
          bind:this={textarea}
          aria-label="给 Pi 发消息…"
          placeholder="给 Pi 发消息…"
          rows="1"
          bind:value={composer.text}
          use:growTextarea={composer.text}
          oninput={searchSkills}
        ></textarea>
        <div class="remote-actions">
          <label class="remote-attach" aria-label="拍照或选择图片"
            >{@html icon(Paperclip)}<input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              onchange={(event) => {
                composer.images = [...composer.images, ...event.currentTarget.files];
                event.currentTarget.value = '';
              }}
            /></label
          >
          <span></span>
          {#if status.mainRunning || activeState === 'running'}<button
              type="button"
              aria-label="停止主代理"
              onclick={() => control('/api/chat/cancel', {})}>{@html icon(Square)}</button
            >{/if}
          <button
            type="submit"
            disabled={!canSend || (!composer.text.trim() && !composer.images.length)}
            aria-label="发送">{@html icon(Send)}</button
          >
        </div>
      </form>
    </footer>
  {/if}
</div>

{#if sessionId}
  <dialog
    id="remote-sessions-drawer"
    class="remote-drawer"
    aria-labelledby="remote-drawer-title"
    bind:this={drawer}
    onkeydown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        drawer.close();
      } else if (event.key === 'Tab') {
        const controls = [...drawer.querySelectorAll('button:not(:disabled), input, a[href]')];
        const index = controls.indexOf(document.activeElement);
        const next = event.shiftKey
          ? (index - 1 + controls.length) % controls.length
          : (index + 1) % controls.length;
        event.preventDefault();
        controls[next]?.focus();
      }
    }}
    onclose={() => {
      drawerOpen = false;
      if (!newDialog.open) drawerTrigger?.focus({ preventScroll: true });
      refreshAcknowledgement.run();
    }}
    onclick={(event) => {
      if (event.target !== drawer) return;
      const box = drawer.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      )
        drawer.close();
    }}
  >
    <header>
      <h2 id="remote-drawer-title">会话</h2>
      <button type="button" aria-label="关闭会话列表" onclick={() => drawer.close()}
        >{@html icon(X)}</button
      >
    </header>
    <button
      class="remote-drawer-new"
      type="button"
      onclick={() => {
        drawer.close();
        openNew();
      }}>{@html icon(Plus)}新建会话</button
    >
    <SessionList {stateLabels} currentSessionId={sessionId} onselect={() => drawer.close()} />
    <footer><a href="/">查看全部会话</a></footer>
  </dialog>
{/if}

<dialog class="remote-preview" aria-label="预览" bind:this={previewDialog} onclose={clearPreview}>
  <header>
    <strong title={preview?.name || previewPath}>{preview?.name || previewPath}</strong>
    <button type="button" onclick={() => openPreview(previewPath)} disabled={previewLoading}
      >重新加载</button
    >
    <a
      href={fileDownloadURL(sessionId, previewPath)}
      download={preview?.name || fileName(previewPath)}
      target="_blank"
      rel="noreferrer">下载</a
    >
    <button type="button" onclick={() => previewDialog.close()} aria-label="关闭"
      >{@html icon(X)}</button
    >
  </header>
  {#if previewLoading}<p role="status">加载中…</p>{/if}
  {#if previewError}<p role="alert">{previewError}</p>{/if}
  {#if preview}
    <iframe
      src={preview.url}
      title={preview.name}
      sandbox="allow-scripts allow-forms allow-modals allow-downloads"
      referrerpolicy="no-referrer"
    ></iframe>
  {/if}
</dialog>

<dialog class="remote-new" bind:this={newDialog}>
  <form onsubmit={createSession}>
    <h2>新建会话</h2>
    <label
      >工作目录<input
        required
        bind:value={newPath}
        list="remote-recent"
        placeholder="/path/to/project"
      /></label
    >
    <datalist id="remote-recent"
      >{#each recent as path (path)}<option value={path}></option>{/each}</datalist
    >
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="remote-actions">
      <button type="button" onclick={() => newDialog.close()}>取消</button><button
        type="submit"
        disabled={composer.sending}>创建</button
      >
    </div>
  </form>
</dialog>

<style>
  :global(html),
  :global(body) {
    margin: 0;
    height: 100%;
    overflow: hidden;
  }
  :global(body) {
    background: var(--body-bg);
    color: var(--text);
    font: var(--font-size-ui)/1.5 var(--font-sans);
  }
  :global(*) {
    box-sizing: border-box;
  }
  :global(button),
  :global(input),
  :global(textarea),
  :global(select) {
    font: inherit;
    color: inherit;
  }
  :global(button),
  :global(select),
  :global(input),
  :global(textarea) {
    border: 1px solid var(--dim);
    background: var(--surface-2);
    border-radius: 8px;
  }
  :global(button),
  :global(select),
  :global(input) {
    min-height: 44px;
    padding: 9px 12px;
  }
  :global(button) {
    cursor: pointer;
  }
  :global(button:disabled) {
    opacity: 0.4;
    cursor: default;
  }
  :global(a) {
    color: var(--accent);
  }
  :global(button:focus-visible),
  :global(a:focus-visible),
  :global(summary:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .remote-app {
    height: var(--remote-height, 100dvh);
    max-width: 860px;
    margin: auto;
    display: flex;
    flex-direction: column;
    padding-top: env(safe-area-inset-top);
  }
  .remote-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--dim);
    flex: none;
  }
  .remote-menu {
    min-width: 44px;
    padding: 9px;
    border-color: transparent;
    background: transparent;
    flex: none;
  }
  .remote-heading {
    flex: 1;
    min-width: 0;
  }
  .remote-compose-context small {
    color: var(--muted);
    font-size: 12px;
  }
  .remote-header button {
    display: grid;
    place-items: center;
  }
  .remote-state {
    white-space: nowrap;
    color: var(--text-soft);
    font-size: 12px;
  }
  .remote-state[data-state='running'] {
    color: var(--accent);
  }
  .remote-state[data-state='background'] {
    color: var(--accent);
  }
  .remote-state[data-state='needs-you'],
  .remote-warning {
    color: var(--warning);
  }
  .remote-main {
    overflow: auto;
    overscroll-behavior: contain;
    flex: 1;
    min-height: min(80px, calc(var(--remote-height, 100dvh) * 0.18));
    padding: 12px;
    overflow-wrap: anywhere;
  }
  .remote-info {
    flex: 0 1 auto;
    min-height: 40px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--dim);
    max-height: 42vh;
    overflow: auto;
    font-size: 12px;
  }
  .remote-info summary {
    cursor: pointer;
    padding: 7px 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .remote-info summary span {
    color: var(--text-soft);
    margin-left: 8px;
  }
  .remote-info dl {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 6px 14px;
  }
  .remote-info dt {
    color: var(--muted);
  }
  .remote-info dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .remote-info label {
    display: block;
    margin: 8px 0;
  }
  .remote-info select {
    width: 100%;
  }
  article {
    min-width: 0;
  }
  article.remote-user {
    margin: 24px 0 16px;
    color: var(--text-soft);
  }
  article.remote-user:first-child {
    margin-top: 0;
  }
  .remote-markdown {
    margin: 12px 0;
    font: var(--font-content-size)/1.6 var(--font-content);
  }
  .remote-user .remote-markdown {
    margin: 0;
  }
  .remote-markdown :global(> :first-child) {
    margin-top: 0;
  }
  .remote-markdown :global(> :last-child) {
    margin-bottom: 0;
  }
  .remote-markdown :global(p) {
    margin: 8px 0;
  }
  .remote-markdown :global(pre),
  :global(.remote-block pre) {
    padding: 12px;
    overflow: auto;
    max-width: 100%;
    background: var(--surface-2);
    border-radius: 6px;
    font: var(--font-content-size)/1.5 var(--font-code);
  }
  .remote-markdown :global(code) {
    font-family: var(--font-code);
  }
  .remote-markdown :global(table) {
    display: block;
    overflow: auto;
    border-collapse: collapse;
  }
  .remote-markdown :global(th),
  .remote-markdown :global(td) {
    border: 1px solid var(--dim);
    padding: 6px 10px;
  }
  :global(.remote-block) {
    min-width: 0;
  }
  :global(.remote-block img) {
    max-width: 100%;
    height: auto;
  }
  .remote-earlier {
    display: block;
    width: 100%;
    margin: 6px 0 14px;
  }
  .remote-bottom {
    position: sticky;
    bottom: 0;
    float: right;
    display: grid;
    place-items: center;
    min-width: 44px;
  }
  .remote-composer {
    position: relative;
    flex: none;
    padding: 8px 12px max(8px, env(safe-area-inset-bottom));
    border-top: 1px solid var(--dim);
  }
  .remote-compose-context {
    flex: 0 1 auto;
    min-height: 0;
    max-height: min(240px, calc(var(--remote-height, 100dvh) * 0.3));
    overflow-y: auto;
    padding: 0 12px;
  }
  .remote-compose-context p {
    margin: 0 0 8px;
    font-size: 12px;
  }
  .remote-composer textarea {
    display: block;
    resize: none;
    width: 100%;
    min-height: 46px;
    max-height: max(46px, min(240px, calc(var(--remote-height, 100dvh) * 0.24)));
    overflow-y: auto;
    padding: 10px;
    font-size: 16px;
    line-height: 1.5;
  }
  .remote-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .remote-actions > span {
    flex: 1;
  }
  .remote-actions button {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .remote-attach {
    display: grid;
    place-items: center;
    min-width: 44px;
    min-height: 44px;
    cursor: pointer;
  }
  .remote-attach input {
    display: none;
  }
  .remote-images {
    display: flex;
    flex: none;
    gap: 6px;
    overflow-x: auto;
    overscroll-behavior-x: contain;
  }
  .remote-images button {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
    max-width: min(100%, 280px);
  }
  .remote-images button span {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .remote-images :global(svg) {
    flex: none;
  }
  .remote-error {
    color: var(--danger);
  }
  .remote-skills {
    background: var(--bg);
    border: 1px solid var(--dim);
    border-radius: 8px;
  }
  .remote-skills button {
    display: block;
    width: 100%;
    text-align: left;
  }
  .remote-skills small {
    display: block;
  }
  :global(.remote-file) {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    max-width: 100%;
    padding: 6px 10px;
    margin: 4px 0;
    border: 1px solid var(--dim);
    border-radius: 8px;
    font-size: 13px;
  }
  :global(.remote-file-name) {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  :global(.remote-image-actions) {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    padding: 4px 8px;
  }
  :global(.remote-image-actions a) {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }
  :global(.remote-file-actions) {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }
  :global(.remote-file-actions button) {
    padding: 8px;
    background: transparent;
  }
  :global(.remote-file-actions a),
  .remote-preview header a {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }
  .remote-preview {
    width: calc(100vw - 16px);
    max-width: 1200px;
    height: calc(var(--remote-height, 100dvh) - 16px);
    max-height: calc(var(--remote-height, 100dvh) - 16px);
    padding: 0;
    border: 1px solid var(--dim);
    border-radius: 12px;
    color: var(--text);
    background: var(--surface);
  }
  .remote-preview[open] {
    display: flex;
    flex-direction: column;
  }
  .remote-preview::backdrop {
    background: #0009;
  }
  .remote-preview header {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px;
    border-bottom: 1px solid var(--dim);
  }
  .remote-preview strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .remote-preview header button {
    flex: none;
  }
  .remote-preview p {
    padding: 0 12px;
    overflow-wrap: anywhere;
  }
  .remote-preview iframe {
    width: 100%;
    flex: 1;
    min-height: 0;
    border: 0;
    background: white;
  }
  .remote-drawer {
    position: fixed;
    inset: 0 auto auto 0;
    width: min(360px, calc(100vw - 48px));
    max-width: none;
    height: var(--remote-height, 100dvh);
    max-height: var(--remote-height, 100dvh);
    margin: 0;
    padding: env(safe-area-inset-top) 0 0 env(safe-area-inset-left);
    overflow: hidden;
    color: var(--text);
    background: var(--surface);
    border: 0;
    border-right: 1px solid var(--dim);
    border-radius: 0 16px 16px 0;
    box-shadow: 12px 0 40px #0003;
  }
  .remote-drawer[open] {
    display: flex;
    flex-direction: column;
    animation: remote-drawer-in 180ms ease-out;
  }
  .remote-drawer::backdrop {
    background: #0008;
  }
  .remote-drawer header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    flex: none;
  }
  .remote-drawer h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
  .remote-drawer header button {
    display: grid;
    place-items: center;
    padding: 9px;
    background: transparent;
    border-color: transparent;
  }
  .remote-drawer-new {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin: 0 12px;
    flex: none;
  }
  .remote-drawer footer {
    padding: 8px 12px max(8px, env(safe-area-inset-bottom));
    border-top: 1px solid var(--dim);
    flex: none;
  }
  .remote-drawer footer a {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    text-decoration: none;
    font-size: 13px;
  }
  @keyframes remote-drawer-in {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .remote-drawer[open] {
      animation: none;
    }
  }
  .remote-new {
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--dim);
    border-radius: 12px;
    width: min(440px, calc(100vw - 24px));
  }
  .remote-new::backdrop {
    background: #0009;
  }
  .remote-new label,
  .remote-new input {
    display: block;
    width: 100%;
  }
  .remote-new .remote-actions {
    justify-content: flex-end;
    margin-top: 16px;
  }
</style>
