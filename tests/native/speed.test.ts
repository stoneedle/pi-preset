import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

test('speed control uses owner capabilities and a session setter, without model prompts or toggles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-speed-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const eventBus = createEventBus();
  let mode = 'off', changes = 0;
  const settingsManager = SettingsManager.inMemory({ packages:[], extensions:[] });
  const loader = new DefaultResourceLoader({ cwd:root, agentDir:root, settingsManager, eventBus,
    noExtensions:true, noSkills:true, noThemes:true, noContextFiles:true, noPromptTemplates:true,
    additionalExtensionPaths:[fileURLToPath(new URL('../../.pi/extensions/index.ts', import.meta.url))],
    extensionFactories:[(pi) => {
      const reply = (request: any) => pi.events.emit('pi-codex-fast:state', {
        version:2,requestId:request.requestId,model:request.model,mode,availableModes:['off','fast'],
        serviceTier:mode === 'fast' ? 'priority' : null,
      });
      pi.events.on('pi-codex-fast:query', reply);
      pi.events.on('pi-codex-fast:set', (request: any) => {
        changes++; mode = request.mode; reply(request);
        pi.events.emit('pi-codex-fast:changed',{version:2});
      });
    }],
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({authPath:join(root,'auth.json'),modelsPath:null,
    modelsStorePath:join(root,'models.sqlite'),allowModelNetwork:false,refreshOnCreate:false});
  const manager = SessionManager.create(root,join(root,'sessions'));
  const {session} = await createAgentSession({cwd:root,agentDir:root,sessionManager:manager,settingsManager,resourceLoader:loader,modelRuntime});
  try {
    await session.bindExtensions({mode:'rpc',uiContext:{notify() {}} as any});
    const owner = JSON.parse(readFileSync(join(root,'pi-web','owners',basename(manager.getSessionFile()!) + '.json'),'utf8'));
    const call = async (action: string, data = {}) => {
      const response = await fetch('http://127.0.0.1:' + owner.port + '/remote', {
        method:'POST',headers:{authorization:'Bearer ' + owner.token},
        body:JSON.stringify({sessionId:manager.getSessionId(),action,...data}),
      });
      return {status:response.status,data:await response.json() as any};
    };
    assert.equal((await call('state')).data.fast.mode,'off');
    assert.equal((await call('speed',{mode:'fast'})).status,200,'off is not evidence that fast is unsupported');
    assert.equal((await call('state')).data.fast.mode,'fast');
    assert.equal((await call('speed',{mode:'fast'})).status,200);
    assert.equal(changes,1,'selecting the same mode has no side effects');
    assert.equal((await call('speed',{mode:'ultrafast'})).status,400,'capabilities belong to the owner');
    assert.equal((await call('speed',{mode:'off'})).status,200);
    assert.equal((await call('state')).data.fast.mode,'off');
    assert.equal(manager.getBranch().filter((entry) => entry.type === 'message').length,0);
    assert.equal((await call('speed',{mode:'invalid'})).status,400);
  } finally {
    await session.extensionRunner!.emit({type:'session_shutdown'}); session.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root,{recursive:true,force:true});
  }
});
