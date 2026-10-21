import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';

type FastState = {
  mode: 'off' | 'fast' | 'ultrafast';
  supported: boolean;
  serviceTier: 'priority' | 'ultrafast' | null;
};

export function readFastState(pi: ExtensionAPI, model?: { provider: string; id: string }): FastState | null {
  const requestId = randomUUID();
  const modelName = model ? `${model.provider}/${model.id}` : null;
  let result: FastState | null = null;
  let replies = 0;
  const unsubscribe = pi.events.on('pi-codex-fast:state', (data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const reply = data as Record<string, unknown>;
    if (reply.version !== 1 || reply.requestId !== requestId || reply.model !== modelName) return;
    replies++;
    if (!['off', 'fast', 'ultrafast'].includes(reply.mode as string) || typeof reply.supported !== 'boolean' ||
      ![null, 'priority', 'ultrafast'].includes(reply.serviceTier as null | string)) return;
    result = { mode: reply.mode, supported: reply.supported, serviceTier: reply.serviceTier } as FastState;
  });
  try { pi.events.emit('pi-codex-fast:query', { version: 1, requestId, model: modelName }); }
  catch { return null; }
  finally { unsubscribe(); }
  return replies === 1 ? result : null;
}
