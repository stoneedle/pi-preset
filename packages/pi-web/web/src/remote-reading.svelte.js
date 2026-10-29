import { SvelteMap } from 'svelte/reactivity';

// Only reading coordinates survive a document. Conversation bodies and drafts never do.
const key = 'pi-web:reading';
const bookmarks = new SvelteMap();
const selector =
  '.remote-markdown p, .remote-markdown pre, .remote-markdown li, .remote-markdown h1, .remote-markdown h2, .remote-markdown h3, .remote-markdown td, .remote-block-toggle, .remote-block-body > pre, .remote-image-preview';

function readBookmark(id) {
  if (bookmarks.has(id)) return bookmarks.get(id);
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}')[id];
    if (typeof value?.id === 'string' && value.id.length <= 512 && Number.isFinite(value.offset)) {
      value.previous = Array.isArray(value.previous)
        ? value.previous
            .filter((item) => typeof item === 'string' && item.length <= 512)
            .slice(0, 5)
        : [];
      bookmarks.set(id, value);
      return value;
    }
  } catch {
    /* Storage is optional; the live reading position still works. */
  }
  return null;
}

function writeBookmark(id, value) {
  if (!id) return;
  bookmarks.delete(id);
  if (value) bookmarks.set(id, value);
  while (bookmarks.size > 128) bookmarks.delete(bookmarks.keys().next().value);
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '{}');
    delete stored[id];
    if (value) stored[id] = value;
    const entries = Object.entries(stored).slice(-128);
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* Do not let denied/quota-limited storage interrupt reading. */
  }
}

function textRange(node, offset) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let text;
  while ((text = walker.nextNode())) {
    if (offset <= text.length) {
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, Math.min(text.length, offset + 1));
      return range;
    }
    offset -= text.length;
  }
  return null;
}

function readingParts(scope) {
  return [...scope.querySelectorAll(selector)].filter(
    (node) => node.closest('.remote-block') === (scope.matches('.remote-block') ? scope : null),
  );
}

function readingAnchor(viewport) {
  if (!viewport) return null;
  const top = viewport.getBoundingClientRect().top;
  const visible = [...viewport.querySelectorAll(selector)].find(
    (node) =>
      node.getBoundingClientRect().height > 0 && node.getBoundingClientRect().bottom > top + 1,
  );
  const messages = [...viewport.querySelectorAll('[data-message-id]')];
  const message =
    visible?.closest('[data-message-id]') ||
    messages.find((node) => node.getBoundingClientRect().bottom > top + 1);
  if (!message) return null;
  const scope = visible?.closest('.remote-block') || message;
  const parts = readingParts(scope);
  const part = parts.indexOf(visible);
  const anchor = {
    id: message.dataset.messageId,
    offset: message.getBoundingClientRect().top - top,
    previous: messages
      .slice(Math.max(0, messages.indexOf(message) - 5), messages.indexOf(message))
      .reverse()
      .map((node) => node.dataset.messageId),
  };
  if (part < 0) return anchor;
  const node = parts[part];
  anchor.part = part;
  if (scope !== message) {
    anchor.block = Number(scope.dataset.readingBlock);
    anchor.expanded =
      scope.querySelector('.remote-block-toggle')?.getAttribute('aria-expanded') === 'true';
  }
  anchor.messageOffset = anchor.offset;
  anchor.offset = node.getBoundingClientRect().top - top;
  const rect = node.getBoundingClientRect();
  const x = Math.max(viewport.getBoundingClientRect().left + 12, rect.left + 3);
  const y = Math.max(top + 3, rect.top + 3);
  const caret = document.caretRangeFromPoint?.(x, y);
  const point = !caret && document.caretPositionFromPoint?.(x, y);
  const container = caret?.startContainer || point?.offsetNode;
  const offset = caret?.startOffset ?? point?.offset;
  if (container && node.contains(container)) {
    const prefix = document.createRange();
    prefix.selectNodeContents(node);
    prefix.setEnd(container, offset);
    anchor.character = prefix.toString().length;
    const range = textRange(node, anchor.character);
    if (range?.getBoundingClientRect().height)
      anchor.offset = range.getBoundingClientRect().top - top;
    else delete anchor.character;
  }
  return anchor;
}

function restoreReadingAnchor(viewport, anchor) {
  const message = anchor && viewport?.querySelector(`[data-message-id="${CSS.escape(anchor.id)}"]`);
  if (!message) return false;
  let rect = message.getBoundingClientRect();
  let offset = anchor.messageOffset ?? anchor.offset;
  const block =
    Number.isInteger(anchor.block) &&
    message.querySelector(`[data-reading-block="${anchor.block}"]`);
  const part = readingParts(block || message)[anchor.part];
  if (block && !part) {
    viewport.scrollTop += block.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    return false;
  }
  if (part) {
    rect =
      (Number.isInteger(anchor.character) &&
        textRange(part, anchor.character)?.getBoundingClientRect()) ||
      part.getBoundingClientRect();
    offset = anchor.offset;
  }
  viewport.scrollTop += rect.top - viewport.getBoundingClientRect().top - offset;
  return true;
}

export function createReadingPosition(id, viewport, atLatest, cachedAnchor) {
  let anchor = cachedAnchor || readBookmark(id);
  const state = $state({ following: !anchor });
  let pending = Number.isInteger(anchor?.block);
  let previousTop = 0;
  let height = 0;
  let width = 0;
  let contentHeight = 0;
  let timer;
  let active = true;
  let intent = -Infinity;
  const save = () => writeBookmark(id, anchor);
  const nearBottom = () => {
    const node = viewport();
    return node && node.scrollHeight - node.scrollTop - node.clientHeight < 24;
  };
  function reconcile() {
    const node = viewport();
    // A user may scroll before the browser delivers its scroll event. Native layout clamping stays at the new bottom.
    if (state.following && node && node.scrollTop < previousTop - 1 && !nearBottom()) {
      state.following = false;
      anchor = readingAnchor(node) || anchor;
      previousTop = node.scrollTop;
      save();
    }
  }
  function capture() {
    reconcile();
    return (pending ? null : readingAnchor(viewport())) || anchor;
  }
  function checkpoint() {
    if (!document.hidden) anchor = capture();
    save();
    return anchor;
  }
  function restore(value = anchor) {
    if (!value) return false;
    const restored = restoreReadingAnchor(viewport(), value);
    pending = !restored && Number.isInteger(value.block);
    if (pending) anchor = value;
    if (restored) anchor = value;
    if (viewport()) previousTop = viewport().scrollTop;
    return restored;
  }
  function pause() {
    if (!document.hidden) checkpoint();
    state.following = false;
    save();
  }
  return {
    state,
    get anchor() {
      return anchor;
    },
    capture,
    reconcile,
    checkpoint,
    restore,
    pause,
    follow() {
      pending = false;
      state.following = true;
    },
    positioned() {
      const node = viewport();
      if (node) {
        previousTop = node.scrollTop;
        anchor = capture();
      }
    },
    relocated(messageId) {
      pending = false;
      anchor = messageId === anchor?.id ? anchor : messageId ? { id: messageId, offset: 0 } : null;
      state.following = !anchor;
      save();
    },
    scrolled() {
      const node = viewport();
      if (!active || !node || document.hidden) return;
      if (
        height !== node.clientHeight ||
        width !== node.clientWidth ||
        contentHeight !== node.scrollHeight
      )
        return;
      if (Math.abs(node.scrollTop - previousTop) < 1) return true;
      if (node.scrollTop < previousTop - 1) state.following = false;
      else if (
        node.scrollTop > previousTop + 1 &&
        performance.now() - intent < 1000 &&
        atLatest() &&
        nearBottom()
      )
        state.following = true;
      previousTop = node.scrollTop;
      pending = false;
      anchor = capture();
      clearTimeout(timer);
      timer = setTimeout(save, 120);
      return true;
    },
    start(followBottom) {
      const node = viewport();
      if (!node) return () => {};
      let pending;
      const observed = new WeakSet();
      const resize = new ResizeObserver(schedule);
      const mutations = new MutationObserver(schedule);
      function schedule() {
        if (pending) return;
        pending = requestAnimationFrame(() => {
          pending = null;
          if (!active) return;
          reconcile();
          height = node.clientHeight;
          width = node.clientWidth;
          contentHeight = node.scrollHeight;
          for (const message of node.querySelectorAll('[data-message-id]')) {
            if (!observed.has(message)) {
              observed.add(message);
              resize.observe(message);
            }
          }
          if (state.following && !document.hidden && atLatest()) {
            followBottom();
            previousTop = node.scrollTop;
            anchor = capture();
          } else restore();
        });
      }
      const visibility = () => {
        // A suspended reader resumes at the old end, not the end reached in their absence.
        if (document.hidden) {
          anchor = capture();
          state.following = false;
          save();
        } else {
          restore();
          schedule();
        }
      };
      const freeze = () => {
        checkpoint();
        state.following = false;
        save();
      };
      const selection = () => {
        const value = window.getSelection();
        if (value && !value.isCollapsed && node.contains(value.anchorNode)) pause();
      };
      const cancelRestore = () => {
        if (pending) {
          pending = false;
          anchor = readingAnchor(node) || anchor;
        }
      };
      const userIntent = () => {
        cancelRestore();
        intent = performance.now();
      };
      node.addEventListener('pointerdown', cancelRestore, { passive: true });
      node.addEventListener('wheel', userIntent, { passive: true });
      node.addEventListener('touchmove', userIntent, { passive: true });
      node.addEventListener('keydown', userIntent);
      document.addEventListener('visibilitychange', visibility);
      document.addEventListener('selectionchange', selection);
      window.addEventListener('pagehide', freeze);
      resize.observe(node);
      mutations.observe(node, { childList: true, subtree: true, characterData: true });
      schedule();
      return () => {
        checkpoint();
        active = false;
        clearTimeout(timer);
        cancelAnimationFrame(pending);
        resize.disconnect();
        mutations.disconnect();
        node.removeEventListener('pointerdown', cancelRestore);
        node.removeEventListener('wheel', userIntent);
        node.removeEventListener('touchmove', userIntent);
        node.removeEventListener('keydown', userIntent);
        document.removeEventListener('visibilitychange', visibility);
        document.removeEventListener('selectionchange', selection);
        window.removeEventListener('pagehide', freeze);
      };
    },
  };
}
