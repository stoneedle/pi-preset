import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../lib/test';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';
import { buildSession, uniqueSessionName, writeSession } from '../lib/sessions';

test.use({ serviceWorkers: 'block' });

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
