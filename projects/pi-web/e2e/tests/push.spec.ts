import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import { test, expect } from "../lib/test";
import { buildSession, uniqueSessionName, writeSession } from "../lib/sessions";

async function mockPushBrowser(page: Page, value: any, stall = "", existingKey = "") {
  await page.addInitScript(({ value, stall, existingKey }) => {
    let permission = existingKey || stall === "registration" ? "granted" : "default", active: any = null;
    const subscription = (options: any) => ({ endpoint: value.endpoint, options, toJSON: () => value,
      async unsubscribe() { (window as any).__pushUnsubscriptions++; active = null; return true; } });
    if (existingKey) active = subscription({ applicationServerKey: Uint8Array.from(atob(existingKey), character => character.charCodeAt(0)).buffer });
    const pending = new Promise<NotificationPermission>((resolve) => {
      (window as any).__grantPushPermission = () => { permission = "granted"; resolve("granted"); };
    });
    (window as any).__pushPermissionRequests = 0;
    (window as any).__pushRegistrations = 0;
    (window as any).__pushSubscriptions = 0;
    (window as any).__pushUnsubscriptions = 0;
    Object.defineProperty(window, "Notification", { configurable: true, value: class {
      static get permission() { return permission; }
      static async requestPermission() {
        (window as any).__pushPermissionRequests++;
        if (stall === "permission") return pending;
        permission = "granted";
        return permission;
      }
    } });
    Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
    const registration = { active: { postMessage(message: any, ports: MessagePort[]) { if (ports?.[0]) ports[0].postMessage({ saved: true }); } },
      addEventListener() {}, async update() {}, pushManager: {
        async getSubscription() { return active; },
        async subscribe(options: any) {
          (window as any).__pushSubscriptions++;
          if (stall === "subscription") await new Promise<void>((resolve) => {
            (window as any).__completePushSubscription = () => { stall = ""; resolve(); };
          });
          active = subscription(options);
          return active;
        },
      },
    };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      async register() {
        (window as any).__pushRegistrations++;
        if (stall === "registration") return new Promise(() => {});
        return registration;
      },
      async getRegistration() { return registration; },
      ready: Promise.resolve(registration), controller: null, addEventListener() {},
    } });
  }, { value, stall, existingKey });
}

test("notification permission that never answers releases controls and ignores a late grant", async ({ page }) => {
  await mockPushBrowser(page, {}, "permission");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/push/")) requests.push(request.url());
  });
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "通知", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "通知", exact: true });
  await dialog.getByRole("button", { name: "为此浏览器启用" }).click();
  await expect(dialog.getByRole("status")).toContainText("正在等待浏览器的通知授权");
  await page.clock.runFor(21000);
  await expect(dialog.getByRole("button", { name: "刷新状态" })).toBeEnabled();
  await expect(dialog.getByRole("alert")).toContainText("通知权限");
  await page.evaluate(() => (window as any).__grantPushPermission());
  await expect(dialog).not.toContainText("此浏览器的通知已启用");
  expect(requests).toEqual([]);
});

test("notification settings reuse the active worker even while registration is stalled", async ({ page }) => {
  await mockPushBrowser(page, {}, "registration");
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => (window as any).__pushRegistrations)).toBe(1);
  await page.getByRole("button", { name: "通知", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "通知", exact: true });
  await expect(dialog.getByRole("button", { name: "为此浏览器启用" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "刷新状态" })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__pushRegistrations)).toBe(1);
});

test("a stalled push service identifies the step, ignores late completion and allows explicit retry at 320px", async ({ page }) => {
  const receiver = createECDH("prime256v1"); receiver.generateKeys();
  const value = { endpoint: `https://fcm.googleapis.com/test/${randomUUID()}`, keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
  await mockPushBrowser(page, value, "subscription");
  let setups = 0;
  await page.route("**/api/push/subscription", async (route) => {
    setups++;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ subscribed: true }) });
  });
  await page.setViewportSize({ width: 320, height: 440 });
  await page.clock.install();
  await page.goto("/");
  await page.getByRole("button", { name: "通知", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "通知", exact: true });
  await dialog.getByRole("button", { name: "为此浏览器启用" }).click();
  await expect(dialog.getByRole("status")).toContainText("正在连接浏览器推送服务");
  await expect.poll(() => page.evaluate(() => typeof (window as any).__completePushSubscription)).toBe("function");
  await page.screenshot({ path: test.info().outputPath("push-connecting-320.png") });
  await page.clock.runFor(21000);
  await expect(dialog.getByRole("alert")).toContainText("连接浏览器推送服务超时");
  await expect(dialog.getByRole("button", { name: "刷新状态" })).toBeEnabled();
  await page.evaluate(() => (window as any).__completePushSubscription());
  await expect(dialog.getByRole("status")).toContainText("无法验证浏览器订阅");
  expect(setups).toBe(0);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "刷新状态" }).click();
  await expect(dialog.getByRole("button", { name: "为此浏览器启用" })).toBeEnabled();
  await dialog.getByRole("button", { name: "为此浏览器启用" }).click();
  await expect(dialog.getByRole("status")).toContainText("此浏览器的通知已启用");
  expect(setups).toBe(1);
});

test("an existing browser subscription missing from the server is restored without reconnecting to the push service", async ({ page }) => {
  const key = createECDH("prime256v1"); key.generateKeys();
  const receiver = createECDH("prime256v1"); receiver.generateKeys();
  const value = { endpoint: `https://fcm.googleapis.com/test/${randomUUID()}`, keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
  await mockPushBrowser(page, value, "subscription", key.getPublicKey().toString("base64"));
  await page.route("**/api/push/config", route => route.fulfill({ json: { publicKey: key.getPublicKey().toString("base64url") } }));
  await page.goto("/");
  await page.getByRole("button", { name: "通知", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "通知", exact: true });
  await expect(dialog.getByRole("button", { name: "为此浏览器启用" })).toBeEnabled();
  await dialog.getByRole("button", { name: "为此浏览器启用" }).click();
  await expect(dialog.getByRole("status")).toContainText("此浏览器的通知已启用");
  expect(await page.evaluate(() => (window as any).__pushUnsubscriptions)).toBe(0);
  expect(await page.evaluate(() => (window as any).__pushSubscriptions)).toBe(0);
});

for (const reason of ["server-expired", "browser-expired", "key-changed"]) {
  test(`an existing ${reason} subscription is replaced instead of reused`, async ({ page }) => {
    const key = createECDH("prime256v1"); key.generateKeys();
    const oldKey = createECDH("prime256v1"); oldKey.generateKeys();
    const receiver = createECDH("prime256v1"); receiver.generateKeys();
    const value = { endpoint: `https://fcm.googleapis.com/test/${randomUUID()}`, keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
    await mockPushBrowser(page, value, "", (reason === "key-changed" ? oldKey : key).getPublicKey().toString("base64"));
    await page.route("**/api/push/config", route => route.fulfill({ json: { publicKey: key.getPublicKey().toString("base64url") } }));
    await page.route("**/api/push/status", route => route.fulfill({ json: { subscribed: reason !== "server-expired", failure: reason === "server-expired" ? "expired" : "" } }));
    await page.goto("/");
    if (reason === "browser-expired") await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration!.pushManager.getSubscription();
      Object.defineProperty(subscription, "expirationTime", { value: Date.now() - 1000 });
    });
    await page.getByRole("button", { name: "通知", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "通知", exact: true });
    await dialog.getByRole("button", { name: "为此浏览器启用" }).click();
    await expect(dialog.getByRole("status")).toContainText("此浏览器的通知已启用");
    expect(await page.evaluate(() => (window as any).__pushUnsubscriptions)).toBe(1);
    expect(await page.evaluate(() => (window as any).__pushSubscriptions)).toBe(1);
  });
}

test("stopping and retrying shares the outstanding browser connection and going offline stops waiting", async ({ page, context }) => {
  const receiver = createECDH("prime256v1"); receiver.generateKeys();
  const value = { endpoint: `https://fcm.googleapis.com/test/${randomUUID()}`, keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
  await mockPushBrowser(page, value, "subscription");
  let setups = 0;
  await page.route("**/api/push/subscription", async route => {
    setups++;
    await route.fulfill({ json: { subscribed: true } });
  });
  await page.setViewportSize({ width: 320, height: 440 });
  await page.goto("/");
  await page.getByRole("button", { name: "通知", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "通知", exact: true });
  await dialog.getByRole("button", { name: "为此浏览器启用" }).click();
  await expect(dialog.getByRole("status")).toContainText("正在连接浏览器推送服务");
  await dialog.getByRole("button", { name: "停止等待" }).click();
  await expect(dialog.getByRole("button", { name: "刷新状态" })).toBeEnabled();
  await dialog.getByRole("button", { name: "为此浏览器启用" }).click();
  await expect(dialog.getByRole("status")).toContainText("正在连接浏览器推送服务");
  expect(await page.evaluate(() => (window as any).__pushSubscriptions)).toBe(1);
  await context.setOffline(true);
  await expect(dialog.getByRole("button", { name: "刷新状态" })).toBeEnabled();
  await page.evaluate(() => (window as any).__completePushSubscription());
  await expect(dialog.getByRole("status")).not.toContainText("此浏览器的通知已启用");
  expect(setups).toBe(0);
  await context.setOffline(false);
  await dialog.getByRole("button", { name: "为此浏览器启用" }).click();
  await expect(dialog.getByRole("status")).toContainText("此浏览器的通知已启用");
  expect(setups).toBe(1);
  expect(await page.evaluate(() => (window as any).__pushSubscriptions)).toBe(1);
});

test("closing stalled notification settings stops waiting and does not save a late subscription", async ({ page }) => {
  const receiver = createECDH("prime256v1"); receiver.generateKeys();
  const value = { endpoint: `https://fcm.googleapis.com/test/${randomUUID()}`, keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
  await mockPushBrowser(page, value, "subscription");
  let setups = 0;
  await page.route("**/api/push/subscription", async route => {
    setups++;
    await route.fulfill({ json: { subscribed: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "通知", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "通知", exact: true });
  await dialog.getByRole("button", { name: "为此浏览器启用" }).click();
  await expect(dialog.getByRole("status")).toContainText("正在连接浏览器推送服务");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "通知", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "刷新状态" })).toBeEnabled();
  await page.evaluate(() => (window as any).__completePushSubscription());
  await expect(dialog.getByRole("status")).not.toContainText("此浏览器的通知已启用");
  expect(setups).toBe(0);
});

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
  await mockPushBrowser(page, value);
  const { entries } = buildSession({ cwd: workingDir });
  const id = writeSession(sessionsDir, uniqueSessionName(info, "push-ui"), entries);
  await page.goto(`/session?id=${encodeURIComponent(id)}`);
  await page.getByRole("textbox", { name: "给 Pi 发消息…" }).fill("Private unsent draft, never notification content");
  await page.locator(".remote-info summary").click();
  await page.getByRole("button", { name: "通知", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "通知", exact: true });
  await expect(dialog.getByRole("button", { name: "为此浏览器启用" })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__pushPermissionRequests)).toBe(0);
  await dialog.getByRole("button", { name: "为此浏览器启用" }).click();
  await expect(dialog).toContainText("此浏览器的通知已启用");
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
  const payload = { eventId, kind: "completed", sessionId: id, identity: lastId, sequence: 1, tag, title: "Pi reply ready", body: "" };
  const deliver = () => cdp.send("ServiceWorker.deliverPushMessage", { origin: baseURL!, registrationId, data: JSON.stringify(payload) });
  const notifications = () => page.evaluate(async (tag) => (await (await navigator.serviceWorker.ready).getNotifications({ tag })).map((item) => ({ title: item.title, body: item.body, data: item.data })), tag);
  await deliver();
  await expect.poll(async () => (await notifications()).length).toBe(1);
  expect((await notifications())[0].data.identity).toBe(lastId);
  expect((await notifications())[0].body).toBe("");
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
