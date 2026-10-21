<script>
  import { request } from '../remote-api.js';
  import { icon, X } from '../shared/icons.js';

  const stateText = {
    off: '此浏览器的通知已关闭。',
    checking: '正在检查此浏览器的订阅…',
    unknown: '无法验证浏览器订阅。',
    enabled: '此浏览器已订阅此主机。',
    denied: '通知已被阻止。请使用普通浏览器窗口，或在浏览器设置中修改此网站的通知权限。',
    unsupported:
      '网页推送需要 HTTPS 和支持的浏览器。在 iPhone 或 iPad 上，请将此网站添加到主屏幕并从那里打开。',
    expired: '订阅已过期。请重新启用通知以续订。',
  };
  const deliveryText = {
    pending: '已排队或等待重试。',
    sending: '正在发送至推送服务。',
    accepted: '推送服务已接受上一条通知，尚未确认设备是否收到。',
    failed: '上一条通知发送失败。',
    expired: '推送服务已将此订阅标为过期。',
    skipped: '无需通知：结果已读、已处理或已过期。',
  };
  const failureText = {
    unreachable: '无法连接推送服务。',
    'state-unavailable': '无法验证当前的确认状态或待处理状态。',
    'event-store': '通知状态变更正等待本地存储恢复。',
    payload: '无法编码通知。',
  };

  let dialog = $state(null);
  let supported = $state(false);
  let subscribed = $state(false);
  let busy = $state(false);
  let state = $state('off');
  let delivery = $state('');
  let failure = $state('');
  let error = $state('');
  let registration;
  let subscription;
  let config;

  const post = (path, body, method = 'POST') =>
    timed(
      request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  async function timed(promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('通知操作超时。请刷新状态后重试。')), 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function applicationKey() {
    const decoded = atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }

  function sameKey(key) {
    const previous = subscription?.options?.applicationServerKey;
    return previous && Array.from(new Uint8Array(previous)).join(',') === Array.from(key).join(',');
  }

  async function workerSettings(value) {
    const channel = new MessageChannel();
    try {
      await timed(
        new Promise((resolve, reject) => {
          channel.port1.onmessage = (event) =>
            event.data?.saved ? resolve() : reject(new Error('此浏览器的通知存储不可用。'));
          registration.active.postMessage({ type: 'pi-web:push-settings', value }, [channel.port2]);
        }),
      );
    } finally {
      channel.port1.close();
    }
  }

  async function prepare() {
    config = await timed(request('/api/push/config'));
    await timed(navigator.serviceWorker.register('/sw.js', { scope: '/' }));
    registration = await timed(navigator.serviceWorker.ready);
    subscription = await timed(registration.pushManager.getSubscription());
  }

  async function refresh() {
    busy = true;
    error = '';
    supported = Boolean(
      window.isSecureContext &&
      'Notification' in window &&
      'PushManager' in window &&
      'serviceWorker' in navigator,
    );
    try {
      if (!supported) {
        state = 'unsupported';
        return;
      }
      if (Notification.permission === 'denied') {
        state = 'denied';
        subscribed = false;
        return;
      }
      if (Notification.permission === 'default') {
        state = 'off';
        subscribed = false;
        delivery = '';
        failure = '';
        return;
      }
      state = 'checking';
      await prepare();
      const status = subscription
        ? await post('/api/push/status', { endpoint: subscription.endpoint })
        : { subscribed: false, delivery: '', failure: '' };
      subscribed = Boolean(
        status.subscribed && Notification.permission === 'granted' && sameKey(applicationKey()),
      );
      state = subscribed ? 'enabled' : status.failure === 'expired' ? 'expired' : 'off';
      delivery = status.delivery;
      failure = status.failure;
      if (subscribed)
        await workerSettings({
          endpoint: subscription.endpoint,
          publicKey: applicationKey(),
        });
    } catch (err) {
      state = 'unknown';
      error = err.message;
    } finally {
      busy = false;
    }
  }

  async function enable() {
    busy = true;
    error = '';
    try {
      const permission =
        Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;
      if (permission !== 'granted') {
        state = permission === 'denied' ? 'denied' : 'off';
        return;
      }
      await prepare();
      const oldEndpoint = subscription?.endpoint;
      const status = subscription
        ? await post('/api/push/status', { endpoint: oldEndpoint })
        : null;
      if (subscription && (!sameKey(applicationKey()) || !status?.subscribed)) {
        await timed(subscription.unsubscribe());
        subscription = null;
      }
      if (!subscription)
        subscription = await timed(
          registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationKey(),
          }),
        );
      await workerSettings({
        endpoint: subscription.endpoint,
        publicKey: applicationKey(),
      });
      await post('/api/push/subscription', {
        subscription: subscription.toJSON(),
        previousEndpoint: oldEndpoint,
      });
      subscribed = true;
      state = 'enabled';
      delivery = '';
      failure = '';
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
    }
  }

  async function disable() {
    busy = true;
    error = '';
    try {
      const endpoint = subscription?.endpoint;
      if (subscription) {
        await timed(subscription.unsubscribe());
        const remaining = await timed(registration.pushManager.getSubscription());
        if (remaining?.endpoint === endpoint) throw new Error('无法移除浏览器订阅，请重试。');
      }
      subscription = null;
      subscribed = false;
      state = 'off';
      await workerSettings(null);
      if (endpoint) await post('/api/push/subscription', { endpoint }, 'DELETE');
      delivery = '';
      failure = '';
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
    }
  }

  export function open() {
    dialog.showModal();
    refresh();
  }

  async function testNotification() {
    busy = true;
    error = '';
    try {
      await post('/api/push/test', { endpoint: subscription.endpoint });
      delivery = 'pending';
      failure = '';
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
    }
  }
</script>

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<dialog class="push-dialog" aria-label="通知" bind:this={dialog}>
  <header>
    <h2>通知</h2>
    <button type="button" aria-label="关闭" onclick={() => dialog.close()}>{@html icon(X)}</button>
  </header>
  <p role="status">{stateText[state]}</p>
  <p>通知仅标明主机、会话和状态，不含回复正文。接收或关闭通知不会将回复标为已读。</p>
  {#if delivery}<p>{deliveryText[delivery]}</p>{/if}
  {#if failure && failure !== 'expired'}<p role="alert">
      {failure.startsWith('http:')
        ? `推送服务返回 HTTP ${failure.slice(5)}。`
        : failureText[failure] || failure}
    </p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <div class="push-actions">
    {#if supported && state !== 'denied'}
      {#if subscribed}<button type="button" disabled={busy} onclick={disable}>为此浏览器停用</button
        ><button type="button" disabled={busy} onclick={testNotification}>发送测试通知</button>
      {:else}<button type="button" disabled={busy} onclick={enable}>为此浏览器启用</button>{/if}
    {/if}
    <button type="button" disabled={busy} onclick={refresh}>{busy ? '加载中…' : '刷新状态'}</button>
  </div>
</dialog>

<style>
  .push-dialog {
    width: min(460px, calc(100vw - 24px));
    max-height: calc(var(--remote-height, 100dvh) - 24px);
    overflow: auto;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--dim);
    border-radius: 24px;
    padding: 20px;
    overflow-wrap: anywhere;
  }
  .push-dialog::backdrop {
    background: #0009;
  }
  .push-dialog header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .push-dialog h2 {
    margin: 0;
    font-size: 16px;
  }
  .push-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .push-dialog [role='alert'] {
    color: var(--danger);
  }
</style>
