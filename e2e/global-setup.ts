import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { STATE_FILE, TMP_DIR, type ServerState } from "./lib/paths";
import { startServer, stopServer } from "./lib/server";

export default async function globalSetup() {
  mkdirSync(TMP_DIR, { recursive: true });
  const { baseURL, agentDir, sessionsDir, child } = await startServer();
  const state: ServerState = {
    baseURL,
    agentDir,
    sessionsDir,
    pid: child.pid!,
  };
  writeFileSync(STATE_FILE, JSON.stringify(state));
  return async () => {
    try {
      await stopServer(child);
      rmSync(agentDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } finally {
      rmSync(STATE_FILE, { force: true });
    }
  };
}
