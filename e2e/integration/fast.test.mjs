import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { patchFastInterface } from '../../scripts/enable-fast-state.mjs';

const packageDir = process.argv[2];
if (!packageDir) throw new Error('usage: node e2e/integration/fast.test.mjs /absolute/path/to/pi-codex-fast');
const root = mkdtempSync(join(tmpdir(),'pi-web-real-fast-'));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const active = new Set();
try {
  const original = readFileSync(join(resolve(packageDir),'extensions','codex-fast.ts'),'utf8');
  const patched = patchFastInterface(original);
  assert.equal(patchFastInterface(patched),patched,'the reviewed upgrade is idempotent');
  const extension = join(root,'codex-fast.ts');
  writeFileSync(extension,patched);
  const settings = JSON.stringify({'pi-codex-fast':{mode:'off'},packages:[],extensions:[]});
  writeFileSync(join(root,'settings.json'),settings);
  const runtime = await ModelRuntime.create({authPath:join(root,'auth.json'),modelsPath:null,
    modelsStorePath:join(root,'models.sqlite'),allowModelNetwork:false,refreshOnCreate:false});
  runtime.registerProvider('openai',{baseUrl:'http://127.0.0.1:1',apiKey:'offline-fixture',api:'openai-completions',
    models:['gpt-6-astra','gpt-6.1-sol'].map((id) => ({id,name:id,reasoning:true,input:['text'],
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:64000,maxTokens:1000}))});
  async function open(manager) {
    const settingsManager = SettingsManager.inMemory({packages:[],extensions:[]});
    const loader = new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager,eventBus:createEventBus(),
      noExtensions:true,noSkills:true,noThemes:true,noContextFiles:true,noPromptTemplates:true,
      additionalExtensionPaths:[fileURLToPath(new URL('../../.pi/extensions/index.ts',import.meta.url)),extension]});
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors,[]);
    const {session} = await createAgentSession({cwd:root,agentDir:root,sessionManager:manager,settingsManager,
      resourceLoader:loader,modelRuntime:runtime,model:runtime.getModel('openai','gpt-6-astra')});
    active.add(session);
    await session.bindExtensions({mode:'rpc',uiContext:{notify() {},setStatus() {},theme:{fg:(_color,text) => text}}});
    const owner = JSON.parse(readFileSync(join(root,'pi-web','owners',basename(manager.getSessionFile())+'.json'),'utf8'));
    return {session,manager,async call(action,data={}) {
      const response = await fetch('http://127.0.0.1:'+owner.port+'/remote',{method:'POST',
        headers:{authorization:'Bearer '+owner.token},body:JSON.stringify({sessionId:manager.getSessionId(),action,...data})});
      return {status:response.status,data:await response.json()};
    }};
  }
  async function close(item) { await item.session.extensionRunner.emit({type:'session_shutdown'}); item.session.dispose(); active.delete(item.session); }
  const manager = SessionManager.create(root,join(root,'sessions'));
  manager.appendMessage({role:'user',content:'Existing conversation',timestamp:Date.now()});
  manager.appendMessage({role:'assistant',content:[{type:'text',text:'Historical reply'}],api:'openai-completions',provider:'openai',model:'gpt-6-astra',stopReason:'stop',timestamp:Date.now()});
  const first = await open(manager);
  assert.equal((await first.call('state')).data.fast.mode,'off');
  assert.deepEqual((await first.call('state')).data.fast.availableModes,['off','fast','ultrafast']);
  assert.equal((await first.call('speed',{mode:'fast'})).status,200);
  assert.equal((await first.call('state')).data.fast.serviceTier,'priority');
  assert.equal(readFileSync(join(root,'settings.json'),'utf8'),settings,'UI selection never writes global defaults');
  const second = await open(SessionManager.create(root,join(root,'sessions')));
  assert.equal((await second.call('state')).data.fast.mode,'off','another session retains its own default');
  assert.equal((await second.call('speed',{mode:'ultrafast'})).status,200);
  assert.equal((await first.call('state')).data.fast.mode,'fast','another live session stays independent');
  assert.equal((await second.call('state')).data.fast.mode,'ultrafast');
  const path = first.manager.getSessionFile();
  await close(first);
  const restored = await open(SessionManager.open(path));
  assert.equal((await restored.call('state')).data.fast.mode,'fast','session mode survives native executor replacement');
  assert.equal(restored.manager.getBranch().filter((entry) => entry.type==='message').length,2,'controls do not create model prompts');
  await restored.session.setModel(runtime.getModel('openai','gpt-6.1-sol'));
  assert.deepEqual((await restored.call('state')).data.fast.availableModes,['off','fast']);
  assert.equal((await restored.call('speed',{mode:'ultrafast'})).status,400,'unsupported targets are rejected by the owner');
  assert.equal(readFileSync(join(root,'settings.json'),'utf8'),settings);
  await close(second); await close(restored);
  console.log(JSON.stringify({realFastOwner:true,offToFast:true,perModeCapabilities:true,sessionIsolation:true,
    sessionRestore:true,globalSettingsUnchanged:true,noModelRequests:true}));
} finally {
  for (const session of active) { await session.extensionRunner.emit({type:'session_shutdown'}); session.dispose(); }
  if (previous===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=previous;
  rmSync(root,{recursive:true,force:true});
}
