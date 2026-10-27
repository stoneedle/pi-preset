import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// Exercises Pi's real OpenAI-compatible transport without a commercial provider.
export async function startControlledChat() {
  let released = false;
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer isolated-child-key') {
      response.writeHead(401).end(); return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const user = input.messages.filter((message) => message.role === 'user').at(-1);
    const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    const fail = text?.includes('empty-provider-failure');
    const hold = text?.includes('hold-until-release');
    requests.push({ hold, fail, model: input.model });
    const deadline = Date.now() + 45000;
    while (hold && !released && !response.destroyed && Date.now() < deadline) await delay(25);
    if (response.destroyed) return;
    if (fail || (hold && !released)) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Controlled child provider failure', type: 'invalid_request_error' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => ({ id: 'chatcmpl-isolated', object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000), model: input.model,
      choices: [{ index: 0, delta, finish_reason }] });
    response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: '' }))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({ content: 'Child lifecycle output' }))}\n\n`);
    response.write(`data: ${JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { baseURL: `http://127.0.0.1:${server.address().port}/v1`, requests,
    release: () => { released = true; },
    hold: () => { released = false; },
    async close() { released = true; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}
