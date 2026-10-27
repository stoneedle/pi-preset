import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServer } from '../lib/server.ts';

test('project and model selection reads native settings without starting Pi or creating a session', {timeout:30000}, async () => {
  const root = mkdtempSync(join(tmpdir(),'pi-web-project-options-'));
  const cwd = join(root,'没有近期会话的项目');
  mkdirSync(cwd); mkdirSync(join(cwd,'子文件夹')); mkdirSync(join(root,'sessions'));
  const settings = JSON.stringify({defaultProvider:'preview-test',defaultModel:'local',defaultThinkingLevel:'high'});
  writeFileSync(join(root,'settings.json'),settings);
  writeFileSync(join(root,'models.json'),JSON.stringify({providers:{'preview-test':{
    baseUrl:'http://127.0.0.1:1',api:'openai-completions',apiKey:'offline-fixture-not-a-secret',
    models:[{id:'local',name:'Local preview model',reasoning:true,input:['text'],
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:64000,maxTokens:1000}],
  }}}));
  const server = await startServer({agentDir:root,nativeWorkers:true});
  try {
    const response = await fetch(server.baseURL + '/api/project-options?path=' + encodeURIComponent(cwd));
    assert.equal(response.status,200,await response.clone().text());
    const options = await response.json();
    assert.equal(options.model,'local'); assert.equal(options.provider,'preview-test');
    assert.equal(options.thinking,'high');
    assert.ok(options.models.some((model) => model.id === 'local' && model.thinkingLevels.includes('high')));
    assert.ok(!JSON.stringify(options).includes('offline-fixture-not-a-secret'));
    const directories = await (await fetch(server.baseURL + '/api/directories?path=' + encodeURIComponent(cwd))).json();
    assert.equal(directories.path,cwd);
    assert.deepEqual(directories.directories.map((entry) => entry.name),['子文件夹']);
    assert.equal((await (await fetch(server.baseURL + '/api/sessions')).json()).total,0);
    assert.equal(existsSync(join(root,'pi-web','owners')),false);
    assert.equal(readFileSync(join(root,'settings.json'),'utf8'),settings);
  } finally { await stopServer(server.child); rmSync(root,{recursive:true,force:true}); }
});
