import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, stopServer } from '../lib/server.ts';
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent';

test('new task and dormant session discover native skills without loading extensions or starting Pi', { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-web-project-skills-'));
  const cwd = join(root, '首条消息前选择技能');
  const skill = (directory, name) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture skill ${name}\n---\n# Instructions\n`);
  };
  skill(join(root, 'skills', 'global-fixture'), 'global-fixture');
  skill(join(cwd, '.pi', 'skills', 'project-fixture'), 'project-fixture');
  skill(join(cwd, '.agents', 'skills', 'agents-fixture'), 'agents-fixture');
  skill(join(cwd, '.pi', 'explicit'), 'explicit-fixture');
  const pkg = join(root, 'local-package');
  skill(join(pkg, 'skills', 'package-fixture'), 'package-fixture');
  skill(join(pkg, 'skills', 'excluded-fixture'), 'excluded-fixture');
  const marker = join(root, 'extension-loaded');
  mkdirSync(join(pkg, 'extensions'));
  writeFileSync(join(pkg, 'extensions', 'index.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); throw new Error('Discovery must not load extensions');`);
  writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ skills: ['./explicit'] }));
  const settings = JSON.stringify({ packages: [{ source: pkg, skills: ['skills/package-fixture'] }] });
  writeFileSync(join(root, 'settings.json'), settings);
  mkdirSync(join(root, 'sessions', 'fixture'), { recursive: true });
  const id = 'dormant.jsonl';
  const session = JSON.stringify({ type: 'session', version: 3, id: 'skills-fixture', cwd, timestamp: new Date().toISOString() }) + '\n';
  writeFileSync(join(root, 'sessions', 'fixture', id), session);
  const trust = new ProjectTrustStore(root);
  trust.set(root, true);
  const savedTrust = readFileSync(join(root, 'trust.json'), 'utf8');
  const server = await startServer({ agentDir: root, nativeWorkers: true });
  try {
    for (const query of ['path=' + encodeURIComponent(cwd), 'id=' + id]) {
      const response = await fetch(server.baseURL + '/api/commands?' + query);
      assert.equal(response.status, 200, await response.clone().text());
      const { commands } = await response.json();
      for (const name of ['global-fixture', 'project-fixture', 'agents-fixture', 'explicit-fixture', 'package-fixture']) {
        assert.ok(commands.some((command) => command.name === 'skill:' + name && command.source === 'skill'), name);
      }
      assert.ok(!commands.some((command) => command.name === 'skill:excluded-fixture'));
    }
    assert.equal(readFileSync(join(root, 'trust.json'), 'utf8'), savedTrust);
    for (const decision of [false, null]) {
      trust.set(root, decision);
      const response = await fetch(server.baseURL + '/api/commands?path=' + encodeURIComponent(cwd));
      assert.equal(response.status, 200, await response.clone().text());
      const { commands } = await response.json();
      assert.ok(commands.some((command) => command.name === 'skill:global-fixture'));
      for (const name of ['project-fixture', 'agents-fixture', 'explicit-fixture']) {
        assert.ok(!commands.some((command) => command.name === 'skill:' + name), `untrusted ${name}`);
      }
    }
    assert.equal((await (await fetch(server.baseURL + '/api/sessions')).json()).total, 1);
    assert.equal(existsSync(join(root, 'pi-web', 'owners')), false);
    assert.equal(existsSync(join(root, 'pi-web', 'workers')), false);
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(join(root, 'sessions', 'fixture', id), 'utf8'), session);
    assert.equal(readFileSync(join(root, 'settings.json'), 'utf8'), settings);
  } finally {
    await stopServer(server.child);
    rmSync(root, { recursive: true, force: true });
  }
});

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
