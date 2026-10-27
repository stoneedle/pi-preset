<script>
  import { untrack } from 'svelte';
  import { request } from '../remote-api.js';
  import { editDraft } from '../remote-drafts.svelte.js';

  let { composer, url = '', catalogKey = '', onselect } = $props();
  const resource = $derived({ url, catalogKey });
  let skills = $state([]);
  let loaded = null;
  let controller;
  const query = $derived(composer.text.match(/^\/(\S*)$/)?.[1]?.toLowerCase());
  const matching = $derived(
    query === undefined ? [] : skills.filter((skill) => skill.name.toLowerCase().includes(query)),
  );

  $effect(() => {
    const source = resource;
    if (loaded?.url !== source.url) skills = [];
    loaded = null;
    if (!source.url) return;
    const active = new AbortController();
    controller = active;
    return () => active.abort();
  });

  $effect(() => {
    const source = resource;
    if (query === undefined || !source.url) return;
    untrack(() => load(source));
  });

  async function load(source) {
    if (loaded === source) return;
    loaded = source;
    const signal = controller.signal;
    const requestedQuery = query;
    try {
      const data = await request(source.url, { signal });
      if (!signal.aborted) skills = data.commands || [];
    } catch {
      if (!signal.aborted) {
        loaded = null;
        if (query !== undefined && query !== requestedQuery) await load(source);
      }
    }
  }
</script>

{#if matching.length}
  <div class="remote-skills">
    {#each matching as skill (skill.name)}
      <button
        type="button"
        title={skill.name}
        onclick={() => {
          editDraft(composer, `/${skill.name} `);
          onselect?.();
        }}>{skill.name}</button
      >
    {/each}
  </div>
{/if}

<style>
  .remote-skills {
    flex: 0 1 auto;
    min-height: 0;
    max-height: min(240px, calc(var(--remote-height, 100dvh) * 0.3));
    overflow-y: auto;
    background: var(--surface);
    border: 1px solid var(--dim);
    border-radius: 8px;
  }
  button {
    display: block;
    width: 100%;
    text-align: left;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
</style>
