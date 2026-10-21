import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// Deterministic transport only; execution, persistence and lifecycle belong to native Pi.
export default function (pi) {
  pi.registerProvider('lifecycle-test', {
    baseUrl: 'http://127.0.0.1', apiKey: 'isolated-no-network-key', api: 'lifecycle-test',
    models: [{ id: 'local', name: 'Local lifecycle probe', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const user = context.messages.filter((message) => message.role === 'user').at(-1);
      const text = typeof user?.content === 'string' ? user.content : (user?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [], timestamp: Date.now(), stopReason: 'pending',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        try {
          await options?.onPayload?.({ text }, model);
          stream.push({ type: 'start', partial: message });
          if (text.includes('hold-until-release')) {
            const until = Date.now() + 45000;
            while (!existsSync(process.env.PI_WEB_NATIVE_GATE || '') && !options?.signal?.aborted) {
              if (Date.now() > until) throw new Error('Owned test gate deadline exceeded');
              await delay(25);
            }
          } else await delay(60);
          if (options?.signal?.aborted) throw new Error('Aborted');
          if (text.includes('empty-provider-failure')) throw new Error('Controlled provider failure');
          const output = `Native lifecycle reply: ${text}`;
          message.content.push({ type: 'text', text: '' });
          stream.push({ type: 'text_start', contentIndex: 0, partial: message });
          message.content[0].text = output;
          stream.push({ type: 'text_delta', contentIndex: 0, delta: output, partial: message });
          stream.push({ type: 'text_end', contentIndex: 0, content: output, partial: message });
          message.stopReason = 'stop';
          stream.push({ type: 'done', reason: 'stop', message });
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
          message.errorMessage = String(error);
          stream.push({ type: 'error', reason: message.stopReason, error: message });
        } finally { stream.end(); }
      })();
      return stream;
    },
  });
  pi.registerCommand('lifecycle-confirm', {
    description: 'Exercise the genuine native RPC UI request/response contract',
    handler: async (_args, ctx) => { await ctx.ui.confirm('Native lifecycle confirmation', 'Answer from the native client, not the phone.'); },
  });
  pi.registerCommand('lifecycle-reload', {
    description: 'Reload only this isolated native test runtime',
    handler: async (_args, ctx) => { await ctx.reload(); },
  });
}
