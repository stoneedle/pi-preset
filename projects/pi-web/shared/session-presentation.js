/** Session facts have one meaning; terminal text and browser SVG are rendering adapters. */
const visuals = {
  running: {
    label: '运行中',
    glyph: '⟳',
    icon: 'LoaderCircle',
    tone: 'accent',
  },
  background: {
    label: '子任务运行中',
    glyph: '▱',
    icon: 'Layers',
    tone: 'accent',
  },
  'needs-you': {
    label: '待你处理',
    glyph: '!',
    icon: 'CircleAlert',
    tone: 'warning',
  },
  idle: { label: '空闲', glyph: '○', icon: 'Circle', tone: 'muted' },
  completed: { label: '已完成', glyph: '✓', icon: 'Check', tone: 'success' },
  failed: { label: '执行失败', glyph: '×', icon: 'CircleX', tone: 'error' },
  stopped: { label: '已停止', glyph: '■', icon: 'Square', tone: 'muted' },
  unknown: {
    label: '运行状态暂不可用',
    glyph: '?',
    icon: 'CircleHelp',
    tone: 'muted',
  },
  disconnected: {
    label: '未连接 Pi',
    glyph: '×',
    icon: 'Unplug',
    tone: 'muted',
  },
  reconnecting: {
    label: '实时连接中断',
    glyph: '↯',
    icon: 'WifiOff',
    tone: 'muted',
  },
};

/**
 * @param {{ state?: string, availability?: string, completed?: boolean, outcome?: string | null, unread?: boolean | null }} snapshot
 * @param {boolean} connected Whether this observer can still receive live facts.
 */
export function sessionPresentation(snapshot = {}, connected = true) {
  let kind = snapshot.state || 'unknown';
  if (!connected) kind = 'reconnecting';
  else if (snapshot.availability && snapshot.availability !== 'connected') kind = 'disconnected';
  else if (kind === 'idle') {
    if (snapshot.outcome === 'error') kind = 'failed';
    else if (snapshot.outcome === 'aborted') kind = 'stopped';
    else if (snapshot.completed === true) kind = 'completed';
  }
  if (!Object.hasOwn(visuals, kind)) kind = 'unknown';
  const unread = snapshot.unread === true ? { label: '未读回复', glyph: '●' } : null;
  return { ...visuals[kind], kind, unread };
}
