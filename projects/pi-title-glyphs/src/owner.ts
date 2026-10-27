import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { titleInput, type SessionTitle } from "./session-title.ts";

export type TitleOwner = {
  local: boolean;
  initialize(text: string): Promise<string | undefined>;
  rename(name: string): Promise<string>;
  close(): Promise<void>;
};

type Registration = { pid: number; port: number; token: string; sessionId: string };

function readRegistration(file: string): Registration {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || !Number.isInteger(value.pid) || value.pid < 1
    || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token)
    || typeof value.sessionId !== "string") throw new Error("Invalid title owner registration.");
  return value;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function remoteOwner(registration: Registration): TitleOwner {
  async function send(operation: "initialize" | "rename", value: string): Promise<string | undefined> {
    const response = await fetch(`http://127.0.0.1:${registration.port}/title`, {
      method: "POST",
      headers: { authorization: `Bearer ${registration.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: registration.sessionId, operation, value }),
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json() as { name?: string; error?: string };
    if (!response.ok) throw new Error(result.error || `Title owner returned HTTP ${response.status}.`);
    return result.name;
  }
  return {
    local: false,
    initialize: (text) => send("initialize", titleInput(text)),
    rename: async (name) => (await send("rename", name))!,
    close: async () => {},
  };
}

/** Publishes one session's naming owner for pi-web and other Pi views of that session. */
export async function openTitleOwner(agentDir: string, ctx: ExtensionContext, title: SessionTitle): Promise<TitleOwner> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return {
    local: true,
    initialize: async (text) => title.initialize(text),
    rename: async (name) => title.rename(name),
    close: async () => {},
  };
  const directory = path.join(agentDir, "extension-data", "pi-title-glyphs", "owners");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${path.basename(sessionFile)}.json`);
  if (fs.existsSync(file)) {
    const current = readRegistration(file);
    if (alive(current.pid)) return remoteOwner(current);
    fs.unlinkSync(file);
  }

  const token = randomBytes(32).toString("hex");
  const sessionId = ctx.sessionManager.getSessionId();
  let closed = false;
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const reply = (status: number, value: object) => {
      response.writeHead(status);
      response.end(JSON.stringify(value));
    };
    if (request.method !== "POST" || request.url !== "/title") return reply(404, { error: "Unknown title operation." });
    if (request.headers.authorization !== `Bearer ${token}`) return reply(403, { error: "Invalid title owner token." });
    try {
      request.setEncoding("utf8");
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 128 * 1024) return reply(413, { error: "Title request is too large." });
      }
      const input = JSON.parse(body);
      if (closed || input.sessionId !== sessionId) return reply(409, { error: "The title owner no longer holds this session." });
      if (typeof input.value !== "string" || !["initialize", "rename"].includes(input.operation)) {
        return reply(400, { error: "Expected a title initialize or rename request." });
      }
      const name = input.operation === "initialize" ? title.initialize(input.value) : title.rename(input.value);
      reply(200, { name });
    } catch (error) {
      reply(400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const port = (server.address() as import("node:net").AddressInfo).port;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, port, token, sessionId }), { mode: 0o600 });
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = readRegistration(file);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!alive(current.pid)) throw new Error("The title owner exited during registration.");
      return remoteOwner(current);
    }
  } catch (error) {
    server.close();
    throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return {
    local: true,
    initialize: async (text) => title.initialize(text),
    rename: async (name) => title.rename(name),
    close: async () => {
      if (closed) return;
      closed = true;
      if (fs.existsSync(file) && readRegistration(file).token === token) fs.unlinkSync(file);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
