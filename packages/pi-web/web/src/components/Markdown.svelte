<script>
  import { mount, unmount } from 'svelte';
  import RemoteImage from './RemoteImage.svelte';
  import { createMarkdown, diagrams } from '../shared/markdown.js';
  import '../shared/markdown.css';

  let { text = '', sessionId, inline = false, muted = false, compact = false, trailing } = $props();
  const parser = $derived(createMarkdown(sessionId, inline));
  const content = $derived(inline ? parser.parseInline(text || '') : parser.parse(text || ''));

  function images(node) {
    let components = [];
    const clear = () => {
      components.forEach((component) => unmount(component));
      components = [];
    };
    const update = () => {
      clear();
      for (const target of node.querySelectorAll('[data-image-path]')) {
        components.push(
          mount(RemoteImage, {
            target,
            props: { sessionId, path: target.dataset.imagePath },
          }),
        );
      }
    };
    update();
    return { update, destroy: clear };
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- HTML is produced by the escaping Markdown renderer -->
{#if inline}
  <span class="markdown-inline">{@html content}</span>
{:else}
  <div
    class="remote-markdown"
    class:markdown-muted={muted}
    class:markdown-compact={compact}
    class:markdown-with-trailing={Boolean(trailing)}
    use:diagrams={content}
    use:images={content}
  >
    {@html content}
    {#if trailing}<span class="markdown-trailing">{@render trailing()}</span>{/if}
  </div>
{/if}
