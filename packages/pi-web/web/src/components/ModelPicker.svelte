<script>
  import { icon, Zap, ChevronDown, Check } from '../shared/icons.js';

  let {
    model = '',
    name = '',
    allowDefaultSpeed = false,
    provider = '',
    thinking = '',
    fast = null,
    models = [],
    disabled = false,
    loading = false,
    error = '',
    onopen,
    onmodel,
    onthinking,
    onspeed,
  } = $props();
  let panel = $state(null);
  let busy = $state(false);
  let query = $state('');
  const levels = {
    off: '关闭',
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最高',
  };
  const selected = $derived(models.find((item) => item.id === model && item.provider === provider));
  const available = $derived(
    selected?.thinkingLevels || ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  );
  const filtered = $derived(
    models.filter((item) =>
      (item.name + ' ' + item.id + ' ' + item.provider).toLowerCase().includes(query.toLowerCase()),
    ),
  );
  const displayName = $derived(name || selected?.name || model || 'Pi 默认');
  async function change(callback, value) {
    if (busy) return;
    busy = true;
    try {
      await callback?.(value);
    } finally {
      busy = false;
    }
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<button
  type="button"
  class="model-trigger"
  aria-label="模型设置"
  aria-haspopup="dialog"
  {disabled}
  onclick={() => {
    panel.showModal();
    onopen?.();
  }}
>
  {#if fast?.mode && fast.mode !== 'off'}<span
      class="model-fast"
      class:model-fast-inactive={Array.isArray(fast.availableModes) &&
        !fast.availableModes.includes(fast.mode)}
      title={(fast.mode === 'ultrafast' ? '极速' : '快速') +
        (Array.isArray(fast.availableModes) && !fast.availableModes.includes(fast.mode)
          ? ' — 对此模型不生效'
          : '')}>{@html icon(Zap, { size: 16 })}</span
    >{/if}
  <span class="model-name">{displayName}</span>
  {#if thinking}<span class="model-thinking">{levels[thinking] || thinking}</span>{/if}
  {@html icon(ChevronDown, { size: 12 })}
</button>

<dialog
  class="model-popover"
  aria-label="模型设置"
  bind:this={panel}
  onclick={(event) => {
    if (event.target === panel) {
      const box = panel.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      )
        panel.close();
    }
  }}
>
  <header>
    <strong>模型设置</strong><button
      type="button"
      onclick={() => panel.close()}
      aria-label="关闭模型设置">完成</button
    >
  </header>
  <label class="model-search"
    ><input type="search" aria-label="搜索模型" placeholder="搜索模型" bind:value={query} /></label
  >
  {#if loading}<p role="status">正在读取 Pi 模型…</p>{/if}
  {#if error}<p role="alert" class="picker-error">{error}</p>{/if}
  <div class="model-options" role="group" aria-label="模型">
    {#each filtered as item (item.provider + '/' + item.id)}
      <button
        type="button"
        class="model-option"
        disabled={busy}
        aria-pressed={item.provider === provider && item.id === model}
        onclick={() => change(onmodel, item)}
      >
        <span><strong>{item.name || item.id}</strong><small>{item.provider}</small></span>
        {#if item.provider === provider && item.id === model}{@html icon(Check, { size: 18 })}{/if}
      </button>
    {/each}
    {#if !loading && !models.length}<p>使用 Pi 的默认模型；连接后可读取更多选项。</p>{/if}
  </div>
  <section>
    <h3>思考强度</h3>
    <div class="picker-segments" role="group" aria-label="思考强度">
      {#each available as level (level)}<button
          type="button"
          aria-pressed={thinking === level}
          disabled={busy}
          onclick={() => change(onthinking, level)}>{levels[level] || level}</button
        >{/each}
    </div>
  </section>
  <section>
    <h3>{@html icon(Zap, { size: 15 })}速度</h3>
    <div class="picker-segments" role="group" aria-label="速度">
      {#if allowDefaultSpeed}<button
          type="button"
          aria-pressed={fast === null}
          disabled={busy}
          onclick={() => change(onspeed, null)}>跟随 Pi</button
        >{/if}
      {#each [{ mode: 'off', name: '标准' }, { mode: 'fast', name: '快速' }, { mode: 'ultrafast', name: '极速' }] as speed (speed.mode)}
        <button
          type="button"
          aria-pressed={fast?.mode === speed.mode}
          disabled={busy ||
            (!allowDefaultSpeed && !Array.isArray(fast?.availableModes)) ||
            (Array.isArray(fast?.availableModes) && !fast.availableModes.includes(speed.mode))}
          onclick={() => change(onspeed, speed.mode)}>{speed.name}</button
        >
      {/each}
    </div>
    <small
      >{fast === null
        ? '沿用 Pi 设置；加速需原生扩展支持'
        : fast.availableModes?.length === 1
          ? '当前模型不支持加速'
          : '设置对后续请求生效'}</small
    >
  </section>
</dialog>

<style>
  .model-trigger {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    min-width: 0;
    min-height: 40px;
    padding: 6px 4px;
    border: 0;
    background: transparent;
    white-space: nowrap;
    font-size: 14px;
  }
  .model-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .model-thinking {
    flex: none;
    color: var(--muted);
  }
  .model-trigger :global(svg),
  .model-fast {
    display: flex;
    flex: none;
  }
  .model-fast {
    color: var(--accent);
  }
  .model-fast-inactive {
    color: var(--muted);
  }
  .model-popover {
    position: fixed;
    inset: auto 12px max(90px, env(safe-area-inset-bottom)) auto;
    width: min(360px, calc(100vw - 24px));
    max-height: calc(var(--remote-height, 100dvh) - 100px);
    margin: 0;
    padding: 16px;
    border: 1px solid var(--dim);
    border-radius: 24px;
    color: var(--text);
    background: var(--surface);
    box-shadow: var(--popover-shadow);
    overflow: auto;
    overscroll-behavior: contain;
  }
  .model-popover[open] {
    animation: popover-in 180ms var(--ease-out);
  }
  .model-popover::backdrop {
    background: #0002;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
  }
  header strong {
    font-size: 15px;
  }
  header button {
    padding: 4px 8px;
    min-height: 36px;
    border: 0;
    background: transparent;
    color: var(--text-soft);
    font-size: 14px;
  }
  .model-search input {
    width: 100%;
    min-height: 40px;
    border: 0;
    border-radius: 12px;
    padding: 8px 12px;
    background: var(--surface-2);
    font-size: 16px;
  }
  .model-options {
    max-height: min(230px, 26dvh);
    overflow: auto;
    margin: 8px -4px;
  }
  .model-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    width: 100%;
    padding: 9px 10px;
    border: 0;
    border-radius: 12px;
    background: transparent;
    text-align: left;
  }
  .model-option[aria-pressed='true'] {
    background: var(--surface-2);
  }
  .model-option span {
    min-width: 0;
  }
  .model-option strong {
    display: block;
    font-size: 14px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .model-option small {
    font-size: 11px;
    color: var(--muted);
  }
  section {
    border-top: 1px solid var(--dim);
    padding: 12px 0 2px;
    margin-top: 10px;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-soft);
  }
  .picker-segments {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    padding: 4px;
    background: var(--surface-2);
    border-radius: 12px;
  }
  .picker-segments button {
    flex: 1;
    min-width: 32px;
    min-height: 34px;
    padding: 5px 7px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    font-size: 12px;
  }
  .picker-segments button[aria-pressed='true'] {
    background: var(--surface);
    box-shadow: 0 1px 4px #0001;
  }
  section > small,
  p {
    display: block;
    font-size: 12px;
    color: var(--muted);
    margin: 8px 0 0;
  }
  .picker-error {
    color: var(--danger);
  }
  @keyframes popover-in {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .model-popover[open] {
      animation: none;
    }
  }
</style>
