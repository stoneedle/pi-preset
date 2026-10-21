<script>
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { icon, Folder, ChevronRight } from '../shared/icons.js';
  import { request, createRefreshCoordinator, createRuntimeStateStore } from '../remote-api.js';
  import { subscribeEvents } from '../remote-events.js';
  import { readView, rememberView } from '../remote-cache.js';

  let { stateLabels, currentSessionId = '', onselect } = $props();
  const cached = readView('list:');
  let sessions = $state(cached?.sessions || []);
  let total = $state(cached?.total || 0);
  let query = $state('');
  let connected = $state(false);
  let loading = $state(!cached);
  let loadingMore = $state(false);
  let error = $state('');
  const collapsedProjects = new SvelteSet();
  const searchCollapsedProjects = new SvelteSet();
  const collapsed = $derived(query.trim() ? searchCollapsedProjects : collapsedProjects);
  const projects = $derived.by(() => {
    const groups = Object.create(null);
    for (const session of sessions) {
      const path = session.project || '';
      if (!groups[path]) {
        groups[path] = {
          path,
          name: path.split(/[\\/]/).filter(Boolean).at(-1) || path || '未知项目',
          sessions: [],
        };
      }
      groups[path].sessions.push(session);
    }
    return Object.values(groups);
  });
  let listQuery = '';
  let searchTimer;
  let refreshList;
  let disposed = false;
  const runtimeStates = createRuntimeStateStore();
  for (const session of cached?.sessions || []) runtimeStates.merge(session.runtime);
  runtimeStates.disconnect();
  updateRuntime();

  function rememberList() {
    if (loading) return;
    rememberView(`list:${listQuery}`, { sessions: $state.snapshot(sessions), total });
  }

  function toggleProject(path) {
    if (collapsed.has(path)) collapsed.delete(path);
    else collapsed.add(path);
    if (!query.trim()) {
      try {
        localStorage.setItem('pi-web:collapsed-projects', JSON.stringify([...collapsedProjects]));
      } catch {
        /* Folding remains usable when browser storage is unavailable. */
      }
    }
  }

  async function loadList(signal) {
    const readEpoch = runtimeStates.mark();
    const requestedQuery = query;
    const data = await request(
      `/api/sessions?limit=30&offset=0&q=${encodeURIComponent(requestedQuery)}`,
      { signal, priority: 'low' },
    );
    if (disposed || requestedQuery !== query) return;
    data.sessions = data.sessions.map((session) => {
      const runtime = runtimeStates.merge(session.runtime, readEpoch);
      return { ...session, ...runtime, runtime };
    });
    const headIds = new Set(data.sessions.map((session) => session.id));
    sessions =
      requestedQuery === listQuery
        ? [...data.sessions, ...sessions.filter((session) => !headIds.has(session.id))]
        : data.sessions;
    listQuery = requestedQuery;
    total = data.total;
    loading = false;
    error = '';
    rememberList();
  }

  async function loadMore() {
    if (loadingMore) return;
    const readEpoch = runtimeStates.mark();
    loadingMore = true;
    const requestedQuery = query;
    try {
      const data = await request(
        `/api/sessions?limit=30&offset=${sessions.length}&q=${encodeURIComponent(requestedQuery)}`,
      );
      if (disposed || requestedQuery !== query) return;
      const ids = new Set(sessions.map((session) => session.id));
      sessions = [
        ...sessions,
        ...data.sessions
          .filter((session) => !ids.has(session.id))
          .map((session) => {
            const runtime = runtimeStates.merge(session.runtime, readEpoch);
            return { ...session, ...runtime, runtime };
          }),
      ];
      total = data.total;
      rememberList();
    } catch (err) {
      if (!disposed) error = err.message;
    } finally {
      loadingMore = false;
    }
  }

  function updateRuntime() {
    sessions = sessions.map((session) => {
      const runtime = runtimeStates.get(session.id) || session.runtime;
      return { ...session, ...runtime, runtime };
    });
  }

  onMount(() => {
    disposed = false;
    try {
      const paths = JSON.parse(localStorage.getItem('pi-web:collapsed-projects') || '[]');
      if (Array.isArray(paths)) {
        for (const path of paths) if (typeof path === 'string') collapsedProjects.add(path);
      }
    } catch {
      /* Invalid or unavailable preferences default to expanded projects. */
    }
    refreshList = createRefreshCoordinator(
      loadList,
      (err) => {
        if (!disposed) {
          error = err.retryable ? `连接不稳定，正在自动重试 — ${err.message}` : err.message;
          loading = false;
        }
      },
      { minInterval: 750 },
    );
    refreshList.run();
    let opened = false;
    const unsubscribe = subscribeEvents('/events?id=__all__', {
      open() {
        runtimeStates.disconnect();
        updateRuntime();
        connected = true;
        if (opened) refreshList.run();
        opened = true;
      },
      error() {
        connected = false;
        runtimeStates.disconnect();
        updateRuntime();
      },
      message(event) {
        if (event.data === 'reload' || event.data === 'new-session') refreshList.run();
      },
      'status-snapshot'(event) {
        for (const snapshot of Object.values(JSON.parse(event.data))) runtimeStates.merge(snapshot);
        updateRuntime();
      },
      'status-delta'(event) {
        runtimeStates.merge(JSON.parse(event.data));
        updateRuntime();
      },
    });
    const onVisible = () => {
      if (!document.hidden) refreshList.run();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      rememberList();
      disposed = true;
      unsubscribe();
      clearTimeout(searchTimer);
      refreshList.dispose();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  });
</script>

<section class="remote-session-list" aria-label="会话列表">
  <div class="remote-search">
    <input
      type="search"
      aria-label="搜索会话"
      placeholder="搜索会话"
      bind:value={query}
      oninput={() => {
        searchCollapsedProjects.clear();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => refreshList.run(), 250);
      }}
    />
  </div>
  <div class="remote-list-main" aria-busy={loading}>
    {#if !connected}<p class="remote-warning" role="status">已断开连接 — 状态未知</p>{/if}
    {#if error}<p class="remote-error" role="alert">
        {error}<button type="button" onclick={() => refreshList.run()}>重试</button>
      </p>{/if}
    {#if loading && !sessions.length}<p role="status">加载中…</p>{/if}
    <div class="remote-sessions">
      {#each projects as project (project.path)}
        <section class="remote-project" aria-label={project.path || '未知项目'}>
          <button
            type="button"
            class="remote-project-toggle"
            aria-expanded={!collapsed.has(project.path)}
            onclick={() => toggleProject(project.path)}
          >
            <span
              class="remote-project-chevron"
              class:remote-project-expanded={!collapsed.has(project.path)}
            >
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted Lucide icon -->
              {@html icon(ChevronRight, { size: 14 })}
            </span>
            <span class="remote-project-folder">
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted Lucide icon -->
              {@html icon(Folder, { size: 17 })}
            </span>
            <span class="remote-project-label">
              <strong>{project.name}</strong>
              <small title={project.path}><bdi dir="ltr">{project.path || '未知项目'}</bdi></small>
            </span>
            {#if project.sessions.some((session) => session.unread)}<span
                class="remote-project-unread"
                aria-label="项目有未读回复"
              ></span>{/if}
            <span class="remote-project-count" title="已加载会话数">{project.sessions.length}</span>
          </button>
          {#if !collapsed.has(project.path)}
            <div class="remote-project-sessions">
              {#each project.sessions as session (session.id)}
                <a
                  class="remote-session"
                  class:remote-current={session.id === currentSessionId}
                  href={`/session?id=${encodeURIComponent(session.id)}`}
                  aria-current={session.id === currentSessionId ? 'page' : undefined}
                  onclick={(event) => {
                    if (
                      session.id === currentSessionId &&
                      !event.ctrlKey &&
                      !event.metaKey &&
                      !event.shiftKey &&
                      !event.altKey
                    ) {
                      event.preventDefault();
                      onselect?.();
                    }
                  }}
                >
                  <div>
                    <strong>{session.name}</strong>{#if session.unread}<span
                        class="remote-unread"
                        aria-label="未读回复"
                      ></span>{/if}
                  </div>
                  <span class="remote-state" data-state={connected ? session.state : 'unknown'}
                    >{stateLabels[connected ? session.state : 'unknown'] || '未知'}</span
                  >
                </a>
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    </div>
    {#if !loading && !error && !sessions.length}<p class="remote-empty">
        {query ? '没有匹配的会话' : '还没有会话'}
      </p>{/if}
    {#if sessions.length < total}<button
        type="button"
        class="remote-more"
        disabled={loadingMore}
        onclick={loadMore}>更多会话</button
      >{/if}
  </div>
</section>

<style>
  .remote-session-list {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .remote-search {
    padding: 10px 12px;
    flex: none;
  }
  .remote-search input {
    width: 100%;
    font-size: 16px;
  }
  .remote-list-main {
    overflow: auto;
    overscroll-behavior: contain;
    flex: 1;
    min-height: 0;
    padding: 0 12px 12px;
    overflow-wrap: anywhere;
  }
  .remote-project + .remote-project {
    margin-top: 12px;
  }
  .remote-project-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    padding: 10px 0;
    text-align: left;
    border: 0;
    background: transparent;
  }
  .remote-project-chevron,
  .remote-project-folder {
    display: flex;
    flex: none;
    color: var(--muted);
  }
  .remote-project-expanded {
    transform: rotate(90deg);
  }
  .remote-project-label {
    flex: 1;
    min-width: 0;
  }
  .remote-project-label strong,
  .remote-project-label small {
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .remote-project-label strong {
    font-size: 13px;
    font-weight: 600;
  }
  .remote-project-label small {
    direction: rtl;
    text-align: left;
    margin-top: 2px;
    color: var(--muted);
    font-size: 11px;
  }
  .remote-project-count {
    flex: none;
    color: var(--muted);
    font-size: 12px;
  }
  .remote-project-sessions {
    padding-left: 22px;
  }
  .remote-session {
    display: block;
    position: relative;
    padding: 10px 8px;
    border: 0;
    color: inherit;
    text-decoration: none;
  }
  .remote-current {
    background: var(--surface-2);
    border-radius: 8px;
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
  .remote-current strong {
    color: var(--accent);
  }
  .remote-state {
    position: absolute;
    right: 8px;
    top: 12px;
    white-space: nowrap;
    color: var(--text-soft);
    font-size: 12px;
  }
  .remote-state[data-state='running'],
  .remote-state[data-state='background'] {
    color: var(--accent);
  }
  .remote-state[data-state='needs-you'],
  .remote-warning {
    color: var(--warning);
  }
  .remote-unread,
  .remote-project-unread {
    display: inline-block;
    flex: none;
    width: 7px;
    height: 7px;
    background: var(--accent);
    border-radius: 50%;
  }
  .remote-more {
    display: block;
    width: 100%;
    margin: 6px 0 14px;
  }
  .remote-error {
    color: var(--danger);
  }
  .remote-empty {
    color: var(--muted);
  }
</style>
