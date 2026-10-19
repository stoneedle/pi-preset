import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { basename, join } from "node:path";
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export default function (pi: ExtensionAPI) {
  let server: Server | undefined;
  let registration: string | undefined;
  let token = "";
  let context: ExtensionContext | undefined;
  let generation = 0;

  async function close() {
    generation++;
    context = undefined;
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

  pi.on("session_start", async (_event, ctx) => {
    await close();
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
    const directory = join(getAgentDir(), "pi-web", "owners");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, basename(sessionFile) + ".json");
    try {
      const existing = JSON.parse(readFileSync(file, "utf8"));
      let alive = true;
      try {
        process.kill(existing.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) return;
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const fd = openSync(file, "wx", 0o600);
    token = randomBytes(32).toString("hex");
    registration = file;
    context = ctx;
    const currentGeneration = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    writeFileSync(
      fd,
      JSON.stringify({ pid: process.pid, port: 0, token, sessionId }),
    );
    closeSync(fd);

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
          currentGeneration !== generation ||
          input.sessionId !== sessionId ||
          current.sessionManager.getSessionId() !== sessionId
        ) {
          reply(409, { error: "session owner changed" });
          return;
        }
        switch (input.action) {
          case "state": {
            let cacheHit: number | null = null;
            const branch = current.sessionManager.getBranch();
            for (let i = branch.length - 1; i >= 0; i--) {
              const entry = branch[i];
              if (
                entry.type !== "message" ||
                entry.message.role !== "assistant"
              )
                continue;
              const usage = entry.message.usage;
              if (usage) {
                const total = usage.input + usage.cacheRead + usage.cacheWrite;
                cacheHit = total > 0 ? (usage.cacheRead / total) * 100 : null;
              }
              break;
            }
            reply(200, {
              model: current.model?.id,
              provider: current.model?.provider,
              thinking: pi.getThinkingLevel(),
              context: current.getContextUsage() ?? null,
              cacheHit,
              fast: null,
              mainRunning: !current.isIdle(),
            });
            return;
          }
          case "send": {
            const chat = input.chat;
            if (
              !chat ||
              typeof chat.message !== "string" ||
              !["steer", "followUp"].includes(chat.delivery)
            )
              throw new Error("invalid message");
            const images: { type: "image"; data: string; mimeType: string }[] =
              Array.isArray(chat.images) ? chat.images : [];
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
            const content = images.length
              ? [{ type: "text" as const, text: chat.message }, ...images]
              : chat.message;
            pi.sendUserMessage(content, {
              deliverAs: chat.delivery,
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
            reply(200, { status: "accepted" });
            return;
          }
          case "thinking":
            if (
              !["off", "minimal", "low", "medium", "high", "xhigh"].includes(
                input.level,
              )
            )
              throw new Error("invalid thinking level");
            pi.setThinkingLevel(input.level);
            reply(200, { status: "accepted" });
            return;
          case "models":
            reply(200, {
              models: current.modelRegistry
                .getAvailable()
                .map(({ id, name, provider }) => ({ id, name, provider })),
            });
            return;
          case "commands":
            reply(200, {
              commands: pi
                .getCommands()
                .filter((command) => command.source === "skill")
                .map(({ name, description }) => ({ name, description })),
            });
            return;
          default:
            reply(400, { error: "unknown action" });
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
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("no loopback address");
      writeFileSync(
        file,
        JSON.stringify({
          pid: process.pid,
          port: address.port,
          token,
          sessionId,
        }),
        { mode: 0o600 },
      );
      server.unref();
    } catch (error) {
      await close();
      throw error;
    }
  });

  const updateContext = (_event: unknown, ctx: ExtensionContext) => {
    if (
      context?.sessionManager.getSessionId() ===
      ctx.sessionManager.getSessionId()
    )
      context = ctx;
  };
  pi.on("agent_start", updateContext);
  pi.on("agent_settled", updateContext);
  pi.on("model_select", updateContext);
  pi.on("input", updateContext);
  pi.on("session_shutdown", close);
}
