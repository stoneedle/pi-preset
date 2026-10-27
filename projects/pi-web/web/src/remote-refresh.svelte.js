import { reloadDocument, trace } from './remote-diagnostics.js';
import { observeControls } from './remote-activity.js';
import { hasUnsavedDrafts } from './remote-drafts.svelte.js';

export const interfaceRefresh = $state({ pending: 0, refreshing: false, error: '' });
let allowUnload = false;

export function startRefreshProtection() {
  observeControls((pending) => (interfaceRefresh.pending = pending));
  $effect.root(() => {
    $effect(() => {
      if (!hasUnsavedDrafts() && !interfaceRefresh.pending) return;
      const preventLoss = (event) => {
        if (allowUnload || (!hasUnsavedDrafts() && !interfaceRefresh.pending)) return;
        event.preventDefault();
        event.returnValue = '';
      };
      window.addEventListener('beforeunload', preventLoss);
      return () => window.removeEventListener('beforeunload', preventLoss);
    });
  });
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    trace('page.resource-error');
    interfaceRefresh.error = '部分界面资源加载失败，草稿已保留；可稍后通过顶部菜单刷新界面。';
  });
}

export async function refreshInterface() {
  if (interfaceRefresh.pending || interfaceRefresh.refreshing) return;
  interfaceRefresh.refreshing = true;
  interfaceRefresh.error = '';
  trace('refresh.preflight');
  try {
    const response = await fetch(location.href, {
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.arrayBuffer();
    if (interfaceRefresh.pending) return;
    if (
      hasUnsavedDrafts() &&
      !window.confirm(
        '刷新界面会丢弃当前页面中所有会话的草稿、附件、待应用设置和未确认内容。确定继续吗？',
      )
    )
      return;
    allowUnload = true;
    reloadDocument('manual');
  } catch (error) {
    trace('refresh.error', { category: error.name });
    interfaceRefresh.error = `暂时无法刷新：${error.message}`;
  } finally {
    interfaceRefresh.refreshing = false;
  }
}
