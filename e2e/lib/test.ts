import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { startServer, stopServer, type StartedServer } from './server';
import { launchTestBrowser } from './browser.mjs';

export const test = base.extend<{
  sessionsDir: string;
  agentDir: string;
  workingDir: string;
}, { server: StartedServer }>({
  browser: [async ({ playwright, browserName, launchOptions, headless, channel }, use) => {
    const host = await launchTestBrowser(playwright[browserName], {
      ...launchOptions, headless, ...(channel ? { channel } : {}),
    });
    try { await use(host.browser); } finally { await host.close(); }
  }, { scope: 'worker' }],
  server: [async ({ browser }, use) => {
    // Stop SSE/HTTP before WebKit shuts down its process and service workers.
    void browser;
    const server = await startServer();
    try {
      await use(server);
    } finally {
      await stopServer(server.child);
      await rm(server.agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  }, { scope: 'worker' }],
  baseURL: async ({ server }, use) => {
    await use(server.baseURL);
  },
  sessionsDir: async ({ server }, use) => {
    await use(server.sessionsDir);
  },
  agentDir: async ({ server }, use) => {
    await use(server.agentDir);
  },
  workingDir: async ({ agentDir }, use) => {
    await use(mkdtempSync(join(agentDir, 'cwd-')));
  },
});

export { expect };
