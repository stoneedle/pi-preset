<script>
  let { cwd = '', branch = '', status = {}, known = false } = $props();
  const folder = $derived(cwd.split(/[\\/]/).filter(Boolean).at(-1) || '未知项目');
  const context = $derived(known ? status.context : null);
  const percent = $derived(
    Number.isFinite(context?.percent) && context.percent >= 0 ? context.percent : null,
  );
  const level = $derived(percent > 90 ? 'danger' : percent > 70 ? 'warning' : 'normal');
  const contextLabel = $derived(percent === null ? '?' : Math.round(percent) + '%');
  function tokens(value) {
    return Number.isFinite(value) && value >= 0
      ? Number((value / 1000).toFixed(value < 1000 ? 3 : 1)) + 'k'
      : '?';
  }
</script>

<div class="session-info" role="group" aria-label="会话信息">
  <span class="session-project" title={cwd + (branch ? ` (${branch})` : '')}
    >{folder}{#if branch}<span class="session-branch"> ({branch})</span>{/if}</span
  >
  <span aria-label="输入 token">↑{tokens(known ? status.usage?.input : null)}</span>
  <span aria-label="输出 token">↓{tokens(known ? status.usage?.output : null)}</span>
  <span aria-label="缓存命中率"
    >CH{known && Number.isFinite(status.cacheHit) ? Math.round(status.cacheHit) + '%' : '?'}</span
  >
  <span
    class="session-context"
    aria-label="上下文窗口"
    title={`上下文 ${tokens(context?.tokens)} / ${tokens(context?.contextWindow)}`}
    data-level={level}
  >
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle class="context-track" cx="16" cy="16" r="14" />
      <circle
        class="context-progress"
        cx="16"
        cy="16"
        r="14"
        pathLength="100"
        stroke-dasharray={`${Math.min(percent ?? 0, 100)} 100`}
        transform="rotate(-90 16 16)"
      />
    </svg>
    <span class:context-wide={contextLabel.length > 3}>{contextLabel}</span>
  </span>
</div>

<style>
  .session-info {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
    min-width: 0;
    padding: 0 16px 7px;
    background: var(--body-bg);
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
    font-variant-numeric: tabular-nums;
  }
  .session-info > span {
    white-space: nowrap;
  }
  .session-info > :not(.session-project) {
    flex: none;
  }
  .session-project {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-soft);
  }
  .session-branch {
    color: var(--muted);
  }
  .session-context {
    position: relative;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    font-size: 9px;
    font-weight: 600;
    line-height: 1;
  }
  .session-context .context-wide {
    font-size: 8px;
  }
  .session-context svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    fill: none;
    stroke-width: 2;
  }
  .context-track {
    stroke: var(--dim);
  }
  .context-progress {
    stroke: currentColor;
  }
  .session-context[data-level='warning'] {
    color: var(--warning);
  }
  .session-context[data-level='danger'] {
    color: var(--danger);
  }
  @media (max-width: 480px) {
    .session-info {
      gap: 8px;
    }
  }
</style>
