// One count for the complete lifetime of HTTP controls and multi-request submissions.
let pending = 0;
let reads = 0;
const trafficListeners = new Set();
const notifyTraffic = () => {
  for (const listener of trafficListeners) listener(pending + reads);
};
const listeners = new Set();
const notify = () => {
  for (const listener of listeners) listener(pending);
  notifyTraffic();
};

export function beginControl() {
  pending++;
  notify();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    pending--;
    notify();
  };
}

export function beginRead() {
  reads++;
  notifyTraffic();
  return () => {
    reads--;
    notifyTraffic();
  };
}

export function observeTraffic(listener) {
  trafficListeners.add(listener);
  listener(pending + reads);
  return () => trafficListeners.delete(listener);
}

export function observeControls(listener) {
  listeners.add(listener);
  listener(pending);
  return () => listeners.delete(listener);
}
