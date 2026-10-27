import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { startServer, stopServer } from '../lib/server.ts';
import { BINARY } from '../lib/paths.ts';
import { appendEntry, assistantTextEntry, buildSession, writeSession } from '../lib/sessions.ts';
import { buildUpdatedRelease } from '../lib/updated-release.ts';
import { launchTestBrowser } from '../lib/browser.mjs';

const picture = { name: 'guard.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64') };
const releaseMark = page => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pi-web-release-probe').trim());
const waitRelease = (page, expected) => page.waitForFunction(expected => getComputedStyle(document.documentElement).getPropertyValue('--pi-web-release-probe').trim() === expected, expected);
async function clickRefresh(page) {
  await page.locator('summary[aria-label="更多"]').click();
  await page.getByRole('button', { name: '刷新界面', exact: true }).click();
}
async function answerRefresh(page, accept) {
  const question = page.waitForEvent('dialog');
  await clickRefresh(page);
  const dialog = await question;
  const message = dialog.message();
  if (accept) await dialog.accept(); else await dialog.dismiss();
  return message;
}

test('manual refresh protects all local drafts and controls without coordinating other tabs', { timeout: 240000 }, async (t) => {
  const updated = buildUpdatedRelease();
  t.after(() => updated.close());
  for (const engine of [chromium, webkit]) {
    await t.test(engine.name(), { timeout: 100000 }, async (t) => {
      let server = await startServer();
      const agentDir = server.agentDir;
      const baseURL = server.baseURL;
      const port = Number(new URL(baseURL).port);
      const cwd = mkdtempSync(join(agentDir, 'draft-project-'));
      const a = writeSession(server.sessionsDir, 'guard-a.jsonl', buildSession({ cwd }).entries);
      const nativeB = buildSession({ cwd });
      const b = writeSession(server.sessionsDir, 'guard-b.jsonl', nativeB.entries);
      let browserHost;
      t.after(async () => {
        await stopServer(server.child);
        await browserHost?.close();
        rmSync(agentDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
      });
      browserHost = await launchTestBrowser(engine);
      const context = await browserHost.browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const restart = async binary => {
        await stopServer(server.child, { preserveWorkers: true });
        server = await startServer({ binary, agentDir, port });
      };
      await page.goto(baseURL + '/session?id=' + a);
      await expect(page.getByText('Initial reply.', { exact: true })).toBeVisible();
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      await page.evaluate(() => { window.__documentKept = true; });
      const input = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
      await input.fill('另一会话中暂存的 prompt');
      await page.locator('.remote-attach input').setInputFiles(picture);
      await page.getByRole('button', { name: '会话列表', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: '会话', exact: true });
      await drawer.getByRole('button', { name: '搜索会话', exact: true }).click();
      await drawer.getByRole('searchbox').fill(b);
      await drawer.locator(`a[href="/session?id=${b}"]`).click();
      await page.getByRole('button', { name: '新建会话', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '新对话', exact: true });
      const newInput = editor.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
      const newText = '新版资源不应打断新增会话输入。'.repeat(30);
      await newInput.fill(newText);
      await editor.locator('input[type=file]').setInputFiles(picture);
      const clean = await context.newPage();
      await clean.goto(baseURL);
      await clean.evaluate(() => { window.__cleanDocument = true; });
      await restart(updated.binary);
      const navigation = clean.waitForEvent('framenavigated', frame => frame === clean.mainFrame());
      await clean.getByRole('button', { name: '刷新界面', exact: true }).click();
      await navigation;
      await waitRelease(clean, 'updated');
      await expect.poll(() => clean.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state), { timeout: 15000 }).toBe('installed');
      assert.equal(await page.evaluate(() => window.__documentKept), true);
      assert.equal(await releaseMark(page), '');
      await expect(editor).toBeVisible();
      await expect(newInput).toHaveValue(newText);
      await expect(editor.getByRole('button', { name: '移除 guard.png', exact: true })).toBeVisible();
      await expect(page.getByText('新版已就绪', { exact: false })).toHaveCount(0);
      await page.setViewportSize({ width: 320, height: 400 });
      await expect(editor.getByRole('button', { name: '发送', exact: true })).toBeInViewport();
      await expect(newInput).toBeInViewport();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.setViewportSize({ width: 393, height: 851 });
      const reply = assistantTextEntry(nativeB.lastId, '更新网页服务后，旧页面仍接收真实 SSE 内容。');
      appendEntry(server.sessionsDir, b, reply.entry);
      await expect(page.locator(`[data-message-id="${reply.id}"]`)).toBeAttached();
      await editor.getByRole('button', { name: '关闭新对话', exact: true }).click();
      await page.goBack();
      await expect(input).toHaveValue('另一会话中暂存的 prompt');
      await expect(page.getByRole('button', { name: '移除 guard.png', exact: true })).toBeVisible();
      await answerRefresh(page, false);
      await expect(input).toHaveValue('另一会话中暂存的 prompt');
      assert.equal(await page.evaluate(() => window.__documentKept), true);
      await input.fill('');
      await page.getByRole('button', { name: '移除 guard.png', exact: true }).click();
      assert.match(await answerRefresh(page, false), /所有会话的草稿/);
      await page.getByRole('button', { name: '新建会话', exact: true }).click();
      await expect(newInput).toHaveValue(newText);
      await expect(editor.getByRole('button', { name: '移除 guard.png', exact: true })).toBeVisible();
      await editor.getByRole('button', { name: '关闭新对话', exact: true }).click();
      await answerRefresh(page, true);
      await waitRelease(page, 'updated');
      assert.equal(await page.evaluate(() => window.__documentKept), undefined);
      await page.getByRole('button', { name: '新建会话', exact: true }).click();
      await expect(newInput).toHaveValue('');
      await expect(editor.getByRole('button', { name: '移除 guard.png', exact: true })).toHaveCount(0);
      await editor.getByRole('button', { name: '关闭新对话', exact: true }).click();
      await expect(editor).not.toBeVisible();

      let mark = 'updated';
      for (const status of [202, 503]) {
        await page.evaluate(() => {
          const nativeFetch = window.fetch.bind(window);
          window.__chatCalls = 0;
          window.fetch = (...args) => {
            if (new URL(String(args[0]), location.href).pathname === '/api/chat') {
              window.__chatCalls++;
              return new Promise(resolve => { window.__releaseChat = status => resolve(new Response(JSON.stringify(status === 202 ? {} : { error: 'Lost acknowledgement' }), { status, headers: { 'Content-Type': 'application/json' } })); });
            }
            return nativeFetch(...args);
          };
        });
        await input.fill('成功清理提交快照，回执未确认时保留');
        await page.getByRole('button', { name: '发送', exact: true }).click();
        await page.waitForFunction(() => Boolean(window.__releaseChat));
        await input.fill('发送期间继续写的新草稿');
        const target = mark === 'updated' ? '' : 'updated';
        await restart(target ? updated.binary : BINARY);
        await page.locator('summary[aria-label="更多"]').click();
        await expect(page.getByRole('button', { name: '刷新界面', exact: true })).toBeDisabled();
        await page.locator('summary[aria-label="更多"]').click();
        await page.evaluate(status => window.__releaseChat(status), status);
        const local = page.locator('[data-recovery-message]');
        if (status === 202) await expect(local).toHaveCount(0);
        else await expect(local).toContainText('未确认是否发送成功');
        await expect(input).toHaveValue('发送期间继续写的新草稿');
        assert.equal(await releaseMark(page), mark);
        assert.equal(await page.evaluate(() => window.__chatCalls), 1);
        await answerRefresh(page, false);
        await expect(input).toHaveValue('发送期间继续写的新草稿');
        if (status !== 202) await expect(local).toHaveCount(1);
        await answerRefresh(page, true);
        await waitRelease(page, target);
        await expect(input).toHaveValue('');
        await expect(local).toHaveCount(0);
        assert.equal(await releaseMark(clean), 'updated');
        mark = target;
      }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ engine: engine.name(), manualOnly: true, independentTabs: true, openNewTaskKept: true, inactiveDraftKept: true, imagesKept: true, streamsContinue: true, acceptedAndUncertainProtected: true, pendingControlProtected: true }));
    });
  }
});
