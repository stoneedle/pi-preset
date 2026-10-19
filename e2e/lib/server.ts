import {
  spawn,
  spawnSync,
  execFile,
  type ChildProcess,
} from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { BINARY, FIXTURES_SESSIONS, REPO_ROOT, TMP_DIR } from "./paths";

/** Directory holding the stub `pi` binary, prepended to PATH so chat works without real pi. */
const STUB_PI_DIR = join(REPO_ROOT, "e2e", "lib", "stub-pi");
const STUB_BIN_DIR =
  process.platform === "win32" ? join(TMP_DIR, "stub-pi") : STUB_PI_DIR;

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine free port")));
      }
    });
  });
}

/** Build the binary only if it is missing. CI is expected to `make build` beforehand. */
export function ensureBinary(): void {
  if (existsSync(BINARY)) return;
  console.log(
    "[e2e] pi-web binary missing — running `make build` (CI should prebuild)...",
  );
  const res = spawnSync("make", ["build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    throw new Error(
      "`make build` failed; build the binary before running e2e tests",
    );
  }
}

/** Create a fresh temp agent dir seeded with the committed sanitized fixtures. */
export function seedAgentDir(): { agentDir: string; sessionsDir: string } {
  const agentDir = join(TMP_DIR, "agent");
  const sessionsDir = join(agentDir, "sessions");
  rmSync(agentDir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  mkdirSync(sessionsDir, { recursive: true });
  cpSync(FIXTURES_SESSIONS, sessionsDir, { recursive: true });
  return { agentDir, sessionsDir };
}

async function waitForReady(baseURL: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseURL + "/", { redirect: "manual" });
      if (res.status > 0) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `server did not become ready at ${baseURL}: ${String(lastErr)}`,
  );
}

export interface StartedServer {
  baseURL: string;
  agentDir: string;
  sessionsDir: string;
  child: ChildProcess;
}

export async function startServer(): Promise<StartedServer> {
  ensureBinary();
  const { agentDir, sessionsDir } = seedAgentDir();
  const port = await findFreePort();
  const baseURL = `http://127.0.0.1:${port}`;

  const child = spawn(BINARY, ["-p", String(port), "-host", "127.0.0.1"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      // Prepend stub `pi` so chat workers spawn the fake, never the real pi.
      PATH: `${STUB_BIN_DIR}${delimiter}${process.env.PATH ?? ""}`,
      PI_WEB_E2E_NODE: process.execPath,
      PI_WEB_E2E_STUB: join(STUB_PI_DIR, "pi"),
      // Ensure auth is off for tests regardless of the dev's shell env.
      PI_WEB_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[pi-web] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[pi-web] ${d}`));

  await Promise.race([
    waitForReady(baseURL),
    new Promise<never>((_, reject) => child.once("error", reject)),
  ]);
  return { baseURL, agentDir, sessionsDir, child };
}

export async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", resolve));
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) =>
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], (error) => {
        if (error && child.exitCode === null) reject(error);
        else resolve();
      }),
    );
  } else child.kill("SIGTERM");
  await closed;
}
