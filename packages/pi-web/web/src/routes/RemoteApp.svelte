<script>
  import { onMount, tick, untrack } from 'svelte';
  import {
    icon,
    ArrowDown,
    ArrowUp,
    Menu,
    Plus,
    SquarePen,
    Ellipsis,
    Bell,
    RefreshCw,
    Share2,
    Layers,
    Power,
    X,
  } from '../shared/icons.js';
  import Markdown from '../components/Markdown.svelte';
  import RemoteBlock from '../components/RemoteBlock.svelte';
  import ImageViewer from '../components/ImageViewer.svelte';
  import MessageActions from '../components/MessageActions.svelte';
  import CopyAction from '../components/CopyAction.svelte';
  import ForkAction from '../components/ForkAction.svelte';
  import { contextMenu } from '../shared/context-menu.js';
  import ContextShare from '../components/ContextShare.svelte';
  import { createReadingPosition } from '../remote-reading.svelte.js';
  import SessionList from '../components/SessionList.svelte';
  import SessionStatus from '../components/SessionStatus.svelte';
  import { withoutImageCoordinates } from '../../../shared/user-text.js';
  import SessionInfo from '../components/SessionInfo.svelte';
  import PushSettings from '../components/PushSettings.svelte';
  import AppNameSettings from '../components/AppNameSettings.svelte';
  import { appName } from '../remote-app-name.svelte.js';
  import NewTask from '../components/NewTask.svelte';
  import RefreshError from '../components/RefreshError.svelte';
  import RemoteComposer from '../components/RemoteComposer.svelte';
  import SessionTools from '../components/SessionTools.svelte';
  import { fileDownloadURL, fileName, isWebFile } from '../remote-files.js';
  import { subscribeEvents } from '../remote-events.js';
  import { diagnosticId, trace } from '../remote-diagnostics.js';
  import { interfaceRefresh, refreshInterface } from '../remote-refresh.svelte.js';
  import { canPrefetchView, readView, rememberView } from '../remote-cache.js';
  import { activateHistory } from '../remote-history.js';
  import {
    sessionComposer,
    captureDraft,
    completeDraft,
    rememberSubmittedProject,
    submitSessionMessage,
  } from '../remote-drafts.svelte.js';
  import { request, createRefreshCoordinator } from '../remote-api.js';
  import { runtime } from '../remote-runtime.svelte.js';
  import { createMessageWindow } from '../remote-messages.svelte.js';

  let { sessionId, drawer, drawerOpen = false, drawerSurface = $bindable(null) } = $props();
  const cached = untrack(() => readView(`session:${sessionId}`));
  const composer = untrack(() => sessionComposer(sessionId));
  const blockViews = {};
  let title = $state(cached?.title || untrack(() => (sessionId ? '加载会话…' : '会话')));
  let cwd = $state(cached?.cwd || '');
  let branch = $state(cached?.branch || '');
  const messageWindow = untrack(() => createMessageWindow(cached, sessionId));
  const messages = $derived(messageWindow.state.messages);
  let visibleStart = $state(cached?.visibleStart || cached?.messages?.[0]?.id || '');
  const visibleIndex = $derived.by(() => {
    const index = messages.findIndex((message) => message.id === visibleStart);
    return index < 0 ? Math.max(0, messages.length - 30) : index;
  });
  const visibleMessages = $derived(messages.slice(visibleIndex));
  const hasEarlier = $derived(visibleIndex > 0 || Boolean(messageWindow.state.before));
  let revealingHistory = false;
  let status = $state(untrack(() => runtime.get(sessionId)));
  const connected = $derived(runtime.connected);
  let loading = $state(!cached);
  let historyLoading = $state(false);
  let historyError = $state('');
  let historyController;
  let historyTimer;
  let historyDemand = false;
  let previousScrollTop = 0;
  let error = $state('');
  let contentError = $state('');
  let chatAvailable = $state(false);
  let chatDisabledReason = $state('');
  let viewport = $state(null);
  const reading = untrack(() =>
    createReadingPosition(
      sessionId,
      () => viewport,
      () => !messageWindow.state.next,
      cached?.anchor,
    ),
  );
  const awayFromBottom = $derived(!reading.state.following || Boolean(messageWindow.state.next));
  let contextShare = $state(null);
  let latestRequested = false;
  let laterLoading = $state(false);
  let laterController;
  let textarea = $state(null);
  let editorFocused = $state(false);
  let keyboardVisible = $state(null);
  let editorPointer = $state(false);
  let editorBlurTimer;
  const editing = $derived(editorPointer || (editorFocused && keyboardVisible !== false));
  let drawerTrigger = $state(null);
  let newTask = $state(null);
  let pushSettings = $state(null);
  let nameSettings = $state(null);
  let info = $state(null);
  let sessionTools = $state(null);
  let modelsLoading = $state(false);
  let modelsError = $state('');
  let previewDialog = $state(null);
  let preview = $state(null);
  let previewPath = $state('');
  let previewError = $state('');
  let previewLoading = $state(false);
  let previewEpoch = 0;
  let models = $state([]);
  let refreshSession;
  let refreshStatus;
  let refreshAcknowledgement;
  let disposed = false;
  let messageActions = $state(null);
  let forkBusy = $state(false);
  let closingProcess = $state(false);
  let reloadingResources = $state(false);

  $effect(() => {
    if (!sessionId) document.title = appName.name;
  });

  const activeState = $derived(connected ? status.state : 'unknown');
  const runtimeKnown = $derived(connected && status.availability === 'connected');
  const canSend = $derived(
    chatAvailable && !composer.sending && !closingProcess && !reloadingResources,
  );
  const canReload = $derived(
    runtimeKnown &&
      status.canReload === true &&
      !composer.sending &&
      !closingProcess &&
      !reloadingResources,
  );
  const canShutdown = $derived(
    runtimeKnown &&
      status.canControl &&
      !composer.sending &&
      !closingProcess &&
      !reloadingResources,
  );
  const canQueue = $derived(
    canSend &&
      runtimeKnown &&
      status.canQueue === true &&
      typeof status.queueRevision === 'number' &&
      status.mainRunning === true &&
      !Object.keys(composer.settings).length,
  );
  const modelStatus = $derived.by(() => {
    const pending = composer.settings;
    return {
      ...status,
      context: runtimeKnown ? status.context : null,
      model: pending.modelId || (runtimeKnown ? status.model : ''),
      modelName: pending.modelId
        ? models.find((item) => item.id === pending.modelId && item.provider === pending.provider)
            ?.name || pending.modelId
        : runtimeKnown
          ? status.modelName
          : '沿用会话设置',
      provider: pending.provider || (runtimeKnown ? status.provider : ''),
      thinking: pending.thinking || (runtimeKnown ? status.thinking : ''),
      fast: pending.speed ? { mode: pending.speed } : runtimeKnown ? status.fast : null,
      deferSettings: !runtimeKnown || Object.keys(pending).length > 0,
      disabled: !chatAvailable || composer.sending || reloadingResources,
    };
  });
  const atBottom = () =>
    !viewport || viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 100;
  const bottom = (keepReplyVisible = false) => {
    historyDemand = false;
    if (!viewport) return;
    let top = viewport.scrollHeight;
    const actions = viewport.querySelector(
      '[data-message-id]:last-of-type .remote-message-actions',
    );
    const content = actions?.previousElementSibling;
    if (keepReplyVisible && content) {
      const end =
        content.getBoundingClientRect().bottom -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop;
      // In a keyboard-sized viewport, keep the reply visible rather than only its action row.
      if (viewport.clientHeight < viewport.scrollHeight - end + 32)
        top = end - viewport.clientHeight + 12;
    }
    viewport.scrollTo({ top });
    previousScrollTop = viewport.scrollTop;
    reading.positioned();
  };
  const endpoint = (path) => `${path}?id=${encodeURIComponent(sessionId)}`;
  const post = (url, body) =>
    request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const readingAnchor = () => reading.capture();
  const restoreAnchor = (anchor) => {
    if (Number.isInteger(anchor?.block) && anchor.expanded)
      blockViews[`${anchor.id}:${anchor.block}`]?.reveal();
    const restored = reading.restore(anchor);
    if (restored) previousScrollTop = viewport.scrollTop;
    return restored;
  };

  function showLatest() {
    reading.follow();
    if (messageWindow.state.next) {
      latestRequested = true;
      refreshSession.run();
    } else bottom(true);
  }

  async function loadLater() {
    if (disposed || loading || laterLoading || !messageWindow.state.next) return;
    laterLoading = true;
    laterController = new AbortController();
    const read = messageWindow.read(false, { forward: true });
    try {
      const data = await request(endpoint('/api/session') + read.query, {
        signal: laterController.signal,
      });
      const anchor = readingAnchor();
      if (disposed || read.commit(data.window) === 'stale') return;
      if (data.window.reset) {
        visibleStart = messages[0]?.id || '';
        reading.relocated(data.window.anchor || '');
      }
      await tick();
      if (!disposed) {
        restoreAnchor(data.window.reset ? reading.anchor : anchor);
        rememberSession();
      }
    } catch (err) {
      if (!disposed && !laterController.signal.aborted) contentError = err.message;
    } finally {
      laterLoading = false;
    }
  }

  export function rememberSession(prefetch = false) {
    if (!sessionId || !messageWindow.state.ready || !viewport?.isConnected) return;
    rememberView(
      `session:${sessionId}`,
      {
        title,
        cwd,
        branch,
        ...$state.snapshot(messageWindow.state),
        visibleStart,
        anchor: reading.checkpoint(),
      },
      { prefetch },
    );
  }

  const nearHistory = () =>
    viewport && viewport.scrollTop < Math.max(600, viewport.clientHeight * 2);

  function scrollConversation() {
    const top = viewport.scrollTop;
    const upward = top < previousScrollTop;
    const towardHistory = upward || top === 0;
    const downward = top > previousScrollTop + 1;
    previousScrollTop = top;
    if (!reading.scrolled()) {
      reading.reconcile();
      if (!towardHistory || reading.state.following) return;
    }
    if (downward && atBottom() && messageWindow.state.next) loadLater();
    if (!nearHistory() || !awayFromBottom) historyDemand = false;
    // A concurrent window commit can consume the upward delta before its scroll event arrives.
    else if (towardHistory) {
      historyDemand = true;
      if (!historyError && !loading) loadEarlier({ source: 'scroll' });
    }
  }

  async function loadSession(signal) {
    reading.reconcile();
    const latest = latestRequested;
    latestRequested = false;
    let anchor = reading.state.following ? null : readingAnchor();
    let read = messageWindow.read(false, {
      latest,
      previous: anchor?.previous,
      around:
        !latest && (!messageWindow.state.ready || messageWindow.state.next) ? anchor?.id || '' : '',
    });
    let data;
    try {
      data = await request(endpoint('/api/session') + read.query, { signal });
      if (!latest && data.window.reset && anchor && !data.window.anchor && read.current()) {
        read = messageWindow.read(false, { around: anchor.id, previous: anchor.previous });
        data = await request(endpoint('/api/session') + read.query, { signal });
      }
    } catch (error) {
      trace('session.read-error', {
        session: diagnosticId(sessionId),
        category: error.name,
        status: error.status,
        aborted: signal.aborted,
      });
      if (read.current()) throw error;
      return;
    }
    const seeking = !messageWindow.state.ready || data.window.reset;
    if (!seeking && !latest) {
      reading.reconcile();
      anchor = reading.state.following ? null : readingAnchor();
    }
    if (disposed || read.commit(data.window) === 'stale') return;
    if (!messages.some((message) => message.id === visibleStart))
      visibleStart = messages[Math.max(0, messages.length - 30)]?.id || '';
    if (seeking && anchor && data.window.anchor !== anchor.id)
      reading.relocated(data.window.anchor || '');
    title = data.name;
    document.title = title;
    cwd = data.cwd;
    chatAvailable = data.chatAvailable || status.canControl;
    chatDisabledReason = data.chatDisabledReason;
    loading = false;
    contentError = '';
    await tick();
    if (disposed) return;
    if (reading.state.following && !messageWindow.state.next) bottom(true);
    else restoreAnchor(seeking && data.window.anchor !== anchor?.id ? reading.anchor : anchor);
    rememberSession();
  }

  function applyStatus(data) {
    if (disposed) return;
    // The first native leaf establishes a baseline; it is not a branch change.
    const changed =
      Object.hasOwn(status, 'leafId') &&
      (status.replyId !== data.replyId || status.leafId !== data.leafId);
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
    if (changed) {
      trace('session.leaf', {
        session: diagnosticId(sessionId),
        leaf: diagnosticId(data.leafId),
        reply: diagnosticId(data.replyId),
      });
      messageWindow.invalidate('runtime-leaf');
      refreshSession.run();
    }
    if (!drawerOpen && !document.hidden && document.hasFocus() && status.replyId && status.unread)
      refreshAcknowledgement.run();
  }

  async function loadStatus(signal) {
    const readEpoch = runtime.mark();
    const data = await request(endpoint('/api/status'), { signal });
    runtime.merge(data, readEpoch);
  }

  async function acknowledgeCurrent() {
    if (drawerOpen || document.hidden || !document.hasFocus() || !status.replyId || !status.unread)
      return;
    const replyId = status.replyId;
    const readEpoch = runtime.mark();
    const data = await post(endpoint('/api/session/acknowledge'), { replyId });
    runtime.merge(data, readEpoch);
  }

  function continueHistory() {
    if (!disposed && historyDemand && nearHistory() && !historyError && hasEarlier) {
      clearTimeout(historyTimer);
      historyTimer = setTimeout(() => loadEarlier({ source: 'continuation' }), 200);
    }
  }

  async function loadEarlier({ background = false, signal, source = 'button' } = {}) {
    if (disposed || loading || revealingHistory) return false;
    trace('history.intent', {
      session: diagnosticId(sessionId),
      background,
      source,
      demand: historyDemand,
      visible: messages.length - visibleIndex,
      retained: messages.length,
      scrollTop: Math.round(viewport.scrollTop),
      height: viewport.clientHeight,
    });
    // Downloaded history can be read immediately, even while another page is in flight.
    if (!background && visibleIndex > 0) {
      revealingHistory = true;
      const anchor = readingAnchor();
      visibleStart = messages[Math.max(0, visibleIndex - 30)].id;
      try {
        await tick();
        if (disposed) return false;
        restoreAnchor(anchor);
        rememberSession();
        return true;
      } finally {
        revealingHistory = false;
        continueHistory();
      }
    }
    if (historyLoading || !messageWindow.state.before) return false;
    historyLoading = true;
    const controller = new AbortController();
    historyController = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const read = messageWindow.read(true);
    try {
      const data = await request(endpoint('/api/session') + read.query, {
        signal: controller.signal,
        background,
        ...(background ? { retries: 0 } : {}),
      });
      if (disposed || controller.signal.aborted || !read.current()) return false;
      if (
        background &&
        !data.window.reset &&
        !canPrefetchView(`session:${sessionId}`, {
          title,
          cwd,
          branch,
          visibleStart,
          ...$state.snapshot(messageWindow.state),
          messages: [...data.window.messages, ...messages],
        })
      )
        return 'full';
      // Capture at commit time: the reader may have moved while the request was in flight.
      const anchor = readingAnchor();
      const result = read.commit(data.window);
      if (result === 'stale') return false;
      if (result === 'reset') {
        await refreshSession.run();
        return false;
      }
      if (!background) visibleStart = messages[0]?.id || '';
      historyError = '';
      await tick();
      if (disposed) return false;
      restoreAnchor(anchor);
      rememberSession(background);
      return true;
    } catch (err) {
      if (background) throw err;
      if (!disposed && !controller.signal.aborted && read.current()) historyError = err.message;
      return false;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (historyController === controller) historyController = null;
      historyLoading = false;
      if (!controller.signal.aborted) continueHistory();
    }
  }

  async function sendMessage(event, delivery = 'steer') {
    event?.preventDefault();
    if (delivery === 'followUp' && !canQueue) return;
    if (!canSend || (!composer.text.trim() && !composer.images.length)) return;
    composer.sending = true;
    const submitted = captureDraft(composer);
    try {
      if (!(await submitSessionMessage(sessionId, submitted, composer, delivery))) return;
      rememberSubmittedProject(cwd);
      completeDraft(composer, submitted);
      if (!disposed && delivery !== 'followUp') showLatest();
      refreshSession.run();
      refreshStatus.run();
    } finally {
      composer.sending = false;
    }
  }

  async function control(path, body) {
    error = '';
    try {
      await post(endpoint(path), body);
      refreshStatus.run();
    } catch (err) {
      error = err.message;
    }
  }

  async function reloadResources() {
    if (!canReload) return;
    reloadingResources = true;
    try {
      await post(endpoint('/api/session/reload'), { instanceId: status.instanceId });
      refreshStatus.run();
    } finally {
      reloadingResources = false;
    }
  }

  async function shutdownProcess() {
    if (!canShutdown) return;
    info.open = false;
    if (
      !window.confirm(
        '关闭当前会话的 Pi 进程？\n\n将强制结束 Pi 及其子进程，未完成任务会中断，进程内的排队消息会丢失。\n聊天记录和当前页面草稿保留，下次发送会重新启动。',
      )
    )
      return;
    closingProcess = true;
    try {
      await control('/api/session/shutdown', {});
    } finally {
      closingProcess = false;
    }
  }

  async function loadModels() {
    if (modelsLoading || !cwd) return;
    modelsLoading = true;
    modelsError = '';
    try {
      const url =
        runtimeKnown && status.canControl
          ? endpoint('/api/models')
          : '/api/project-options?path=' + encodeURIComponent(cwd);
      models = (await request(url)).models || [];
    } catch (err) {
      modelsError = err.message;
    } finally {
      modelsLoading = false;
    }
  }

  async function selectSettings(change, path, body) {
    const defer = !runtimeKnown || !status.canControl || Object.keys(composer.settings).length > 0;
    composer.settings = { ...composer.settings, ...change };
    const selected = composer.settings;
    if (defer) return;
    try {
      await post(endpoint(path), body);
      if (composer.settings === selected) composer.settings = {};
      refreshStatus.run();
    } catch (err) {
      error = err.message;
    }
  }

  function selectSpeed(mode) {
    if (mode === null) {
      delete composer.settings.speed;
      return;
    }
    return selectSettings({ speed: mode }, '/api/set-speed', { mode });
  }

  function messageText(message, block) {
    const text = typeof block.text === 'string' ? block.text : '';
    if (message.role !== 'user' || !message.blocks.some((part) => part.type === 'image'))
      return text;
    return withoutImageCoordinates(text);
  }

  const replyClock = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  function replyTiming(message) {
    if (!Number.isFinite(message.durationMs) || message.durationMs < 0) return null;
    const finished = new Date(message.timestamp);
    if (!Number.isFinite(finished.getTime())) return null;
    const seconds = Math.floor(message.durationMs / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    const duration = seconds
      ? [hours && `${hours}小时`, minutes && `${minutes}分`, remainder && `${remainder}秒`]
          .filter(Boolean)
          .join('')
      : '不足1秒';
    return { clock: replyClock.format(finished), duration };
  }

  function commentaryBlocks(blocks) {
    const grouped = [];
    for (const block of blocks) {
      const previous = grouped.at(-1);
      if (block.type === 'text' && previous?.type === 'text') previous.text += '\n\n' + block.text;
      else grouped.push(block.type === 'text' ? { ...block } : block);
    }
    return grouped;
  }

  function navigateFork(id) {
    if (disposed) return;
    history.pushState(null, '', '/session?id=' + encodeURIComponent(id));
    window.dispatchEvent(new PopStateEvent('popstate'));
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
    if (preview?.key) revokePreview(preview.key);
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
      if (isWebFile(path)) {
        preview = {
          url: fileDownloadURL(sessionId, path) + '&preview=1',
          name: fileName(path),
          source: path,
        };
        return;
      }
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

  export function openNew(path) {
    newTask.open(typeof path === 'string' ? path : undefined);
  }

  export function canSwipeDrawer() {
    return !info?.open;
  }

  export function drawerClosed() {
    if (!newTask?.isOpen()) drawerTrigger?.focus({ preventScroll: true });
    refreshAcknowledgement?.run();
  }

  function openDrawer() {
    if (info) info.open = false;
    drawer?.open();
  }

  onMount(() => {
    disposed = false;
    trace('view.mount', {
      key: diagnosticId(`session:${sessionId}`),
      session: diagnosticId(sessionId),
      cached: Boolean(cached),
      retained: messages.length,
    });
    const fail = (err) => {
      if (!disposed) {
        contentError = err.retryable ? `连接不稳定，正在自动重试 — ${err.message}` : err.message;
        loading = false;
      }
    };
    document.title = sessionId ? title : appName.name;
    if (cached)
      tick().then(() => {
        if (!disposed && viewport) restoreAnchor(reading.anchor);
      });
    refreshSession = createRefreshCoordinator(loadSession, fail, { minInterval: 200 });
    refreshStatus = createRefreshCoordinator(loadStatus);
    refreshAcknowledgement = createRefreshCoordinator(acknowledgeCurrent, fail);
    const releaseHistory = sessionId
      ? activateHistory(sessionId, (signal) => {
          if (loading || drawerOpen || newTask?.isOpen()) return false;
          return loadEarlier({ background: true, signal, source: 'prefetch' });
        })
      : () => {};
    const unsubscribeRuntime = runtime.subscribe((event) => {
      if (!sessionId) return;
      if (event.type === 'status' && event.snapshot.id === sessionId) applyStatus(event.snapshot);
      else if (event.type === 'disconnect') {
        messageWindow.invalidate('stream-disconnected');
        applyStatus(runtime.get(sessionId));
      } else if (event.type === 'reconnect') {
        refreshSession.run();
        if (!runtime.has(sessionId)) refreshStatus.run();
      }
    });
    if (sessionId) {
      applyStatus(runtime.get(sessionId));
      refreshSession.run();
      if (!runtime.has(sessionId)) refreshStatus.run();
      request(endpoint('/api/git/info'))
        .then((data) => {
          if (!disposed) branch = data.branch || '';
        })
        .catch(() => {});
    }
    const unsubscribe = sessionId
      ? subscribeEvents(`/events?id=${encodeURIComponent(sessionId)}`, {
          open() {
            refreshSession.run();
          },
          error() {
            messageWindow.invalidate('content-stream-disconnected');
          },
          message(event) {
            if (event.data === 'reload' || event.data === 'new-session') refreshSession.run();
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
      if (info?.open && !info.contains(event.target)) info.open = false;
      const button = event.target.closest?.('button[data-preview-path]');
      if (button) openPreview(button.dataset.previewPath);
    };
    window.addEventListener('click', onFilePreview);
    let layoutWidth = window.innerWidth;
    let fullHeight = document.documentElement.clientHeight;
    const onViewport = () => {
      const visual = window.visualViewport;
      const height = (visual?.height || window.innerHeight) * (visual?.scale || 1);
      const layoutHeight = document.documentElement.clientHeight;
      const inputFocused = document.activeElement?.matches('input, textarea');
      if (window.innerWidth !== layoutWidth || (!inputFocused && keyboardVisible !== true))
        fullHeight = layoutHeight;
      else fullHeight = Math.max(fullHeight, layoutHeight);
      layoutWidth = window.innerWidth;
      const keyboard = fullHeight - height > 150;
      // Once a soft keyboard is observed, dismissal is independent of editor focus.
      if (keyboard || keyboardVisible !== null) keyboardVisible = keyboard;
      document.documentElement.style.setProperty('--remote-height', `${height}px`);
    };
    window.addEventListener('resize', onViewport);
    window.visualViewport?.addEventListener('resize', onViewport);
    onViewport();
    const beginEditorPointer = () => {
      editorPointer = editing;
    };
    const endEditorPointer = () => {
      if (!editorPointer) return;
      clearTimeout(editorBlurTimer);
      // Touch compatibility clicks can arrive after pointerup in a later task.
      editorBlurTimer = setTimeout(() => {
        editorPointer = false;
      }, 0);
    };
    window.addEventListener('pointerdown', beginEditorPointer, true);
    window.addEventListener('click', endEditorPointer, true);
    window.addEventListener('pointercancel', endEditorPointer, true);
    const stopReading = reading.start(() => bottom(true));
    return () => {
      rememberSession();
      disposed = true;
      trace('view.dispose', { session: diagnosticId(sessionId) });
      messageWindow.invalidate('dispose');
      releaseHistory();
      historyController?.abort();
      laterController?.abort();
      stopReading();
      clearTimeout(historyTimer);
      clearPreview();
      unsubscribe?.();
      unsubscribeRuntime();
      refreshSession.dispose();
      refreshStatus.dispose();
      refreshAcknowledgement.dispose();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('click', onFilePreview);
      window.removeEventListener('resize', onViewport);
      window.visualViewport?.removeEventListener('resize', onViewport);
      window.removeEventListener('pointerdown', beginEditorPointer, true);
      window.removeEventListener('click', endEditorPointer, true);
      window.removeEventListener('pointercancel', endEditorPointer, true);
      clearTimeout(editorBlurTimer);

      document.documentElement.style.removeProperty('--remote-height');
    };
  });
</script>

<!-- eslint-disable svelte/no-at-html-tags -- Lucide icons and escaped Markdown renderer -->
<div
  class="remote-app"
  class:remote-home={!sessionId}
  class:remote-editing={editing}
  bind:this={drawerSurface}
>
  <header class="remote-header">
    {#if sessionId}<button
        type="button"
        class="remote-menu"
        bind:this={drawerTrigger}
        aria-label="会话列表"
        aria-haspopup="dialog"
        aria-controls="remote-sessions-drawer"
        aria-expanded={drawerOpen}
        onclick={openDrawer}>{@html icon(Menu)}</button
      >{/if}
    <div class="remote-heading">
      <h1 {title}>{title}</h1>
    </div>
    {#if sessionId}<SessionStatus snapshot={status} {connected} />{/if}
    <details class="remote-info" bind:this={info}>
      <summary
        aria-label="更多"
        onkeydown={(event) => {
          if (event.key === 'Escape') info.open = false;
        }}>{@html icon(Ellipsis)}</summary
      >
      <div class="remote-info-panel">
        <button
          type="button"
          class="remote-info-notifications"
          aria-haspopup="dialog"
          onclick={() => {
            info.open = false;
            nameSettings.open();
          }}>{@html icon(SquarePen)}<span>应用名称</span></button
        >
        {#if sessionId}
          <button
            type="button"
            class="remote-info-notifications"
            aria-haspopup="dialog"
            onclick={() => {
              info.open = false;
              sessionTools.open();
            }}>{@html icon(Menu)}<span>会话详情</span></button
          >
          <button
            type="button"
            class="remote-info-notifications"
            aria-haspopup="dialog"
            onclick={() => {
              info.open = false;
              sessionTools.open('compact');
            }}>{@html icon(Layers)}<span>压缩上下文</span></button
          >
          <button
            type="button"
            class="remote-info-notifications"
            onclick={() => {
              info.open = false;
              contextShare.shareLoaded();
            }}>{@html icon(Share2)}<span>分享已加载上下文</span></button
          >
          <button
            type="button"
            class="remote-info-notifications"
            onclick={() => {
              info.open = false;
              contextShare.prepareFull();
            }}>{@html icon(Share2)}<span>分享完整会话</span></button
          >
          <button
            type="button"
            class="remote-info-notifications"
            aria-label="通知"
            aria-haspopup="dialog"
            onclick={() => {
              info.open = false;
              pushSettings.open();
            }}>{@html icon(Bell)}<span>通知设置</span></button
          >
          <button
            type="button"
            class="remote-info-notifications"
            disabled={interfaceRefresh.pending > 0 || interfaceRefresh.refreshing}
            onclick={() => {
              info.open = false;
              refreshInterface();
            }}>{@html icon(RefreshCw)}<span>刷新界面</span></button
          >
          <button
            type="button"
            class="remote-info-notifications remote-info-shutdown"
            disabled={!canShutdown}
            aria-busy={closingProcess}
            onclick={shutdownProcess}
            >{@html icon(Power)}<span>{closingProcess ? '正在关闭…' : '关闭进程'}</span></button
          >
        {/if}
      </div>
    </details>
    {#if !sessionId}<button
        type="button"
        aria-label="通知"
        aria-haspopup="dialog"
        onclick={() => pushSettings.open()}>{@html icon(Bell)}</button
      ><button
        type="button"
        aria-label="刷新界面"
        disabled={interfaceRefresh.pending > 0 || interfaceRefresh.refreshing}
        onclick={refreshInterface}>{@html icon(RefreshCw)}</button
      >{/if}
    <button type="button" class="remote-new-button" onclick={openNew} aria-label="新建会话"
      >{@html icon(SquarePen, { size: 23 })}</button
    >
  </header>

  {#if sessionId}<SessionInfo {cwd} {branch} {status} known={runtimeKnown} />{/if}

  <RefreshError />

  {#if !sessionId}
    <SessionList onnew={openNew} />
    <footer class="remote-home-composer">
      <button type="button" class="remote-home-input" aria-label="开始新任务" onclick={openNew}>
        {@html icon(Plus, { size: 24 })}<span>给 Pi 一个新任务</span><span class="home-send"
          >{@html icon(ArrowUp, { size: 22 })}</span
        >
      </button>
    </footer>
  {:else}
    <main
      class="remote-main"
      aria-busy={loading || historyLoading}
      bind:this={viewport}
      onscroll={scrollConversation}
    >
      {#if !connected}<p class="remote-warning" role="status">实时更新连接中…</p>{/if}
      {#if activeState === 'needs-you'}<p class="remote-warning">
          Pi 需要终端交互，请在电脑上处理原生对话框。
        </p>{/if}
      {#if contentError}<p class="remote-error" role="alert">
          {contentError}<button type="button" onclick={() => refreshSession.run()}>重试</button>
        </p>{/if}
      {#if error}<p class="remote-error" role="alert">
          {error}<button type="button" aria-label="关闭错误提示" onclick={() => (error = '')}
            >关闭</button
          >
        </p>{/if}
      {#if loading && !messages.length}<p role="status">加载中…</p>{/if}
      {#if hasEarlier}<div class="remote-history">
          {#if historyError}<p class="remote-error" role="alert">
              历史加载失败，已读内容仍保留。{historyError}
            </p>{/if}
          <button
            type="button"
            class="remote-earlier"
            disabled={historyLoading && visibleIndex === 0}
            onclick={() => {
              historyError = '';
              loadEarlier();
            }}>{historyLoading && visibleIndex === 0 ? '加载中…' : '加载更早的消息'}</button
          >
        </div>{/if}
      {#each visibleMessages as message (message.id)}
        {@const inlineCopy =
          message.role === 'assistant' && message.blocks.some((block) => block.type === 'tool')}
        {@const blocks = inlineCopy ? commentaryBlocks(message.blocks) : message.blocks}
        {@const timing = replyTiming(message)}
        {@const lastBlock = blocks.at(-1)}
        {@const body = message.blocks
          .filter((block) => block.type === 'text')
          .map((block) => messageText(message, block))
          .join('\n\n')}
        {#snippet endedAt()}
          &#32;<time
            class="remote-reply-time"
            datetime={message.timestamp}
            aria-label={`回复结束时间 ${timing.clock}`}>{timing.clock}</time
          >
        {/snippet}
        {#snippet content()}
          {#each blocks as block (block.index)}
            {#if block.type === 'text'}
              {@const text = messageText(message, block)}
              {#if text.trim()}
                {@const endsReply = timing && block === lastBlock && !message.error}
                {#snippet textTail()}
                  {#if inlineCopy}<CopyAction {text} inline />{/if}
                  {#if endsReply}{@render endedAt()}{/if}
                {/snippet}
                <Markdown
                  {text}
                  {sessionId}
                  compact={message.role === 'user'}
                  trailing={inlineCopy || endsReply ? textTail : undefined}
                />
              {/if}
            {:else}<RemoteBlock
                {sessionId}
                entryId={message.id}
                {block}
                bind:this={blockViews[`${message.id}:${block.index}`]}
              />{/if}
          {/each}
          {#if message.error}<p class="remote-error">
              {message.error}{#if timing}{@render endedAt()}{/if}
            </p>
          {:else if timing && lastBlock?.type !== 'text'}{@render endedAt()}{/if}
        {/snippet}
        {#if message.role === 'user'}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (user bubbles expose a keyboard context menu) -->
          <article
            class="remote-user"
            data-message-id={message.id}
            aria-label="你"
            aria-haspopup="menu"
            tabindex="0"
            use:contextMenu={(anchor) => messageActions.open(message, anchor, body)}
          >
            {@render content()}
          </article>
        {:else}
          <article data-message-id={message.id} aria-label="Pi">
            {@render content()}
            {#if (!inlineCopy && body.trim()) || message.forkable || timing}
              <div class="remote-message-actions">
                {#if !inlineCopy && body.trim()}<CopyAction text={body} />{/if}
                {#if message.forkable}
                  <ForkAction
                    {sessionId}
                    entryId={message.id}
                    menu={false}
                    bind:busy={forkBusy}
                    onfork={navigateFork}
                  />
                {/if}
                {#if timing}<span class="remote-duration" aria-label={`本轮耗时 ${timing.duration}`}
                    >{timing.duration}</span
                  >{/if}
              </div>
            {/if}
          </article>
        {/if}
      {/each}
      {#if messageWindow.state.next}<div class="remote-history">
          <button type="button" disabled={laterLoading} onclick={loadLater}
            >{laterLoading ? '加载中…' : '加载后续消息'}</button
          >
        </div>{/if}
      {#if awayFromBottom}<button
          type="button"
          class="remote-bottom"
          aria-label="最新消息"
          onclick={showLatest}>{@html icon(ArrowDown, { size: 16 })}</button
        >{/if}
    </main>

    <div class="remote-compose-context">
      {#if !chatAvailable && !loading}<p>{chatDisabledReason}</p>{/if}
    </div>
    <footer class="remote-composer">
      <RemoteComposer
        {composer}
        commandsURL={endpoint('/api/commands')}
        catalogKey={status.instanceId || ''}
        onsessioninfo={() => sessionTools.open()}
        oncompact={() => sessionTools.open('compact')}
        canCompact={runtimeKnown && status.canCompact === true && !reloadingResources}
        onreload={reloadResources}
        {canReload}
        reloading={reloadingResources}
        {canSend}
        running={status.mainRunning || activeState === 'running'}
        onsend={sendMessage}
        {canQueue}
        {sessionId}
        queueStatus={status}
        queueAvailable={runtimeKnown}
        onqueue={() => sendMessage(null, 'followUp')}
        onstop={() => control('/api/chat/cancel', {})}
        oninput={() => {
          if (info) info.open = false;
        }}
        onfocus={() => {
          editorFocused = true;
          if (info) info.open = false;
        }}
        onblur={() => {
          editorFocused = false;
        }}
        status={modelStatus}
        {models}
        {modelsLoading}
        {modelsError}
        onmodelopen={loadModels}
        onmodel={(model) =>
          selectSettings({ provider: model.provider, modelId: model.id }, '/api/set-model', {
            provider: model.provider,
            modelId: model.id,
          })}
        onthinking={(level) =>
          selectSettings({ thinking: level }, '/api/set-thinking-level', { level })}
        onspeed={selectSpeed}
        bind:textarea
      />
    </footer>
  {/if}
</div>

{#if sessionId}
  <MessageActions
    bind:this={messageActions}
    {sessionId}
    bind:busy={forkBusy}
    onfork={navigateFork}
  />
  <ContextShare bind:this={contextShare} {sessionId} {messages} {blockViews} {title} {cwd} />
  <SessionTools bind:this={sessionTools} {sessionId} {status} known={runtimeKnown} />
{/if}

<dialog class="remote-preview" aria-label="预览" bind:this={previewDialog} onclose={clearPreview}>
  <header>
    <strong title={preview?.name || previewPath}>{preview?.name || previewPath}</strong>
    <button type="button" onclick={() => openPreview(previewPath)} disabled={previewLoading}
      >重新加载</button
    >
    {#if preview?.source}<a href={preview.source} target="_blank" rel="noreferrer">原文</a>{/if}
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
      sandbox={preview.source ? '' : 'allow-scripts allow-forms allow-modals allow-downloads'}
      referrerpolicy="no-referrer"
    ></iframe>
  {/if}
</dialog>

<ImageViewer />
<NewTask bind:this={newTask} />
<PushSettings bind:this={pushSettings} />
<AppNameSettings bind:this={nameSettings} />

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
    border-radius: 12px;
  }
  :global(button),
  :global(select),
  :global(input) {
    min-height: 44px;
    padding: 9px 12px;
  }
  :global(button) {
    cursor: pointer;
    transition:
      background 150ms ease,
      opacity 150ms ease,
      transform 150ms ease;
    -webkit-tap-highlight-color: transparent;
  }
  :global(button:not(:disabled):active) {
    transform: scale(0.97);
  }
  :global(button:hover) {
    filter: brightness(0.98);
  }
  :global(input:focus-visible) {
    outline: 2px solid color-mix(in srgb, var(--accent) 65%, transparent);
    outline-offset: 2px;
  }
  :global(dialog) {
    overscroll-behavior: contain;
  }
  :global(body) {
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  @media (prefers-reduced-motion: reduce) {
    :global(button) {
      transition: none;
    }
  }

  :global(button:disabled) {
    opacity: 0.4;
    cursor: default;
  }
  :global(a) {
    color: var(--link);
  }
  :global(button:focus-visible),
  :global(a:focus-visible),
  :global(summary:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .remote-app {
    height: var(--remote-height, 100dvh);
    max-width: 800px;
    margin: auto;
    display: flex;
    flex-direction: column;
    padding-top: env(safe-area-inset-top);
  }
  .remote-header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    flex: none;
    z-index: 2;
    background: var(--body-bg);
  }
  .remote-editing > .remote-header,
  .remote-editing > :global(.session-info) {
    display: none;
  }
  .remote-home .remote-header {
    padding: 22px 20px 18px;
  }
  .remote-heading h1 {
    display: -webkit-box;
    width: 100%;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow-wrap: anywhere;
    line-height: 1.35;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .remote-home .remote-heading h1 {
    font-size: 30px;
    font-weight: 500;
  }
  .remote-header > button {
    display: grid;
    place-items: center;
    min-width: 42px;
    width: 42px;
    min-height: 42px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--surface-2);
    flex: none;
  }
  .remote-heading {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    min-height: 44px;
  }
  .remote-warning {
    color: var(--warning);
  }
  .remote-main {
    overflow: auto;
    overflow-anchor: none;
    overscroll-behavior: contain;
    flex: 1;
    min-height: min(80px, calc(var(--remote-height, 100dvh) * 0.14));
    padding: 14px 20px 24px;
    overflow-wrap: anywhere;
    scrollbar-width: thin;
  }
  .remote-info {
    flex: none;
  }
  .remote-info summary {
    display: grid;
    place-items: center;
    cursor: pointer;
    list-style: none;
    width: 42px;
    height: 42px;
    padding: 0;
    border-radius: 50%;
    background: var(--surface-2);
  }
  .remote-info summary::-webkit-details-marker {
    display: none;
  }
  .remote-info:not([open]) .remote-info-panel {
    display: none;
  }
  .remote-info-panel {
    position: absolute;
    top: calc(100% - 2px);
    right: 12px;
    z-index: 5;
    width: min(360px, calc(100vw - 24px));
    max-height: calc(var(--remote-height, 100dvh) - 100px);
    overflow: auto;
    padding: 18px;
    background: var(--surface);
    border: 1px solid var(--dim);
    border-radius: 22px;
    box-shadow: var(--popover-shadow);
    font-size: 12px;
    animation: info-in 150ms var(--ease-out);
  }
  .remote-info-notifications {
    width: 100%;
    border: 0;
    border-radius: 0;
    background: transparent;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 8px;
    color: var(--text-soft);
  }
  .remote-info-shutdown {
    min-height: 44px;
    margin-top: 8px;
    color: var(--danger);
  }
  .remote-home-composer {
    flex: none;
    padding: 12px 12px max(14px, env(safe-area-inset-bottom));
    background: linear-gradient(transparent, var(--body-bg) 20%);
  }
  .remote-home-input {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 58px;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--dim) 65%, transparent);
    border-radius: 30px;
    background: var(--composer-bg);
    box-shadow: var(--floating-shadow);
    text-align: left;
  }
  .remote-home-input > span:first-of-type {
    flex: 1;
    min-width: 0;
    color: var(--muted);
    font-size: 16px;
  }
  .home-send {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    flex: none;
    border-radius: 50%;
    color: var(--body-bg);
    background: var(--muted);
    opacity: 0.35;
  }
  @keyframes info-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  article {
    min-width: 0;
  }
  article.remote-user {
    width: fit-content;
    max-width: 92%;
    margin: 24px 0 22px auto;
    padding: 12px 16px;
    border-radius: 22px;
    background: var(--surface-2);
    color: var(--text);
  }
  article.remote-user:first-child {
    margin-top: 0;
  }
  article.remote-user:focus-visible {
    outline: 2px solid var(--muted);
    outline-offset: 3px;
  }
  @media (pointer: coarse) {
    article.remote-user {
      -webkit-touch-callout: none;
      user-select: none;
    }
  }
  .remote-reply-time,
  .remote-duration {
    color: var(--text-soft);
    font-size: 12px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .remote-reply-time {
    display: inline-block;
  }
  .remote-message-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    margin-top: 4px;
    user-select: none;
  }
  .remote-message-actions :global(button) {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 12px;
    background: transparent;
    color: var(--muted);
  }
  .remote-message-actions :global(button:first-of-type) {
    /* 只将触控区向左外扩，让图标与正文左缘对齐。 */
    margin-left: -19px;
  }
  .remote-message-actions :global(button:first-of-type svg) {
    transform: translateX(6px);
  }
  .remote-message-actions :global(button:nth-of-type(2) svg) {
    transform: translateX(-6px);
  }
  .remote-message-actions :global(button:hover),
  .remote-message-actions :global(button:focus-visible) {
    background: var(--surface-2);
    color: var(--text);
  }
  :global(.remote-block) {
    min-width: 0;
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
    display: flex;
    flex-direction: column;
    flex: 0 1 auto;
    min-height: 0;
    padding: clamp(0px, calc(var(--remote-height, 100dvh) - 420px), 8px) 12px
      max(clamp(0px, calc(var(--remote-height, 100dvh) - 420px), 12px), env(safe-area-inset-bottom));
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
  .remote-error {
    color: var(--danger);
  }
  :global(.remote-file) {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    padding: 2px 8px;
    margin: 4px 0;
    border: 1px solid var(--dim);
    border-radius: 8px;
    font-size: 12px;
    line-height: 20px;
  }
  :global(.remote-file-name) {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  :global(.remote-file-actions) {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 8px;
  }
  :global(.remote-file-actions button),
  :global(.remote-file-actions a) {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 3px 2px;
    line-height: 20px;
    white-space: nowrap;
    background: transparent;
  }
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
</style>
