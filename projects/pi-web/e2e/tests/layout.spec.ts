import { test, expect } from '../lib/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSession, uniqueSessionName, writeSession, appendEntry, assistantTextEntry } from '../lib/sessions';
import { openFixtureOwner } from '../lib/runtime-owner.mjs';

// Network gates must intercept reads; the real service worker is covered in push.spec.ts.
test.use({serviceWorkers:'block'});

test('首页单行入口展开为全屏草稿，选择无历史项目后发送才创建会话', async ({ page, request, workingDir }) => {
  let holdOptions = false, releaseOptions: (() => void) | undefined;
  await page.route(/\/api\/project-options\?/,async (route) => {
    if (!holdOptions) return route.continue();
    await new Promise<void>((resolve) => { releaseOptions = resolve; });
    await route.fulfill({json:{provider:'test',model:'test-model',thinking:'off',models:[
      {provider:'test',id:'test-model',name:'Test model',thinking:'off',thinkingLevels:['off','minimal','low','medium','high','xhigh']},
    ]}});
  });
  const projectSessions = '/api/sessions?project=' + encodeURIComponent(workingDir) + '&limit=100';
  const before = (await (await request.get(projectSessions)).json()).total;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '会话', exact: true })).toBeVisible();
  await expect(page.locator('.remote-heading button, .remote-heading svg')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '模型设置', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '开始新任务', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新对话', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor).not.toContainText(new URL(page.url()).host);
  await expect(editor.locator('.new-task-context > *')).toHaveCount(1);
  await expect(editor.getByRole('button', { name: '选择项目', exact: true })).toBeVisible();
  await editor.getByRole('textbox', { name: '给 Pi 发消息…' }).fill('A draft that must survive closing');
  expect((await (await request.get(projectSessions)).json()).total).toBe(before);
  await editor.getByRole('button', { name: '选择项目', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择项目', exact: true });
  await expect(picker.getByRole('region', { name: '已有项目', exact: true })).toBeVisible();
  await expect(picker.locator('details')).not.toHaveAttribute('open');
  await expect(picker.getByRole('textbox', { name: '文件夹路径', exact: true })).toBeHidden();
  await picker.locator('summary').filter({ hasText: '系统路径' }).click();
  await picker.getByRole('textbox', { name: '文件夹路径', exact: true }).fill(workingDir);
  await picker.getByRole('button', { name: '前往', exact: true }).click();
  await picker.getByRole('button', { name: '使用此文件夹', exact: true }).click();
  await expect(editor.getByRole('button', { name: '选择项目', exact: true })).not.toContainText(workingDir);
  await editor.getByRole('button', { name: '关闭新对话', exact: true }).click();
  await page.getByRole('button', { name: '开始新任务', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: '给 Pi 发消息…' })).toHaveValue('A draft that must survive closing');
  holdOptions = true;
  await editor.getByRole('button', { name: '模型设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '模型设置', exact: true });
  await expect(settings).toBeVisible();
  await settings.getByRole('group', {name:'思考强度',exact:true}).getByRole('button', {name:'高',exact:true}).click();
  await settings.getByRole('group', {name:'速度',exact:true}).getByRole('button', {name:'快速',exact:true}).click();
  await expect.poll(() => Boolean(releaseOptions)).toBe(true);
  releaseOptions!();
  await expect(settings.getByRole('button',{name:'Test model test',exact:true})).toBeVisible();
  await expect(settings.getByRole('group', {name:'思考强度',exact:true}).getByRole('button',{name:'高',exact:true})).toHaveAttribute('aria-pressed','true');
  expect((await (await request.get(projectSessions)).json()).total).toBe(before);
  await page.keyboard.press('Escape');
  await editor.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page).toHaveURL(/\/session\?id=/);
  await expect(page.locator('[data-message-id]').last()).toContainText('Stub reply: A draft that must survive closing');
  await expect.poll(async () => {
    const status = await (await request.get('/api/status?id=' + encodeURIComponent(new URL(page.url()).searchParams.get('id')!))).json();
    return {thinking:status.thinking,mode:status.fast?.mode};
  }).toEqual({thinking:'high',mode:'fast'});
  expect((await (await request.get(projectSessions)).json()).total).toBe(before + 1);
});

test('已有项目直接选择，系统路径默认折叠且展开才读取，320px键盘缩小仍可浏览确认', async ({ page, sessionsDir, workingDir }, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const prefix = uniqueSessionName(info, 'project-picker').replace(/\.jsonl$/, '');
  const longName = 'a-very-long-project-name-for-mobile-selection';
  const locations = Array.from({length:10}, (_, index) => join(workingDir, index ? 'project-' + index : longName));
  for (const [index, cwd] of locations.entries()) {
    mkdirSync(cwd);
    const directory = join(sessionsDir, prefix + '-' + index);
    mkdirSync(directory);
    writeFileSync(join(directory, 'history.jsonl'), buildSession({cwd}).entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  }
  mkdirSync(join(locations[0], 'child'));
  let directoryReads = 0, creations = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/directories') directoryReads++;
    if (path === '/api/new-session') creations++;
  });
  await page.goto('/');
  await page.getByRole('button', { name: '开始新任务', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新对话', exact: true });
  const draft = editor.getByRole('textbox', { name: '给 Pi 发消息…', exact: true });
  await draft.fill('项目切换不丢草稿');
  const openPicker = () => editor.getByRole('button', { name: '选择项目', exact: true }).click();
  await openPicker();
  const picker = page.getByRole('dialog', { name: '选择项目', exact: true });
  const projects = picker.getByRole('region', { name: '已有项目', exact: true });
  await expect(projects.getByRole('button')).toHaveCount(10);
  await expect(projects.getByRole('button', { name: longName, exact: true })).toBeVisible();
  await expect(picker.locator('details')).not.toHaveAttribute('open');
  await expect(picker.getByRole('textbox', { name: '文件夹路径', exact: true })).toBeHidden();
  await expect(picker.getByRole('button', { name: '使用此文件夹', exact: true })).toHaveCount(0);
  expect(directoryReads).toBe(0);
  await page.screenshot({path:info.outputPath('projects-first-320.png'),animations:'disabled'});
  await projects.getByRole('button', { name: longName, exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(editor.getByRole('button', { name: '选择项目', exact: true })).toContainText(longName);
  await expect(draft).toHaveValue('项目切换不丢草稿');
  expect(directoryReads).toBe(0);
  await openPicker();
  const summary = picker.locator('summary').filter({ hasText: '系统路径' });
  await summary.click();
  const directories = picker.locator('.directory-list');
  await expect(directories.getByRole('button', { name: 'child', exact: true })).toBeEnabled();
  expect(directoryReads).toBe(1);
  await summary.click();
  await expect(picker.getByRole('button', { name: '使用此文件夹', exact: true })).toHaveCount(0);
  await summary.click();
  await expect(directories.getByRole('button', { name: 'child', exact: true })).toBeEnabled();
  expect(directoryReads).toBe(1);
  await page.setViewportSize({ width: 320, height: 360 });
  await directories.getByRole('button', { name: 'child', exact: true }).click();
  await expect(picker.locator('footer span')).toHaveAttribute('title', join(locations[0], 'child'));
  await directories.getByRole('button', { name: '上一级', exact: true }).click();
  await expect(directories.getByRole('button', { name: 'child', exact: true })).toBeEnabled();
  const input = picker.getByRole('textbox', { name: '文件夹路径', exact: true });
  await input.fill(workingDir);
  await picker.getByRole('button', { name: '前往', exact: true }).click();
  await expect(directories.getByRole('button', { name: longName, exact: true })).toBeEnabled();
  await expect(picker.locator('.directory-shortcuts button').first()).toBeVisible();
  const confirm = picker.getByRole('button', { name: '使用此文件夹', exact: true });
  await expect(confirm).toBeInViewport();
  expect(await picker.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('system-paths-keyboard-320.png'),animations:'disabled'});
  await confirm.click();
  await expect(picker).toBeHidden();
  await expect(draft).toHaveValue('项目切换不丢草稿');
  const reads = directoryReads;
  await openPicker();
  await expect(picker.locator('details')).not.toHaveAttribute('open');
  expect(directoryReads).toBe(reads);
  expect(creations).toBe(0);
});

test('配色随系统实时切换且首页与全屏编辑器在320px均不横向溢出', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect.poll(() => page.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(255, 255, 255)');
  await page.screenshot({path:info.outputPath('home-light.png'),animations:'disabled'});
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(0, 0, 0)');
  await page.getByRole('button', { name: '开始新任务', exact: true }).click();
  await page.screenshot({path:info.outputPath('editor-dark.png'),animations:'disabled'});
  await page.getByRole('dialog', { name: '新对话', exact: true }).getByRole('textbox').fill('Long input '.repeat(120));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const send = page.getByRole('dialog', { name: '新对话', exact: true }).getByRole('button', { name: '发送', exact: true });
  await expect(send).toBeInViewport();
});

test('项目固定按名称排序，工具活动、停止和成功完成均不移动会话', async ({page,request,sessionsDir,workingDir,agentDir}, info) => {
  const prefix = uniqueSessionName(info,'stable-sort').replace(/\.jsonl$/,'');
  const alpha = join(workingDir,'Alpha'), zulu = join(workingDir,'Zulu');
  mkdirSync(alpha); mkdirSync(zulu);
  const make = (cwd:string, label:string, timestamp:string) => {
    const native = buildSession({cwd});
    native.entries[0].timestamp = timestamp;
    const id = writeSession(sessionsDir,prefix + '-' + label + '.jsonl',native.entries);
    return {...native,id};
  };
  const older = make(alpha,'older','2026-01-01T00:00:00Z');
  const newer = make(alpha,'newer','2026-01-02T00:00:00Z');
  make(zulu,'other','2026-01-03T00:00:00Z');
  let state = 'running';
  let completed = false;
  const owner = await openFixtureOwner({agentDir,sessionPath:join(sessionsDir,'--home-user-demo-project--',older.id),
    getState:() => ({state,completed})});
  try {
    await page.goto('/');
    await page.getByRole('searchbox').fill(prefix);
    const projects = page.locator('.remote-project-label strong');
    await expect(projects).toHaveText(['Alpha','Zulu']);
    const group = page.getByRole('region',{name:alpha,exact:true});
    const order = () => group.locator('a.remote-session').evaluateAll((links) => links.map((link) => new URL((link as HTMLAnchorElement).href).searchParams.get('id')));
    await expect.poll(order).toEqual([newer.id,older.id]);
    expect(await group.locator('.remote-project-label').innerText()).not.toContain(workingDir);
    for (let index=0;index<3;index++) {
      appendEntry(sessionsDir,older.id,{type:'message',id:'tool-' + index,parentId:index ? 'tool-' + (index-1) : older.lastId,
        timestamp:new Date().toISOString(),message:{role:'toolResult',toolCallId:'test-call',content:[{type:'text',text:'Tool activity ' + index}]}});
      owner.publish();
      await request.get('/api/sessions?q=' + encodeURIComponent(prefix));
      await expect.poll(order).toEqual([newer.id,older.id]);
    }
    state = 'idle'; owner.publish();
    await expect.poll(order).toEqual([newer.id,older.id]);
    const result = assistantTextEntry('tool-2','Stable completion');
    appendEntry(sessionsDir,older.id,result.entry);
    completed = true; owner.publish();
    await expect.poll(order).toEqual([newer.id,older.id]);
    await expect(projects).toHaveText(['Alpha','Zulu']);
    await owner.close();
    await page.reload();
    await page.getByRole('searchbox').fill(prefix);
    await expect.poll(order).toEqual([newer.id,older.id]);
    await expect(projects).toHaveText(['Alpha','Zulu']);
  } finally { await owner.close(); }
});

test('休眠历史会话首条消息前可选择模型、强度和速度，发送前先应用设置', async ({page,request,sessionsDir,workingDir,agentDir},info) => {
  const native = buildSession({cwd:workingDir});
  const id = writeSession(sessionsDir,uniqueSessionName(info,'model-popover'),native.entries);
  await page.route(/\/api\/project-options\?/, route => route.fulfill({json:{models:[
    {provider:'test',id:'other-model',name:'Other model',thinkingLevels:['off','low','medium','high']},
  ]}}));
  const ownerFile = join(agentDir,'pi-web','owners',id+'.json');
  await page.goto('/session?id=' + encodeURIComponent(id));
  await page.getByRole('button',{name:'模型设置',exact:true}).click();
  const picker = page.getByRole('dialog',{name:'模型设置',exact:true});
  await picker.getByRole('group',{name:'模型',exact:true}).getByRole('button',{name:'Other model test',exact:true}).click();
  await picker.getByRole('group',{name:'思考强度',exact:true}).getByRole('button',{name:'高',exact:true}).click();
  await picker.getByRole('group',{name:'速度',exact:true}).getByRole('button',{name:'快速',exact:true}).click();
  expect(existsSync(ownerFile)).toBe(false);
  await picker.getByRole('button',{name:'关闭模型设置',exact:true}).click();
  await page.getByRole('textbox',{name:'给 Pi 发消息…',exact:true}).fill('First message with selected settings');
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect(page.getByText('Stub reply: First message with selected settings',{exact:true})).toBeVisible();
  await expect.poll(async () => {
    const state = await (await request.get('/api/status?id=' + encodeURIComponent(id))).json();
    return [state.model,state.thinking,state.fast?.mode];
  }).toEqual(['other-model','high','fast']);
  await expect(page.locator('.model-trigger')).toContainText('Other model');
  await expect(page.locator('.model-trigger')).toContainText('高');
  await expect(page.locator('.model-fast')).toHaveAttribute('title','快速');
});

test('分页外项目仍显示未读，子任务完成不擅自加载或重排会话', async ({page,sessionsDir,workingDir,agentDir,request},info) => {
  const prefix = uniqueSessionName(info,'unloaded-completion').replace(/\.jsonl$/,'');
  const inboxPath = join(workingDir,'Inbox'), otherPath = join(workingDir,'Other');
  mkdirSync(inboxPath); mkdirSync(otherPath);
  const inbox = buildSession({cwd:inboxPath});
  inbox.entries[0].timestamp = '2026-01-01T00:00:00Z';
  const id = writeSession(sessionsDir,prefix + '-inbox.jsonl',inbox.entries);
  for (let index=0;index<31;index++) {
    const native = buildSession({cwd:otherPath});
    native.entries[0].timestamp = '2026-01-02T00:00:00Z';
    writeSession(sessionsDir,prefix + '-other-' + index + '.jsonl',native.entries);
  }
  let state = 'background', completed = false;
  const owner = await openFixtureOwner({agentDir,sessionPath:join(sessionsDir,'--home-user-demo-project--',id),getState:() => ({state,completed})});
  try {
    await page.goto('/');
    await page.getByRole('searchbox').fill(prefix);
    const project = page.getByRole('region',{name:inboxPath,exact:true});
    await expect(project.locator('.remote-project-unread')).toBeVisible();
    await expect(project.locator('.remote-session')).toHaveCount(0);
    const reply = assistantTextEntry(inbox.lastId,'Work done, awaiting children');
    appendEntry(sessionsDir,id,reply.entry); owner.publish();
    await expect.poll(async () => (await (await request.get('/api/session?id=' + encodeURIComponent(id))).json()).window.messages.at(-1).id).toBe(reply.id);
    await expect(project.locator('.remote-session')).toHaveCount(0);
    state = 'idle'; completed = true; owner.publish();
    await expect(project.locator('.remote-project-unread')).toBeVisible();
    await expect(project.locator('.remote-session')).toHaveCount(0);
    await expect(page.locator('.remote-project-label strong')).toHaveText(['Inbox','Other']);
  } finally { await owner.close(); }
});
