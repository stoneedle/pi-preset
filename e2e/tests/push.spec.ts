import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test, expect } from "../lib/test";
import { buildSession, uniqueSessionName, writeSession } from "../lib/sessions";

test("notification availability is honest and opening settings never subscribes", async ({ page }) => {
  const subscriptions: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/push/subscription")) subscriptions.push(request.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "通知", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "通知", exact: true });
  const supported = await page.evaluate(() => isSecureContext && "Notification" in window && "PushManager" in window && "serviceWorker" in navigator);
  if (!supported) {
    await expect(dialog).toContainText("网页推送需要 HTTPS 和支持的浏览器");
    await expect(dialog.getByRole("button", { name: "为此浏览器启用" })).toHaveCount(0);
  } else if (await page.evaluate(() => Notification.permission === "denied")) {
    await expect(dialog).toContainText("通知已被阻止");
    await expect(dialog.getByRole("button", { name: "为此浏览器启用" })).toHaveCount(0);
  } else {
    await expect(dialog.getByRole("button", { name: "为此浏览器启用" })).toBeEnabled();
    await expect(dialog).toContainText("此浏览器的通知已关闭");
  }
  expect(subscriptions).toEqual([]);
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  const pngs = manifest.icons.filter((icon: any) => icon.type === "image/png");
  expect(pngs).toHaveLength(3);
  for (const icon of pngs) {
    const response = await page.request.get(icon.src);
    expect(response.headers()["content-type"]).toBe("image/png");
    const bytes = await response.body();
    expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(icon.sizes);
  }
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("subscription UI handles explicit permission, metadata-only setup, test acceptance and disable (controlled browser Push API)", async ({ page, sessionsDir, workingDir }, info) => {
  const serverKey = createECDH("prime256v1"); serverKey.generateKeys();
  const receiver = createECDH("prime256v1"); receiver.generateKeys();
  const value = { endpoint: `https://fcm.googleapis.com/test/${randomUUID()}`, keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
  let enabled = false, delivery = "", failure = "";
  const setups: Record<string, unknown>[] = [];
  await page.route(/\/api\/push\/(config|subscription|status|test)$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    let result: Record<string, unknown>;
    if (path.endsWith("/config")) result = { publicKey: serverKey.getPublicKey().toString("base64url") };
    else if (path.endsWith("/status")) result = { subscribed: enabled, delivery, failure };
    else if (path.endsWith("/test")) { delivery = "pending"; result = { status: "queued" }; }
    else if (route.request().method() === "DELETE") { enabled = false; result = { subscribed: false }; }
    else { enabled = true; setups.push(route.request().postDataJSON()); result = { subscribed: true }; }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(result) });
  });
  await page.addInitScript((value) => {
    let permission = "default", active: any = null;
    (window as any).__pushPermissionRequests = 0;
    Object.defineProperty(window, "Notification", { configurable: true, value: class {
      static get permission() { return permission; }
      static async requestPermission() { (window as any).__pushPermissionRequests++; permission = "granted"; return permission; }
    } });
    Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
    const registration = { active: { postMessage(message: any, ports: MessagePort[]) { if (ports?.[0]) ports[0].postMessage({ saved: true }); } }, pushManager: {
      async getSubscription() { return active; },
      async subscribe(options: any) { active = { endpoint: value.endpoint, options, toJSON: () => value,
        async unsubscribe() { active = null; return true; } }; return active; },
    } };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      async register() { return registration; }, ready: Promise.resolve(registration), controller: null,
    } });
  }, value);
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, "push-ui"), entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.getByRole("textbox", { name: "给 Pi 发消息…" }).fill("Private unsent draft, never notification content");
  await page.getByRole("button", { name: "通知", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "通知", exact: true });
  await expect(dialog.getByRole("button", { name: "为此浏览器启用" })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__pushPermissionRequests)).toBe(0);
  await dialog.getByRole("button", { name: "为此浏览器启用" }).click();
  await expect(dialog).toContainText("此浏览器已订阅此主机");
  expect(await page.evaluate(() => (window as any).__pushPermissionRequests)).toBe(1);
  expect(setups).toHaveLength(1);
  expect(JSON.stringify(setups)).not.toContain("Private unsent draft");
  expect(Object.keys(setups[0])).toEqual(["subscription"]);
  await dialog.getByRole("button", { name: "发送测试通知" }).click();
  await expect(dialog).toContainText("已排队或等待重试");
  delivery = "accepted";
  await dialog.getByRole("button", { name: "刷新状态" }).click();
  await expect(dialog).toContainText("尚未确认设备是否收到");
  if (info.project.name === "Mobile Chrome" || info.project.name === "iPad") await page.screenshot({ path: info.outputPath("push-settings.png") });
  delivery = "pending"; failure = "http:503";
  await dialog.getByRole("button", { name: "刷新状态" }).click();
  await expect(dialog.getByRole("alert")).toContainText("HTTP 503");
  await dialog.getByRole("button", { name: "为此浏览器停用" }).click();
  await expect(dialog).toContainText("此浏览器的通知已关闭");
  await expect.poll(() => enabled).toBe(false);
  await expect(dialog.getByRole("button", { name: "为此浏览器启用" })).toBeEnabled();
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "给 Pi 发消息…" })).toHaveValue("Private unsent draft, never notification content");
});

test("actual service worker suppresses duplicate and already-read pushes without reading reply bodies", async ({ playwright, browserName, sessionsDir, workingDir, agentDir, baseURL }, info) => {
  test.skip(browserName !== "chromium", "Native push-event delivery is exposed by Chromium DevTools; other engines exercise capability/setup UI.");
  const profile = mkdtempSync(join(tmpdir(), "pi-web-push-browser-"));
  const use = info.project.use;
  const context = await playwright.chromium.launchPersistentContext(profile, {
    headless: true, channel: "chromium", viewport: use.viewport, userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor, isMobile: use.isMobile, hasTouch: use.hasTouch,
  });
  try {
  await context.grantPermissions(["notifications"], { origin: baseURL! });
  const page = await context.newPage();
  const { entries, lastId } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, "push-worker"), entries);
  const db = new DatabaseSync(join(agentDir, "pi-web.sqlite"));
  db.exec("PRAGMA busy_timeout=5000");
  const sessionId = (entries[0] as any).id;
  const eventId = randomUUID();
  db.prepare("INSERT INTO session_results(session_id,result_id,completed) VALUES(?,?,1)").run(sessionId, lastId);
  db.prepare("INSERT INTO push_events(event_key,value) VALUES(?,?)").run(eventId, JSON.stringify({ eventId, sessionId, kind: "completed", identity: lastId, file: id }));
  db.close();
  const contentRequests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/session") contentRequests.push(request.url()); });
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await context.newCDPSession(page);
  const workerErrors: string[] = [];
  cdp.on("ServiceWorker.workerErrorReported", (event) => workerErrors.push(event.errorMessage.errorMessage));
  expect(await page.evaluate(() => Notification.permission)).toBe("granted");
  let registrationId = "";
  cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
    const registration = registrations.find((item: any) => item.scopeURL === baseURL + "/" && !item.isDeleted);
    if (registration) registrationId = registration.registrationId;
  });
  await cdp.send("ServiceWorker.enable");
  await expect.poll(() => registrationId).not.toBe("");
  const tag = `test-${randomUUID()}`;
  const payload = { eventId, kind: "completed", sessionId: id, identity: lastId, sequence: 1, tag, title: "Pi reply ready", body: "Host and session metadata only" };
  const deliver = () => cdp.send("ServiceWorker.deliverPushMessage", { origin: baseURL!, registrationId, data: JSON.stringify(payload) });
  const notifications = () => page.evaluate(async (tag) => (await (await navigator.serviceWorker.ready).getNotifications({ tag })).map((item) => ({ title: item.title, body: item.body, data: item.data })), tag);
  await deliver();
  await expect.poll(async () => (await notifications()).length).toBe(1);
  expect((await notifications())[0].data.identity).toBe(lastId);
  expect(contentRequests).toEqual([]);
  await page.evaluate(async (tag) => { for (const item of await (await navigator.serviceWorker.ready).getNotifications({ tag })) item.close(); }, tag);
  await cdp.send("ServiceWorker.stopAllWorkers");
  await deliver();
  await expect.poll(async () => (await notifications()).length).toBe(0);
  const unread = await page.request.get(`/api/status?id=${encodeURIComponent(id)}`);
  expect((await unread.json()).unread).toBe(true);
  await page.request.post(`/api/session/acknowledge?id=${encodeURIComponent(id)}`, { data: { replyId: lastId } });
  payload.eventId = randomUUID(); payload.sequence = 2;
  const updated = new DatabaseSync(join(agentDir, "pi-web.sqlite"));
  updated.prepare("INSERT INTO push_events(event_key,value) VALUES(?,?)").run(payload.eventId, JSON.stringify({ eventId: payload.eventId, sessionId, kind: "completed", identity: lastId, file: id }));
  updated.close();
  await deliver();
  await expect.poll(async () => (await notifications()).length).toBe(0);
  expect(contentRequests).toEqual([]);
  expect(workerErrors).toEqual([]);
  await cdp.detach();
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  }
});
