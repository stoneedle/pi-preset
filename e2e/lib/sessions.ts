import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TestInfo } from "@playwright/test";

let sequence = 0;
const nextId = () => randomBytes(4).toString("hex");
export function uniqueSessionName(info: TestInfo, prefix = "mobile"): string {
  return `${prefix}-${info.project.name.replace(/\W+/g, "-").toLowerCase()}-${Date.now()}-${sequence++}.jsonl`;
}

export function assistantTextEntry(parentId: string, text: string) {
  const id = nextId();
  return {
    id,
    entry: {
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 40,
          output: 20,
          cacheRead: 60,
          cacheWrite: 0,
          totalTokens: 120,
          cost: { total: 0 },
        },
      },
    },
  };
}

export function buildSession({ cwd }: { cwd: string }) {
  const user = nextId();
  const assistant = assistantTextEntry(user, "Initial reply.");
  const entries: Record<string, unknown>[] = [
    {
      type: "session",
      version: 3,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd,
    },
    {
      type: "message",
      id: user,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: "Initial prompt." }],
      },
    },
    assistant.entry,
  ];
  return { entries, lastId: assistant.id };
}

export function writeSession(
  sessionsDir: string,
  name: string,
  entries: unknown[],
): string {
  const directory = join(sessionsDir, "--home-user-demo-project--");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, name),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  return name;
}

export function appendEntry(sessionsDir: string, name: string, entry: unknown) {
  appendFileSync(
    join(sessionsDir, "--home-user-demo-project--", name),
    JSON.stringify(entry) + "\n",
  );
}
