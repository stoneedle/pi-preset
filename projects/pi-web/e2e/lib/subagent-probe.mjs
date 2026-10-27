import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Test-only caller of the installed provider's public event-bus contract.
export default function (pi) {
  pi.registerCommand('lifecycle-child', {
    description: 'Exercise the isolated child-provider lifecycle contract',
    handler: async (args) => {
      const { requestId, method, params } = JSON.parse(args);
      if (!/^[a-f0-9-]{36}$/.test(requestId) || !['ping', 'status', 'spawn', 'stop'].includes(method))
        throw new Error('Invalid isolated child probe request');
      const reply = await new Promise((resolve) => {
        const finish = (reply) => { clearTimeout(timer); unsubscribe(); resolve(reply); };
        const unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, finish);
        const timer = setTimeout(() => finish({ success: false, error: { message: 'Provider deadline exceeded' } }), 20000);
        pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method, params });
      });
      const dir = join(getAgentDir(), 'subagent-probe');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, requestId + '.json'), JSON.stringify(reply));
    },
  });
}
