import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SessionState } from "./session-state.ts";
import type { SessionTitle } from "./title/session-title.ts";
import { setFastState } from "./fast-state.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { basename, join } from "node:path";
import {
  mkdirSync,
  linkSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

type Registration = {
  pid: number;
  port: number;
  token: string;
  sessionId: string;
};

export async function openRemote(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  agentDir: string,
  state: SessionState,
  title: SessionTitle,
) {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
  const directory = join(agentDir, "pi-web", "owners");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, basename(sessionFile) + ".json");
  const sessionId = ctx.sessionManager.getSessionId();
  let server: Server | undefined;
  let registration: string | undefined;
  let token = "";
  let context: ExtensionContext | undefined = ctx;
  let generation = 0;
  let closed = false;
  let retiring = false;
  let pendingControls = 0;

  async function release() {
    generation++;
    if (registration) {
      try {
        if (JSON.parse(readFileSync(registration, "utf8")).token === token)
          unlinkSync(registration);
      } catch {
        /* Already removed during shutdown. */
      }
    }
    registration = undefined;
    const previous = server;
    server = undefined;
    if (previous)
      await new Promise<void>((resolve) => {
        previous.close(() => resolve());
        previous.closeAllConnections();
      });
  }

  async function claim() {
    if (closed || registration) return;
    try {
      const existing: Registration = JSON.parse(readFileSync(file, "utf8"));
      if (
        existing.sessionId !== sessionId ||
        !Number.isInteger(existing.pid) ||
        existing.pid <= 0 ||
        !Number.isInteger(existing.port) ||
        existing.port <= 0 ||
        existing.port > 65535 ||
        typeof existing.token !== "string" ||
        !existing.token
      )
        throw new Error("Invalid session owner");
      let alive = true;
      try {
        process.kill(existing.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) return;
      if (JSON.parse(readFileSync(file, "utf8")).token === existing.token)
        unlinkSync(file);
      else return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    token = randomBytes(32).toString("hex");
    const currentGeneration = generation;

    server = createServer(async (req, res) => {
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(body));
      };
      const supplied = Buffer.from(req.headers.authorization || "");
      const expected = Buffer.from("Bearer " + token);
      if (
        req.headers.origin ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        reply(401, { error: "unauthorized" });
        return;
      }
      if (
        req.method === "GET" &&
        req.url === `/snapshot?sessionId=${encodeURIComponent(sessionId)}`
      ) {
        if (
          !context ||
          currentGeneration !== generation ||
          context.sessionManager.getSessionId() !== sessionId
        ) {
          reply(409, { error: "session owner changed" });
          return;
        }
        state.reconcileReceipts();
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        });
        const send = () => {
          if (res.destroyed) return;
          if (res.writableLength > 64 * 1024) {
            res.destroy();
            return;
          }
          try {
            res.write(`data: ${JSON.stringify(state.snapshot())}\n\n`);
          } catch {
            res.destroy();
          }
        };
        const unsubscribe = state.subscribe(send);
        send();
        const timer = setInterval(() => {
          try {
            state.reconcileReceipts();
            res.write(":keepalive\n\n");
          } catch {
            res.destroy();
          }
        }, 15000);
        timer.unref();
        res.on("close", () => {
          clearInterval(timer);
          unsubscribe();
        });
        res.on("error", () => res.destroy());
        return;
      }
      if (req.method !== "POST" || req.url !== "/remote") {
        reply(404, { error: "not found" });
        return;
      }
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 34 << 20) {
            reply(413, { error: "request too large" });
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const current = context;
        if (
          !current ||
          retiring ||
          currentGeneration !== generation ||
          input.sessionId !== sessionId ||
          current.sessionManager.getSessionId() !== sessionId
        ) {
          reply(409, { error: "session owner changed" });
          return;
        }
        const mutation = [
          "send",
          "queue-remove",
          "abort",
          "model",
          "thinking",
          "speed",
          "compact",
        ].includes(input.action);
        if (mutation) pendingControls++;
        try {
          switch (input.action) {
            case "retire": {
              state.updateContext(current);
              const snapshot = state.snapshot();
              if (
                process.env.PI_WEB_MANAGED_WORKER !== "1" ||
                ctx.mode !== "rpc" ||
                snapshot.state !== "idle" ||
                snapshot.mainRunning ||
                snapshot.children !== 0 ||
                pendingControls > 0 ||
                !current.isIdle() ||
                current.hasPendingMessages() ||
                state.queue.count > 0
              ) {
                reply(409, { error: "Pi is not eligible for idle retirement" });
                return;
              }
              retiring = true;
              current.shutdown();
              reply(200, { status: "retiring" });
              return;
            }
            case "state":
              state.updateContext(current);
              reply(200, state.snapshot());
              return;
            case "acknowledge":
              state.acknowledge(input.replyId);
              reply(200, state.snapshot());
              return;
            case "initialize-title":
              reply(200, { name: title.initialize(input.text) });
              return;
            case "rename-title":
              reply(200, { name: title.rename(input.name) });
              return;
            case "queue":
              reply(200, input.itemId ? { item: state.queue.read(input.itemId) } : state.queue.list());
              return;
            case "queue-remove":
              if (typeof input.itemId !== "string")
                throw new Error("invalid queue operation");
              reply(200, state.queue.remove(input.itemId));
              return;
            case "send": {
              const chat = input.chat;
              if (!chat || typeof chat.message !== "string")
                throw new Error("invalid message");
              const images: {
                type: "image";
                data: string;
                mimeType: string;
              }[] = Array.isArray(chat.images) ? chat.images : [];
              if (
                images.some(
                  (image) =>
                    !image ||
                    image.type !== "image" ||
                    typeof image.data !== "string" ||
                    typeof image.mimeType !== "string" ||
                    !/^image\/(png|jpeg|gif|webp)$/.test(image.mimeType),
                )
              )
                throw new Error("invalid image");
              if (!chat.message.trim() && images.length === 0)
                throw new Error("empty message");
              const queued = chat.delivery === "followUp";
              if (chat.delivery && !queued) throw new Error("invalid message delivery");
              if (queued && current.isIdle())
                throw new Error("Pi 当前未在运行，请直接发送开始任务");
              if (queued && chat.message.startsWith("/") && pi.getCommands().some(
                (command) => command.source === "extension" && command.name === chat.message.slice(1).split(/\s/)[0],
              )) throw new Error("扩展命令不能排队，请直接执行命令");
              if (queued) {
                reply(200, state.queue.add(chat.message, images));
                return;
              }
              const content = images.length
                ? [{ type: "text" as const, text: chat.message }, ...images]
                : chat.message;
              pi.sendUserMessage(content, {
                deliverAs: "steer",
                expandPromptTemplates: true,
              });
              reply(200, { status: "accepted" });
              return;
            }
            case "abort":
              current.abort();
              reply(200, { status: "accepted" });
              return;
            case "model": {
              const model = current.modelRegistry.find(
                input.provider,
                input.modelId,
              );
              if (!model || !(await pi.setModel(model)))
                throw new Error("model unavailable or authentication missing");
              state.updateContext(current);
              reply(200, { status: "accepted" });
              return;
            }
            case "thinking":
              if (!current.model || !getSupportedThinkingLevels(current.model).includes(input.level))
                throw new Error("invalid thinking level");
              pi.setThinkingLevel(input.level);
              state.updateContext(current);
              reply(200, { status: "accepted" });
              return;
            case "speed":
              setFastState(pi, current.model, input.mode);
              state.updateContext(current);
              reply(200, { status: "accepted" });
              return;
            case "models":
              reply(200, {
                models: current.modelRegistry
                  .getAvailable()
                  .map((model) => ({
                    id: model.id,
                    name: model.name,
                    provider: model.provider,
                    thinkingLevels: getSupportedThinkingLevels(model),
                  })),
              });
              return;
            case "compact":
              if (typeof input.customInstructions !== "string") throw new Error("invalid compaction instructions");
              state.compact(input.customInstructions);
              reply(200, { status: "accepted" });
              return;
            case "commands":
              reply(200, {
                commands: pi.getCommands().map(({ name, description, source }) => ({ name, description, source })),
              });
              return;
            default:
              reply(400, { error: "unknown action" });
          }
        } finally {
          if (mutation) pendingControls--;
        }
      } catch (error) {
        if (!res.headersSent)
          reply(400, {
            error: error instanceof Error ? error.message : String(error),
          });
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      if (closed) {
        await release();
        return;
      }
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("no loopback address");
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(
          temporary,
          JSON.stringify({
            pid: process.pid,
            port: address.port,
            token,
            sessionId,
            hostId: process.env.PI_WEB_WORKER_HOST_ID,
          }),
          { mode: 0o600 },
        );
        try {
          linkSync(temporary, file);
          registration = file;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await release();
          return;
        }
      } finally {
        try {
          unlinkSync(temporary);
        } catch {}
      }
      server.on("error", (error) => {
        ctx.ui.notify(`Remote listener failed: ${error.message}`, "error");
      });
      server.unref();
    } catch (error) {
      await release();
      throw error;
    }
  }

  async function callTitle(
    action: "initialize-title" | "rename-title",
    input: { text: string } | { name: string },
  ) {
    if (closed) throw new Error("The session owner has closed.");
    if (registration)
      return "text" in input
        ? title.initialize(input.text)
        : title.rename(input.name);
    // A second instance may forward naming, but must never promote its old context.
    const owner: Registration = JSON.parse(readFileSync(file, "utf8"));
    if (
      owner.sessionId !== sessionId ||
      !Number.isInteger(owner.port) ||
      !owner.token
    )
      throw new Error("Session owner is unavailable.");
    const response = await fetch(`http://127.0.0.1:${owner.port}/remote`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId, action, ...input }),
      signal: AbortSignal.timeout(5000),
    });
    const reply = (await response.json()) as { name?: string; error?: string };
    if (!response.ok)
      throw new Error(
        reply.error || `Title owner returned HTTP ${response.status}`,
      );
    return reply.name;
  }

  await claim();
  return {
    async close() {
      closed = true;
      context = undefined;
      await release();
    },
    get local() {
      return registration !== undefined;
    },
    initialize: (text: string) => callTitle("initialize-title", { text }),
    rename: (name: string) => callTitle("rename-title", { name }),
    updateContext(ctx: ExtensionContext) {
      if (
        context?.sessionManager.getSessionId() ===
        ctx.sessionManager.getSessionId()
      )
        context = ctx;
    },
  };
}
