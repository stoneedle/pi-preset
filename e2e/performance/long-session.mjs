import { createServer, request as httpRequest } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";
import { startServer, stopServer } from "../lib/server.ts";
import { BINARY, REPO_ROOT } from '../lib/paths.ts';
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  if (
    !["--session", "--baseline", "--output"].includes(args[index]) ||
    !args[index + 1] ||
    args[index + 1].startsWith("--")
  )
    throw new Error(
      "Expected --session <native.jsonl> --baseline <built-binary> [--output <report.json>]",
    );
}
const option = (key) => args[args.indexOf(key) + 1];
if (!args.includes("--session") || !args.includes("--baseline"))
  throw new Error(
    "Expected --session <native.jsonl> --baseline <built-binary>",
  );
const corpus = readFileSync(resolve(option("--session")));
const entries = corpus
  .toString("utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const fingerprint = createHash("sha256").update(corpus).digest("hex");
const baseline = resolve(option("--baseline"));
const profile = {
  latencyMs: 100,
  downloadBytesPerSecond: 256000,
  uploadBytesPerSecond: 64000,
  cpuSlowdown: 4,
  idleMs: 10000,
  throttleScope:
    "page CDP target; byte accounting covers the entire origin including worker requests",
};
const ordinary = entries.flatMap((entry) =>
  ["user", "assistant"].includes(entry.message?.role)
    ? typeof entry.message.content === "string"
      ? [entry.message.content]
      : (entry.message.content || [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
    : [],
);
const markers = [];
function collect(value, kind) {
  if (typeof value === "string" && value.length > 512) {
    const marker = value.slice(
      Math.floor(value.length / 2),
      Math.floor(value.length / 2) + 256,
    );
    if (!ordinary.some((text) => text.includes(marker)))
      markers.push({ marker, kind });
  } else if (value && typeof value === "object")
    for (const item of Object.values(value)) collect(item, kind);
}
for (const entry of entries) {
  for (const part of Array.isArray(entry.message?.content)
    ? entry.message.content
    : []) {
    if (part.type === "thinking") collect(part.thinking, "thinking");
    if (part.type === "toolCall") collect(part.arguments, "tool-input");
    if (part.type === "image") collect(part.data, "image");
    if (entry.message.role === "toolResult") collect(part.text, "tool-result");
  }
}

async function run(name, binary) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-traffic-"));
  const folder = join(root, "sessions", "--real-native-corpus--");
  mkdirSync(folder, { recursive: true });
  const id = "long-session.jsonl";
  const sessionPath = join(folder, id);
  writeFileSync(sessionPath, corpus);
  const token = randomBytes(24).toString("hex");
  const records = [],
    violations = [],
    responses = new Set();
  let server, proxy, context, session;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  let ordinaryBlocksChecked = 0;
  const nativeById = new Map(entries.map((entry) => [entry.id, entry]));
  const digest = (value) =>
    createHash("sha256").update(value).digest("hex").slice(0, 10);
  const keyFor = (url) => {
    const parsed = new URL(url, "http://localhost");
    for (const key of [...parsed.searchParams.keys()])
      parsed.searchParams.set(
        key,
        key === "id" ? "<session>" : digest(parsed.searchParams.get(key)),
      );
    return parsed.pathname + parsed.search;
  };
  const snapshot = () =>
    records.map((record) => ({ ...record, chunks: undefined }));
  const delta = (before, after) => {
    const old = new Map(before.map((record) => [record.id, record]));
    const changes = after
      .map((record) => ({
        ...record,
        bodyBytes: record.bodyBytes - (old.get(record.id)?.bodyBytes || 0),
        headerBytes:
          record.headerBytes - (old.get(record.id)?.headerBytes || 0),
        requestBodyBytes:
          record.requestBodyBytes - (old.get(record.id)?.requestBodyBytes || 0),
        requestHeaderBytes:
          record.requestHeaderBytes -
          (old.get(record.id)?.requestHeaderBytes || 0),
      }))
      .filter(
        (record) =>
          record.bodyBytes ||
          record.headerBytes ||
          record.requestBodyBytes ||
          record.requestHeaderBytes ||
          !old.has(record.id),
      );
    return {
      requestsStarted: after.length - before.length,
      encodedBodyBytes: changes.reduce(
        (sum, record) => sum + record.bodyBytes,
        0,
      ),
      httpHeaderBytes: changes.reduce(
        (sum, record) => sum + record.headerBytes,
        0,
      ),
      requestBodyBytes: changes.reduce(
        (sum, record) => sum + record.requestBodyBytes,
        0,
      ),
      requestHeaderBytes: changes.reduce(
        (sum, record) => sum + record.requestHeaderBytes,
        0,
      ),
      requests: changes,
    };
  };
  try {
    const manager = SessionManager.open(sessionPath);
    const cwd = manager.getCwd();
    const settingsManager = SettingsManager.inMemory({
      packages: [],
      extensions: [],
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: root,
      settingsManager,
      eventBus: createEventBus(),
      additionalExtensionPaths: [resolve(".pi/extensions/index.ts")],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(root, "models.sqlite"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    ({ session } = await createAgentSession({
      cwd,
      agentDir: root,
      modelRuntime,
      sessionManager: manager,
      settingsManager,
      resourceLoader: loader,
    }));
    await session.bindExtensions({ mode: "rpc" });
    assert.ok(
      readFileSync(sessionPath).subarray(0, corpus.length).equals(corpus),
      "native replay changed the original corpus bytes",
    );
    const initialNativeBytes = readFileSync(sessionPath).length;
    server = await startServer({
      agentDir: root,
      token,
      ...(binary ? { binary } : {}),
    });
    proxy = createServer((request, response) => {
      const record = {
        id: records.length,
        method: request.method,
        url: keyFor(request.url),
        started: performance.now(),
        bodyBytes: 0,
        headerBytes: 0,
        decodedBytes: 0,
        status: 0,
        finished: false,
        requestBodyBytes: 0,
        requestHeaderBytes: Buffer.byteLength(
          `${request.method} ${request.url} HTTP/1.1\r\n${request.rawHeaders.reduce((all, value, index) => all + (index % 2 ? value + "\r\n" : value + ": "), "")}\r\n`,
          "latin1",
        ),
      };
      const requestHash = createHash("sha256");
      request.on("data", (chunk) => {
        record.requestBodyBytes += chunk.length;
        requestHash.update(chunk);
      });
      request.on("end", () => {
        record.requestHash = requestHash.digest("hex").slice(0, 12);
      });
      records.push(record);
      if (
        /^\/(?:api\/session\/(?:block|image|file|preview)|preview\/)/.test(
          new URL(request.url, "http://localhost").pathname,
        )
      )
        violations.push({ url: record.url, kind: "unrequested-body-endpoint" });
      const upstream = httpRequest(
        server.baseURL + request.url,
        { method: request.method, headers: request.headers },
        (incoming) => {
          record.status = incoming.statusCode;
          record.headerBytes = Buffer.byteLength(
            `HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\n${incoming.rawHeaders.reduce((all, value, index) => all + (index % 2 ? value + "\r\n" : value + ": "), "")}\r\n`,
            "latin1",
          );
          const chunks = [];
          let sseTail = "";
          response.writeHead(incoming.statusCode, incoming.headers);
          responses.add(response);
          incoming.on("data", (chunk) => {
            record.bodyBytes += chunk.length;
            if (!request.url.startsWith("/events")) chunks.push(chunk);
            else {
              const text = sseTail + chunk.toString("utf8");
              for (const { marker, kind } of markers)
                if (
                  text.includes(marker) ||
                  text.includes(JSON.stringify(marker).slice(1, -1))
                )
                  violations.push({ url: record.url, kind });
              sseTail = text.slice(-512);
            }
          });
          incoming.on("end", () => {
            record.finished = true;
            record.durationMs = performance.now() - record.started;
            try {
              const raw = Buffer.concat(chunks);
              let decoded = raw;
              if (incoming.headers["content-encoding"] === "gzip")
                decoded = gunzipSync(raw);
              record.decodedBytes = decoded.length;
              const text = /json|html|javascript|text/.test(
                incoming.headers["content-type"] || "",
              )
                ? decoded.toString("utf8")
                : "";
              if (
                new URL(request.url, "http://localhost").pathname ===
                  "/api/session" &&
                incoming.statusCode === 200
              ) {
                const window = JSON.parse(text).window;
                record.windowMessages = window.messages.length;
                for (const message of window.messages) {
                  const original = nativeById.get(message.id)?.message?.content;
                  for (const block of message.blocks)
                    if (block.type === "text") {
                      const expected =
                        typeof original === "string"
                          ? original
                          : original?.[block.index]?.text;
                      if (block.text !== expected)
                        violations.push({
                          url: record.url,
                          kind: "ordinary-text-not-whole",
                        });
                      ordinaryBlocksChecked++;
                    }
                }
              }
              for (const { marker, kind } of markers)
                if (
                  text.includes(marker) ||
                  text.includes(JSON.stringify(marker).slice(1, -1))
                )
                  violations.push({ url: record.url, kind });
            } catch {
              violations.push({ url: record.url, kind: "invalid-http-body" });
            }
          });
          incoming.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      response.on("close", () => {
        responses.delete(response);
        upstream.destroy();
      });
      request.pipe(upstream);
    });
    await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${proxy.address().port}`;
    context = await chromium.launchPersistentContext(
      join(root, "browser-profile"),
      {
        ...devices["Pixel 5"],
        channel: "chromium",
        headless: true,
      },
    );
    await context.addCookies([
      { name: "pi_token", value: token, url: origin, sameSite: "Lax" },
    ]);
    const blocked = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        url.origin !== origin ||
        (request.method() !== "GET" &&
          url.pathname !== "/api/session/acknowledge")
      ) {
        blocked.push({
          method: request.method(),
          path: url.origin === origin ? url.pathname : "<external-origin>",
        });
        await route.abort();
      } else await route.continue();
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: profile.latencyMs,
      downloadThroughput: profile.downloadBytesPerSecond,
      uploadThroughput: profile.uploadBytesPerSecond,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", {
      rate: profile.cpuSlowdown,
    });
    await page.addInitScript(() => {
      window.__traffic = {
        firstContentMs: null,
        firstOrdinaryMs: null,
        readingControlsMs: null,
        firstSendReadyMs: null,
      };
      const inspect = () => {
        const now = performance.now();
        const main = document.querySelector(".remote-main");
        const textarea = document.querySelector('.remote-composer textarea');
        if (textarea && !textarea.dataset.readinessProbe) {
          textarea.dataset.readinessProbe = 'true';
          textarea.value = 'Local readiness probe; never sent.';
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const send = document.querySelector('.remote-composer button[type="submit"]');
        if (send && !send.disabled) window.__traffic.firstSendReadyMs ??= now;
        const visible = (element) => {
          const box = element.getBoundingClientRect(),
            region = main.getBoundingClientRect();
          return (
            box.height > 0 && box.top < region.bottom && box.bottom > region.top
          );
        };
        if (main && [...main.querySelectorAll("article")].some(visible))
          window.__traffic.firstContentMs ??= now;
        if (
          main &&
          [...main.querySelectorAll(".remote-markdown")].some(visible)
        )
          window.__traffic.firstOrdinaryMs ??= now;
        if (
          main &&
          main.scrollHeight > main.clientHeight &&
          document.querySelector(".remote-info summary")
        )
          window.__traffic.readingControlsMs ??= now;
        if (now < 60000) requestAnimationFrame(inspect);
      };
      requestAnimationFrame(inspect);
    });
    const before = snapshot();
    await page.goto(origin + "/session?id=" + id, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => window.__traffic.firstContentMs !== null,
      null,
      { timeout: 30000 },
    );
    if (name === 'current') await page.waitForFunction(() => window.__traffic.firstSendReadyMs !== null, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const initial = snapshot();
    const timings = await page.evaluate(() => ({
      ...window.__traffic,
      articles: document.querySelectorAll("article").length,
      totalElements: document.querySelectorAll("*").length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      composerEnabled: !document.querySelector(".remote-composer textarea")
        ?.disabled,
    }));
    const initialResult = delta(before, initial);
    await page.waitForTimeout(profile.idleMs);
    const idle = snapshot();
    const marker = "benchmark-update-" + randomUUID();
    for (let index = 0; index < 5; index++) {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: marker + "-" + index }],
        api: "benchmark",
        provider: "benchmark",
        model: "benchmark",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const id = manager.appendMessage(message);
      nativeById.set(id, { id, message });
      await session.extensionRunner.emit({ type: "message_end", message });
    }
    await page
      .getByText(marker + "-4", { exact: true })
      .waitFor({ timeout: 30000 });
    await page.waitForTimeout(1500);
    const update = snapshot();
    for (const response of responses)
      if (response.req.url.startsWith("/events")) response.destroy();
    await page.waitForTimeout(5500);
    const reconnect = snapshot();
    const history = page.getByRole("button", {
      name: "加载更早的消息",
      exact: true,
    });
    let historyResult = null;
    if (await history.count()) {
      const count = await page.locator("article").count();
      await history.click();
      await page.waitForFunction(
        (count) => document.querySelectorAll("article").length > count,
        count,
        { timeout: 30000 },
      );
      await page.waitForTimeout(500);
      historyResult = delta(reconnect, snapshot());
    }
    assert.equal(
      violations.length,
      0,
      "hidden real corpus bodies appeared in HTTP/SSE payloads",
    );
    const final = snapshot();
    const conversationRequests = final.filter((record) =>
      record.url.startsWith("/api/session?"),
    );
    let inFlight = 0,
      maxConcurrent = 0;
    const events = conversationRequests
      .flatMap((record) => [
        [record.started, 1],
        [record.started + (record.durationMs || 0), -1],
      ])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, change] of events) {
      inFlight += change;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
    }
    const duplicates = new Map();
    for (const record of final) {
      const key = `${record.method} ${record.url} ${record.requestHash}`;
      duplicates.set(key, (duplicates.get(key) || 0) + 1);
    }
    assert.ok(
      maxConcurrent <= 1,
      "competing conversation requests were observed",
    );
    assert.equal(
      blocked.length,
      0,
      "guarded requests would make the network comparison incomplete",
    );
    return {
      name,
      binary: binary ? "<baseline-abceb86>" : "<current>",
      corpusSHA256: fingerprint,
      nativeBytes: corpus.length,
      entries: entries.length,
      initialNativeBytes,
      originalPrefixUnchanged: true,
      ordinaryBlocksChecked,
      markersChecked: [...new Set(markers.map((item) => item.kind))],
      proxyCoverage:
        "all origin HTTP responses including service worker, manifest/static assets and unfinished SSE; compressed body bytes plus HTTP/1.1 response headers, not TCP/TLS overhead",
      runtimeEvidence:
        "actual Pi SDK/loader + merged native extension, original native corpus prefix unchanged; synthetic update burst uses native persistence/message events, no provider call or commercial timing claim",
      timings,
      initial: initialResult,
      idle: delta(initial, idle),
      update: delta(idle, update),
      reconnect: delta(update, reconnect),
      history: historyResult,
      maxConcurrentConversationRequests: maxConcurrent,
      fullWindowRequests: conversationRequests.filter(
        (record) => !/[?&](before|after)=/.test(record.url),
      ).length,
      emptyDeltaWindows: conversationRequests.filter(
        (record) => record.windowMessages === 0,
      ).length,
      repeatedRequests: [...duplicates]
        .filter(([, count]) => count > 1)
        .map(([request, count]) => ({ request, count })),
      hiddenBodyViolations: violations,
      guardedRequests: blocked,
      endToEndTotal: delta(before, final),
    };
  } finally {
    if (context) await context.close();
    for (const response of responses) response.destroy();
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise((done) => proxy.close(done));
    }
    if (server) await stopServer(server.child);
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown" });
      session.dispose();
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 100,
    });
  }
}

const binaryArtifact = (path) => {
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
const nativeRoot = join(REPO_ROOT, '.pi', 'extensions');
const result = {
  artifacts: { baseline: binaryArtifact(baseline), current: binaryArtifact(BINARY),
    nativeModules: Object.fromEntries(readdirSync(nativeRoot, { recursive: true }).filter((path) => path.endsWith('.ts')).sort()
      .map((path) => [String(path).replaceAll('\\', '/'), binaryArtifact(join(nativeRoot, path)).sha256])) },
  profile,
  dataset: {
    bytes: corpus.length,
    sha256: fingerprint,
    entries: entries.length,
  },
  runs: [],
};
for (const [name, binary] of [
  ["baseline", baseline],
  ["current", null],
])
  result.runs.push(await run(name, binary));
assert.deepEqual(binaryArtifact(BINARY), result.artifacts.current, 'current binary changed during measurement');
assert.deepEqual(binaryArtifact(baseline), result.artifacts.baseline, 'baseline binary changed during measurement');
const output = args.includes("--output") ? resolve(option("--output")) : null;
if (output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
}
console.log(
  JSON.stringify({
    output,
    profile,
    dataset: result.dataset,
    runs: result.runs.map((run) => ({
      name: run.name,
      timings: run.timings,
      ordinaryBlocksChecked: run.ordinaryBlocksChecked,
      initialBytes: run.initial.encodedBodyBytes + run.initial.httpHeaderBytes,
      idleBytes: run.idle.encodedBodyBytes + run.idle.httpHeaderBytes,
      updateBytes: run.update.encodedBodyBytes + run.update.httpHeaderBytes,
      reconnectBytes:
        run.reconnect.encodedBodyBytes + run.reconnect.httpHeaderBytes,
      maxConcurrentConversationRequests: run.maxConcurrentConversationRequests,
      fullWindowRequests: run.fullWindowRequests,
      guardedRequests: run.guardedRequests,
      violations: run.hiddenBodyViolations,
    })),
  }),
);
