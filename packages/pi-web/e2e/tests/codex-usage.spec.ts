import { test, expect } from '../lib/test';
import { buildSession, uniqueSessionName, writeSession } from '../lib/sessions';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
const sample = {
  status: 'ok', plan: 'pro', updatedAt: Date.now(),
  windows: [
    { id: 'primary', windowMinutes: 300, remainingPercent: 67, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
    { id: 'secondary', windowMinutes: 10080, remainingPercent: 6, resetsAt: Math.floor(Date.now() / 1000) + 5 * 86400 },
  ],
};
const drawer = (page: Page) => page.getByRole('dialog', { name: '会话', exact: true });
const trigger = (page: Page) => drawer(page).getByRole('button', { name: /^Codex 周剩余/ });
const details = (page: Page) => page.getByRole('dialog', { name: 'Codex 额度详情', exact: true });
const refresh = (page: Page) => details(page).getByRole('button', { name: '刷新 Codex 额度', exact: true });

async function checkFooter(page: Page) {
  await expect.poll(() => drawer(page).evaluate(node => node.getBoundingClientRect().left)).toBeCloseTo(0, 0);
  const bounds = await drawer(page).evaluate(node => {
    const footer = node.querySelector('footer')!.getBoundingClientRect();
    const number = node.querySelector('.quota-trigger')!.getBoundingClientRect();
    const link = node.querySelector('footer > a')!.getBoundingClientRect();
    return {
      height: footer.height, bottom: footer.bottom, drawerBottom: node.getBoundingClientRect().bottom,
      number: { x: number.x, y: number.y, width: number.width, height: number.height },
      link: { center: (link.left + link.right) / 2, y: link.y },
      width: node.clientWidth, scrollWidth: node.scrollWidth,
      listHeight: node.querySelector('.remote-list-main')!.clientHeight,
    };
  });
  expect(bounds.height).toBeLessThanOrEqual(64);
  expect(bounds.bottom).toBeCloseTo(bounds.drawerBottom, 0);
  expect(bounds.number.x).toBeLessThanOrEqual(16);
  expect(bounds.number.width).toBeGreaterThanOrEqual(44);
  expect(bounds.number.height).toBeGreaterThanOrEqual(44);
  expect(bounds.number.y).toBeCloseTo(bounds.link.y, 0);
  expect(bounds.link.center).toBeCloseTo(bounds.width / 2, 0);
  expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width);
  expect(bounds.listHeight).toBeGreaterThan(80);
}

async function checkPopup(page: Page) {
  const box = await details(page).boundingBox();
  const drawerBox = await drawer(page).boundingBox();
  const anchor = await trigger(page).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(drawerBox!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(anchor!.y);
  expect(await details(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
}

test('周额度数字与详情', async ({ page, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'quota'), buildSession({ cwd: workingDir }).entries);
  let reads = 0;
  await page.route('**/api/codex-usage*', async route => { reads++; await route.fulfill({ json: sample }); });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  const draft = page.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
  await draft.fill('额度详情不影响这份草稿');
  await draft.blur();
  expect(reads).toBe(0);
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  await expect(trigger(page)).toHaveText('6%');
  await expect(details(page)).not.toBeVisible();
  expect((await drawer(page).locator('footer').innerText()).replace(/\s+/g, '')).toBe('6%查看全部会话');
  await checkFooter(page);
  await page.screenshot({ path: info.outputPath('quota-collapsed.png'), animations: 'disabled' });
  await trigger(page).click();
  await expect(details(page)).toBeVisible();
  await expect(details(page).getByText('剩余 67%', { exact: true })).toBeVisible();
  await expect(details(page).getByRole('progressbar', { name: '每周剩余额度' })).toHaveAttribute('aria-valuenow', '6');
  await checkPopup(page);
  await page.screenshot({ path: info.outputPath('quota-details.png'), animations: 'disabled' });
  expect(reads).toBe(1);
  await page.keyboard.press('Escape');
  await expect(details(page)).not.toBeVisible();
  await expect(drawer(page)).toBeVisible();
  await expect(trigger(page)).toBeFocused();
  await trigger(page).click();
  await expect(details(page)).toBeVisible();
  await drawer(page).locator(':scope > header').click({ position: { x: 100, y: 2 } });
  await expect(details(page)).not.toBeVisible();

  await page.setViewportSize({ width: 320, height: 640 });
  await drawer(page).getByRole('button', { name: '搜索会话', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 360 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(() => drawer(page).evaluate(node => node.getBoundingClientRect().height)).toBe(360);
  await checkFooter(page);
  await drawer(page).screenshot({ path: info.outputPath('quota-collapsed-320.png'), animations: 'disabled' });
  await trigger(page).click();
  await expect(details(page)).toBeVisible();
  await checkPopup(page);
  await drawer(page).screenshot({ path: info.outputPath('quota-details-320.png'), animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await drawer(page).screenshot({ path: info.outputPath('quota-details-320-dark.png'), animations: 'disabled' });
  await details(page).getByRole('button', { name: '关闭额度详情', exact: true }).click();
  await expect(trigger(page)).toBeFocused();
  await drawer(page).getByRole('button', { name: '关闭会话列表', exact: true }).click();
  await expect(draft).toHaveValue('额度详情不影响这份草稿');
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  await expect(trigger(page)).toHaveText('6%');
  expect(reads).toBe(1);
});

test('详情刷新、未知窗口与失效状态', async ({ page, context, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'quota-states'), buildSession({ cwd: workingDir }).entries);
  let response: any = sample;
  let release: (() => void) | undefined;
  let hold = false;
  await page.route('**/api/codex-usage*', async route => {
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: response });
  });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  await expect(trigger(page)).toHaveText('6%');
  await trigger(page).click();
  response = { ...sample, windows: [{ ...sample.windows[1], id: 'primary' }] };
  await refresh(page).click();
  await expect(details(page).getByText('5 小时', { exact: true })).toHaveCount(0);
  await expect(trigger(page)).toHaveText('6%');
  response = { ...sample, windows: [sample.windows[0]] };
  await refresh(page).click();
  await expect(trigger(page)).toHaveText('?');
  await expect(details(page).getByText('剩余 67%', { exact: true })).toBeVisible();
  response = sample;
  await refresh(page).click();
  await expect(trigger(page)).toHaveText('6%');
  hold = true;
  await refresh(page).click();
  await expect(refresh(page)).toBeDisabled();
  await expect(trigger(page)).toHaveText('6%');
  response = { status: 'unavailable', message: '额度查询过于频繁，请稍后刷新' };
  hold = false;
  await expect.poll(() => Boolean(release)).toBe(true);
  release!();
  await expect(refresh(page)).toBeEnabled();
  await expect(details(page).getByRole('status')).toContainText('更新失败');
  await expect(trigger(page)).toHaveText('6%');
  await expect(trigger(page)).toHaveAttribute('aria-label', /更新失败/);
  await context.setOffline(true);
  await refresh(page).click();
  await expect(details(page).getByRole('status')).toContainText('当前离线');
  await context.setOffline(false);
  response = { status: 'signed-out', message: '请先在电脑端 /login openai-codex' };
  await refresh(page).click();
  await expect(trigger(page)).toHaveText('?');
  await expect(details(page).getByText('请先在电脑端 /login openai-codex', { exact: true })).toBeVisible();
  await expect(details(page).getByRole('progressbar')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 360 });
  await checkFooter(page);
  await checkPopup(page);
  await page.screenshot({ path: info.outputPath('quota-signed-out.png'), animations: 'disabled' });
});

test('只在抽屉前台按分钟更新', async ({ page, sessionsDir, workingDir }, info) => {
  const id = writeSession(sessionsDir, uniqueSessionName(info, 'quota-polling'), buildSession({ cwd: workingDir }).entries);
  let reads = 0;
  await page.clock.install();
  await page.route('**/api/codex-usage*', async route => { reads++; await route.fulfill({ json: sample }); });
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.getByRole('button', { name: '会话列表', exact: true }).click();
  await expect(trigger(page)).toHaveText('6%');
  expect(reads).toBe(1);
  await page.clock.fastForward(61000);
  await expect.poll(() => reads).toBe(2);
  await expect(trigger(page)).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(61000);
  expect(reads).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => reads).toBe(3);
  await expect(trigger(page)).toHaveAttribute('aria-busy', 'false');
  await drawer(page).getByRole('button', { name: '关闭会话列表', exact: true }).click();
  await page.clock.runFor(300);
  await expect(drawer(page)).not.toBeVisible();
  await expect(details(page)).not.toBeVisible();
  await page.clock.fastForward(120000);
  expect(reads).toBe(3);
});
