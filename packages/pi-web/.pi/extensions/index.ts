import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { SessionState } from './lib/session-state.ts';
import { openRemote } from './lib/remote.ts';
import { SessionTitle, firstUserText, openingTaskText, titleModel } from './lib/title/session-title.ts';
import { externalBadge, renderTitle } from './lib/title/format.ts';
import { observeTerminalFocus } from './lib/title/focus.ts';
import management from './lib/management.ts';
import { resourceReload } from './lib/resource-reload.ts';

export default function (pi: ExtensionAPI) {
  let state: SessionState | undefined;
  const reload = resourceReload(pi, () => state);
  management(pi, reload.run);
  let title: SessionTitle | undefined;
  let remote: Awaited<ReturnType<typeof openRemote>>;
  let ctxRef: ExtensionContext | undefined;
  let watcher: FSWatcher | undefined;
  let stopFocus: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let focused = false;
  let promptSession: { manager: ExtensionContext['sessionManager']; id: string } | undefined;

  function render() {
    if (!ctxRef || ctxRef.mode !== 'tui' || !state) return;
    const snapshot = state.snapshot();
    ctxRef.ui.setTitle(renderTitle({ ...snapshot,
      cwdName: basename(ctxRef.cwd), title: title?.name,
      badge: externalBadge(process.env.PI_TITLE_GLYPHS_STATUS_FILE
        ?? join(getAgentDir(), 'extension-data', 'pi-title-glyphs', `status-${process.pid}.json`)),
    }));
  }

  function acknowledge() {
    const snapshot = state?.snapshot();
    if (!snapshot?.replyId || !snapshot.unread) return;
    try { state?.acknowledge(snapshot.replyId); }
    catch (error) { ctxRef?.ui.notify(`共享已读确认失败： ${error}`, 'error'); }
  }

  async function close() {
    unsubscribe?.(); unsubscribe = undefined;
    stopFocus?.(); stopFocus = undefined;
    watcher?.close(); watcher = undefined;
    state?.close(); state = undefined;
    await remote?.close(); remote = undefined;
    await title?.close(); title = undefined;
    ctxRef = undefined;
  }

  pi.on('session_start', async (_event, ctx) => {
    await close();
    ctxRef = ctx;
    focused = ctx.mode === 'tui';
    state = new SessionState(pi, ctx, getAgentDir());
    let namingModel: string | undefined;
    try { namingModel = titleModel(getAgentDir()); }
    catch (error) { ctx.ui.notify(`自动命名配置不可用： ${error}`, 'error'); }
    title = new SessionTitle(pi, ctx, namingModel);
    unsubscribe = state.subscribe(() => {
      render();
      if (focused) acknowledge();
    });
    render();
    try { remote = await openRemote(pi, ctx, getAgentDir(), state, title, reload.request); }
    catch (error) { ctx.ui.notify(`远程控制不可用： ${error}`, 'error'); }
    try {
      const first = title.name ? undefined : firstUserText(ctx);
      if (first) {
        if (remote) await remote.initialize(first);
        else title.initialize(first);
      }
    } catch (error) { ctx.ui.notify(`自动命名失败： ${error}`, 'error'); }
    const file = ctx.sessionManager.getSessionFile();
    if (file) {
      try {
        watcher = watch(dirname(file), (_event, filename) => {
          if (filename?.toString() !== basename(file)) return;
          try { title?.nameChanged(); render(); }
          catch (error) { ctx.ui.notify(`标题同步失败： ${error}`, 'error'); }
        });
        watcher.on('error', (error) => ctx.ui.notify(`标题同步失败： ${error}`, 'error'));
      } catch (error) { ctx.ui.notify(`标题同步不可用： ${error}`, 'error'); }
    }
    if (ctx.mode === 'tui' && process.stdin.isTTY) {
      stopFocus = observeTerminalFocus((visible) => {
        focused = visible;
        if (visible) acknowledge();
        render();
      });
    }
    await state.start();
    render();
  });
  pi.on('session_shutdown', close);

  const updateContext = (_event: unknown, ctx: ExtensionContext) => {
    if (state?.sessionId !== ctx.sessionManager.getSessionId()) return;
    ctxRef = ctx;
    remote?.updateContext(ctx);
    state?.updateContext(ctx);
    render();
  };
  pi.on('session_info_changed', async (event, ctx) => {
    if (state?.sessionId !== ctx.sessionManager.getSessionId()) return;
    title?.nameChanged();
    if (remote?.local === false && event.name) await remote.rename(event.name);
    updateContext(event, ctx);
  });
  pi.on('session_tree', updateContext);
  pi.on('model_select', updateContext);
  pi.on('thinking_level_select', updateContext);
  pi.on('message_end', async (event, ctx) => {
    if (state?.sessionId !== ctx.sessionManager.getSessionId()) return;
    updateContext(event, ctx);
    const text = openingTaskText(event.message);
    if (!text || title?.name) return;
    try {
      if (remote) await remote.initialize(text);
      else title?.initialize(text);
    } catch (error) { ctx.ui.notify(`自动命名失败： ${error}`, 'error'); }
    render();
  });
  pi.on('input', (event, ctx) => {
    if (state?.sessionId !== ctx.sessionManager.getSessionId()) return;
    updateContext(event, ctx);
    if (event.source === 'interactive') { focused = true; acknowledge(); }
    render();
  });
  pi.on('agent_start', (_event, ctx) => {
    if (state?.sessionId !== ctx.sessionManager.getSessionId()) return;
    ctxRef = ctx; remote?.updateContext(ctx); state?.agentStarted(ctx);
  });
  pi.on('ui_prompt_start', (event, ctx) => {
    promptSession = { manager: ctx.sessionManager, id: ctx.sessionManager.getSessionId() };
    SessionState.promptStarted(promptSession.manager, promptSession.id, event.kind);
  });
  pi.on('ui_prompt_end', () => {
    if (promptSession) SessionState.promptEnded(promptSession.manager, promptSession.id);
    promptSession = undefined;
  });
  pi.on('agent_before_settle', async (event, ctx) => {
    if (state?.sessionId !== ctx.sessionManager.getSessionId() || remote?.local !== true) return;
    if (event.outcome === 'completed') await state.queue.deliverNext(pi);
  });
  pi.on('agent_settled', async (event, ctx) => {
    if (state?.sessionId !== ctx.sessionManager.getSessionId()) return;
    ctxRef = ctx; remote?.updateContext(ctx); await state?.agentSettled(ctx, event.aborted);
  });
}
