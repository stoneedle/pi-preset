<script>
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { SvelteSet } from 'svelte/reactivity';
  import { icon, Folder, ChevronRight, Search } from '../shared/icons.js';
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
  const loadingProjects = new SvelteSet();
  let projectInfos = $state(cached?.projects || []);
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  let error = $state('');
  const collapsedProjects = new SvelteSet();
  const searchCollapsedProjects = new SvelteSet();
  const collapsed = $derived(query.trim() ? searchCollapsedProjects : collapsedProjects);
  const projects = $derived.by(() => {
    const groups = Object.create(null);
    for (const info of projectInfos) groups[info.path] = { ...info, sessions: [] };
    for (const session of sessions) {
      const path = session.project || '';
      if (!groups[path]) groups[path] = { path, count: 0, lastActivity: '', sessions: [] };
      groups[path].sessions.push(session);
    }
    const result = Object.values(groups);
    for (const project of result) {
      const parts = project.path.split(/[\\\\/]/).filter(Boolean);
      project.name = parts.at(-1) || project.path || '未知项目';
      project.parentName = parts.at(-2) || '';
      project.sessions.sort(
        (a, b) => (b.sortTime || 0) - (a.sortTime || 0) || b.id.localeCompare(a.id),
      );
    }
    for (const project of result)
      project.duplicateName = result.some(
        (other) => other.path !== project.path && other.name === project.name,
      );
    return result.sort(
      (a, b) => collator.compare(a.name, b.name) || collator.compare(a.path, b.path),
    );
  });
  function activityLabel(value) {
    const at = new Date(value);
    if (!Number.isFinite(at.getTime())) return '无活动';
    const today = new Date();
    const days = Math.max(
      0,
      Math.round(
        (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
          Date.UTC(at.getFullYear(), at.getMonth(), at.getDate())) /
          86400000,
      ),
    );
    return days === 0 ? '今天' : days + ' 天前';
  }
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
    rememberView(`list:${listQuery}`, {
      sessions: $state.snapshot(sessions),
      projects: $state.snapshot(projectInfos),
      total,
    });
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
    projectInfos = (data.projects || []).map((project) => {
      const previous = projectInfos.find((item) => item.path === project.path);
      return previous?.unreadEpoch > readEpoch
        ? { ...project, unread: previous.unread, unreadEpoch: previous.unreadEpoch }
        : project;
    });
    loading = false;
    error = '';
    rememberList();
  }

  async function loadProject(project) {
    if (loadingProjects.has(project.path)) return;
    loadingProjects.add(project.path);
    const requestedQuery = query;
    const readEpoch = runtimeStates.mark();
    try {
      const data = await request(
        '/api/sessions?limit=30&project=' +
          encodeURIComponent(project.path) +
          '&offset=' +
          project.sessions.length +
          '&q=' +
          encodeURIComponent(query),
      );
      if (disposed || query !== requestedQuery) return;
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
      rememberList();
    } catch (err) {
      if (!disposed) error = err.message;
    } finally {
      loadingProjects.delete(project.path);
    }
  }

  function mergeRuntime(snapshot) {
    const previous = runtimeStates.get(snapshot.id);
    const current = runtimeStates.merge(snapshot);
    const resultChanged =
      current.replyId !== previous?.replyId || current.unread !== previous?.unread;
    const completed = (current.completedAt || 0) > (previous?.completedAt || 0);
    if (resultChanged)
      projectInfos = projectInfos.map((project) =>
        project.path === current.cwd
          ? {
              ...project,
              unread: project.unread || current.unread === true,
              unreadEpoch: runtimeStates.mark(),
            }
          : project,
      );
    if (completed || resultChanged) refreshList?.run();
  }

  function updateRuntime() {
    sessions = sessions.map((session) => {
      const runtime = runtimeStates.get(session.id) || session.runtime;
      return {
        ...session,
        ...runtime,
        runtime,
        sortTime: Math.max(session.sortTime || 0, runtime.completedAt || 0),
      };
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
        for (const snapshot of Object.values(JSON.parse(event.data))) mergeRuntime(snapshot);
        updateRuntime();
      },
      'status-delta'(event) {
        mergeRuntime(JSON.parse(event.data));
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
    <span>
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- trusted Lucide icon -->
      {@html icon(Search, { size: 18 })}
    </span>
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
              {#if project.duplicateName}<small>{project.parentName}</small>{/if}
            </span>
            {#if project.unread || project.sessions.some((session) => session.unread)}<span
                class="remote-project-unread"
                aria-label="项目有未读回复"
              ></span>{/if}
            <time class="remote-project-activity" datetime={project.lastActivity || undefined}
              >{activityLabel(project.lastActivity)}</time
            >
            <span class="remote-project-count" title="会话数"
              >{project.count || project.sessions.length}</span
            >
          </button>
          {#if !collapsed.has(project.path)}
            <div
              class="remote-project-sessions"
              transition:slide={{ duration: motion.matches ? 0 : 180 }}
            >
              {#each project.sessions as session (session.id)}
                <a
                  class="remote-session"
                  animate:flip={{ duration: motion.matches ? 0 : 220 }}
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
                    <strong title={session.name}>{session.name}</strong>{#if session.unread}<span
                        class="remote-unread"
                        aria-label="未读回复"
                      ></span>{/if}
                  </div>
                  <span class="remote-state" data-state={connected ? session.state : 'unknown'}
                    >{stateLabels[connected ? session.state : 'unknown'] || '未知'}</span
                  >
                </a>
              {/each}
              {#if project.sessions.length < project.count}
                <button
                  class="remote-more"
                  type="button"
                  disabled={loadingProjects.has(project.path)}
                  onclick={() => loadProject(project)}
                >
                  {loadingProjects.has(project.path)
                    ? '加载中…'
                    : project.sessions.length
                      ? '更多会话'
                      : '查看会话'}
                </button>
              {/if}
            </div>
          {/if}
        </section>
      {/each}
    </div>
    {#if !loading && !error && !sessions.length}<p class="remote-empty">
        {query ? '没有匹配的会话' : '还没有会话'}
      </p>{/if}
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
    position: relative;
    padding: 8px 20px 16px;
    flex: none;
  }
  .remote-search > span {
    position: absolute;
    top: 22px;
    left: 33px;
    display: flex;
    color: var(--muted);
    pointer-events: none;
  }
  .remote-search input {
    width: 100%;
    min-height: 44px;
    padding: 10px 14px 10px 40px;
    border: 0;
    border-radius: 14px;
    background: var(--surface-2);
    font-size: 15px;
  }
  .remote-search input::placeholder {
    color: var(--muted);
  }
  .remote-list-main {
    overflow: auto;
    overscroll-behavior: contain;
    flex: 1;
    min-height: 0;
    padding: 0 16px 24px;
    scrollbar-width: thin;
  }
  .remote-project + .remote-project {
    margin-top: 16px;
  }
  .remote-project-toggle {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-width: 0;
    min-height: 48px;
    padding: 10px 4px;
    text-align: left;
    border: 0;
    border-radius: 12px;
    background: transparent;
  }
  .remote-project-chevron,
  .remote-project-folder {
    display: flex;
    flex: none;
    color: var(--text-soft);
  }
  .remote-project-chevron {
    transition: transform 180ms var(--ease-out);
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
    font-size: 15px;
    font-weight: 550;
  }
  .remote-project-label small {
    margin-top: 2px;
    color: var(--muted);
    font-size: 11px;
  }
  .remote-project-count {
    flex: none;
    min-width: 15px;
    color: var(--muted);
    font-size: 11px;
    text-align: right;
  }
  .remote-project-activity {
    flex: none;
    white-space: nowrap;
    color: var(--muted);
    font-size: 11px;
  }
  .remote-project-sessions {
    padding-left: 26px;
  }
  .remote-session {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 44px;
    padding: 10px 10px;
    border: 0;
    border-radius: 12px;
    color: inherit;
    text-decoration: none;
  }
  .remote-session:hover {
    background: var(--surface-2);
  }
  .remote-current {
    background: var(--surface-2);
  }
  .remote-session > div {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: 1;
    min-width: 0;
  }
  .remote-session strong {
    display: block;
    min-width: 0;
    font-size: 14px;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remote-state {
    flex: none;
    white-space: nowrap;
    color: var(--muted);
    font-size: 11px;
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
    width: 6px;
    height: 6px;
    background: var(--accent);
    border-radius: 50%;
  }
  .remote-more {
    display: block;
    min-height: 36px;
    padding: 6px 10px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--muted);
    font-size: 12px;
  }
  .remote-error {
    color: var(--danger);
    font-size: 13px;
  }
  .remote-empty,
  .remote-warning {
    font-size: 13px;
    color: var(--muted);
    padding: 8px 6px;
  }
  @media (prefers-reduced-motion: reduce) {
    .remote-project-chevron {
      transition: none;
    }
  }
</style>
