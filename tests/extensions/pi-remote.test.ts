import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import remote from "../../.pi/extensions/pi-remote.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.unstubAllEnvs();
});

it("routes authenticated controls to the same context and revokes ownership on session switch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-remote-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  mkdirSync(join(root, "sessions"));
  const handlers = new Map<string, Function[]>();
  const sendUserMessage = vi.fn();
  const pi = {
    on: (event: string, callback: Function) =>
      handlers.set(event, [...(handlers.get(event) || []), callback]),
    sendUserMessage,
    getThinkingLevel: () => "high",
    getCommands: () => [
      { name: "skill:memory", description: "memory", source: "skill" },
      { name: "reload", source: "extension" },
    ],
    setModel: vi.fn(async () => true),
    setThinkingLevel: vi.fn(),
  };
  remote(pi as any);
  const emit = async (event: string, context?: unknown) => {
    for (const handler of handlers.get(event) || []) await handler({}, context);
  };
  cleanups.push(async () => {
    await emit("session_shutdown");
    rmSync(root, { recursive: true, force: true });
  });
  const makeContext = (id: string) => ({
    mode: "tui",
    isIdle: () => false,
    cwd: root,
    abort: vi.fn(),
    model: { id: "model", provider: "test" },
    getContextUsage: () => ({ tokens: 42, contextWindow: 100, percent: 42 }),
    modelRegistry: { find: () => ({ id: "model", provider: "test" }) },
    sessionManager: {
      getSessionFile: () => join(root, "sessions", id + ".jsonl"),
      getSessionId: () => id,
      getBranch: () => [],
    },
  });
  expect(existsSync(join(root, "pi-web", "owners"))).toBe(false);
  const first = makeContext("first");
  await emit("session_start", first);
  const file = join(root, "pi-web", "owners", "first.jsonl.json");
  const owner = JSON.parse(readFileSync(file, "utf8"));
  const url = `http://127.0.0.1:${owner.port}/remote`;
  const call = (body: unknown, extraHeaders: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + owner.token, ...extraHeaders },
      body: JSON.stringify(body),
    });
  expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
  expect(
    (
      await call(
        { action: "state", sessionId: "first" },
        { Origin: "https://untrusted.test" },
      )
    ).status,
  ).toBe(401);
  expect((await call({ action: "state", sessionId: "wrong" })).status).toBe(
    409,
  );
  const result = await call({
    action: "send",
    sessionId: "first",
    chat: { message: "change direction", images: [], delivery: "steer" },
  });
  expect(result.status).toBe(200);
  expect((await result.json()).status).toBe("accepted");
  expect(sendUserMessage).toHaveBeenCalledWith("change direction", {
    deliverAs: "steer",
    expandPromptTemplates: true,
  });
  await call({ action: "abort", sessionId: "first" });
  expect(first.abort).toHaveBeenCalledOnce();
  const commands = await (
    await call({ action: "commands", sessionId: "first" })
  ).json();
  expect(
    commands.commands.map((command: { name: string }) => command.name),
  ).toEqual(["skill:memory"]);
  const second = makeContext("second");
  await emit("session_start", second);
  expect(existsSync(file)).toBe(false);
  expect(existsSync(join(root, "pi-web", "owners", "second.jsonl.json"))).toBe(
    true,
  );
  await expect(
    call({
      action: "send",
      sessionId: "first",
      chat: { message: "stale", delivery: "steer" },
    }),
  ).rejects.toThrow();
  expect(sendUserMessage).toHaveBeenCalledTimes(1);
});
