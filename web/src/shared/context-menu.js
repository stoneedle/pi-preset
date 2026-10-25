// Shared row gesture: long press, right click and the native keyboard context-menu keys.
export function contextMenu(node, open) {
  let press;
  let timer;
  let suppressClick = false;
  const cancel = () => {
    clearTimeout(timer);
    press = null;
  };
  const hasSelection = () => {
    const selection = window.getSelection();
    return selection && !selection.isCollapsed && node.contains(selection.anchorNode);
  };
  const nestedControl = (event) => {
    const target = event.target.closest?.('a, button, input, textarea, select, [contenteditable]');
    return target && target !== node && node.contains(target);
  };
  const show = () => {
    cancel();
    if (hasSelection()) return;
    suppressClick = true;
    open(node);
  };
  const handlers = {
    pointerdown(event) {
      if (event.button !== 0 || !event.isPrimary || nestedControl(event)) return;
      cancel();
      suppressClick = false;
      press = { x: event.clientX, y: event.clientY };
      timer = setTimeout(show, 500);
    },
    pointermove(event) {
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) cancel();
    },
    pointerup: cancel,
    pointercancel: cancel,
    contextmenu(event) {
      if (nestedControl(event) || hasSelection()) return;
      event.preventDefault();
      show();
    },
    keydown(event) {
      if (
        !nestedControl(event) &&
        (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
      ) {
        event.preventDefault();
        show();
      }
    },
    click(event) {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
  };
  for (const [type, handler] of Object.entries(handlers)) node.addEventListener(type, handler);
  return {
    update(value) {
      open = value;
    },
    destroy() {
      cancel();
      for (const [type, handler] of Object.entries(handlers))
        node.removeEventListener(type, handler);
    },
  };
}
