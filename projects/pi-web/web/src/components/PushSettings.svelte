<script>
  import { onDestroy } from 'svelte';
  import { request } from '../remote-api.js';
  import { icon, X } from '../shared/icons.js';

  const stateText = {
    off: '此浏览器的通知已关闭。',
    unknown: '无法验证浏览器订阅。',
    enabled: '此浏览器的通知已启用。',
    denied: '通知已被阻止。请使用普通浏览器窗口，或在浏览器设置中修改此网站的通知权限。',
    unsupported:
      '网页推送需要 HTTPS 和支持的浏览器。在 iPhone 或 iPad 上，请将此网站添加到主屏幕并从那里打开。',
    expired: '订阅已过期。请重新启用通知以续订。',
  };
  const operationText = {
    checking: '正在检查此浏览器的订阅…',
    permission: '正在等待浏览器的通知授权，请在权限提示中选择允许…',
    preparing: '正在准备此浏览器的通知服务…',
    subscribing: '正在连接浏览器推送服务…',
    saving: '正在保存此浏览器的订阅…',
    disabling: '正在停用此浏览器的通知…',
    testing: '正在提交测试通知…',
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
  let operation = $state('');
  let busy = $derived(Boolean(operation));
  let state = $state('off');
  let delivery = $state('');
  let failure = $state('');
  let error = $state('');
  let registration;
  let subscription;
  let config;
  let currentOperation;
  let connecting;
  const connectionHint =
    '浏览器需要直接连接自身的推送服务（Chrome 使用 Google FCM），不经过 Pi 主机。请检查手机的推送支持和该通道的网络。';

  function startOperation(next) {
    if (busy) return;
    const controller = new AbortController();
    currentOperation = controller;
    operation = next;
    error = '';
    return controller;
  }

  function finishOperation(controller) {
    if (currentOperation !== controller) return;
    currentOperation = null;
    operation = '';
  }

  function stopWaiting() {
    if (!currentOperation) return;
    const controller = currentOperation;
    finishOperation(controller);
    state = 'unknown';
    error = '已停止等待。浏览器操作可能仍在进行，请刷新状态确认结果。';
    controller.abort(new Error('通知操作已取消。'));
  }

  onDestroy(stopWaiting);

  const post = (path, body, signal, method = 'POST') =>
    request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      timeout: 20000,
      retries: 0,
    });

  async function timed(promise, signal, message = '通知操作超时。请刷新状态后重试。') {
    let timer;
    let abort;
    try {
      signal.throwIfAborted();
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => reject(new Error(message)), 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
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

  function subscriptionExpired(status) {
    return (
      status?.failure === 'expired' ||
      (subscription?.expirationTime != null && subscription.expirationTime <= Date.now())
    );
  }

  async function workerSettings(value, signal) {
    const channel = new MessageChannel();
    try {
      await timed(
        new Promise((resolve, reject) => {
          channel.port1.onmessage = (event) =>
            event.data?.saved ? resolve() : reject(new Error('此浏览器的通知存储不可用。'));
          registration.active.postMessage({ type: 'pi-web:push-settings', value }, [channel.port2]);
        }),
        signal,
        '保存浏览器通知设置超时。请刷新状态后重试。',
      );
    } finally {
      channel.port1.close();
    }
  }

  async function prepare(signal) {
    config = await request('/api/push/config', { signal, timeout: 20000, retries: 0 });
    // Registration is independent of page refresh; a waiting update does not block push.
    const workerTimeout = '浏览器通知服务尚未就绪。请刷新状态后重试。';
    registration = await timed(navigator.serviceWorker.getRegistration('/'), signal, workerTimeout);
    if (!registration?.active)
      registration = await timed(navigator.serviceWorker.ready, signal, workerTimeout);
    subscription = await timed(registration.pushManager.getSubscription(), signal);
  }

  async function refresh() {
    const controller = startOperation('checking');
    if (!controller) return;
    const { signal } = controller;
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
      await prepare(signal);
      const status = subscription
        ? await post('/api/push/status', { endpoint: subscription.endpoint }, signal)
        : { subscribed: false, delivery: '', failure: '' };
      subscribed = Boolean(
        status.subscribed &&
        Notification.permission === 'granted' &&
        sameKey(applicationKey()) &&
        !subscriptionExpired(status),
      );
      state = subscribed ? 'enabled' : subscriptionExpired(status) ? 'expired' : 'off';
      delivery = status.delivery;
      failure = status.failure;
      if (subscribed)
        await workerSettings(
          { endpoint: subscription.endpoint, publicKey: applicationKey() },
          signal,
        );
    } catch (err) {
      if (signal.aborted) return;
      state = 'unknown';
      error = err.message;
    } finally {
      finishOperation(controller);
    }
  }

  async function enable() {
    const controller = startOperation('permission');
    if (!controller) return;
    const { signal } = controller;
    try {
      const permission =
        Notification.permission === 'default'
          ? await timed(
              Notification.requestPermission(),
              signal,
              '浏览器尚未返回通知权限结果。请检查浏览器或系统的通知权限，然后刷新状态。',
            )
          : Notification.permission;
      if (permission !== 'granted') {
        state = permission === 'denied' ? 'denied' : 'off';
        return;
      }
      operation = 'preparing';
      await prepare(signal);
      const oldEndpoint = subscription?.endpoint;
      const status = subscription
        ? await post('/api/push/status', { endpoint: oldEndpoint }, signal)
        : null;
      // Missing server metadata does not invalidate a browser subscription.
      if (subscription && (!sameKey(applicationKey()) || subscriptionExpired(status))) {
        await timed(subscription.unsubscribe(), signal);
        subscription = null;
      }
      if (!subscription) {
        operation = 'subscribing';
        // subscribe() cannot be aborted; explicit retries share the outstanding browser call.
        connecting ??= registration.pushManager
          .subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey() })
          .finally(() => (connecting = null));
        subscription = await timed(connecting, signal, '连接浏览器推送服务超时。');
      }
      if (!sameKey(applicationKey())) throw new Error('浏览器订阅密钥已变化，请刷新状态后重试。');
      operation = 'saving';
      await workerSettings(
        { endpoint: subscription.endpoint, publicKey: applicationKey() },
        signal,
      );
      await post(
        '/api/push/subscription',
        { subscription: subscription.toJSON(), previousEndpoint: oldEndpoint },
        signal,
      );
      subscribed = true;
      state = 'enabled';
      delivery = '';
      failure = '';
    } catch (err) {
      if (signal.aborted) return;
      state = 'unknown';
      error = operation === 'subscribing' ? `${err.message} ${connectionHint}` : err.message;
    } finally {
      finishOperation(controller);
    }
  }

  async function disable() {
    const controller = startOperation('disabling');
    if (!controller) return;
    const { signal } = controller;
    try {
      const endpoint = subscription?.endpoint;
      if (subscription) {
        await timed(subscription.unsubscribe(), signal);
        const remaining = await timed(registration.pushManager.getSubscription(), signal);
        if (remaining?.endpoint === endpoint) throw new Error('无法移除浏览器订阅，请重试。');
      }
      subscription = null;
      subscribed = false;
      state = 'off';
      await workerSettings(null, signal);
      if (endpoint) await post('/api/push/subscription', { endpoint }, signal, 'DELETE');
      delivery = '';
      failure = '';
    } catch (err) {
      if (signal.aborted) return;
      error = err.message;
    } finally {
      finishOperation(controller);
    }
  }

  export function open() {
    dialog.showModal();
    refresh();
  }

  async function testNotification() {
    const controller = startOperation('testing');
    if (!controller) return;
    const { signal } = controller;
    try {
      await post('/api/push/test', { endpoint: subscription.endpoint }, signal);
      delivery = 'pending';
      failure = '';
    } catch (err) {
      if (signal.aborted) return;
      error = err.message;
    } finally {
      finishOperation(controller);
    }
  }
</script>

<svelte:window onoffline={stopWaiting} />

<!-- eslint-disable svelte/no-at-html-tags -- trusted Lucide icons -->
<dialog
  class="push-dialog"
  aria-label="通知"
  bind:this={dialog}
  oncancel={stopWaiting}
  onclose={() => {
    if (!dialog.open) stopWaiting();
  }}
>
  <header>
    <h2>通知</h2>
    <button
      type="button"
      aria-label="关闭"
      onclick={() => {
        stopWaiting();
        dialog.close();
      }}>{@html icon(X)}</button
    >
  </header>
  <p role="status">{operation ? operationText[operation] : stateText[state]}</p>
  {#if operation === 'subscribing'}<p>{connectionHint}</p>{/if}
  <p>通知仅标明会话和状态，不含回复正文。接收或关闭通知不会将回复标为已读。</p>
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
    {#if busy}<button type="button" onclick={stopWaiting}>停止等待</button>
    {:else}<button type="button" onclick={refresh}>刷新状态</button>{/if}
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
