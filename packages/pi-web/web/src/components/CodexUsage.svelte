<script>
  import { onDestroy, onMount, untrack } from 'svelte';
  import { request } from '../remote-api.js';
  import { icon, RefreshCw, X } from '../shared/icons.js';

  let { active = false } = $props();
  let snapshot = $state(null);
  let loading = $state(false);
  let error = $state('');
  let opened = $state(false);
  let trigger;
  let panel;
  let checkedAt = 0;
  let pending;
  let controller;
  const weekly = $derived(snapshot?.windows.find((window) => window.windowMinutes === 10080));
  const percentage = (value) =>
    new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value) + '%';
  const label = $derived(
    `Codex 周剩余 ${weekly ? percentage(weekly.remainingPercent) : '未知'}，查看额度详情${error ? '，更新失败' : ''}`,
  );

  function windowLabel(minutes) {
    if (minutes === 10080) return '每周';
    if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
    if (minutes % 60 === 0) return `${minutes / 60} 小时`;
    return `${minutes} 分钟`;
  }

  function timeLabel(milliseconds, date = false) {
    return new Intl.DateTimeFormat('zh-CN', {
      ...(date ? { month: 'numeric', day: 'numeric' } : {}),
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(milliseconds);
  }

  function resetLabel(seconds) {
    if (!seconds || seconds <= 0) return '恢复时间未知';
    const date = new Date(seconds * 1000);
    return `${timeLabel(date, date.toDateString() !== new Date().toDateString())} 恢复`;
  }

  function refresh(force = false) {
    if (pending) return pending;
    if (!force && Date.now() - checkedAt < 60000) return;
    if (!navigator.onLine) {
      error = '当前离线，联网后可刷新';
      return;
    }
    controller = new AbortController();
    loading = true;
    pending = (async () => {
      try {
        const result = await request('/api/codex-usage' + (force ? '?refresh=1' : ''), {
          signal: controller.signal,
          timeout: 15000,
          retries: 0,
          background: true,
        });
        checkedAt = Date.now();
        error = result.message || '';
        if (result.status === 'ok') snapshot = result;
        else if (result.status !== 'unavailable') snapshot = null;
      } catch (cause) {
        if (!controller.signal.aborted) error = cause.message;
      } finally {
        loading = false;
        pending = null;
      }
    })();
    return pending;
  }

  function position() {
    if (!panel?.matches(':popover-open')) return;
    const anchor = trigger.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft || 0) + 12;
    const top = (viewport?.offsetTop || 0) + 12;
    const right = left + (viewport?.width || window.innerWidth) - 24;
    panel.style.left = `${Math.max(left, Math.min(anchor.left, right - box.width))}px`;
    panel.style.top = `${Math.max(top, anchor.top - box.height - 8)}px`;
  }

  function close(restoreFocus = false) {
    panel.hidePopover();
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function toggle() {
    if (opened) return close();
    panel.showPopover();
    position();
    panel.focus({ preventScroll: true });
    void refresh();
  }

  $effect(() => {
    if (!active) {
      panel?.hidePopover();
      return;
    }
    const update = () => {
      if (!document.hidden) void refresh();
    };
    untrack(update);
    const timer = setInterval(update, 60000);
    window.addEventListener('online', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', update);
      document.removeEventListener('visibilitychange', update);
    };
  });

  onMount(() => {
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  });
  onDestroy(() => controller?.abort());
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<button
  type="button"
  class="quota-trigger"
  class:low={weekly && weekly.remainingPercent <= 30}
  class:empty={weekly && weekly.remainingPercent <= 10}
  class:stale={error}
  bind:this={trigger}
  aria-label={label}
  aria-haspopup="dialog"
  aria-controls="codex-usage-details"
  aria-expanded={opened}
  aria-busy={loading}
  title={label}
  onclick={toggle}>{weekly ? percentage(weekly.remainingPercent) : loading ? '…' : '?'}</button
>

<div
  id="codex-usage-details"
  class="codex-details"
  role="dialog"
  aria-label="Codex 额度详情"
  tabindex="-1"
  popover="auto"
  bind:this={panel}
  onbeforetoggle={(event) => (opened = event.newState === 'open')}
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }}
>
  <header>
    <strong>Codex{snapshot?.plan ? ' · ' + snapshot.plan : ''}</strong>
    <button
      type="button"
      aria-label="刷新 Codex 额度"
      disabled={loading}
      onclick={() => refresh(true)}>{@html icon(RefreshCw, { size: 17 })}</button
    >
    <button type="button" aria-label="关闭额度详情" onclick={() => close(true)}
      >{@html icon(X, { size: 18 })}</button
    >
  </header>
  <div class="quota-windows" aria-live="polite" aria-busy={loading}>
    {#if snapshot}
      {#each snapshot.windows as window (window.id)}
        <div
          class="quota-window"
          class:low={window.remainingPercent <= 30}
          class:empty={window.remainingPercent <= 10}
        >
          <div class="quota-values">
            <span>{windowLabel(window.windowMinutes)}</span>
            <span class="quota-remaining">剩余 {percentage(window.remainingPercent)}</span>
          </div>
          <div
            class="quota-meter"
            role="progressbar"
            aria-label={windowLabel(window.windowMinutes) + '剩余额度'}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={window.remainingPercent}
          >
            <span style:width={window.remainingPercent + '%'}></span>
          </div>
          <div class="quota-reset">{resetLabel(window.resetsAt)}</div>
        </div>
      {/each}
    {:else}
      <p>{error || (loading ? '正在读取订阅额度…' : '尚未读取订阅额度')}</p>
    {/if}
  </div>
  {#if snapshot}
    <div class="quota-updated" role="status">
      {loading ? '正在更新' : error ? '更新失败 · 上次' : '更新于'}
      <time
        datetime={new Date(snapshot.updatedAt).toISOString()}
        title={new Date(snapshot.updatedAt).toLocaleString('zh-CN')}
        >{timeLabel(snapshot.updatedAt)}</time
      >
      {#if error}<p>{error}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .quota-trigger,
  .codex-details {
    font-variant-numeric: tabular-nums;
  }
  .quota-trigger {
    justify-self: start;
    min-width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    color: var(--text-soft);
    background: transparent;
    text-align: left;
    font-size: 13px;
  }
  .quota-trigger:hover {
    color: var(--text);
  }
  .quota-trigger.low,
  .quota-window.low .quota-remaining {
    color: var(--warning);
  }
  .quota-trigger.empty,
  .quota-window.empty .quota-remaining {
    color: var(--danger);
  }
  .quota-trigger.stale {
    color: var(--text-soft);
    text-decoration: underline dotted;
    text-underline-offset: 3px;
  }
  .codex-details {
    position: fixed;
    inset: auto;
    width: min(336px, calc(100vw - 24px));
    max-height: calc(var(--remote-height, 100dvh) - 24px);
    margin: 0;
    padding: 8px 16px 16px;
    overflow: auto;
    border: 1px solid var(--dim);
    border-radius: 12px;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--popover-shadow);
    font-size: 13px;
    outline: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-right: -8px;
    margin-bottom: 8px;
  }
  strong {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    font-weight: 600;
  }
  header button {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text-soft);
  }
  header button:hover:not(:disabled) {
    background: var(--surface-2);
  }
  header button:disabled {
    opacity: 0.5;
  }
  .quota-window + .quota-window {
    margin-top: 16px;
  }
  .quota-values {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .quota-meter {
    height: 4px;
    margin: 8px 0 6px;
    overflow: hidden;
    border-radius: 2px;
    background: var(--dim);
  }
  .quota-meter span {
    display: block;
    height: 100%;
    background: var(--accent);
  }
  .quota-window.low .quota-meter span {
    background: var(--warning);
  }
  .quota-window.empty .quota-meter span {
    background: var(--danger);
  }
  .quota-reset,
  .quota-updated {
    color: var(--text-soft);
    font-size: 12px;
    line-height: 18px;
  }
  .quota-updated {
    margin-top: 16px;
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
</style>
