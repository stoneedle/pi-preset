import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';

type SpeedMode = 'off' | 'fast' | 'ultrafast';
type FastState = {
  mode: SpeedMode;
  availableModes: SpeedMode[];
  serviceTier: 'priority' | 'ultrafast' | null;
};
const modes = ['off', 'fast', 'ultrafast'];

function exchange(pi: ExtensionAPI, model: {provider:string;id:string} | undefined, action: 'query' | 'set', mode?: string): FastState | null {
  const requestId = randomUUID();
  const modelName = model ? model.provider + '/' + model.id : null;
  let result: FastState | null = null;
  let replies = 0;
  let error = '';
  const unsubscribe = pi.events.on('pi-codex-fast:state', (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const reply = data as Record<string, unknown>;
    if (reply.version !== 2 || reply.requestId !== requestId || reply.model !== modelName) return;
    replies++;
    if (typeof reply.error === 'string') { error = reply.error; return; }
    if (!modes.includes(reply.mode as string) || !Array.isArray(reply.availableModes) ||
      !reply.availableModes.includes('off') || reply.availableModes.some((mode) => !modes.includes(mode)) ||
      ![null,'priority','ultrafast'].includes(reply.serviceTier as null | string)) return;
    result = {mode:reply.mode,availableModes:reply.availableModes,serviceTier:reply.serviceTier} as FastState;
  });
  try { pi.events.emit('pi-codex-fast:' + action, {version:2,requestId,model:modelName,...(mode === undefined ? {} : {mode})}); }
  finally { unsubscribe(); }
  if (error && action === 'set') throw new Error(error);
  return replies === 1 ? result : null;
}

export function readFastState(pi: ExtensionAPI, model?: {provider:string;id:string}): FastState | null {
  try { return exchange(pi,model,'query'); } catch { return null; }
}

export function setFastState(pi: ExtensionAPI, model: {provider:string;id:string} | undefined, mode: string) {
  const current = readFastState(pi,model);
  if (!current) throw new Error('当前 Pi 未提供会话速度控制');
  if (!current.availableModes.includes(mode as SpeedMode)) throw new Error('当前模型不支持所选速度');
  if (current.mode === mode) return;
  const changed = exchange(pi,model,'set',mode);
  if (!changed || changed.mode !== mode) throw new Error('速度设置尚未确认，请检查 Pi 状态');
}
