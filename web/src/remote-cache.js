// Same-tab, same-origin memory only. No session content or credentials go to browser storage.
const views = new Map();
let bytes = 0;
const maxBytes = 8 * 1024 * 1024;

export function readView(key) {
  const entry = views.get(key);
  if (!entry) return null;
  views.delete(key);
  views.set(key, entry);
  return entry.value;
}

export function rememberView(key, value) {
  const previous = views.get(key);
  if (previous) bytes -= previous.bytes;
  views.delete(key);
  const size = JSON.stringify(value).length * 2;
  if (size <= maxBytes) {
    views.set(key, { value, bytes: size });
    bytes += size;
  }
  while (bytes > maxBytes || views.size > 8) {
    const oldest = views.keys().next().value;
    bytes -= views.get(oldest).bytes;
    views.delete(oldest);
  }
}
