<script>
  import ActionMenu from './ActionMenu.svelte';
  import ForkAction from './ForkAction.svelte';
  import CopyAction from './CopyAction.svelte';

  let { sessionId, onfork, busy = $bindable(false) } = $props();
  let menu;
  let message = $state(null);
  let text = $state('');

  export function open(value, anchor, body) {
    if (busy || menu.isOpenFor(anchor)) return;
    message = value;
    text = body;
    menu.open(anchor, false);
  }
</script>

<ActionMenu bind:this={menu} label="消息操作">
  {#if message}
    {#key message.id}
      {#if text.trim()}<CopyAction {text} menu oncopy={() => menu.close(true)} />{/if}
      {#if message.forkable}
        <ForkAction
          {sessionId}
          entryId={message.id}
          bind:busy
          onfork={(id) => {
            menu.close();
            onfork(id);
          }}
        />
      {/if}
    {/key}
  {/if}
</ActionMenu>
