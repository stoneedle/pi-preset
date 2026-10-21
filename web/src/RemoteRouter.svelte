<script>
  import { onMount } from 'svelte';
  import RemoteApp from './routes/RemoteApp.svelte';

  let sessionId = $state(new URLSearchParams(location.search).get('id') || '');
  onMount(() => {
    const sync = () => (sessionId = new URLSearchParams(location.search).get('id') || '');
    const navigate = (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = event.target.closest?.('a[href]');
      if (!link || link.download || (link.target && link.target !== '_self')) return;
      const url = new URL(link.href);
      if (
        url.origin !== location.origin ||
        !['/', '/session'].includes(url.pathname) ||
        url.hash ||
        [...url.searchParams.keys()].some((key) => key !== 'id')
      )
        return;
      event.preventDefault();
      if (url.href !== location.href) history.pushState(null, '', url);
      sync();
    };
    document.addEventListener('click', navigate);
    window.addEventListener('popstate', sync);
    return () => {
      document.removeEventListener('click', navigate);
      window.removeEventListener('popstate', sync);
    };
  });
</script>

{#key sessionId}
  <RemoteApp {sessionId} />
{/key}
