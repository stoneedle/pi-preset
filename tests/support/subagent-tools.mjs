import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [root, realHome] = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const workspace = path.join(process.cwd(), 'workspace');
const forbiddenCall = path.join(process.cwd(), 'forbidden-database-call');
fs.mkdirSync(path.join(agentDir, 'agents'), { recursive: true });
fs.mkdirSync(workspace);
const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
const subagents = { ...settings.subagents, defaultExtensions: settings.subagents.defaultExtensions.map(p => p.replace(/^~(?=[/\\])/, realHome)) };
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ subagents }));
fs.writeFileSync(path.join(agentDir, 'web-search.json'), JSON.stringify({ toolActivation: 'dynamic' }));
for (const name of ['implementer', 'luna', 'advisor']) fs.copyFileSync(path.join(root, 'agents', `${name}.md`), path.join(agentDir, 'agents', `${name}.md`));
const server = path.join(root, 'tests/support/mcp-tooling-server.mjs');
fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
  'chrome-devtools': { command: process.execPath, args: [server, 'browser'], exposure: 'deferred' },
  dbhub: { command: process.execPath, args: [server, 'database', forbiddenCall], exposure: 'direct' },
} }));

const sdk = await import(pathToFileURL(path.join(process.env.PI_SDK_ROOT, 'dist/index.js')).href);
const load = relative => import(pathToFileURL(path.join(root, 'packages/pi-subagents/src', relative)).href);
const { discoverAgents } = await load('agents/agents.ts');
const { buildInProcessChildLaunch } = await load('runs/shared/child-launch.ts');
const { createDefaultChildSessionFactory } = await load('runs/shared/child-session.ts');
let parentApi;
const parentLoader = new sdk.DefaultResourceLoader({
  cwd: workspace, agentDir, noExtensions: true, noSkills: true, noContextFiles: true,
  additionalExtensionPaths: ['builtin:mcp'],
  extensionFactories: [
    { name: 'mcp', factory: sdk.createMcpExtension(), builtin: true, replaceable: true },
    pi => { parentApi = pi; },
  ],
});
await parentLoader.reload();
assert.deepEqual(parentLoader.getExtensions().errors, []);
const { session: parent } = await sdk.createAgentSession({ cwd: workspace, agentDir, resourceLoader: parentLoader, sessionManager: sdk.SessionManager.inMemory(workspace) });
let native;
const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({ ...sdk,
  async createAgentSession(options) {
    const created = await sdk.createAgentSession(options);
    native = created.session;
    return created;
  },
}) });
const body = result => result.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
async function call(name, args) {
  const tool = native.agent.state.tools.find(t => t.name === name);
  assert.ok(tool, `Missing active tool ${name}`);
  const id = randomUUID();
  const message = { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }],
    api: 'openai-codex-responses', provider: 'openai-codex', model: 'tooling-fixture', stopReason: 'toolUse', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  // Drive a recorded tool call without invoking a commercial model.
  native.sessionManager.appendMessage(message);
  native.agent.state.messages.push(message);
  const result = await tool.execute(id, args, new AbortController().signal);
  const reply = { role: 'toolResult', toolCallId: id, toolName: name, ...result, isError: result.isError === true, timestamp: Date.now() };
  native.sessionManager.appendMessage(reply);
  native.agent.state.messages.push(reply);
  return result;
}
try {
  await parent.bindExtensions({ mode: 'print', onError: error => { throw error; } });
  for (let i = 0; i < 200 && parent.getAllTools().filter(t => t.name.startsWith('mcp__')).length < 4; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(parent.getAllTools().filter(t => t.name.startsWith('mcp__')).length, 4, 'Both fixture MCP servers must be connected');
  const { agents } = discoverAgents(workspace, 'user');
  for (const host of ['parent', 'runner']) for (const name of ['implementer', 'luna', 'advisor']) {
    const agent = agents.find(a => a.name === name);
    assert.ok(agent);
    const launch = buildInProcessChildLaunch({
      cwd: workspace, host, childAgentName: name, childIndex: 0, sessionEnabled: false,
      tools: agent.tools, mcpDirectTools: agent.mcpDirectTools, extensions: agent.extensions,
      systemPrompt: agent.systemPrompt, inheritProjectContext: agent.inheritProjectContext,
      inheritGlobalContext: agent.inheritGlobalContext, inheritSkills: agent.inheritSkills,
      parentSessionId: parent.sessionId, orchestratorIntercomTarget: 'fixture-parent', runId: randomUUID(),
      runtimeSnapshotHost: parentApi, projectTrusted: true,
    });
    const errors = [];
    const child = await factory.create({ ...launch.session, onExtensionError: e => errors.push(e) });
    try {
      assert.deepEqual(errors, [], JSON.stringify(errors));
      const active = new Set(native.getActiveToolNames());
      for (const tool of ['read', 'grep', 'find', 'ls', 'codemode', 'tool_search', 'web_enable', 'contact_supervisor']) assert.ok(active.has(tool), `${host}/${name}: ${tool}`);
      for (const tool of ['subagent', 'subagents_enable', 'create_goal', 'codex_generate_image']) assert.ok(!active.has(tool), `${host}/${name}: unexpected ${tool}`);
      assert.doesNotMatch(native.systemPrompt, /gemini_collaboration/);
      for (const tool of ['list_pages', 'evaluate_script', 'take_snapshot']) assert.ok(active.has(`mcp__chrome_devtools__${tool}`));
      assert.ok(!native.getAllTools().some(t => t.name === 'mcp__dbhub__execute_sql' && t.exposure !== 'hidden'));
      assert.ok(!native.extensionRunner.getRegisteredCommands().some(c => ['pi-web', 'web', 'codex-fast'].includes(c.name)));
      const progress = await call('contact_supervisor', { reason: 'progress_update', message: 'tooling fixture progress' });
      assert.equal(progress.details.delivered, true);
      const request = JSON.parse(fs.readFileSync(path.join(launch.config.supervisorChannelDir, 'requests', `${progress.details.requestId}.json`), 'utf8'));
      assert.equal(request.message, 'tooling fixture progress');
      await call('web_enable', {});
      for (const tool of ['web_search', 'fetch_content', 'get_search_content', 'source_check']) assert.ok(native.getActiveToolNames().includes(tool), `${host}/${name}: web enable ${tool}`);
      const browser = body(await call('codemode', { code: 'text(await tools.mcp__chrome_devtools__list_pages({}));' }));
      assert.match(browser, /fixture:browser:list_pages/);
      const denied = body(await call('codemode', { code: 'try { await tools.mcp__dbhub__execute_sql({}); text("DATABASE_WAS_CALLED"); } catch (error) { text("DATABASE_DENIED:" + error.message); }' }));
      assert.match(denied, /DATABASE_DENIED:/);
      assert.ok(!fs.existsSync(forbiddenCall));
      const search = await call('tool_search', { query: 'dbhub execute_sql', limit: 5 });
      assert.deepEqual(search.details.loaded, [], 'Discovery must not expose the hidden database tool');
      assert.ok(!native.getActiveToolNames().includes('mcp__dbhub__execute_sql'));
      const file = path.join(workspace, 'probe.txt');
      fs.writeFileSync(file, 'tooling fixture');
      assert.match(body(await call('read', { path: file })), /tooling fixture/);
      for (const tool of ['bash', 'edit', 'write']) assert.equal(active.has(tool), name !== 'advisor', `${host}/${name}: local mutation ${tool}`);
      if (name === 'advisor') {
        const deniedWrite = body(await call('codemode', { code: `try { await tools.write({path:${JSON.stringify(file)},content:"unexpected"}); } catch (error) { text("WRITE_DENIED:" + error.message); }` }));
        assert.match(deniedWrite, /WRITE_DENIED:/);
        assert.equal(fs.readFileSync(file, 'utf8'), 'tooling fixture');
      } else {
        await call('write', { path: file, content: 'changed through child' });
        assert.equal(fs.readFileSync(file, 'utf8'), 'changed through child');
        const guarded = body(await call('codemode', { code: 'try { await tools.bash({command:"echo SHOULD_NOT_RUN",timeout:360000}); } catch (error) { text(error.message); }' }));
        assert.match(guarded, /bash.timeout 的单位是秒/);
        assert.match(body(await call('bash', { command: 'echo child-shell-ok', timeout: 5 })), /child-shell-ok/);
      }
      console.log(`PASS ${host}/${name}`);
    } finally { await child.dispose(); }
  }
  const limited = buildInProcessChildLaunch({ cwd: workspace, host: 'parent', childAgentName: 'limited', childIndex: 0,
    sessionEnabled: false, tools: ['read'], inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false });
  for (const restriction of [
    {},
    { tools: ['read', 'codemode', 'tool_search'], excludeTools: ['codemode', 'tool_search'] },
    { tools: ['read', 'codemode', 'tool_search'], runtime: { ...limited.config, capabilityCeiling: { version: 1, denyExtensions: true, sources: ['fixture'] } } },
  ]) {
    const child = await factory.create({ ...limited.session, ...restriction });
    try {
      assert.deepEqual(native.getActiveToolNames(), ['read']);
      assert.ok(!native.getAllTools().some(t => ['codemode', 'tool_search'].includes(t.name)));
    } finally { await child.dispose(); }
  }
  console.log('PASS shared tooling for 3 roles in foreground and background sessions');
} finally {
  await factory.dispose();
  await parent.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  parent.dispose();
}
