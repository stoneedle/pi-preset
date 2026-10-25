<script>
  import { onMount, tick, untrack } from 'svelte';
  import { slide } from 'svelte/transition';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { icon, Folder, Search, SquarePen, Archive, ArrowLeft } from '../shared/icons.js';
  import { contextMenu } from '../shared/context-menu.js';
  import { request, createRefreshCoordinator, createRuntimeStateStore } from '../remote-api.js';
  import { subscribeEvents } from '../remote-events.js';
  import { readView, rememberView } from '../remote-cache.js';
  import {
    sessionArchives,
    setSessionArchived,
    archiveProject,
    archiveDisconnected,
    observeSessions,
    observeProjects,
    sessionHidden,
  } from '../remote-session-management.svelte.js';
  import SessionRow from './SessionRow.svelte';
  import ListActions from './ListActions.svelte';

  let {
    currentSessionId = '',
    active = false,
    lazy = false,
    showSearch = true,
    activeOnly = false,
    query = $bindable(''),
    archived = $bindable(false),
    onselect,
    onnew,
  } = $props();
  const mode = $derived(archived ? 'archived' : activeOnly ? 'active' : 'all');
  const cacheKey = (mode, term) => 'list:' + mode + ':' + term;
  const cached = untrack(() => readView(cacheKey(mode, query)));
  let sessions = $state(cached?.sessions || []);
  let currentSession = $state(
    cached?.currentSession?.id === untrack(() => currentSessionId) ? cached.currentSession : null,
  );
  let listElement = $state(null);
  let located = $state(false);
  let revealedProject = $state(null);
  let connected = $state(false);
  let loading = $state(!cached);
  let projectInfos = $state(cached?.projects || []);
  let menu;
  let archiveRevision = sessionArchives.revision;
  let listQuery = $state(untrack(() => query));
  let listMode = untrack(() => mode);
  const modePositions = { all: 0, active: 0, archived: 0 };
  let switchingMode = false;
  let restoring = $state('');
  let searchTimer;
  let refreshList;
  let disposed = false;
  let error = $state('');
  const openedProjects = new SvelteSet();
  const loadingProjects = new SvelteSet();
  const collapsedProjects = new SvelteSet();
  const searchCollapsedProjects = new SvelteSet();
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const runtimeStates = createRuntimeStateStore();
  for (const session of [...(cached?.sessions || []), ...(currentSession ? [currentSession] : [])])
    runtimeStates.merge(session.runtime);
  runtimeStates.disconnect();

  const projectKey = (path) => mode + ':' + path;
  const projects = $derived.by(() => {
    const groups = Object.create(null);
    for (const info of projectInfos) {
      if (!archived && (info.archived || sessionArchives.projects.has(info.path))) continue;
      groups[info.path] = { ...info, sessions: [] };
    }
    for (const session of sessions) groups[session.project]?.sessions.push(session);
    for (const project of Object.values(groups)) project.loadedCount = project.sessions.length;
    if (currentSession && !sessions.some((item) => item.id === currentSession.id))
      groups[currentSession.project]?.sessions.push(currentSession);
    const result = Object.values(groups);
    for (const project of result) {
      project.hiddenCount = project.sessions.filter((item) => sessionHidden(item, archived)).length;
      project.sessions = project.sessions.filter((item) => !sessionHidden(item, archived));
      if (
        !archived &&
        (project.archiveRevision ?? -1) < (sessionArchives.projectBarriers.get(project.path) ?? -1)
      )
        project.count = project.sessions.length;
      const parts = project.path.split(/[\\/]/).filter(Boolean);
      project.name = parts.at(-1) || project.path || '未知项目';
      project.parentName = parts.at(-2) || '';
      project.sessions.sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt) || b.id.localeCompare(a.id),
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

  function readingPosition() {
    if (!listElement) return null;
    const top = listElement.getBoundingClientRect().top;
    const anchors = [];
    for (const node of listElement.querySelectorAll('.remote-project-toggle, .remote-session')) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom < top) continue;
      if (anchors.length < 24 || node.matches('.remote-project-toggle'))
        anchors.push({ node, top: rect.top });
    }
    return { anchors, scrollTop: listElement.scrollTop };
  }
  $effect.pre(() => {
    projects;
    if (mode !== listMode || switchingMode) return;
    const position = untrack(readingPosition);
    if (!position) return;
    tick().then(() => {
      if (disposed || !listElement) return;
      const anchor = position.anchors.find(
        (item) => item.node.isConnected && listElement.contains(item.node),
      );
      if (anchor) {
        // If the first visible row was removed, its successor takes the same visual slot.
        listElement.scrollTop += anchor.node.getBoundingClientRect().top - position.anchors[0].top;
      } else listElement.scrollTop = position.scrollTop;
    });
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
  function rememberList() {
    if (!loading)
      rememberView(cacheKey(listMode, listQuery), {
        sessions: $state.snapshot(sessions),
        currentSession: $state.snapshot(currentSession),
        projects: $state.snapshot(projectInfos),
      });
  }
  function isCollapsed(path) {
    if (!archived && revealedProject === path) return false;
    if (query.trim() || mode === 'active') return searchCollapsedProjects.has(path);
    return lazy || archived ? !openedProjects.has(projectKey(path)) : collapsedProjects.has(path);
  }
  function scrollCurrent() {
    if (!active || !located || disposed || !listElement || document.querySelector(':popover-open'))
      return;
    const current = listElement.querySelector('[aria-current="page"]');
    if (!current) return;
    const row = current.getBoundingClientRect(),
      viewport = listElement.getBoundingClientRect();
    listElement.scrollTop += (row.top + row.bottom - viewport.top - viewport.bottom) / 2;
  }
  $effect(() => {
    if (!active || archived) {
      located = false;
      revealedProject = null;
      return;
    }
    if (located || loading || listQuery !== query) return;
    const project = projects.find((item) =>
      item.sessions.some((session) => session.id === currentSessionId),
    );
    if (!project) return;
    located = true;
    revealedProject = project.path;
    tick().then(scrollCurrent);
  });
  $effect(() => {
    if (loading || error || (!lazy && !archived)) return;
    for (const project of projects) {
      if (
        !isCollapsed(project.path) &&
        project.loadedCount === 0 &&
        project.count > 0 &&
        !loadingProjects.has(projectKey(project.path))
      )
        untrack(() => loadProject(project));
    }
  });
  function toggleProject(project) {
    const path = project.path;
    const expand = isCollapsed(path) || (!project.loadedCount && project.count > 0);
    if (query.trim() || mode === 'active') {
      if (expand) searchCollapsedProjects.delete(path);
      else searchCollapsedProjects.add(path);
    } else {
      if (expand) {
        openedProjects.add(projectKey(path));
        collapsedProjects.delete(path);
      } else {
        openedProjects.delete(projectKey(path));
        collapsedProjects.add(path);
      }
      if (!archived) {
        try {
          localStorage.setItem('pi-web:collapsed-projects', JSON.stringify([...collapsedProjects]));
        } catch {
          /* Optional folding preference. */
        }
      }
    }
    if (revealedProject === path) revealedProject = null;
    if (expand && !project.loadedCount && project.count) loadProject(project);
  }
  function mergeItem(session, epoch, revision) {
    const runtime = runtimeStates.merge(session.runtime, epoch);
    return { ...session, ...runtime, name: session.name, runtime, archiveRevision: revision };
  }
  $effect(() => {
    const nextMode = mode;
    untrack(() => {
      if (nextMode === listMode) return;
      switchingMode = true;
      if (listElement) modePositions[listMode] = listElement.scrollTop;
      rememberList();
      const view = readView(cacheKey(nextMode, query));
      sessions = view?.sessions || [];
      projectInfos = view?.projects || [];
      currentSession = view?.currentSession?.id === currentSessionId ? view.currentSession : null;
      listQuery = query;
      listMode = nextMode;
      loading = !view;
      error = '';
      located = false;
      revealedProject = null;
      searchCollapsedProjects.clear();
      tick().then(() => {
        if (!disposed && listElement) listElement.scrollTop = modePositions[nextMode];
        switchingMode = false;
      });
      if (refreshList) restartRefresh();
    });
  });
  $effect(() => {
    const revision = sessionArchives.revision;
    if (revision === archiveRevision) return;
    archiveRevision = revision;
    untrack(() => refreshList?.run());
  });
  $effect(() => {
    const value = query;
    untrack(() => {
      searchCollapsedProjects.clear();
      clearTimeout(searchTimer);
      if (value !== listQuery) searchTimer = setTimeout(restartRefresh, 250);
    });
  });
  function projectPage(path, offset, limit, term, mode, signal) {
    return request(
      '/api/sessions?limit=' +
        limit +
        '&project=' +
        encodeURIComponent(path) +
        '&offset=' +
        offset +
        '&q=' +
        encodeURIComponent(term) +
        (mode === 'all' ? '' : '&' + mode + '=true'),
      { signal },
    );
  }
  async function loadList(signal) {
    const readEpoch = runtimeStates.mark();
    const revision = sessionArchives.revision;
    const requestedQuery = query,
      requestedMode = mode;
    const data = await request(
      '/api/sessions?limit=30&q=' +
        encodeURIComponent(requestedQuery) +
        '&current=' +
        encodeURIComponent(currentSessionId) +
        (requestedMode === 'all' ? '' : '&' + requestedMode + '=true') +
        ((lazy || requestedMode === 'archived') && !requestedQuery.trim() ? '&summary=true' : ''),
      { signal, priority: 'low' },
    );
    if (disposed || requestedQuery !== query || requestedMode !== mode) return;
    const sameView = requestedQuery === listQuery && requestedMode === listMode;
    const replacements = new SvelteMap();
    let invalidated = false;
    if (sameView) {
      // A changed project invalidates pagination, not the rows the user is still reading.
      // Prepare its previously loaded depth before committing the new list snapshot.
      await Promise.all(
        (data.projects || []).map(async (project) => {
          const previous = projectInfos.find((item) => item.path === project.path);
          const count = sessions.filter((item) => item.project === project.path).length;
          if (!count || previous?.revision === project.revision) return;
          const items = [];
          while (items.length < Math.min(count, project.count)) {
            const page = await projectPage(
              project.path,
              items.length,
              Math.min(100, Math.max(30, count - items.length)),
              requestedQuery,
              requestedMode,
              signal,
            );
            if (
              page.projects?.find((item) => item.path === project.path)?.revision !==
                project.revision ||
              !page.sessions.length
            ) {
              invalidated = true;
              return;
            }
            items.push(...page.sessions);
          }
          replacements.set(project.path, items);
        }),
      );
    }
    if (disposed || requestedQuery !== query || requestedMode !== mode) return;
    for (const project of data.projects || []) {
      const items = replacements.get(project.path);
      // A user may have loaded another page while this refresh was being prepared.
      if (
        items &&
        items.length <
          Math.min(project.count, sessions.filter((item) => item.project === project.path).length)
      )
        invalidated = true;
    }
    if (invalidated) {
      refreshList.run();
      return;
    }
    const incoming = [
      ...data.sessions.filter((item) => !replacements.has(item.project)),
      ...[...replacements.values()].flat(),
    ];
    observeSessions(
      [...incoming, ...(data.currentSession ? [data.currentSession] : [])],
      revision,
      requestedMode === 'archived',
    );
    if (requestedMode !== 'archived') observeProjects(data.projects || [], revision);
    const head = incoming.map((item) => mergeItem(item, readEpoch, revision));
    currentSession = data.currentSession
      ? mergeItem(data.currentSession, readEpoch, revision)
      : null;
    const ids = new Set(head.map((item) => item.id));
    const unchanged = new Set(
      (data.projects || [])
        .filter(
          (item) => item.revision === projectInfos.find((old) => old.path === item.path)?.revision,
        )
        .map((item) => item.path),
    );
    sessions = [
      ...head,
      ...(requestedQuery === listQuery && requestedMode === listMode
        ? sessions.filter((item) => !ids.has(item.id) && unchanged.has(item.project))
        : []),
    ];
    listQuery = requestedQuery;
    listMode = requestedMode;
    projectInfos = (data.projects || []).map((project) => {
      const previous = projectInfos.find((item) => item.path === project.path);
      return {
        ...project,
        archiveRevision: revision,
        ...(previous?.unreadEpoch > readEpoch
          ? { unread: previous.unread, unreadEpoch: previous.unreadEpoch }
          : {}),
      };
    });
    loading = false;
    error = '';
    rememberList();
  }
  async function loadProject(project) {
    // Pagination belongs to the applied filter, never to a pending search.
    if (query !== listQuery || mode !== listMode) return;
    const key = projectKey(project.path);
    if (loadingProjects.has(key)) return;
    loadingProjects.add(key);
    const requestedQuery = query,
      requestedMode = mode;
    const readEpoch = runtimeStates.mark(),
      revision = sessionArchives.revision;
    try {
      const data = await projectPage(
        project.path,
        project.loadedCount,
        30,
        requestedQuery,
        requestedMode,
      );
      if (
        disposed ||
        query !== requestedQuery ||
        requestedMode !== mode ||
        projectInfos.find((item) => item.path === project.path)?.revision !== project.revision
      )
        return;
      if (
        data.projects?.find((item) => item.path === project.path)?.revision !== project.revision
      ) {
        refreshList.run();
        return;
      }
      observeSessions(data.sessions, revision, requestedMode === 'archived');
      const ids = new Set(sessions.map((item) => item.id));
      sessions = [
        ...sessions,
        ...data.sessions
          .filter((item) => !ids.has(item.id))
          .map((item) => mergeItem(item, readEpoch, revision)),
      ];
      rememberList();
      if (!project.loadedCount && project.path === revealedProject) {
        // First-page rows can arrive after initial positioning; let layout and anchor restoration finish.
        await tick();
        requestAnimationFrame(scrollCurrent);
      }
    } catch (err) {
      if (!disposed && requestedMode === mode && requestedQuery === query) error = err.message;
    } finally {
      loadingProjects.delete(key);
    }
  }
  function pageMore(node, project) {
    let current = project;
    let visible = false;
    const load = () => {
      if (
        current &&
        visible &&
        !error &&
        !loadingProjects.has(projectKey(current.path)) &&
        node.getBoundingClientRect().top < listElement.getBoundingClientRect().bottom + 120
      )
        loadProject(current);
    };
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
        load();
      },
      { root: listElement, rootMargin: '120px' },
    );
    observer.observe(node);
    return {
      update(value) {
        current = value;
        load();
      },
      destroy() {
        observer.disconnect();
      },
    };
  }
  function mergeRuntime(snapshot) {
    const previous = runtimeStates.get(snapshot.id);
    const current = runtimeStates.merge(snapshot);
    if (
      mode === 'active' &&
      (current.state !== previous?.state || current.availability !== previous?.availability)
    )
      refreshList?.run();
    if (current.replyId !== previous?.replyId || current.unread !== previous?.unread) {
      projectInfos = projectInfos.map((project) =>
        project.path === current.cwd
          ? {
              ...project,
              unread: project.unread || current.unread === true,
              unreadEpoch: runtimeStates.mark(),
            }
          : project,
      );
      refreshList?.run();
    }
  }
  function updateRuntime() {
    const merge = (session) => ({
      ...session,
      ...(runtimeStates.get(session.id) || session.runtime),
      name: session.name,
    });
    sessions = sessions.map(merge);
    if (currentSession) currentSession = merge(currentSession);
  }
  function navigate(id) {
    onselect?.();
    const url = id ? '/session?id=' + encodeURIComponent(id) : '/';
    if (location.pathname + location.search !== url) {
      history.pushState(null, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }
  function select(event, session) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (archived) {
      event.preventDefault();
      if (!restoring) restore(session);
    } else if (session.id === currentSessionId) {
      event.preventDefault();
      onselect?.();
    }
  }
  async function restore(session) {
    restoring = session.id;
    try {
      if ((await setSessionArchived(session, false)) && !disposed) navigate(session.id);
    } finally {
      restoring = '';
    }
  }
  async function archive(session) {
    if (session.archived) {
      await restore(session);
      return;
    }
    if ((await setSessionArchived(session, true)) && !disposed) {
      rememberList();
    }
  }
  async function archiveFolder(project) {
    if ((await archiveProject(project)) && !disposed) {
      rememberList();
    }
  }
  export function openArchiveMenu(anchor) {
    if (!archived) menu.open({ kind: 'all' }, anchor);
  }
  async function archiveDisconnectedSessions(project) {
    if ((await archiveDisconnected(project)) && !disposed) rememberList();
  }
  async function renamed(session, patch) {
    sessions = sessions.map((item) =>
      item.id === session.id ? { ...item, name: patch.name } : item,
    );
    if (currentSession?.id === session.id) currentSession = { ...currentSession, name: patch.name };
    await refreshList.run();
  }
  function restartRefresh() {
    refreshList?.dispose();
    refreshList = createRefreshCoordinator(
      loadList,
      (err) => {
        if (!disposed) {
          error = err.retryable ? '连接不稳定，正在自动重试 — ' + err.message : err.message;
          loading = false;
        }
      },
      { minInterval: 750 },
    );
    refreshList.run();
  }
  onMount(() => {
    disposed = false;
    try {
      const paths = JSON.parse(localStorage.getItem('pi-web:collapsed-projects') || '[]');
      if (Array.isArray(paths))
        for (const path of paths) if (typeof path === 'string') collapsedProjects.add(path);
    } catch {
      /* Invalid preferences default to expanded on home. */
    }
    restartRefresh();
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

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<section class="remote-session-list" aria-label={archived ? '已归档会话列表' : '会话列表'}>
  {#if showSearch}
    <div class="remote-search">
      <span>{@html icon(Search, { size: 18 })}</span>
      <input
        type="search"
        aria-label="搜索会话"
        placeholder={archived ? '搜索已归档会话' : '搜索会话'}
        bind:value={query}
      />
      <button
        type="button"
        class="remote-archives"
        aria-label={archived ? '返回会话列表' : '已归档'}
        title={archived ? '返回会话列表' : '已归档，长按归档所有断开会话'}
        aria-haspopup={!archived ? 'menu' : undefined}
        use:contextMenu={openArchiveMenu}
        onclick={() => {
          archived = !archived;
          query = '';
        }}
      >
        {@html icon(archived ? ArrowLeft : Archive)}
      </button>
    </div>
  {/if}
  <div
    class="remote-list-main"
    aria-busy={loading || Boolean(restoring) || sessionArchives.batchPending}
    bind:this={listElement}
  >
    {#if !connected}<p class="remote-warning" role="status">实时更新连接中…</p>{/if}
    {#if error}<p class="remote-error" role="alert">
        {error}<button type="button" onclick={() => refreshList.run()}>重试</button>
      </p>{/if}
    {#each [...sessionArchives.errors] as [id, failure] (id)}
      <p class="remote-error" role="alert">“{failure.name}”：{failure.message}</p>
    {/each}
    {#if loading && !projects.length}<p role="status">加载中…</p>{/if}
    <div class="remote-sessions">
      {#each projects as project (project.path)}
        <section
          class="remote-project"
          data-project={project.path}
          aria-label={project.path || '未知项目'}
        >
          <div class="remote-project-heading">
            <button
              type="button"
              class="remote-project-toggle"
              aria-expanded={!isCollapsed(project.path)}
              aria-haspopup={!archived ? 'menu' : undefined}
              use:contextMenu={(anchor) => {
                if (!archived) menu.open({ ...project, kind: 'project' }, anchor);
              }}
              onclick={() => toggleProject(project)}
            >
              <span class="remote-project-folder">{@html icon(Folder, { size: 17 })}</span>
              <span class="remote-project-label"
                ><strong>{project.name}</strong>{#if project.duplicateName}<small
                    >{project.parentName}</small
                  >{/if}</span
              >
              {#if project.unread || project.sessions.some((session) => session.unread)}<span
                  class="remote-project-unread"
                  aria-label="项目有未读回复"
                ></span>{/if}
              <time class="remote-project-activity" datetime={project.lastActivity || undefined}
                >{activityLabel(project.lastActivity)}</time
              >
              <span class="remote-project-count" title="会话数"
                >{Math.max(0, project.count - project.hiddenCount)}</span
              >
            </button>
            {#if !archived}
              <button
                type="button"
                class="remote-project-action"
                aria-label={'在 ' + project.name + ' 中新建会话'}
                title="新建会话"
                onclick={() => onnew?.(project.path)}>{@html icon(SquarePen, { size: 18 })}</button
              >
            {/if}
          </div>
          {#if !isCollapsed(project.path)}
            <div
              class="remote-project-sessions"
              onintroend={() => {
                if (revealedProject === project.path) requestAnimationFrame(scrollCurrent);
              }}
              transition:slide={{ duration: motion.matches ? 0 : 180 }}
            >
              {#each project.sessions as session (session.id)}
                <SessionRow
                  {session}
                  {connected}
                  {currentSessionId}
                  history={archived}
                  onselect={select}
                  onmenu={(item, anchor) => menu.open({ ...item, kind: 'session' }, anchor)}
                />
              {/each}
              {#if project.loadedCount < project.count}
                <button
                  class="remote-more"
                  use:pageMore={mode !== 'all' ? project : null}
                  type="button"
                  disabled={query !== listQuery ||
                    mode !== listMode ||
                    loadingProjects.has(projectKey(project.path))}
                  onclick={() => loadProject(project)}
                  >{loadingProjects.has(projectKey(project.path))
                    ? '加载中…'
                    : project.loadedCount
                      ? '更多会话'
                      : '查看会话'}</button
                >
              {:else if !project.sessions.length}
                <p class="remote-empty">{archived ? '暂无已归档会话' : '暂无未归档会话'}</p>
              {/if}
            </div>
          {/if}
        </section>
      {/each}
    </div>
    {#if !loading && !error && !projects.length}<p class="remote-empty">
        {query
          ? '没有匹配的会话'
          : archived
            ? '暂无已归档会话'
            : activeOnly
              ? '暂无活跃会话'
              : '还没有会话'}
      </p>{/if}
  </div>
</section>
<ListActions
  bind:this={menu}
  onchange={renamed}
  onarchive={archive}
  onprojectarchive={archiveFolder}
  ondisconnected={archiveDisconnectedSessions}
  onfork={(id) => {
    if (!disposed && (!lazy || active)) navigate(id);
  }}
/>

<style>
  .remote-session-list {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .remote-search {
    display: flex;
    align-items: center;
    gap: 8px;
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
    flex: 1;
    min-width: 0;
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
  .remote-archives {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--text-soft);
  }
  .remote-list-main {
    overflow: auto;
    overscroll-behavior: contain;
    overflow-anchor: none;
    flex: 1;
    min-height: 0;
    padding: 0 16px 24px;
    scrollbar-width: thin;
  }
  .remote-project + .remote-project {
    margin-top: 16px;
  }
  .remote-project-heading {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 1px;
  }
  .remote-project-toggle {
    display: flex;
    align-items: center;
    flex: 1;
    gap: 7px;
    min-width: 0;
    min-height: 48px;
    padding: 10px 3px;
    text-align: left;
    border: 0;
    border-radius: 12px;
    background: transparent;
    -webkit-touch-callout: none;
    user-select: none;
  }
  .remote-project-folder {
    display: flex;
    flex: none;
    color: var(--text-soft);
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
    min-width: 10px;
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
  .remote-project-action {
    display: grid;
    place-items: center;
    flex: none;
    width: 32px;
    min-height: 44px;
    padding: 0;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--text-soft);
  }
  .remote-project-toggle:global(.remote-menu-active),
  .remote-project-action:hover {
    background: var(--surface-2);
    color: var(--accent);
  }
  .remote-project-sessions {
    padding-left: 18px;
  }
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
    overflow-wrap: anywhere;
  }
  .remote-empty,
  .remote-warning {
    font-size: 13px;
    color: var(--muted);
    padding: 8px 6px;
  }
</style>
