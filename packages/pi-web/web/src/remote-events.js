import { diagnosticId, trace } from './remote-diagnostics.js';

// A heartbeat watches transport availability only; Pi remains the execution-state owner.
export function subscribeEvents(url, handlers) {
  let source;
  let timer;
  let disposed = false;
  let lastActivity = 0;
  const stream = diagnosticId(new URL(url, location.href).searchParams.get('id') || '__all__');
  const touch = () => {
    lastActivity = Date.now();
    clearTimeout(timer);
    timer = setTimeout(() => reconnect('heartbeat-timeout'), 45000);
  };
  function connect() {
    if (disposed || navigator.onLine === false) return;
    trace('stream.connect', { stream });
    const current = new EventSource(url);
    source = current;
    touch();
    current.onopen = (event) => {
      if (source !== current || disposed) return;
      touch();
      trace('stream.open', { stream });
      handlers.open?.(event);
    };
    current.onerror = (event) => {
      if (source === current && !disposed) {
        trace('stream.error', { stream, readyState: current.readyState });
        handlers.error?.(event);
      }
    };
    const events = new Set(['message', 'status-snapshot', 'status-delta', 'heartbeat']);
    for (const name of Object.keys(handlers))
      if (name !== 'open' && name !== 'error') events.add(name);
    for (const name of events) {
      current.addEventListener(name, (event) => {
        if (source !== current || disposed) return;
        touch();
        handlers[name]?.(event);
      });
    }
  }
  function reconnect(reason) {
    trace('stream.reconnect', { stream, reason, idle: Date.now() - lastActivity });
    clearTimeout(timer);
    source?.close();
    source = null;
    handlers.error?.();
    if (!document.hidden) connect();
  }
  const resume = (event) => {
    if (
      !document.hidden &&
      (source?.readyState !== EventSource.OPEN || Date.now() - lastActivity >= 45000)
    )
      reconnect(event.type);
  };
  const offline = (reason = 'offline') => {
    trace('stream.close', { stream, reason: typeof reason === 'string' ? reason : reason.type });
    clearTimeout(timer);
    source?.close();
    source = null;
    handlers.error?.();
  };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('online', resume);
  window.addEventListener('offline', offline);
  connect();
  return () => {
    disposed = true;
    trace('stream.dispose', { stream });
    clearTimeout(timer);
    source?.close();
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('online', resume);
    window.removeEventListener('offline', offline);
  };
}
