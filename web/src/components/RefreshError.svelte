<script>
  import { interfaceRefresh } from '../remote-refresh.svelte.js';
</script>

{#if interfaceRefresh.error}
  <p class="refresh-error" role="alert">{interfaceRefresh.error}</p>
{/if}

<style>
  .refresh-error {
    flex: 0 1 auto;
    min-height: 0;
    max-height: 84px;
    overflow: auto;
    margin: 6px 12px;
    color: var(--muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
</style>
