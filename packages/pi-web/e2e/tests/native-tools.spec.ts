import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../lib/test';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';
import { buildSession, uniqueSessionName, writeSession } from '../lib/sessions';

test.use({ serviceWorkers: 'block' });

test('无键盘时打开已加载的技能列表，键盘弹起和收起后仍贴住入口且可选择', async ({ page, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'commands-keyboard-position'), buildSession({ cwd: workingDir }).entries);
  await page.route('**/api/commands?*', route => route.fulfill({ json: {
    commands: Array.from({ length: 37 }, (_, index) => ({ name: `skill:workflow-${index}`, source: 'skill' })),
  } }));
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/session?id=' + encodeURIComponent(id));
  const draft = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
  await draft.fill('保留已有草稿');
  await draft.blur();
  const trigger = page.getByRole('button', { name: '技能', exact: true });
  const panel = page.getByRole('dialog', { name: '技能', exact: true });
  await trigger.click();
  await expect(panel.locator('.command-option')).toHaveCount(37);
  await expect.poll(() => panel.evaluate(node => {
    const panelBottom = node.getBoundingClientRect().bottom;
    return [...node.querySelectorAll('.command-option')].filter(option =>
      option.getBoundingClientRect().bottom <= panelBottom,
    ).length;
  })).toBeGreaterThanOrEqual(7);
  if (info.project.name === 'Mobile Chrome') await page.screenshot({ path: info.outputPath('commands-dense-320.png') });
  await panel.getByRole('button', { name: '收起快捷操作', exact: true }).click();
  await trigger.click();
  for (const resizeLayout of [false, true]) {
    for (const height of [360, 420, 800, 360]) {
      if (resizeLayout) {
        await page.evaluate(() => { delete (window.visualViewport as any).height; });
        await page.setViewportSize({ width: 320, height });
      } else await page.evaluate(height => {
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: height });
        window.visualViewport!.dispatchEvent(new Event('resize'));
      }, height);
      await expect.poll(() => panel.evaluate(node => {
        const box = node.getBoundingClientRect();
        const anchor = document.querySelector('.command-bar')!.getBoundingClientRect();
        const viewport = window.visualViewport!;
        return box.top >= viewport.offsetTop && box.bottom <= viewport.offsetTop + viewport.height &&
          Math.abs(box.bottom + 4 - anchor.top) < 2;
      })).toBe(true);
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
    }
  }
  await panel.getByRole('textbox', { name: '搜索快捷操作', exact: true }).fill('workflow-36');
  await expect(panel.locator('.command-option')).toHaveCount(1);
  if (info.project.name === 'Mobile Chrome') await page.screenshot({ path: info.outputPath('commands-after-keyboard-320.png') });
  await panel.getByRole('button', { name: 'skill:workflow-36', exact: true }).click();
  await expect(draft).toHaveValue('/skill:workflow-36 保留已有草稿');
});

test('移动端快捷列表分类、搜索并保留草稿，离线可再次选择已加载项', async ({ page, context, sessionsDir, workingDir, agentDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'native-commands'), entries);
  const file = join(sessionsDir, '--home-user-demo-project--', id);
  const commands = [
    ...Array.from({ length: 37 }, (_, index) => ({ name: `skill:workflow-${index}`, source: 'skill' })),
    { name: 'review', source: 'prompt' },
    { name: 'review-api', source: 'prompt' },
    { name: 'project-command', source: 'extension' },
  ];
  const actions: string[] = [];
  const owner = await openFixtureOwner({ agentDir, sessionPath: file, getState: () => ({ state: 'running' }),
    control: (input: any) => { actions.push(input.action); return { commands }; },
  });
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/session?id=' + encodeURIComponent(id));
    const textbox = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    await textbox.fill('现有草稿');
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await page.getByRole('button', { name: '技能', exact: true }).click();
    const skills = page.getByRole('dialog', { name: '技能', exact: true });
    await expect(skills.locator('.command-option')).toHaveCount(37);
    await skills.locator('.command-option').last().scrollIntoViewIfNeeded();
    await expect(skills.locator('.command-option').last()).toBeInViewport();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: '停止主代理', exact: true })).toBeInViewport();
    await skills.getByRole('button', { name: 'skill:workflow-36', exact: true }).click();
    await expect(textbox).toHaveValue('/skill:workflow-36 现有草稿');
    await page.getByRole('button', { name: 'Prompt', exact: true }).click();
    const prompts = page.getByRole('dialog', { name: 'Prompt', exact: true });
    await expect(prompts.locator('.command-option')).toHaveText(['review', 'review-api']);
    await prompts.getByRole('textbox', { name: '搜索快捷操作' }).fill('api');
    await expect(prompts.locator('.command-option')).toHaveText(['review-api']);
    await page.screenshot({ path: info.outputPath('commands-320-keyboard.png'), animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: info.outputPath('commands-320-keyboard-dark.png'), animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'light' });
    await prompts.getByRole('button', { name: 'review-api', exact: true }).click();
    await expect(textbox).toHaveValue('/review-api 现有草稿');
    await page.getByRole('button', { name: '命令', exact: true }).click();
    const list = page.getByRole('dialog', { name: '命令', exact: true });
    await expect(list.getByRole('button', { name: 'project-command', exact: true })).toBeVisible();
    await expect(list.getByRole('button', { name: '压缩上下文 /compact', exact: true })).toBeDisabled();
    await list.getByRole('button', { name: 'project-command', exact: true }).click();
    await expect(textbox).toHaveValue('/project-command 现有草稿');
    const catalogReads = actions.filter((action) => action === 'commands').length;
    expect(catalogReads).toBeGreaterThan(0);
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Prompt', exact: true }).click();
    await prompts.getByRole('button', { name: 'review', exact: true }).click();
    await expect(textbox).toHaveValue('/review 现有草稿');
    expect(actions.filter((action) => action === 'commands')).toHaveLength(catalogReads);
    expect(actions).not.toContain('send');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain('现有草稿');
  } finally { await context.setOffline(false); await owner.close(); }
});

test('重载资源保留图文草稿，显示进度与失败且更新已缓存目录', async ({ page, sessionsDir, workingDir, agentDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'reload-resources'), buildSession({ cwd: workingDir }).entries);
  const file = join(sessionsDir, '--home-user-demo-project--', id);
  const original = readFileSync(file, 'utf8');
  let instanceId = 'before-reload';
  let attempts = 0;
  let release: () => void;
  const owner = await openFixtureOwner({ agentDir, sessionPath: file,
    getState: () => ({ state: 'idle', canReload: true, instanceId }),
    control: async (input: any) => {
      if (input.action === 'commands') return { commands: [{ name: instanceId + '-template', source: 'prompt' }] };
      if (input.action !== 'reload') throw new Error('Unexpected control: ' + input.action);
      expect(input.instanceId).toBe(instanceId);
      if (++attempts === 1) throw new Error('Fixture reload failure');
      await new Promise<void>(resolve => { release = resolve; });
      instanceId = 'after-reload';
      return { status: 'reloaded' };
    },
  });
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/session?id=' + encodeURIComponent(id));
    const draft = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    await draft.fill('重载期间保留草稿');
    await page.locator('input[type=file]').setInputFiles({ name: 'draft.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=', 'base64') });
    await page.getByRole('button', { name: 'Prompt', exact: true }).click();
    await expect(page.getByRole('button', { name: 'before-reload-template', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '命令', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '命令', exact: true });
    const reload = panel.getByRole('button', { name: '重载 Pi 资源 /reload', exact: true });
    await expect(reload).toBeEnabled();
    await reload.click();
    await expect(panel.getByRole('alert')).toContainText('Fixture reload failure');
    expect(attempts).toBe(1);
    await reload.click();
    await expect(panel.getByRole('button', { name: '正在重载… /reload', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    if (info.project.name === 'Mobile Chrome') await page.screenshot({ path: info.outputPath('reload-progress-320.png') });
    release!();
    await expect(panel).not.toBeVisible();
    await expect(draft).toHaveValue('重载期间保留草稿');
    await expect(page.getByRole('button', { name: '移除 draft.png', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Prompt', exact: true }).click();
    await expect(page.getByRole('button', { name: 'after-reload-template', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'before-reload-template', exact: true })).toHaveCount(0);
    expect(attempts).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { release?.(); await owner.close(); }
});

test('会话详情复制原生 UUID，压缩保持草稿与历史并显示原生摘要', async ({ page, sessionsDir, workingDir, agentDir }, info) => {
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'native-details'), entries);
  const file = join(sessionsDir, '--home-user-demo-project--', id);
  const before = readFileSync(file, 'utf8');
  const native = before.trim().split('\n').map((line) => JSON.parse(line));
  let compacting = false;
  let attempts = 0;
  let received = '';
  let timer: ReturnType<typeof setTimeout>;
  const owner = await openFixtureOwner({ agentDir, sessionPath: file,
    getState: () => ({ state: compacting ? 'running' : 'idle', canCompact: !compacting, compaction: { running: compacting, error: null } }),
    control: (input: any) => {
      if (input.action === 'compact') {
        received = input.customInstructions;
        if (++attempts === 1) throw new Error('Fixture compact failure');
        compacting = true;
        timer = setTimeout(() => {
          appendFileSync(file, JSON.stringify({ type: 'compaction', id: 'native-summary', parentId: native.at(-1).id,
            timestamp: new Date().toISOString(), summary: '## 已确定的方案\n保留手机操作入口。', firstKeptEntryId: native[1].id, tokensBefore: 12000 }) + '\n');
          compacting = false;
          owner.publish();
        }, 500);
      }
      return { status: 'accepted' };
    },
  });
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/session?id=' + encodeURIComponent(id));
    const textbox = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    await textbox.fill('压缩期间也保留的草稿');
    await textbox.blur();
    await page.evaluate(() => {
      navigator.clipboard.writeText = async (text) => { (window as any).__copiedNativeValue = text; };
    });
    await page.getByLabel('更多', { exact: true }).click();
    await page.getByRole('button', { name: '会话详情', exact: true }).click();
    const details = page.getByRole('dialog', { name: '会话详情', exact: true });
    await expect(details).toContainText(native[0].id);
    await expect(details).toContainText(file);
    await page.screenshot({ path: info.outputPath('session-details-320.png'), animations: 'disabled' });
    await details.getByRole('group', { name: '复制Session ID', exact: true }).getByRole('button').click();
    expect(await page.evaluate(() => (window as any).__copiedNativeValue)).toBe(native[0].id);
    expect(native[0].id).not.toBe(id);
    await details.getByRole('button', { name: '压缩上下文', exact: true }).click();
    const compact = page.getByRole('dialog', { name: '压缩上下文', exact: true });
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect.poll(async () => (await compact.boundingBox())!.y + (await compact.boundingBox())!.height).toBeLessThanOrEqual(361);
    await compact.getByRole('textbox', { name: '重点保留什么（可选）' }).fill('保留手机操作方案');
    await compact.getByRole('button', { name: '压缩上下文', exact: true }).click();
    await expect(compact.getByRole('alert')).toContainText('Fixture compact failure');
    await compact.getByRole('button', { name: '压缩上下文', exact: true }).click();
    await expect(compact.getByRole('button', { name: '正在压缩…', exact: true })).toBeDisabled();
    await expect(compact.getByRole('region', { name: '上次压缩摘要' })).toContainText('保留手机操作入口。');
    expect(received).toBe('保留手机操作方案');
    expect(attempts).toBe(2);
    expect(readFileSync(file, 'utf8').startsWith(before)).toBe(true);
    await page.screenshot({ path: info.outputPath('compaction-320.png'), animations: 'disabled' });
    await compact.getByRole('button', { name: '关闭会话工具' }).click();
    await expect(textbox).toHaveValue('压缩期间也保留的草稿');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { clearTimeout(timer!); await owner.close(); }
});
