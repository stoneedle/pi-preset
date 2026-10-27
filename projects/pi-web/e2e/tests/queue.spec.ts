import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test, expect } from '../lib/test';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';
import { buildSession, uniqueSessionName, writeSession } from '../lib/sessions';

test.use({ serviceWorkers: 'block' });

for (const lostReceipt of [false, true]) {
  test(`排队可读、逐条取回和取消，保留下一份图文，撤回回执丢失=${lostReceipt}`, async ({ page, request, sessionsDir, agentDir, workingDir }, info) => {
    const id = writeSession(sessionsDir, uniqueSessionName(info, 'queue'), buildSession({ cwd: workingDir }).entries);
    let items: any[] = [];
    let revision = 0;
    let sends = 0;
    let removes = 0;
    const owner = await openFixtureOwner({ agentDir, sessionPath: join(sessionsDir, '--home-user-demo-project--', id),
      getState: () => ({ state: 'running', mainRunning: true, queueRevision: revision, queueCount: items.length }),
      control: (input: any) => {
        const list = () => ({ revision, items: items.map(({ images, ...item }) => ({ ...item, imageCount: images.length })) });
        if (input.action === 'send') {
          sends++;
          items.push({ id: randomUUID(), message: input.chat.message, images: input.chat.images || [], state: 'queued' });
          revision++;
          return { status: 'accepted' };
        }
        if (input.action === 'queue') {
          if (input.itemId) {
            const item = items.find(item => item.id === input.itemId);
            if (!item) throw new Error('已开始执行');
            return { item };
          }
          return list();
        }
        if (input.action === 'queue-remove') {
          removes++;
          if (!items.some(item => item.id === input.itemId)) throw new Error('已开始执行');
          items = items.filter(item => item.id !== input.itemId);
          revision++;
          return list();
        }
        return { status: 'accepted' };
      },
    });
    try {
      await page.setViewportSize({ width: 320, height: 380 });
      await page.goto(`/session?id=${encodeURIComponent(id)}`);
      await expect(page.locator('.remote-header .remote-state')).toHaveAttribute('data-state', 'running');
      const draft = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
      const list = page.getByRole('region', { name: '排队消息', exact: true });
      const picture = { name: 'queued.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64') };
      const original = '稍后执行这份完整图文。'.repeat(30) + '排队原文末尾';
      let releaseList = () => {};
      let listStarted = false;
      if (!lostReceipt) await page.route('**/api/session/queue?*', async route => {
        if (route.request().method() === 'GET' && !new URL(route.request().url()).searchParams.has('item') && !listStarted) {
          listStarted = true;
          await new Promise<void>(resolve => { releaseList = resolve; });
        }
        await route.continue();
      });
      await draft.fill(original);
      await page.locator('.remote-attach input').setInputFiles(picture);
      await page.getByRole('button', { name: '发送', exact: true }).click({ button: 'right' });
      await expect(draft).toBeFocused();
      await page.getByRole('menuitem', { name: '排队', exact: true }).click();
      await expect(draft).toHaveValue('');
      await expect(draft).toBeFocused();
      if (!lostReceipt) {
        try { await expect(list).toContainText('排队 1 条，正在读取'); }
        finally { releaseList(); }
      }
      await expect(list.locator('[data-queue-id]')).toHaveCount(1);
      await expect(page.locator('[data-message-id]')).toHaveCount(2);
      await list.locator('.queue-summary').click();
      await expect(list.locator('.queue-text')).toHaveText(original);
      await expect(list).toContainText('1 张图片');
      await list.locator('.queue-summary').click();
      await page.context().setOffline(true);
      await list.locator('.queue-summary').click();
      await expect(list.locator('.queue-text')).toHaveText(original);
      await page.context().setOffline(false);
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
      await expect(page.getByRole('button', { name: '停止主代理', exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('queue-320-keyboard.png') });
      // A second browser submission with identical text must remain a distinct queue entry.
      await request.post('/api/chat?id=' + encodeURIComponent(id), { multipart: { message: original, delivery: 'followUp' } });
      await expect(list.locator('[data-queue-id]')).toHaveCount(2);
      const secondId = items[1].id;
      await page.reload();
      await expect(list.locator('[data-queue-id]')).toHaveCount(2);
      await draft.fill('下一份草稿');
      await page.locator('.remote-attach input').setInputFiles({ ...picture, name: 'next.png' });
      if (lostReceipt) {
        await page.route('**/api/session/queue?*', async route => {
          if (route.request().method() !== 'POST') return route.continue();
          await route.fetch();
          await route.abort('connectionreset');
        });
      }
      await list.locator('[data-queue-id]').first().getByRole('button', { name: '取回编辑', exact: true }).click();
      if (lostReceipt) {
        const recovery = page.locator('[data-recovery-message]');
        await expect(recovery).toContainText('未确认是否撤回成功');
        await expect(draft).toHaveValue('下一份草稿');
        await recovery.getByRole('button', { name: '未确认是否撤回成功', exact: true }).click();
        await expect(recovery).toContainText(original);
        await expect(recovery.getByRole('link', { name: /保存图片/ })).toHaveCount(1);
        await recovery.getByRole('button', { name: '重新编辑', exact: true }).click();
        await page.unroute('**/api/session/queue?*');
      }
      await expect(draft).toHaveValue(original);
      await expect(draft).toBeFocused();
      await expect(page.locator('.remote-images img')).toHaveCount(1);
      await expect(list.locator('[data-queue-id]')).toHaveCount(1);
      await expect(list.locator('[data-queue-id]')).toHaveAttribute('data-queue-id', secondId);
      const saved = page.locator('[data-recovery-message]');
      await expect(saved).toContainText('另一份草稿已暂存');
      await saved.getByRole('button', { name: '继续编辑', exact: true }).click();
      await expect(draft).toHaveValue('下一份草稿');
      await expect(page.getByRole('button', { name: '移除 next.png', exact: true })).toBeVisible();
      await list.getByRole('button', { name: '取消排队', exact: true }).click();
      await expect(list).toHaveCount(0);
      await expect(draft).toHaveValue('下一份草稿');
      expect(items).toHaveLength(0);
      expect(sends).toBe(2);
      expect(removes).toBe(2);
      expect(revision).toBe(4);
    } finally { await owner.close(); }
  });
}
