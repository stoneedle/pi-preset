import { join } from 'node:path';
import { test, expect } from '../lib/test';
import {
  appendEntry,
  assistantTextEntry,
  buildSession,
  uniqueSessionName,
  writeSession,
} from '../lib/sessions';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';

test.use({ serviceWorkers: 'block', timezoneId: 'Asia/Shanghai' });

function user(id: string, parentId: string, timestamp: string, text = '新的提问') {
  return {
    type: 'message',
    id,
    parentId,
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function reply(parentId: string, text: string, timestamp: string) {
  const value = assistantTextEntry(parentId, text);
  value.entry.timestamp = timestamp;
  return value;
}

test('结束时间只尾随最终输出，耗时在 Fork 右侧且不进入复制内容', async ({
  page,
  context,
  request,
  sessionsDir,
  workingDir,
}, info) => {
  const native = buildSession({ cwd: workingDir });
  native.entries = native.entries.slice(0, 2);
  const question = native.entries[1];
  question.timestamp = '2026-10-26T06:30:00.000Z';
  native.entries.push(
    {
      type: 'message',
      id: 'working',
      parentId: question.id,
      timestamp: '2026-10-26T06:30:20.000Z',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: '先检查工具输出。' },
          {
            type: 'toolCall',
            id: 'timed-tool',
            name: 'bash',
            arguments: { command: 'echo timing' },
          },
        ],
      },
    },
    {
      type: 'message',
      id: 'tool-result',
      parentId: 'working',
      timestamp: '2026-10-26T06:31:00.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'timed-tool',
        toolName: 'bash',
        content: [{ type: 'text', text: 'timing' }],
      },
    },
  );
  const final = reply('tool-result', '第一段输出。', '2026-10-26T06:32:18.000Z');
  final.entry.message.timestamp = Date.parse('2026-10-26T06:31:30.000Z');
  final.entry.message.content.push({
    type: 'text',
    text: '**最后一段输出。**',
  });
  native.entries.push(final.entry);
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'message-time'), native.entries);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as any).copiedText = text;
        },
      },
    });
  });
  await page.setViewportSize({ width: 320, height: 430 });
  await page.goto('/session?id=' + encodeURIComponent(id));
  const article = page.locator(`[data-message-id="${final.id}"]`);
  await expect(article.getByText('最后一段输出。', { exact: true })).toBeVisible();
  await page.screenshot({
    path: info.outputPath('reply-time-320-light.png'),
    animations: 'disabled',
  });
  await expect(article.locator('time')).toHaveText('14:32');
  await expect(article.locator('.remote-markdown').first().locator('time')).toHaveCount(0);
  await expect(article.locator('.remote-markdown').last().locator('time')).toHaveCount(1);
  await expect(page.locator('[data-message-id="working"] time, .remote-user time')).toHaveCount(0);
  await expect(article.getByLabel('本轮耗时 2分18秒', { exact: true })).toHaveText('2分18秒');
  const { window } = await (await request.get('/api/session?id=' + encodeURIComponent(id))).json();
  expect(window.messages.find((message: any) => message.id === final.id).durationMs).toBe(138000);
  expect(
    window.messages.find((message: any) => message.id === 'working').durationMs,
  ).toBeUndefined();
  const layout = await article.evaluate((node) => {
    const markdown = [...node.querySelectorAll('.remote-markdown')].at(-1)!;
    const range = document.createRange();
    range.selectNodeContents(markdown.querySelector('p')!);
    const text = [...range.getClientRects()].at(-1)!;
    const clock = node.querySelector('time')!.getBoundingClientRect();
    const fork = node.querySelector('[aria-label="从这里分叉"]')!.getBoundingClientRect();
    const duration = node.querySelector('.remote-duration')!.getBoundingClientRect();
    return {
      sameLine: clock.top < text.bottom && clock.bottom > text.top,
      afterText: clock.left >= text.right,
      afterFork: duration.left >= fork.right,
      actionRow: duration.top >= fork.top && duration.bottom <= fork.bottom,
      inside: duration.right <= innerWidth && clock.right <= innerWidth,
    };
  });
  expect(layout).toEqual({
    sameLine: true,
    afterText: true,
    afterFork: true,
    actionRow: true,
    inside: true,
  });
  await article.getByRole('button', { name: '复制', exact: true }).click();
  expect(await page.evaluate(() => (window as any).copiedText)).toBe(
    '第一段输出。\n\n**最后一段输出。**',
  );
  await context.setOffline(true);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(article.locator('time')).toHaveText('14:32');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: info.outputPath('reply-time-320-dark.png'),
    animations: 'disabled',
  });
});

test('分页外提问与活动分支仍提供正确耗时，书签与前向窗口保持一致', async ({
  page,
  request,
  sessionsDir,
  workingDir,
  agentDir,
}, info) => {
  const native = buildSession({ cwd: workingDir });
  const initial = native.entries[1];
  initial.timestamp = '2026-10-26T06:00:00.000Z';
  native.entries[2].timestamp = '2026-10-26T06:00:10.000Z';
  const question = user('long-question', native.lastId, '2026-10-26T06:30:00.000Z');
  native.entries.push(question);
  let parent = question.id;
  for (let index = 0; index < 40; index++) {
    const interim = reply(parent, '过程输出 ' + index, '2026-10-26T06:31:00.000Z');
    interim.entry.message.stopReason = 'toolUse';
    native.entries.push(interim.entry);
    parent = interim.id;
  }
  const final = reply(parent, '分页末尾的最终输出。', '2026-10-26T06:32:18.000Z');
  native.entries.push(final.entry);
  const alternate = user('other-branch', native.lastId, '2026-10-26T05:00:00.000Z');
  native.entries.push(
    alternate,
    reply(alternate.id, '不属于当前分支。', '2026-10-26T08:00:00.000Z').entry,
  );
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, 'message-time-history'),
    native.entries,
  );
  const owner = await openFixtureOwner({
    agentDir,
    sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
    getState: () => ({ state: 'idle', leafId: final.id }),
  });
  try {
    await expect
      .poll(
        async () =>
          (await (await request.get('/api/status?id=' + encodeURIComponent(id))).json())
            .availability,
      )
      .toBe('connected');
    const endpoint = '/api/session?id=' + encodeURIComponent(id);
    const { window: latest } = await (await request.get(endpoint)).json();
    expect(latest.messages.some((message: any) => message.id === question.id)).toBe(false);
    expect(latest.messages.find((message: any) => message.id === final.id).durationMs).toBe(138000);
    const { window: around } = await (await request.get(endpoint + '&around=' + final.id)).json();
    expect(around.messages.find((message: any) => message.id === final.id).durationMs).toBe(138000);
    const { window: forward } = await (
      await request.get(endpoint + '&forward=' + parent + '&after=' + final.id)
    ).json();
    expect(forward.messages.find((message: any) => message.id === final.id).durationMs).toBe(
      138000,
    );
    const { window: earlier } = await (
      await request.get(endpoint + '&before=' + latest.before)
    ).json();
    expect(earlier.messages.find((message: any) => message.id === native.lastId).durationMs).toBe(
      10000,
    );
    await page.goto('/session?id=' + encodeURIComponent(id));
    const article = page.locator(`[data-message-id="${final.id}"]`);
    await expect(article.locator('time')).toHaveText('14:32');
    await expect(article.getByLabel('本轮耗时 2分18秒', { exact: true })).toBeVisible();
    await expect(page.getByText('不属于当前分支。', { exact: true })).toHaveCount(0);
  } finally {
    await owner.close();
  }
});

test('增量最终回复使用本轮提问时间，行尾不足自然换行且代码保持原排版', async ({
  page,
  sessionsDir,
  workingDir,
}, info) => {
  const native = buildSession({ cwd: workingDir });
  native.entries[1].timestamp = '2026-10-26T06:00:00.000Z';
  native.entries[2].timestamp = '2026-10-26T06:00:05.000Z';
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, 'message-time-incremental'),
    native.entries,
  );
  await page.setViewportSize({ width: 320, height: 430 });
  await page.goto('/session?id=' + encodeURIComponent(id));
  await expect(page.locator('article time')).toHaveText('14:00');
  const question = user('next-question', native.lastId, '2026-10-26T06:32:00.000Z');
  const interim = reply(question.id, '正在处理。', '2026-10-26T06:32:03.000Z');
  interim.entry.message.stopReason = 'toolUse';
  appendEntry(sessionsDir, id, question);
  appendEntry(sessionsDir, id, interim.entry);
  await expect(page.getByText('正在处理。', { exact: true })).toBeVisible();
  await expect(page.locator(`[data-message-id="${interim.id}"] time`)).toHaveCount(0);
  const final = reply(
    interim.id,
    '```text\n' + 'long-code-'.repeat(40) + '\n```\n\n最后这段输出末尾刚好占满整个行宽',
    '2026-10-26T06:32:09.000Z',
  );
  appendEntry(sessionsDir, id, final.entry);
  const article = page.locator(`[data-message-id="${final.id}"]`);
  await expect(article.locator('time')).toHaveText('14:32');
  await expect(article.getByLabel('本轮耗时 9秒', { exact: true })).toHaveText('9秒');
  expect(
    await article.locator('.remote-markdown').evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node.querySelector('p')!);
      const lastLine = [...range.getClientRects()].at(-1)!;
      const clock = node.querySelector('time')!.getBoundingClientRect();
      return (
        clock.top >= lastLine.bottom &&
        Math.abs(clock.left - node.getBoundingClientRect().left) <= 1
      );
    }),
  ).toBe(true);
  expect(await article.locator('pre').evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: info.outputPath('reply-time-wrapped-320.png'),
    animations: 'disabled',
  });
});

test('跨日与长耗时正确格式化，缺失或倒退的时间不显示伪造结果', async ({
  page,
  request,
  sessionsDir,
  workingDir,
}, info) => {
  const native = buildSession({ cwd: workingDir });
  native.entries = native.entries.slice(0, 1);
  const samples = [
    {
      start: '2026-10-26T15:59:59.700Z',
      end: '2026-10-26T15:59:59.700Z',
      clock: '23:59',
      elapsed: '不足1秒',
    },
    {
      start: '2026-10-26T15:59:59.700Z',
      end: '2026-10-26T16:00:00.200Z',
      clock: '00:00',
      elapsed: '不足1秒',
    },
    {
      start: '2026-10-26T15:59:00.000Z',
      end: '2026-10-26T17:01:03.000Z',
      clock: '01:01',
      elapsed: '1小时2分3秒',
    },
    { start: '', end: '2026-10-26T17:01:00.000Z' },
    { start: '2026-10-26T17:01:00.000Z', end: 'invalid' },
    { start: 'invalid', end: '2026-10-26T17:01:00.000Z' },
    { start: '2026-10-26T17:02:00.000Z', end: '2026-10-26T17:01:00.000Z' },
  ];
  let parent = '';
  const replies = samples.map((sample, index) => {
    const question = user('sample-' + index, parent, sample.start);
    const answer = reply(question.id, '时间样例 ' + index, sample.end);
    native.entries.push(question, answer.entry);
    parent = answer.id;
    return answer;
  });
  const id = writeSession(
    sessionsDir,
    uniqueSessionName(info, 'message-time-format'),
    native.entries,
  );
  const { window: view } = await (
    await request.get('/api/session?id=' + encodeURIComponent(id))
  ).json();
  await page.goto('/session?id=' + encodeURIComponent(id));
  for (let index = 0; index < samples.length; index++) {
    const article = page.locator(`[data-message-id="${replies[index].id}"]`);
    const sample = samples[index];
    if (sample.clock) {
      await expect(article.locator('time')).toHaveText(sample.clock);
      await expect(article.getByLabel('本轮耗时 ' + sample.elapsed, { exact: true })).toHaveText(
        sample.elapsed!,
      );
    } else {
      await expect(article.locator('time, .remote-duration')).toHaveCount(0);
      expect(
        view.messages.find((message: any) => message.id === replies[index].id).durationMs,
      ).toBeUndefined();
    }
  }
});
