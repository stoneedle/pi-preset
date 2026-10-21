// A heartbeat watches transport availability only; Pi remains the execution-state owner.
export function subscribeEvents(url, handlers) {
  let source;
  let timer;
  let disposed = false;
  let lastActivity = 0;
  const touch = () => {
    lastActivity = Date.now();
    clearTimeout(timer);
    timer = setTimeout(reconnect, 45000);
  };
  function connect() {
    if (disposed || navigator.onLine === false) return;
    const current = new EventSource(url);
    source = current;
    touch();
    current.onopen = (event) => {
      if (source !== current || disposed) return;
      touch();
      handlers.open?.(event);
    };
    current.onerror = (event) => {
      if (source === current && !disposed) handlers.error?.(event);
    };
    for (const name of ['message', 'status-snapshot', 'status-delta', 'heartbeat']) {
      current.addEventListener(name, (event) => {
        if (source !== current || disposed) return;
        touch();
        handlers[name]?.(event);
      });
    }
  }
  function reconnect() {
    clearTimeout(timer);
    source?.close();
    source = null;
    handlers.error?.();
    if (!document.hidden) connect();
  }
  const resume = () => {
    if (
      !document.hidden &&
      (source?.readyState !== EventSource.OPEN || Date.now() - lastActivity >= 45000)
    )
      reconnect();
  };
  const offline = () => {
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
    clearTimeout(timer);
    source?.close();
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('online', resume);
    window.removeEventListener('offline', offline);
  };
}
