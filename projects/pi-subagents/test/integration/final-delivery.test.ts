import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { AssistantMessageEventStream, Type } from "@earendil-works/pi-ai";
import { createFinalDelivery, FINAL_DELIVERY_MESSAGE_TYPE } from "../../src/extension/final-delivery.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../../src/runs/background/async-job-tracker.ts";
import registerSubagentNotify from "../../src/runs/background/notify.ts";
import { registerExternalJobProvider } from "../../src/api/external-job-provider.ts";
import { DIRS, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_PROCESS_TERMINAL_EVENT } from "../../src/shared/types.ts";
import { readStatus } from "../../src/shared/utils.ts";
import { deliverStopRequest } from "../../src/runs/background/control-channel.ts";
import { createEventBus, makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { tempDir, mockPi, installSingleExecutionHooks } from "../support/single-execution-fixture.ts";

// Real parent loop, detached runner, artifacts, bridge service and notification ownership.
// Only model responses and the external provider are controlled test doubles; no network calls.
function harness(options: { external?: boolean; task?: string; extraCall?: boolean; timeoutMs?: number; agent?: string; activeWork?: boolean } = {}) {
	const hooks = new Map<string, Function[]>();
	const sent: Array<{ message: any; options: any }> = [];
	const events = createEventBus();
	const pi: any = {
		events,
		getSessionName: () => undefined,
		on(name: string, handler: Function) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
		sendMessage(message: any, options: any) { sent.push({ message, options }); parent.state.messages.push({ role: "custom", ...message, timestamp: Date.now() }); },
	};
	const state: any = { baseCwd: tempDir, currentSessionId: "session-123", asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), completionSeen: new Map(), completionOwnerId: "final-test-owner", widgetsSuspended: false };
	const tracker = createAsyncJobTracker(pi, state, DIRS.async, { widgetEnabled: false });
	const notifications = registerSubagentNotify(pi, state);
	events.on(SUBAGENT_ASYNC_STARTED_EVENT, tracker.handleStarted);
	events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, tracker.handleComplete);
	const completed: any[] = [];
	events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (event: any) => completed.push(event));
	const executor = createSubagentExecutor({
		pi, state, config: {}, asyncByDefault: false, tempArtifactsDir: tempDir,
		getSubagentSessionRoot: () => path.join(tempDir, "sessions"), expandTilde: (value: string) => value,
		discoverAgents: () => ({ agents: [makeAgent("writer", options.external ? { runner: { type: "external-job", provider: "final-test-provider" }, acceptanceRole: "read-only" } as never : { acceptanceRole: "read-only" })] }),
	});
	const delivery = createFinalDelivery(pi, { execute: (id, params, signal, update, ctx) => executor.executePublic(id, params, signal, update, ctx), hasActiveWork: () => options.activeWork === true });
	const params = { agent: options.agent ?? "writer", task: options.task ?? "Write the final answer", delivery: "final" as const, context: "fresh" as const, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) };
	const ctx: any = {
		...makeMinimalCtx(tempDir), hasPendingMessages: () => parent.hasQueuedMessages(),
		sessionManager: { ...makeMinimalCtx(tempDir).sessionManager, getBranch: () => parent.state.messages.map((message) => ({ type: "message", message })) },
	};
	const requests: any[] = [];
	const parent = new Agent({
		initialState: { model: { id: "scripted-parent", name: "Scripted test model", api: "openai-completions", provider: "test", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }, tools: [
			{ name: "subagent", label: "Subagent", description: "Test final delivery", parameters: Type.Object({}), execute: (id, args, signal, update) => delivery.execute(id, args, signal!, update, ctx) },
			{ name: "other", label: "Other", description: "Unrelated tool", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "other succeeded" }], details: {} }) },
		] },
		convertToLlm: (messages) => messages.map((message) => message.role === "custom" ? { role: "user" as const, content: message.content, timestamp: message.timestamp } : message) as any,
		afterToolCall: async ({ toolCall, result, isError }) => {
			let override: any;
			for (const handler of hooks.get("tool_result") ?? []) override = await handler({ toolName: toolCall.name, toolCallId: toolCall.id, ...result, isError }) ?? override;
			return override;
		},
		transformContext: async (messages) => {
			for (const handler of hooks.get("context") ?? []) messages = (await handler({ messages }))?.messages ?? messages;
			return messages;
		},
		streamFn: (_model, context) => {
			requests.push(structuredClone(context));
			const first = requests.length === 1;
			const message: any = { role: "assistant", api: "openai-completions", provider: "openai", model: "gpt-4o-mini", timestamp: Date.now(), stopReason: first ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content: first ? [
				{ type: "toolCall", id: "final-call", name: "subagent", arguments: params },
				...(options.extraCall ? [{ type: "toolCall", id: "other-call", name: "other", arguments: {} }] : []),
			] : [{ type: "text", text: "Parent continued the original request." }] };
			const stream = new AssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end();
			return stream;
		},
	});
	return { parent, requests, sent, completed, events, ctx, delivery, params, run: () => parent.prompt("Explain the original request"), dispose() { tracker.dispose(); notifications.dispose(); } };
}

function lastTool(parent: Agent): any {
	return parent.state.messages.find((message) => message.role === "toolResult" && message.toolCallId === "final-call");
}
function assertFallback(h: ReturnType<typeof harness>, expectedRequests = 2) {
	assert.equal(h.requests.length, expectedRequests);
	assert.equal(h.sent.length, 0);
	assert.equal(lastTool(h.parent)?.details.finalDelivery.status, "fallback");
	assert.equal(lastTool(h.parent)?.isError, true);
	const providerInput = JSON.stringify(h.requests[1]);
	assert.doesNotMatch(providerInput, /final-call|private partial|private provider failure/);
	assert.match(providerInput, /Explain the original request/);
	assert.match(providerInput, /Do not retry final delivery/);
}

describe("final child delivery", () => {
	installSingleExecutionHooks();

	it("delivers native child text once without another parent request", async () => {
		const body = "  # Original answer\n\nParagraph one.\n\nParagraph two.\n\n";
		mockPi.onCall({ output: body });
		const h = harness();
		try {
			await h.run();
			assert.equal(h.requests.length, 1, JSON.stringify(lastTool(h.parent)));
			assert.equal(mockPi.callCount(), 1);
			assert.equal(h.sent.length, 1);
			assert.equal(h.sent[0].message.customType, FINAL_DELIVERY_MESSAGE_TYPE);
			assert.equal(h.sent[0].message.content, fs.readFileSync(h.sent[0].message.details.outputPath, "utf-8"));
			assert.equal(h.sent[0].message.content, body.trimEnd(), "existing native acceptance processing owns artifact creation; delivery preserves that artifact exactly");
			assert.equal(h.sent[0].options.triggerTurn, false);
			assert.equal(lastTool(h.parent).details.finalDelivery.status, "delivered");
			assert.equal(lastTool(h.parent).details.results.length, 0, "tool rendering cannot duplicate the body");
			assert.equal(h.completed.length, 1);
			assert.equal(h.completed[0].awaitedByCaller, true);
			assert.equal(h.completed[0].parentWorkflowRunId, undefined);
		} finally { h.dispose(); }
	});

	it("reads full, untrimmed external-job artifacts instead of previews", async () => {
		const body = "\n  # External original\n\n" + "long paragraph\n".repeat(2500) + "\n";
		const artifactPath = path.join(tempDir, "original-provider-answer.md");
		fs.writeFileSync(artifactPath, body);
		let starts = 0;
		const unregister = registerExternalJobProvider({ name: "final-test-provider", start: () => { starts++; return { providerJobId: "original-job", state: "completed" }; }, status: () => ({ providerJobId: "original-job", state: "completed" }), reattach: () => ({ providerJobId: "original-job", state: "completed" }), result: () => ({ providerJobId: "original-job", state: "completed", output: "preview only", artifactPath }) });
		const h = harness({ external: true });
		try {
			await h.run();
			assert.equal(h.requests.length, 1, JSON.stringify(lastTool(h.parent)));
			assert.equal(starts, 1);
			assert.equal(h.sent.length, 1);
			assert.equal(h.sent[0].message.content, body);
			assert.equal(fs.readFileSync(h.sent[0].message.details.outputPath, "utf-8"), body);
			assert.equal(h.completed[0].awaitedByCaller, true);
			assert.equal(fs.existsSync(path.join(DIRS.results, `${h.completed[0].runId}.json`)), false);
		} finally { h.dispose(); unregister(); }
	});

	it("resumes the parent after launch failure without deleting audit history", async () => {
		const h = harness({ agent: "missing-agent" });
		try {
			await h.run();
			assertFallback(h);
			assert.equal(mockPi.callCount(), 0);
			assert.match(lastTool(h.parent).details.finalDelivery.error, /missing-agent/);
			const retry = await h.delivery.execute("final-call", h.params, new AbortController().signal, undefined, h.ctx);
			assert.equal(retry.details.finalDelivery?.status, "fallback");
			assert.equal(mockPi.callCount(), 0, "no automatic retry after fallback");
		} finally { h.dispose(); }
	});

	it("does not publish a failed provider's partial answer", async () => {
		const unregister = registerExternalJobProvider({ name: "final-test-provider", start: () => ({ providerJobId: "failed-job", state: "failed" }), status: () => ({ providerJobId: "failed-job", state: "failed" }), reattach: () => ({ providerJobId: "failed-job", state: "failed" }), result: () => ({ providerJobId: "failed-job", state: "failed", output: "private partial", failureMessage: "private provider failure" }) });
		const h = harness({ external: true });
		try { await h.run(); assertFallback(h); } finally { h.dispose(); unregister(); }
	});

	it("falls back on an empty original artifact", async () => {
		const artifactPath = path.join(tempDir, "empty-provider-answer.md");
		fs.writeFileSync(artifactPath, " \n\n");
		const unregister = registerExternalJobProvider({ name: "final-test-provider", start: () => ({ providerJobId: "empty-job", state: "completed" }), status: () => ({ providerJobId: "empty-job", state: "completed" }), reattach: () => ({ providerJobId: "empty-job", state: "completed" }), result: () => ({ providerJobId: "empty-job", state: "completed", artifactPath }) });
		const h = harness({ external: true });
		try { await h.run(); assertFallback(h); assert.match(lastTool(h.parent).details.finalDelivery.error, /empty text/); } finally { h.dispose(); unregister(); }
	});

	it("rejects mixed batches before launch and keeps the other tool's context", async () => {
		const h = harness({ extraCall: true });
		try { await h.run(); assertFallback(h); assert.equal(mockPi.callCount(), 0); assert.match(JSON.stringify(h.requests[1]), /other-call|other succeeded/); } finally { h.dispose(); }
	});

	it("cancels a waiting native child without publishing or resuming the parent", { timeout: 15000 }, async () => {
		mockPi.onCall({ hangUntilAbort: true });
		const h = harness();
		let asyncDir: string | undefined;
		const exited = new Promise<any>((resolve) => h.events.on(SUBAGENT_PROCESS_TERMINAL_EVENT, resolve));
		h.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (event: any) => { asyncDir = event.asyncDir; h.parent.abort(); });
		try {
			await h.run();
			assert.equal(h.requests.length, 1);
			assert.equal(h.sent.length, 0);
			assert.equal(lastTool(h.parent)?.details.finalDelivery.status, "cancelled");
			const proof = await exited;
			assert.notEqual(proof.state, "pending", "runner close has been observed, including early-start cancellation");
			assert.equal(readStatus(asyncDir!)?.state, "stopped");
		} finally { h.dispose(); }
	});

	it("honors an explicit child stop without falling back to the parent", { timeout: 15000 }, async () => {
		mockPi.onCall({ hangUntilAbort: true });
		const h = harness();
		const exited = new Promise<any>((resolve) => h.events.on(SUBAGENT_PROCESS_TERMINAL_EVENT, resolve));
		h.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (event: any) => deliverStopRequest({ asyncDir: event.asyncDir, source: "test-user-stop" }));
		try { await h.run(); await exited; assert.equal(h.requests.length, 1); assert.equal(h.sent.length, 0); assert.equal(lastTool(h.parent).details.finalDelivery.status, "cancelled"); } finally { h.dispose(); }
	});

	it("rejects final handoff while another child still owns work", async () => {
		const h = harness({ activeWork: true });
		try { await h.run(); assertFallback(h); assert.equal(mockPi.callCount(), 0); } finally { h.dispose(); }
	});

	it("preserves a user message queued while the child was writing", async () => {
		const h = harness({ external: true });
		const unregister = registerExternalJobProvider({ name: "final-test-provider", start: () => { h.parent.followUp({ role: "user", content: "New user request", timestamp: Date.now() }); return { providerJobId: "queued-job", state: "completed" }; }, status: () => ({ providerJobId: "queued-job", state: "completed" }), reattach: () => ({ providerJobId: "queued-job", state: "completed" }), result: () => ({ providerJobId: "queued-job", state: "completed", output: "Child answer not published" }) });
		try { await h.run(); assertFallback(h, 3); assert.match(JSON.stringify(h.requests.at(-1)), /New user request/); } finally { h.dispose(); unregister(); }
	});

	it("falls back when the original provider artifact cannot be read", async () => {
		const unregister = registerExternalJobProvider({ name: "final-test-provider", start: () => ({ providerJobId: "missing-file-job", state: "completed" }), status: () => ({ providerJobId: "missing-file-job", state: "completed" }), reattach: () => ({ providerJobId: "missing-file-job", state: "completed" }), result: () => ({ providerJobId: "missing-file-job", state: "completed", output: "preview only", artifactPath: path.join(tempDir, "missing-file.md") }) });
		const h = harness({ external: true });
		try { await h.run(); assertFallback(h); assert.match(lastTool(h.parent).details.finalDelivery.error, /ENOENT|no such file/); } finally { h.dispose(); unregister(); }
	});

	it("resumes the parent on the existing runner deadline", async () => {
		mockPi.onCall({ hangUntilAbort: true });
		const h = harness({ timeoutMs: 1500 });
		try { await h.run(); assertFallback(h); assert.match(lastTool(h.parent).details.finalDelivery.error, /timed out|timeout|deadline/i); } finally { h.dispose(); }
	});
});
