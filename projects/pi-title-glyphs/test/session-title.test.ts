import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionTitle } from "../src/session-title.ts";
import { openTitleOwner } from "../src/owner.ts";

function fixture(t: import("node:test").TestContext, model?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptg-name-"));
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "修复字幕导入后的时间轴错位", timestamp: Date.now() });
  const reply = Promise.withResolvers<any>();
  const notified = Promise.withResolvers<string>();
  const notices: string[] = [];
  let title: SessionTitle;
  const pi = { setSessionName: (name: string) => { manager.appendSessionInfo(name); title?.nameChanged(); } } as ExtensionAPI;
  const ctx = {
    cwd: root, sessionManager: manager,
    ui: { notify: (message: string) => { notices.push(message); notified.resolve(message); } },
    modelRegistry: { find: () => ({ provider: "test", id: "title" }), streamSimple: () => ({ result: () => reply.promise }) },
  } as unknown as ExtensionContext;
  title = new SessionTitle(pi, ctx, model);
  t.after(async () => {
    reply.resolve({ stopReason: "stop", content: [{ type: "text", text: "Unused" }] });
    await title.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, manager, pi, ctx, title, reply, notified, notices };
}

const response = (text: string) => ({ stopReason: "stop", content: [{ type: "text", text }] });

test("first input is saved once; follow-ups and reopen preserve it", async (t) => {
  const { manager, title } = fixture(t);
  const first = "修复字幕导入后的时间轴错位";
  assert.equal(title.initialize(first), first);
  title.initialize("继续");
  title.initialize("现在调整 Gemini 的角色");
  const reopened = SessionManager.open(manager.getSessionFile()!);
  assert.equal(reopened.getSessionName(), first);
  assert.equal(reopened.getEntries().filter((entry) => entry.type === "session_info").length, 1);
});

test("a successful background summary replaces only the initial name", async (t) => {
  const { manager, title, reply } = fixture(t, "test/title");
  const first = "修复字幕导入后的时间轴错位";
  assert.equal(title.initialize(first), first);
  title.initialize("继续");
  reply.resolve(response('"字幕导入时间轴修复"\nExtra commentary'));
  await reply.promise;
  assert.equal(manager.getSessionName(), "字幕导入时间轴修复");
  title.initialize("做其他任务");
  assert.equal(SessionManager.open(manager.getSessionFile()!).getSessionName(), "字幕导入时间轴修复");
});

test("manual rename wins over a late summary, even when it repeats the first name", async (t) => {
  const { manager, title, reply, notices } = fixture(t, "test/title");
  const first = "修复字幕导入后的时间轴错位";
  title.initialize(first);
  title.rename("人工命名 👨‍👩‍👧‍👦");
  title.rename(first);
  reply.resolve(response("迟到的模型标题"));
  await reply.promise;
  assert.equal(manager.getSessionName(), first);
  assert.equal(SessionManager.open(manager.getSessionFile()!).getSessionName(), first);
  assert.deepEqual(notices, []);
});

test("a native name change invalidates the pending model result", async (t) => {
  const { manager, pi, title, reply } = fixture(t, "test/title");
  title.initialize("First task");
  pi.setSessionName("Native /name");
  reply.resolve(response("Late model title"));
  await reply.promise;
  assert.equal(manager.getSessionName(), "Native /name");
});

test("persisted rename by another Pi instance rejects the late model result", async (t) => {
  const { manager, title, reply } = fixture(t, "test/title");
  title.initialize("First task");
  const other = SessionManager.open(manager.getSessionFile()!);
  other.appendSessionInfo("另一实例的手动名称");
  reply.resolve(response("Late automatic title"));
  await reply.promise;
  assert.equal(title.name, "另一实例的手动名称");
  assert.equal(SessionManager.open(manager.getSessionFile()!).getSessionName(), title.name);
});

test("model failure keeps the first name and reports the actual error", async (t) => {
  const { manager, title, reply, notified } = fixture(t, "test/title");
  title.initialize("First task");
  reply.resolve({ stopReason: "error", errorMessage: "Provider rejected the request", content: [] });
  assert.match(await notified.promise, /Provider rejected the request/);
  assert.equal(manager.getSessionName(), "First task");
});

test("closing the owner prevents a late summary from changing the session", async (t) => {
  const { manager, title, reply } = fixture(t, "test/title");
  title.initialize("First task");
  const closed = title.close();
  reply.resolve(response("Late title for old session"));
  await closed;
  assert.equal(SessionManager.open(manager.getSessionFile()!).getSessionName(), "First task");
});

test("web rename crosses the real local owner endpoint and persists in Pi", async (t) => {
  const { root, ctx, title, manager, reply } = fixture(t, "test/title");
  const owner = await openTitleOwner(root, ctx, title);
  t.after(() => owner.close());
  const peer = await openTitleOwner(root, ctx, title);
  assert.equal(owner.local, true);
  assert.equal(peer.local, false);
  await peer.initialize("First task");
  const named = await peer.rename("网页改名：字幕修复 🇨🇳");
  assert.equal(named, "网页改名：字幕修复 🇨🇳");
  reply.resolve(response("Late title"));
  await reply.promise;
  assert.equal(manager.getSessionName(), named);
  assert.equal(SessionManager.open(manager.getSessionFile()!).getSessionName(), named);
  await owner.close();
  assert.equal(fs.existsSync(path.join(root, "extension-data", "pi-title-glyphs", "owners", path.basename(manager.getSessionFile()!) + ".json")), false);
});
