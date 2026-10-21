import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import type { ServerState } from "./paths";

function readState(): ServerState {
  const state = process.env.PI_WEB_E2E_SERVER;
  if (!state) throw new Error("Playwright global setup did not start the server");
  return JSON.parse(state);
}

export const test = base.extend<{
  sessionsDir: string;
  agentDir: string;
  workingDir: string;
}>({
  baseURL: async ({}, use) => {
    await use(readState().baseURL);
  },
  sessionsDir: async ({}, use) => {
    await use(readState().sessionsDir);
  },
  agentDir: async ({}, use) => {
    await use(readState().agentDir);
  },
  workingDir: async ({ agentDir }, use) => {
    await use(mkdtempSync(join(agentDir, "cwd-")));
  },
});

export { expect };
