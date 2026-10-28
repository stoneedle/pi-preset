import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { context, linkPreset, piSdk, prepareUpstreams } from '../scripts/preset.mjs';
import { verifyFileLinks } from './support/file-links.mjs';

const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const skill = (description) => `---\nname: preset-fixture\ndescription: ${description}\n---\nFixture instructions.\n`;
const runGit = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
function fixture(t, links = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-preset-e2e-'));
  const root = path.join(home, '.pi', 'preset');
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, 'preset.json'), { links, upstreams: {} });
  writeJson(path.join(root, 'settings.json'), { skills: ['!**/.agents/skills/**'] });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return context(root);
}
async function loaderFor(ctx, extra = {}) {
  const { DefaultResourceLoader, SettingsManager } = await piSdk();
  const loader = new DefaultResourceLoader({
    cwd: ctx.root, agentDir: ctx.agent, noExtensions: true, noContextFiles: true,
    settingsManager: SettingsManager.inMemory({ ...ctx.settings, ...extra }),
  });
  await loader.reload();
  return loader;
}

test('editing a skill through the Pi directory changes the repository and reloads in Pi', async (t) => {
  const ctx = fixture(t, { skills: 'skills' });
  const directory = path.join(ctx.root, 'skills', 'preset-fixture');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), skill('Before editing'));
  linkPreset(ctx);
  const loader = await loaderFor(ctx);
  assert.equal(loader.getSkills().skills.find(s => s.name === 'preset-fixture')?.description, 'Before editing');
  fs.writeFileSync(path.join(ctx.agent, 'skills', 'preset-fixture', 'SKILL.md'), skill('After editing'));
  assert.equal(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8'), skill('After editing'));
  await loader.reload();
  assert.equal(loader.getSkills().skills.find(s => s.name === 'preset-fixture')?.description, 'After editing');
  assert.equal(loader.getSkills().diagnostics.length, 0);
});

test('native Pi settings writes and prompt edits reach the repository through file links', async (t) => {
  const ctx = fixture(t, { 'settings.json': 'settings.json', 'APPEND_SYSTEM.md': 'APPEND_SYSTEM.md', 'keybindings.json': 'keybindings.json' });
  fs.writeFileSync(path.join(ctx.root, 'APPEND_SYSTEM.md'), 'Initial instruction');
  writeJson(path.join(ctx.root, 'keybindings.json'), {});
  try { linkPreset(ctx); }
  catch (error) {
    if (error.exitCode === 77) { t.skip('Windows file symbolic links require elevation or Developer Mode'); return; }
    throw error;
  }
  await verifyFileLinks(ctx);
});

test('upstream skill installation uses the selected commit and Pi discovers it without vendoring', async (t) => {
  const ctx = fixture(t);
  const upstream = path.join(ctx.home, 'upstream-source');
  const resource = path.join(upstream, 'skills', 'preset-fixture');
  fs.mkdirSync(resource, { recursive: true });
  runGit(upstream, 'init', '-q');
  runGit(upstream, 'config', 'user.name', 'Preset fixture');
  runGit(upstream, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(resource, 'SKILL.md'), skill('Pinned version'));
  runGit(upstream, 'add', '.');
  runGit(upstream, 'commit', '-qm', 'First version');
  const commit = runGit(upstream, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(resource, 'SKILL.md'), skill('New upstream version'));
  runGit(upstream, 'commit', '-qam', 'Second version');
  ctx.manifest.upstreams.fixture = { url: upstream, commit, skills: ['skills/preset-fixture'] };
  prepareUpstreams(ctx);
  const loader = await loaderFor(ctx, { packages: ['../upstreams'] });
  assert.equal(loader.getSkills().skills.find(s => s.name === 'preset-fixture')?.description, 'Pinned version');
  assert.equal(loader.getSkills().diagnostics.length, 0);
  const installed = path.join(ctx.upstreams, 'fixture', 'skills', 'preset-fixture', 'SKILL.md');
  fs.writeFileSync(installed, skill('Local change'));
  assert.throws(() => prepareUpstreams(ctx), /上游目录有本地修改/);
  assert.equal(fs.readFileSync(installed, 'utf8'), skill('Local change'));
});

test('initialization refuses divergent existing content without changing it', (t) => {
  const ctx = fixture(t, { skills: 'skills' });
  fs.mkdirSync(path.join(ctx.root, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(ctx.agent, 'skills'), { recursive: true });
  const source = path.join(ctx.agent, 'skills', 'existing.md');
  fs.writeFileSync(source, 'An existing local customization');
  assert.throws(() => linkPreset(ctx), /已有内容与仓库不同/);
  assert.equal(fs.readFileSync(source, 'utf8'), 'An existing local customization');
});
