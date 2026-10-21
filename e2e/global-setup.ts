import { rm } from 'node:fs/promises';
import type { ServerState } from "./lib/paths";
import { startServer, stopServer } from "./lib/server";

export default async function globalSetup() {
  const { baseURL, agentDir, sessionsDir, child } = await startServer();
  const state: ServerState = {
    baseURL,
    agentDir,
    sessionsDir,
    pid: child.pid!,
  };
  process.env.PI_WEB_E2E_SERVER = JSON.stringify(state);
  return async () => {
    await stopServer(child);
    delete process.env.PI_WEB_E2E_SERVER;
    await rm(agentDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
  };
}
