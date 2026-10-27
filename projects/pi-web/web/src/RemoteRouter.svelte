<script>
  import { onMount } from 'svelte';
  import RemoteApp from './routes/RemoteApp.svelte';
  import SessionDrawer from './components/SessionDrawer.svelte';
  import { startHistoryPrefetch } from './remote-history.js';
  import { startRuntime } from './remote-runtime.svelte.js';

  let sessionId = $state(new URLSearchParams(location.search).get('id') || '');
  let app = $state(null);
  let drawer = $state(null);
  let drawerOpen = $state(false);
  let drawerSurface = $state(null);
  onMount(() => {
    const stopPrefetch = startHistoryPrefetch();
    const stopRuntime = startRuntime();
    const sync = () => {
      app?.rememberSession();
      sessionId = new URLSearchParams(location.search).get('id') || '';
    };
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
      stopPrefetch();
      stopRuntime();
      document.removeEventListener('click', navigate);
      window.removeEventListener('popstate', sync);
    };
  });
</script>

{#key sessionId}
  <RemoteApp {sessionId} {drawer} {drawerOpen} bind:drawerSurface bind:this={app} />
{/key}

{#if sessionId}
  <SessionDrawer
    surface={drawerSurface}
    currentSessionId={sessionId}
    canSwipe={() => app?.canSwipeDrawer()}
    bind:this={drawer}
    bind:isOpen={drawerOpen}
    onnew={(path) => app?.openNew(path)}
    onclose={() => app?.drawerClosed()}
  />
{/if}
