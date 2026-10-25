import { test, expect } from '../lib/test';
import { buildSession, uniqueSessionName, writeSession } from '../lib/sessions';

test('thinking previews and bodies render Markdown without a repeated thinking label', async ({ page, sessionsDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  entries.push({ type: 'message', id: 'markdown-thinking', parentId: lastId, message: { role: 'assistant', content: [
    { type: 'thinking', thinking: '**先验证** `布局`，再看[链接](https://example.com)。\n\n## 分析\n\n- 保留惰性加载\n- 确保窄屏\n\n> [!TIP]\n> **完整正文**保持可读。\n\n```mermaid\nflowchart LR\n A[检查] --> B[完成]\n```' },
    { type: 'text', text: '分析已就绪。' },
  ] } });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'thinking-markdown'), entries);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const thinking = page.locator('.remote-block-toggle');
  await expect(thinking).toBeVisible();
  await expect(thinking.locator('.remote-block-name')).toHaveCount(0);
  await expect(thinking.locator('.remote-block-summary strong')).toHaveText('先验证');
  await expect(thinking.locator('.remote-block-summary code')).toHaveText('布局');
  await expect(thinking.locator('.remote-block-summary')).not.toContainText('##');
  await expect(thinking.locator('a, button')).toHaveCount(0);
  expect(requests.some((url) => url.includes('/api/session/block'))).toBe(false);
  const original = page.viewportSize()!;
  for (const width of [...new Set([original.width, 320])]) {
    await page.setViewportSize({ width, height: original.height });
    expect(await thinking.evaluate((node) => node.getBoundingClientRect().height)).toBeLessThanOrEqual(30);
    expect(await thinking.evaluate((node) => node.getBoundingClientRect().right)).toBeLessThanOrEqual(width);
  }
  await thinking.click();
  const body = page.locator('.remote-block-body');
  await expect(body.getByRole('heading', { name: '分析', exact: true })).toBeVisible();
  await expect(body.locator('li')).toHaveCount(2);
  await expect(body.locator('.markdown-alert strong')).toContainText(['提示', '完整正文']);
  await expect(body.locator('.markdown-diagram svg')).toBeVisible({ timeout: 15000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await thinking.click();
  await expect(body).toHaveCount(0);
});

test('replies render safe callouts, GFM and Mermaid with local overflow and readable fallback', async ({ page, sessionsDir, workingDir }, info) => {
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const callouts = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'].map((kind) => `> [!${kind}]\n> **${kind} 内容**\n>\n> - 保留列表`).join('\n\n');
  entries.push({ type: 'message', id: 'rich-markdown', parentId: lastId, message: { role: 'assistant', content: [{ type: 'text', text: `# 渲染验收\n\n${callouts}\n\n| 项目 | 结果 |\n| --- | --- |\n| 中文 | **完整** |\n\n- [x] 已验证\n\n~~~mermaid\nflowchart LR\n A[较长的起点中文标签] --> B[后续处理节点一] --> C[后续处理节点二] --> D[最终完成]\n~~~\n\n~~~mermaid\nthis is not valid Mermaid syntax\n~~~\n\n<img src=x onerror="window.__markdownUnsafe=true">\n\n[危险链接](javascript:alert(1))` }] } });
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'rich-markdown'), entries);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const reply = page.locator('[data-message-id="rich-markdown"]');
  await expect(reply.getByRole('heading', { name: '渲染验收' })).toBeVisible();
  await expect(reply.locator('.markdown-alert')).toHaveCount(5);
  for (const kind of ['note', 'tip', 'important', 'warning', 'caution']) {
    await expect(reply.locator(`.markdown-alert[data-kind="${kind}"]`)).toContainText(`${kind.toUpperCase()} 内容`);
  }
  await expect(reply.locator('table strong')).toHaveText('完整');
  await expect(reply.locator('input[type=checkbox]')).toBeChecked();
  const diagrams = reply.locator('.markdown-diagram');
  await expect(diagrams).toHaveCount(2);
  await expect(diagrams.first().locator('svg')).toBeVisible({ timeout: 15000 });
  await expect(diagrams.last()).toContainText('this is not valid Mermaid syntax');
  await expect(diagrams.last()).toContainText('显示源码');
  for (const width of [...new Set([page.viewportSize()!.width, 320])]) {
    await page.setViewportSize({ width, height: page.viewportSize()!.height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 320)
      expect(await diagrams.first().evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(diagrams.first().locator('svg')).toBeVisible();
  await page.screenshot({ path: info.outputPath('rich-markdown-320-dark.png'), fullPage: true });
  await expect(reply.locator('img')).toHaveCount(0);
  await expect(reply.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__markdownUnsafe)).toBeUndefined();
  expect(errors).toEqual([]);
});
