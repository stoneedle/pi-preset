import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "@playwright/test";
import { STATE_FILE, type ServerState } from "./paths";

function readState(): ServerState {
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
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
