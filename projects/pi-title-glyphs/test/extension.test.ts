import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Real host loader, event runner and session file; only terminal pixels are captured.
test("native lifecycle preserves the saved title across input, dialogs, rename and reopen", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptg-extension-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const manager = SessionManager.create(root, path.join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "修复字幕导入", timestamp: Date.now() });
  const titles: string[] = [];
  const errors: string[] = [];
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [] });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
    additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null,
    modelsStorePath: path.join(root, "models.sqlite"), allowModelNetwork: false, refreshOnCreate: false });
  const { session } = await createAgentSession({ cwd: root, modelRuntime, resourceLoader: loader,
    settingsManager, sessionManager: manager });
  t.after(async () => {
    await session.extensionRunner!.emit({ type: "session_shutdown" });
    session.dispose();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: "tui", uiContext: {
    setTitle: (title: string) => titles.push(title), notify: (message: string) => errors.push(message),
  } as any, onError: (error: any) => errors.push(String(error.error)) });
  assert.equal(manager.getSessionName(), "修复字幕导入");
  assert.equal(titles.at(-1), "✓ · 修复字幕导入");
  await session.extensionRunner!.emitInput("继续", undefined, "interactive");
  assert.equal(manager.getSessionName(), "修复字幕导入");
  await session.extensionRunner!.emit({ type: "agent_start" });
  assert.equal(titles.at(-1), "⏳ · 修复字幕导入");
  await session.extensionRunner!.emit({ type: "ui_prompt_start", kind: "confirm", title: "Confirm" } as any);
  assert.equal(titles.at(-1), "❗ · 修复字幕导入");
  await session.extensionRunner!.emit({ type: "ui_prompt_end", kind: "confirm" } as any);
  assert.equal(titles.at(-1), "✓ · 修复字幕导入");
  session.setSessionName("人工改名 👨‍👩‍👧‍👦");
  await session.extensionRunner!.emitInput("讨论 Gemini", undefined, "interactive");
  assert.equal(titles.at(-1), "✓ · 人工改名 👨‍👩‍👧‍👦");
  assert.equal(SessionManager.open(manager.getSessionFile()!).getSessionName(), "人工改名 👨‍👩‍👧‍👦");
  assert.deepEqual(errors, []);
});
