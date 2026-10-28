import fs from 'node:fs';
import readline from 'node:readline';

const [kind, forbiddenCall] = process.argv.slice(2);
const names = kind === 'browser' ? ['list_pages', 'evaluate_script', 'take_snapshot'] : ['execute_sql'];
const inputSchema = { type: 'object', properties: {}, additionalProperties: true };
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: kind, version: '1.0.0' } };
      break;
    case 'tools/list':
      result = { tools: names.map(name => ({ name, description: `${kind} fixture ${name}`, inputSchema })) };
      break;
    case 'tools/call':
      if (kind === 'database') fs.writeFileSync(forbiddenCall, 'called');
      result = { content: [{ type: 'text', text: `fixture:${kind}:${request.params.name}` }] };
      break;
    default:
      result = {};
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
