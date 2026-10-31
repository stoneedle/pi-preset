<script>
  import { flushSync } from 'svelte';
  import { icon, Plus, Image, File } from '../shared/icons.js';
  import ActionMenu from './ActionMenu.svelte';

  let { composer, disabled = false } = $props();
  let menu;
  let input;
  let kind = $state('images');
  const actions = [
    { label: '图片', icon: Image, kind: 'images' },
    { label: '文件', icon: File, kind: 'files' },
  ];
  function select(selected) {
    menu.close();
    flushSync(() => (kind = selected));
    input.click();
  }
  function add(event, kind) {
    composer[kind] = [...composer[kind], ...event.currentTarget.files];
    composer.picking = false;
    event.currentTarget.value = '';
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<div class="remote-attach">
  <button
    class="attach"
    type="button"
    aria-label="添加附件"
    aria-haspopup="menu"
    {disabled}
    onclick={(event) => {
      const button = event.currentTarget;
      if (menu.isOpenFor(button)) menu.close(true);
      else menu.open(button);
    }}>{@html icon(Plus, { size: 26 })}</button
  >
  <ActionMenu bind:this={menu} label="添加附件" dismissOnScroll={false}>
    {#each actions as action (action.kind)}
      <button
        class="action"
        type="button"
        role="menuitem"
        {disabled}
        onclick={() => select(action.kind)}
        >{@html icon(action.icon, { size: 20 })}{action.label}</button
      >
    {/each}
  </ActionMenu>
  <input
    bind:this={input}
    type="file"
    aria-label={kind === 'images' ? '选择图片' : '选择文件'}
    accept={kind === 'images' ? 'image/png,image/jpeg,image/gif,image/webp' : undefined}
    multiple
    onclick={() => (composer.picking = true)}
    oncancel={() => (composer.picking = false)}
    onchange={(event) => add(event, kind)}
  />
</div>

<style>
  .remote-attach {
    display: contents;
  }
  .attach {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    min-height: 44px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
  }
  .attach:disabled {
    opacity: 0.4;
  }
  input {
    display: none;
  }
</style>
