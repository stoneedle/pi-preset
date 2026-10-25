import {
  spawn,
  spawnSync,
  execFile,
  type ChildProcess,
} from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from 'node:timers/promises';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { BINARY, FIXTURES_SESSIONS, REPO_ROOT, TMP_DIR } from "./paths.ts";

/** Directory holding the stub `pi` binary, prepended to PATH so chat works without real pi. */
const ownedAgents = new WeakMap<ChildProcess, string>();
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
  const agentDir = mkdtempSync(join(tmpdir(), "pi-web-e2e-"));
  const sessionsDir = join(agentDir, "sessions");
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

export async function startServer(options: { agentDir?: string; token?: string; binary?: string; nativeWorkers?: boolean; port?: number; env?: NodeJS.ProcessEnv } = {}): Promise<StartedServer> {
  if (options.binary) {
    if (!existsSync(options.binary)) throw new Error('Benchmark binary does not exist');
  } else ensureBinary();
  const { agentDir, sessionsDir } = options.agentDir
    ? { agentDir: options.agentDir, sessionsDir: join(options.agentDir, 'sessions') }
    : seedAgentDir();
  const port = options.port ?? await findFreePort();
  const baseURL = `http://127.0.0.1:${port}`;

  const child = spawn(options.binary || BINARY, ["-p", String(port), "-host", "127.0.0.1"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...options.env,
      PI_CODING_AGENT_DIR: agentDir,
      // Native integration opts in explicitly; browser fixtures keep the stub.
      PATH: options.nativeWorkers ? process.env.PATH ?? '' : `${STUB_BIN_DIR}${delimiter}${process.env.PATH ?? ""}`,
      PI_OFFLINE: options.nativeWorkers ? '1' : process.env.PI_OFFLINE,
      PI_WEB_E2E_NODE: process.execPath,
      PI_WEB_E2E_STUB: join(STUB_PI_DIR, "pi"),
      // Ensure auth is off for tests regardless of the dev's shell env.
      PI_WEB_TOKEN: options.token || "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ownedAgents.set(child, agentDir);
  child.stdout?.on("data", (d) => process.stdout.write(`[pi-web] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[pi-web] ${d}`));

  try {
    await Promise.race([
      waitForReady(baseURL),
      new Promise<never>((_, reject) => child.once("error", reject)),
    ]);
  } catch (error) {
    if (child.pid) await stopServer(child);
    throw error;
  }
  return { baseURL, agentDir, sessionsDir, child };
}

export async function stopServer(child: ChildProcess, { preserveWorkers = false } = {}): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', resolve));
    if (process.platform === 'win32') {
      const args = ['/PID', String(child.pid), ...(preserveWorkers ? [] : ['/T']), '/F'];
      const error = await new Promise<Error | null>((resolve) => execFile('taskkill', args, (error) => resolve(error)));
      if (error && child.exitCode === null && child.signalCode === null) {
        await Promise.race([exited, delay(2000, undefined, { ref: false })]);
        if (child.exitCode === null && child.signalCode === null) throw error;
      }
    } else child.kill('SIGTERM');
    await exited;
  }
  // A detached descendant may retain a pipe; process exit, not pipe EOF, owns teardown.
  child.stdout?.destroy();
  child.stderr?.destroy();
  // Detached test hosts can outlive an earlier Go process in a restart test.
  // Only registrations inside this helper's isolated agent directory are eligible.
  const agentDir = ownedAgents.get(child);
  if (preserveWorkers || !agentDir) return;
  const directory = join(agentDir, 'pi-web', 'workers');
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    let pid: number;
    try { pid = JSON.parse(readFileSync(join(directory, name), 'utf8')).pid; } catch { continue; }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve()));
    } else { try { process.kill(pid, 'SIGTERM'); } catch {} }
  }
}
