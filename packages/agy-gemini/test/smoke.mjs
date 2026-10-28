import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

if (!process.env.PI_SDK_ROOT) throw new Error('Set PI_SDK_ROOT to the installed Pi package.');
process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = process.env.PI_SDK_ROOT;
const root = resolve(import.meta.dirname, '..');
const role = readFileSync(join(root, 'role.md'), 'utf8').trim();
const collaboration = readFileSync(join(root, 'collaboration.md'), 'utf8').trim();
const fixture = mkdtempSync(join(tmpdir(), 'gemini-role-e2e-'));
const cwd = join(fixture, 'materials');
const agentDir = join(fixture, 'agent');
mkdirSync(cwd); mkdirSync(agentDir);
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ subagents: { disableBuiltins: true, defaultExtensions: [] } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sdk = await import(pathToFileURL(join(process.env.PI_SDK_ROOT, 'dist/index.js')).href);
const { DEFAULT_MODEL } = await import(pathToFileURL(join(root, 'adapter.mjs')).href);
const marker = randomUUID();
const cancelMarker = randomUUID();
const facts = '使用场景：资深开发者同时使用多个 Pi 会话。\n当前体验：标签标题不断变化，显示命令、路径和状态，用户很难辨认每个会话的任务。\n用户目标：一眼找到正在处理目标任务的会话，保持阅读和切换时的安定感。\n';
writeFileSync(join(cwd, 'facts.txt'), facts);

const executions = [];
let cancelStarted;
const cancelReady = new Promise(resolve => { cancelStarted = resolve; });
const observer = ({ process: child }) => child.once('spawn', () => {
  const args = child.spawnargs;
  const print = args.indexOf('--print');
  if (print < 0 || !args.includes('--model')) return;
  let exited;
  const taskPath = join(args[args.indexOf('--add-dir') + 1], 'task.md');
  const execution = { args, prompt: readFileSync(taskPath, 'utf8'), stdout: '', closed: new Promise(resolve => { exited = resolve; }) };
  child.stdout.on('data', data => { execution.stdout += data; });
  child.once('close', exited);
  executions.push(execution);
  if (execution.prompt.includes(cancelMarker)) cancelStarted(execution);
});
channel('child_process').subscribe(observer);

let host;
async function openHost(manager) {
  const bus = sdk.createEventBus();
  const completed = new Map(), waiters = new Map(), wakes = [];
  const off = bus.on('subagent:async-complete', event => { completed.set(event.runId, event); waiters.get(event.runId)?.(event); });
  const loader = new sdk.DefaultResourceLoader({
    cwd, agentDir, eventBus: bus, noContextFiles: true,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    additionalExtensionPaths: [join(root, 'node_modules/pi-subagents/index.ts'), join(root, 'index.ts')],
    // This SDK host drives tools directly; consume native wakes instead of starting an unconfigured parent model.
    extensionFactories: [pi => pi.on('input', event => {
      if (event.source === 'extension') {
        wakes.push(event.text);
        return { action: 'handled' };
      }
    })],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  if (!manager.getEntries().length) manager.appendMessage({
    role: 'assistant', content: [{ type: 'toolCall', id: 'gemini-role-e2e', name: 'subagent', arguments: {} }],
    api: 'openai-codex-responses', provider: 'openai-codex', model: 'test-driver', stopReason: 'toolUse', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const { session } = await sdk.createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: manager });
  await session.bindExtensions({ mode: 'json', onError: error => { throw error; } });
  assert.ok(!session.agent.state.tools.some(tool => tool.name === 'gemini'), 'Only the generic subagent entry is registered.');
  session.setActiveToolsByName(['subagent']);
  const tool = session.agent.state.tools.find(tool => tool.name === 'subagent');
  assert.ok(tool);
  return {
    session, manager, wakes,
    async call(params) {
      const result = await tool.execute('gemini-role-e2e', params, new AbortController().signal);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.details;
    },
    completion(id) {
      if (completed.has(id)) return Promise.resolve(completed.get(id));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No native completion for ' + id)), 300000);
        waiters.set(id, event => { clearTimeout(timer); waiters.delete(id); resolve(event); });
      });
    },
    async close() {
      await session.abort();
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose(); off();
    },
  };
}
async function finish(receipt) {
  const completed = await host.completion(receipt.asyncId);
  assert.equal(completed.success, true, JSON.stringify(completed));
  const step = completed.results[0];
  const path = step.externalJob.resultArtifactPath;
  const value = readFileSync(path, 'utf8');
  const execution = executions.at(-1);
  const provider = JSON.parse(execution.stdout);
  assert.ok(execution.prompt.includes(collaboration), 'The real CLI receives the shared collaboration contract.');
  assert.ok(execution.prompt.includes(role), 'The real CLI receives the complete role declaration.');
  assert.equal(execution.args[execution.args.indexOf('--model') + 1], DEFAULT_MODEL);
  assert.equal(value, provider.response, 'The artifact preserves the complete reply exactly.');
  assert.equal(step.output, value.trim(), 'The generic role result carries the reply body.');
  assert.ok(value.includes(marker), 'Revisions retain context from the original conversation.');
  assert.equal(readFileSync(join(cwd, 'facts.txt'), 'utf8'), facts);
  assert.deepEqual(readdirSync(cwd), ['facts.txt'], 'Gemini only reads authorized source material.');
  return { runId: completed.runId, provider, artifactPath: path };
}
try {
  const manager = sdk.SessionManager.create(cwd, join(fixture, 'sessions'));
  host = await openHost(manager);
  const listing = await host.call({ action: 'list', capabilities: true });
  const gemini = listing.agentCapabilities.agents.find(agent => agent.name === 'gemini');
  assert.equal(gemini.source, 'runtime'); assert.equal(gemini.runner.provider, 'agy'); assert.equal(gemini.runner.available, true);
  const first = await finish(await host.call({
    agent: 'gemini', async: true, cwd,
    task: '请只读 facts.txt，从当前体验与用户目标出发，自主选择你认为最好的会话标签体验设计，让读者看见一个具体的使用过程。尾行保留工作代号：' + marker,
  }));
  const second = await finish(await host.call({
    action: 'resume', id: first.runId, message: '继续完善你的设计，把核心体验写成一个从辨认会话到切换会话的具体操作片段；尾行保留首轮的工作代号。',
  }));
  assert.equal(second.provider.conversation_id, first.provider.conversation_id);
  const sessionPath = manager.getSessionFile();
  await host.close(); host = await openHost(sdk.SessionManager.open(sessionPath, join(fixture, 'sessions')));
  const third = await finish(await host.call({
    action: 'resume', id: second.runId, message: '沿你的设计补充一个场景：用户对多个不同任务都只追问“继续”时，怎样保持会话辨识度与整体体验一致？尾行保留最初的工作代号。',
  }));
  assert.equal(third.provider.conversation_id, first.provider.conversation_id);
  const cancellation = await host.call({
    agent: 'gemini', async: true, cwd,
    task: '请阅读 facts.txt，深入推演面向多会话长期使用的产品与体验设计。工作代号：' + cancelMarker,
  });
  const cancelledProcess = await cancelReady;
  await host.call({ action: 'stop', id: cancellation.asyncId });
  await cancelledProcess.closed;
  const stopped = await host.completion(cancellation.asyncId);
  assert.equal(stopped.state, 'stopped');
  assert.ok(host.wakes.length > 0, 'Native completion wakes reach the SDK host without invoking a parent model.');
  console.log(JSON.stringify({ ok: true, model: DEFAULT_MODEL, runId: third.runId, artifactPath: third.artifactPath,
    checks: ['permanent Gemini role', 'one generic entry', 'real CLI role propagation', 'shared collaboration contract', 'native completion wake', 'product design', 'two design refinements', 'exact artifacts', 'read-only materials', 'host reopen continuation', 'native stop terminates agy'] }));
} finally {
  if (host) await host.close();
  channel('child_process').unsubscribe(observer);
  rmSync(fixture, { recursive: true, force: true });
}
