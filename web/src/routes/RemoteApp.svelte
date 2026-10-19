<script>
  import { onMount, tick } from 'svelte';
  import { Marked } from 'marked';
  import { t } from '../shared/i18n.js';
  import {
    icon,
    ArrowDown,
    ChevronLeft,
    Plus,
    Paperclip,
    Send,
    Square,
    X,
  } from '../shared/icons.js';
  import { escapeHtml } from '../shared/escape.js';
  import RemoteBlock from '../components/RemoteBlock.svelte';
  import {
    request,
    createRefreshCoordinator,
    mergeMessages,
    readSeenReplies,
    markSeen,
  } from '../remote-api.js';

  const sessionId = new URLSearchParams(window.location.search).get('id') || '';
  const host = window.location.hostname;
  const markdown = new Marked({ breaks: true, gfm: true });
  markdown.use({
    renderer: {
      html(token) {
        return escapeHtml(token.text);
      },
      link(token) {
        if (!/^(https?:|mailto:|\/|#)/i.test(token.href || ''))
          return this.parser.parseInline(token.tokens);
        return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noreferrer">${this.parser.parseInline(token.tokens)}</a>`;
      },
      image(token) {
        if (!/^https?:\/\//i.test(token.href || ''))
          return escapeHtml(token.text || t('remote.image'));
        return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noreferrer">${escapeHtml(token.text || t('remote.image'))}</a>`;
      },
    },
  });

  let sessions = $state([]);
  let seen = $state(readSeenReplies());
  let total = $state(0);
  let query = $state('');
  let title = $state('Pi');
  let cwd = $state('');
  let branch = $state('');
  let messages = $state([]);
  let cursor = '';
  let before = $state('');
  let status = $state({ state: 'unknown', canControl: false });
  let connected = $state(false);
  let loading = $state(true);
  let loadingMore = $state(false);
  let listQuery = '';
  let historyLoading = $state(false);
  let error = $state('');
  let notice = $state('');
  let draft = $state('');
  let images = $state([]);
  let delivery = $state('steer');
  let sending = $state(false);
  let chatAvailable = $state(false);
  let chatDisabledReason = $state('');
  let viewport = $state(null);
  let textarea = $state(null);
  let newDialog = $state(null);
  let newPath = $state('');
  let recent = $state([]);
  let models = $state([]);
  let skills = $state([]);
  let skillsLoaded = false;
  let searchTimer;
  let refreshList;
  let refreshSession;
  let refreshStatus;
  let disposed = false;

  const activeState = $derived(connected ? status.state : 'unknown');
  const skillQuery = $derived(draft.match(/^\/(\S*)$/)?.[1]?.toLowerCase());
  const matchingSkills = $derived(
    skillQuery === undefined
      ? []
      : skills.filter((skill) => skill.name.toLowerCase().includes(skillQuery)).slice(0, 6),
  );
  const canSend = $derived(chatAvailable && status.canControl && connected && !sending);
  const atBottom = () =>
    !viewport || viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 100;
  const bottom = () => viewport?.scrollTo({ top: viewport.scrollHeight });
  const unknown = () => t('remote.unknown');
  const endpoint = (path) => `${path}?id=${encodeURIComponent(sessionId)}`;
  const post = (url, body) =>
    request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  async function loadList() {
    const requestedQuery = query;
    const data = await request(
      `/api/sessions?limit=30&offset=0&q=${encodeURIComponent(requestedQuery)}`,
    );
    if (disposed || requestedQuery !== query) return;
    const headIds = new Set(data.sessions.map((session) => session.id));
    sessions =
      requestedQuery === listQuery
        ? [...data.sessions, ...sessions.filter((session) => !headIds.has(session.id))]
        : data.sessions;
    listQuery = requestedQuery;
    total = data.total;
    loading = false;
    error = '';
  }

  async function loadSession() {
    const follow = loading || atBottom();
    const data = await request(
      endpoint('/api/session') + (cursor ? `&after=${encodeURIComponent(cursor)}` : ''),
    );
    if (disposed) return;
    title = data.name;
    document.title = title;
    cwd = data.cwd;
    chatAvailable = data.chatAvailable;
    chatDisabledReason = data.chatDisabledReason;
    const window = data.window;
    if (!cursor || window.reset) {
      messages = window.messages;
      before = window.before;
    } else {
      messages = mergeMessages(messages, window.messages);
    }
    cursor = window.cursor;
    if (!document.hidden) markSeen(sessionId, window.replyId);
    loading = false;
    error = '';
    await tick();
    if (follow) bottom();
  }

  async function loadStatus() {
    const data = await request(endpoint('/api/status'));
    if (!disposed) {
      if (status.state !== data.state && data.state !== 'unknown') refreshSession.run();
      status = data;
    }
  }

  async function loadEarlier() {
    if (historyLoading || !before) return;
    historyLoading = true;
    const anchor = viewport?.querySelector('[data-message-id]');
    const oldTop = anchor?.getBoundingClientRect().top;
    try {
      const data = await request(
        endpoint('/api/session') + `&before=${encodeURIComponent(before)}`,
      );
      if (disposed) return;
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
      error = err.message;
    } finally {
      historyLoading = false;
    }
  }

  async function loadMore() {
    if (loadingMore) return;
    loadingMore = true;
    const requestedQuery = query;
    try {
      const data = await request(
        `/api/sessions?limit=30&offset=${sessions.length}&q=${encodeURIComponent(requestedQuery)}`,
      );
      if (disposed || requestedQuery !== query) return;
      const ids = new Set(sessions.map((session) => session.id));
      sessions = [...sessions, ...data.sessions.filter((session) => !ids.has(session.id))];
      total = data.total;
    } catch (err) {
      error = err.message;
    } finally {
      loadingMore = false;
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!canSend || (!draft.trim() && !images.length)) return;
    sending = true;
    error = '';
    notice = '';
    const form = new FormData();
    form.set('message', draft);
    form.set('delivery', delivery);
    for (const image of images) form.append('images', image);
    try {
      const data = await request(endpoint('/api/chat'), { method: 'POST', body: form });
      draft = '';
      images = [];
      notice = t(`remote.${data.status}`);
      refreshSession.run();
      refreshStatus.run();
    } catch (err) {
      error = err.message;
    } finally {
      sending = false;
    }
  }

  async function control(path, body) {
    error = '';
    try {
      await post(endpoint(path), body);
      notice = t('remote.accepted');
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
    if (!draft.startsWith('/') || skillsLoaded || !status.canControl) return;
    skillsLoaded = true;
    try {
      skills = (await request(endpoint('/api/commands'))).commands || [];
    } catch {
      skillsLoaded = false;
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
    if (!newPath.trim() || sending) return;
    sending = true;
    try {
      const data = await post('/api/new-session', { path: newPath.trim() });
      window.location.assign(`/session?id=${encodeURIComponent(data.id)}`);
    } catch (err) {
      error = err.message;
      sending = false;
    }
  }

  onMount(() => {
    disposed = false;
    const fail = (err) => {
      if (!disposed) {
        error = err.message;
        loading = false;
      }
    };
    refreshList = createRefreshCoordinator(loadList, fail);
    refreshSession = createRefreshCoordinator(loadSession, fail);
    refreshStatus = createRefreshCoordinator(loadStatus, () => {
      if (!disposed) status = { state: 'unknown', canControl: false };
    });
    if (sessionId) {
      markSeen(sessionId, seen[sessionId] || '');
      refreshSession.run();
      refreshStatus.run();
      request(endpoint('/api/git/info'))
        .then((data) => {
          if (!disposed) branch = data.branch || '';
        })
        .catch(() => {});
    } else {
      refreshList.run();
    }
    const stream = new EventSource(`/events?id=${encodeURIComponent(sessionId || '__all__')}`);
    stream.onopen = () => {
      connected = true;
      (sessionId ? refreshSession : refreshList).run();
      if (sessionId) refreshStatus.run();
    };
    stream.onerror = () => {
      connected = false;
    };
    stream.onmessage = (event) => {
      if (event.data === 'reload' || event.data === 'new-session')
        (sessionId ? refreshSession : refreshList).run();
    };
    stream.addEventListener('status-snapshot', (event) => {
      const states = JSON.parse(event.data);
      if (sessionId) status = { ...status, state: states[sessionId] || 'unknown' };
      else
        sessions = sessions.map((session) => ({
          ...session,
          state: states[session.id] || 'unknown',
        }));
    });
    stream.addEventListener('status-delta', (event) => {
      const data = JSON.parse(event.data);
      if (sessionId === data.id) {
        status = { ...status, state: data.state };
        refreshStatus.run();
      } else if (!sessionId) {
        sessions = sessions.map((session) =>
          session.id === data.id ? { ...session, state: data.state } : session,
        );
        if (data.state === 'idle') refreshList.run();
      }
    });
    const timer = setInterval(() => {
      if (sessionId && !document.hidden) refreshStatus.run();
    }, 3000);
    const onVisible = () => {
      if (document.hidden) return;
      (sessionId ? refreshSession : refreshList).run();
      if (sessionId) refreshStatus.run();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    const onViewport = () =>
      document.documentElement.style.setProperty(
        '--remote-height',
        `${window.visualViewport?.height || window.innerHeight}px`,
      );
    window.visualViewport?.addEventListener('resize', onViewport);
    onViewport();
    return () => {
      disposed = true;
      stream.close();
      clearInterval(timer);
      clearTimeout(searchTimer);
      refreshList.dispose();
      refreshSession.dispose();
      refreshStatus.dispose();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      window.visualViewport?.removeEventListener('resize', onViewport);
      document.documentElement.style.removeProperty('--remote-height');
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons and escaped Markdown renderer -->
<div class="remote-app">
  <header class="remote-header">
    {#if sessionId}<a href="/" aria-label={t('remote.sessions')}>{@html icon(ChevronLeft)}</a>{/if}
    <div class="remote-heading"><strong>{title}</strong><small>{host}</small></div>
    {#if sessionId}<span class="remote-state" data-state={activeState}
        >{t(`remote.state.${activeState}`)}</span
      >{/if}
    <button type="button" onclick={openNew} aria-label={t('remote.new')}>{@html icon(Plus)}</button>
  </header>

  {#if !sessionId}
    <div class="remote-search">
      <input
        type="search"
        aria-label={t('remote.search')}
        placeholder={t('remote.search')}
        bind:value={query}
        oninput={() => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => refreshList.run(), 250);
        }}
      />
    </div>
  {:else}
    <details class="remote-info" ontoggle={loadModels}>
      <summary
        >{branch || cwd?.split(/[\\/]/).at(-1) || t('remote.info')}
        <span>{status.model || unknown()}</span></summary
      >
      <dl>
        <dt>{t('remote.project')}</dt>
        <dd>{cwd}</dd>
        <dt>{t('remote.branch')}</dt>
        <dd>{branch || unknown()}</dd>
        <dt>CH</dt>
        <dd>{status.cacheHit == null ? unknown() : `${Math.round(status.cacheHit)}%`}</dd>
        <dt>{t('remote.context')}</dt>
        <dd>
          {status.context?.tokens == null ? unknown() : status.context.tokens.toLocaleString()} / {status.context?.contextWindow?.toLocaleString() ||
            unknown()}
        </dd>
        <dt>Fast</dt>
        <dd>{status.fast == null ? unknown() : status.fast}</dd>
        <dt>{t('remote.model')}</dt>
        <dd>{status.model || unknown()}</dd>
        <dt>{t('remote.thinking')}</dt>
        <dd>{status.thinking || unknown()}</dd>
      </dl>
      {#if status.canControl}
        <label
          >{t('remote.model')}<select
            value={`${status.provider}/${status.model}`}
            onchange={(event) => {
              const model = models.find(
                (item) => `${item.provider}/${item.id}` === event.currentTarget.value,
              );
              if (model) control('/api/set-model', { provider: model.provider, modelId: model.id });
            }}
          >
            <option value={`${status.provider}/${status.model}`}>{status.model || unknown()}</option
            >
            {#each models.filter((model) => model.id !== status.model || model.provider !== status.provider) as model (model.provider + '/' + model.id)}<option
                value={`${model.provider}/${model.id}`}
                >{model.provider}/{model.name || model.id}</option
              >{/each}
          </select></label
        >
        <label
          >{t('remote.thinking')}<select
            value={status.thinking || 'off'}
            onchange={(event) =>
              control('/api/set-thinking-level', { level: event.currentTarget.value })}
            >{#each ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as level (level)}<option
                value={level}>{level}</option
              >{/each}</select
          ></label
        >
        <small>{t('remote.nextRequest')}</small>
      {/if}
    </details>
  {/if}

  <main class="remote-main" bind:this={viewport}>
    {#if !connected}<p class="remote-warning" role="status">{t('remote.disconnected')}</p>{/if}
    {#if activeState === 'needs-you'}<p class="remote-warning">
        {t('remote.nativeAttention')}
      </p>{/if}
    {#if error}<p class="remote-error" role="alert">
        {error}<button
          type="button"
          onclick={() => (sessionId ? refreshSession : refreshList).run()}
          >{t('remote.retry')}</button
        >
      </p>{/if}
    {#if loading && !messages.length && !sessions.length}<p role="status">
        {t('remote.loading')}
      </p>{/if}
    {#if sessionId}
      {#if before}<button
          type="button"
          class="remote-earlier"
          disabled={historyLoading}
          onclick={loadEarlier}>{historyLoading ? t('remote.loading') : t('remote.earlier')}</button
        >{/if}
      {#each messages as message (message.id)}
        <article class:remote-user={message.role === 'user'} data-message-id={message.id}>
          <small class="remote-role">{t(`remote.${message.role}`)}</small>
          {#each message.blocks as block (block.index)}
            {#if block.type === 'text'}<div class="remote-markdown">
                {@html markdown.parse(block.text)}
              </div>
            {:else}<RemoteBlock {sessionId} entryId={message.id} {block} />{/if}
          {/each}
          {#if message.error}<p class="remote-error">{message.error}</p>{/if}
        </article>
      {/each}
      <button type="button" class="remote-bottom" aria-label={t('remote.latest')} onclick={bottom}
        >{@html icon(ArrowDown, { size: 16 })}</button
      >
    {:else}
      <div class="remote-sessions">
        {#each sessions as session (session.id)}
          <a
            class="remote-session"
            href={`/session?id=${encodeURIComponent(session.id)}`}
            onclick={() => {
              markSeen(session.id, session.replyId);
              seen = readSeenReplies();
            }}
          >
            <div>
              <strong>{session.name}</strong
              >{#if session.replyId && seen[session.id] !== session.replyId}<span
                  class="remote-unread"
                  aria-label={t('remote.unread')}
                ></span>{/if}
            </div>
            <small>{session.project}</small>
            <span class="remote-state" data-state={connected ? session.state : 'unknown'}
              >{t(`remote.state.${connected ? session.state : 'unknown'}`)}</span
            >
          </a>
        {/each}
      </div>
      {#if sessions.length < total}<button
          type="button"
          class="remote-earlier"
          disabled={loadingMore}
          onclick={loadMore}>{t('remote.more')}</button
        >{/if}
    {/if}
  </main>

  {#if sessionId}
    <footer class="remote-composer">
      {#if chatAvailable && !status.canControl}
        <p>{status.error || t('remote.notAttached')}</p>
        <button type="button" onclick={() => control('/api/session/continue', {})}
          >{t('remote.continue')}</button
        >
      {:else if !chatAvailable && !loading}<p>{chatDisabledReason}</p>{/if}
      {#if notice}<small role="status">{notice}</small>{/if}
      {#if matchingSkills.length}<div class="remote-skills">
          {#each matchingSkills as skill (skill.name)}<button
              type="button"
              onclick={() => {
                draft = `/${skill.name} `;
                textarea?.focus();
              }}>{skill.name}<small>{skill.description}</small></button
            >{/each}
        </div>{/if}
      <form onsubmit={sendMessage}>
        <textarea
          bind:this={textarea}
          aria-label={t('remote.message')}
          placeholder={t('remote.message')}
          rows="2"
          bind:value={draft}
          oninput={searchSkills}
        ></textarea>
        {#if images.length}<div class="remote-images">
            {#each images as image, i (image)}<button
                type="button"
                onclick={() => (images = images.filter((_, index) => index !== i))}
                >{image.name} {@html icon(X, { size: 14 })}</button
              >{/each}
          </div>{/if}
        <div class="remote-actions">
          <label class="remote-attach" aria-label={t('remote.attach')}
            >{@html icon(Paperclip)}<input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              onchange={(event) => {
                images = [...images, ...event.currentTarget.files];
                event.currentTarget.value = '';
              }}
            /></label
          >
          <select aria-label={t('remote.delivery')} bind:value={delivery}
            ><option value="steer">{t('remote.sendNow')}</option><option value="followUp"
              >{t('remote.nextTurn')}</option
            ></select
          >
          <span></span>
          {#if status.mainRunning || activeState === 'running'}<button
              type="button"
              aria-label={t('remote.stop')}
              onclick={() => control('/api/chat/cancel', {})}>{@html icon(Square)}</button
            >{/if}
          <button
            type="submit"
            disabled={!canSend || (!draft.trim() && !images.length)}
            aria-label={t('remote.send')}>{@html icon(Send)}</button
          >
        </div>
      </form>
    </footer>
  {/if}
</div>

<dialog class="remote-new" bind:this={newDialog}>
  <form onsubmit={createSession}>
    <h2>{t('remote.new')}</h2>
    <label
      >{t('remote.directory')}<input
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
      <button type="button" onclick={() => newDialog.close()}>{t('common.cancel')}</button><button
        type="submit"
        disabled={sending}>{t('common.create')}</button
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
  .remote-header > a {
    display: grid;
    place-items: center;
    min-width: 40px;
    min-height: 44px;
  }
  .remote-heading {
    flex: 1;
    min-width: 0;
  }
  .remote-heading strong,
  .remote-heading small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remote-heading small,
  .remote-role,
  .remote-session small,
  .remote-composer small {
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
  .remote-search {
    padding: 10px 12px;
  }
  .remote-search input {
    width: 100%;
  }
  .remote-main {
    overflow: auto;
    overscroll-behavior: contain;
    flex: 1;
    min-height: 0;
    padding: 12px;
    overflow-wrap: anywhere;
  }
  .remote-session {
    display: block;
    position: relative;
    padding: 14px 0;
    border-bottom: 1px solid var(--dim);
    color: inherit;
    text-decoration: none;
  }
  .remote-session > div {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding-right: 70px;
  }
  .remote-session strong {
    font-size: 14px;
    font-weight: 550;
  }
  .remote-session small {
    display: block;
    padding-right: 70px;
    margin-top: 4px;
    overflow-wrap: anywhere;
  }
  .remote-session > .remote-state {
    position: absolute;
    right: 0;
    top: 16px;
  }
  .remote-unread {
    display: inline-block;
    flex: none;
    width: 7px;
    height: 7px;
    background: var(--accent);
    border-radius: 50%;
  }
  .remote-info {
    flex: none;
    padding: 6px 12px;
    border-bottom: 1px solid var(--dim);
    max-height: 42vh;
    overflow: auto;
    font-size: 12px;
  }
  .remote-info summary {
    cursor: pointer;
    padding: 7px 0;
    overflow-wrap: anywhere;
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
    padding: 12px 0 18px;
    border-bottom: 1px solid var(--dim);
  }
  article.remote-user {
    border-left: 2px solid var(--accent);
    padding-left: 10px;
  }
  .remote-role {
    display: block;
    margin-bottom: 5px;
  }
  .remote-markdown {
    font: var(--font-content-size)/1.5 var(--font-content);
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
    margin: 6px 0;
    border: 1px solid var(--dim);
    border-radius: 6px;
  }
  :global(.remote-block-toggle) {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: 0;
    font-size: 12px;
    background: transparent;
  }
  :global(.remote-block-toggle > :last-child) {
    margin-left: auto;
  }
  :global(.remote-block-summary) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    color: var(--muted);
  }
  :global(.remote-block-error) {
    border-color: var(--danger);
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
    flex: none;
    padding: 8px 12px max(8px, env(safe-area-inset-bottom));
    border-top: 1px solid var(--dim);
  }
  .remote-composer p {
    margin: 0 0 8px;
    font-size: 12px;
  }
  .remote-composer textarea {
    resize: vertical;
    width: 100%;
    min-height: 62px;
    max-height: 24vh;
    padding: 10px;
    font-size: 16px;
  }
  .remote-actions {
    display: flex;
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
  .remote-actions select {
    max-width: 48%;
    font-size: 12px;
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
    gap: 6px;
    flex-wrap: wrap;
  }
  .remote-images button {
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .remote-error {
    color: var(--danger);
  }
  .remote-skills {
    max-height: 24vh;
    overflow: auto;
  }
  .remote-skills button {
    display: block;
    width: 100%;
    text-align: left;
  }
  .remote-skills small {
    display: block;
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
