// Cross-repository E2E actor: real Pi persistence and owner endpoint; controlled model completion.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { SessionTitle, firstUserText } from '../src/session-title.ts';
import { openTitleOwner } from '../src/owner.ts';

const root = process.argv[2];
if (!root) throw new Error('Usage: owner-fixture.mjs <isolated agent directory>');
const reply = Promise.withResolvers();
let manager = SessionManager.create(root, path.join(root, 'sessions', 'fixture-project'));
manager.appendMessage({ role: 'user', content: '定位字幕导入错位', timestamp: Date.now() });
let title;
let owner;
function makeTitle() {
  const pi = { setSessionName(name) { manager.appendSessionInfo(name); title?.nameChanged(); } };
  const ctx = { sessionManager: manager, cwd: root,
    ui: { notify(message) { throw new Error(message); } },
    modelRegistry: { find: () => ({ provider: 'fixture', id: 'title' }), streamSimple: () => ({ result: () => reply.promise }) } };
  title = new SessionTitle(pi, ctx, 'fixture/title');
  return ctx;
}
let ctx = makeTitle();
owner = await openTitleOwner(root, ctx, title);
await owner.initialize(firstUserText(ctx));
const emit = (phase) => console.log(JSON.stringify({ phase, sessionFile: manager.getSessionFile(), name: title.name }));
emit('ready');
const lines = createInterface({ input: process.stdin });
try {
  for await (const command of lines) {
    if (command === 'finish') {
      reply.resolve({ stopReason: 'stop', content: [{ type: 'text', text: '迟到的自动摘要' }] });
      await reply.promise;
      emit('finished');
    } else if (command === 'stop') {
      await title.close();
      await owner.close();
      emit('stopped');
    } else if (command === 'reopen') {
      manager = SessionManager.open(manager.getSessionFile());
      ctx = makeTitle();
      owner = await openTitleOwner(root, ctx, title);
      await owner.initialize(firstUserText(ctx));
      emit('reopened');
    } else if (command === 'shutdown') {
      break;
    } else {
      throw new Error(`Unexpected fixture command: ${command}`);
    }
  }
} finally {
  reply.resolve({ stopReason: 'stop', content: [{ type: 'text', text: 'Fixture ended' }] });
  await title.close();
  await owner.close();
  lines.close();
}
