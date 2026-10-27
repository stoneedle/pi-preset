import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../lib/test';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';
import { appendEntry, assistantTextEntry, buildSession, uniqueSessionName, writeSession } from '../lib/sessions';

test.use({ serviceWorkers: 'block' });

function skillEntry(id: string, parentId: string | null, userMessage: string, display = true) {
  return {
    type: 'custom_message', customType: 'inline-skills', id, parentId,
    timestamp: new Date().toISOString(), display,
    content: '<skill name="grilling">private-expanded-skill-instructions</skill>\n' + userMessage,
    details: { blocks: [{ name: 'grilling', location: '/private/SKILL.md', content: 'private-expanded-skill-instructions' }], userMessage },
  };
}

test('技能扩展接收的长消息按用户正文显示，增量、分享与分叉均不遗漏', async ({ page, request, sessionsDir, agentDir, workingDir }, info) => {
  const native = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'skill-prompt'), native.entries);
  const path = join(sessionsDir, '--home-user-demo-project--', id);
  const prompt = '对于我的终极目标，在弱网环境下获得极致的远程体验。\n\n' + '保护提示词，保留已经加载的完整内容。'.repeat(300) + '\n\n这是长消息的最后一句。';
  const promptId = randomUUID();
  const owner = await openFixtureOwner({ agentDir, sessionPath: path, control: (input: any) => {
    if (input.action === 'send') {
      expect(input.chat.message.replace(/\r\n/g, '\n')).toBe('/skill:grilling\n' + prompt);
      appendEntry(sessionsDir, id, skillEntry(promptId, native.lastId, prompt));
      appendEntry(sessionsDir, id, assistantTextEntry(promptId, '已经收到完整的长消息。').entry);
    }
    return { status: 'accepted' };
  } });
  try {
    await page.goto(`/session?id=${encodeURIComponent(id)}`);
    await expect(page.locator('[data-message-id]')).toHaveCount(2);
    const input = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
    await input.fill('/skill:grilling\n' + prompt);
    const sending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chat');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const receipt = await sending;
    expect(receipt.status(), await receipt.text()).toBe(202);
    await expect(input).toHaveValue('');
    await expect(page.getByText('已经收到完整的长消息。', { exact: true })).toBeVisible();
    const message = page.locator(`[data-message-id="${promptId}"]`);
    await expect(message).toHaveCount(1);
    await expect(message).toHaveClass(/remote-user/);
    await expect(message).toContainText('这是长消息的最后一句。');
    await expect(message.locator('.remote-markdown').last()).toHaveText(prompt);
    await expect(page.locator('.remote-main')).not.toContainText('private-expanded-skill-instructions');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('[data-message-id]')).toHaveCount(4);
    const exported = await (await request.get(`/api/session/context?id=${encodeURIComponent(id)}`)).json();
    expect(exported.text).toContain(prompt);
    expect(exported.text).toContain('/skill:grilling');
    expect(exported.text).not.toContain('private-expanded-skill-instructions');
    await page.setViewportSize({ width: 320, height: 380 });
    await message.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await message.locator('.remote-markdown').last().evaluate(element => element.scrollIntoView({ block: 'end' }));
    await page.screenshot({ path: info.outputPath('skill-long-message-320.png') });
    const original = readFileSync(path, 'utf8');
    const fork = await request.post(`/api/session/fork?id=${encodeURIComponent(id)}`, { data: { entryId: promptId } });
    expect(fork.status(), await fork.text()).toBe(201);
    const forkId = (await fork.json()).id;
    await page.goto(`/session?id=${encodeURIComponent(forkId)}`);
    await expect(page.locator(`[data-message-id="${promptId}"]`)).toContainText('这是长消息的最后一句。');
    await expect(page.getByText('已经收到完整的长消息。', { exact: true })).toHaveCount(0);
    expect(existsSync(join(agentDir, 'pi-web', 'owners', forkId + '.json'))).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(original);
  } finally { await owner.close(); }
});

test('历史窗口保留技能消息和仅技能调用，不暴露隐藏通知或其他分支', async ({ page, request, sessionsDir, workingDir }, info) => {
  const native = buildSession({ cwd: workingDir });
  const prompt = skillEntry('history-skill', native.lastId, '历史里的原始长提问。');
  const onlySkill = skillEntry('only-skill', prompt.id, '');
  const hidden = skillEntry('hidden-skill', onlySkill.id, 'hidden-skill-prompt', false);
  const notice = { type: 'custom_message', customType: 'subagent-notify', id: 'notice', parentId: hidden.id, display: true, content: 'private-notification-content' };
  native.entries.push(prompt, onlySkill, hidden, notice);
  let tip = notice.id;
  for (let index = 0; index < 40; index++) {
    const next = assistantTextEntry(tip, `后续回复 ${index}`);
    native.entries.push(next.entry); tip = next.id;
  }
  native.entries.push(skillEntry('inactive-skill', native.lastId, 'inactive-branch-prompt'));
  native.entries.push({ type: 'session_info', id: 'active-tip', parentId: tip, name: '技能历史' });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'skill-history'), native.entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await expect(page.getByText('后续回复 39', { exact: true })).toBeVisible();
  await expect(page.locator('[data-message-id="history-skill"]')).toHaveCount(0);
  await page.locator('.remote-main').evaluate(element => element.scrollTo({ top: 0 }));
  const message = page.locator('[data-message-id="history-skill"]');
  await expect(message).toContainText('历史里的原始长提问。');
  await expect(page.locator('[data-message-id="only-skill"]')).toContainText('/skill:grilling');
  await expect(page.locator('[data-message-id="hidden-skill"], [data-message-id="notice"], [data-message-id="inactive-skill"]')).toHaveCount(0);
  const exported = await (await request.get(`/api/session/context?id=${encodeURIComponent(id)}`)).json();
  expect(exported.text).toContain('历史里的原始长提问。');
  for (const secret of ['hidden-skill-prompt', 'private-notification-content', 'inactive-branch-prompt', 'private-expanded-skill-instructions']) expect(exported.text).not.toContain(secret);
});
