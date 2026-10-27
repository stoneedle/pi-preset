import * as fs from "node:fs";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { Details } from "../shared/types.ts";
import { readStatus } from "../shared/utils.ts";

export const FINAL_DELIVERY_MESSAGE_TYPE = "subagent-final";
const FALLBACK_INSTRUCTION = "Final child delivery was unavailable for this request. Continue the original user request yourself, using the context before that attempt. Do not retry final delivery or use the failed child's partial output.";

type Execute = (id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((result: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>;

function fallbackCallIds(messages: AgentMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const details = message.details as Details | undefined;
		if (details?.finalDelivery?.status === "fallback") ids.add(message.toolCallId);
	}
	return ids;
}

/** Drop only failed final-call pairs from provider input, keeping their original session entries intact. */
function omitFailedFinalDelegations(messages: AgentMessage[], failed: ReadonlySet<string>): AgentMessage[] {
	if (!failed.size) return messages;
	return messages.flatMap((message): AgentMessage[] => {
		if (message.role === "toolResult" && failed.has(message.toolCallId)) return [];
		if (message.role !== "assistant") return [message];
		const content = message.content.filter((part) => part.type !== "toolCall" || !failed.has(part.id));
		if (!content.length) return [];
		return content.length === message.content.length ? [message] : [{ ...message, content }];
	});
}

function assertExclusiveCall(id: string, ctx: ExtensionContext): void {
	const assistant = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
	if (!assistant || assistant.type !== "message" || assistant.message.role !== "assistant") throw new Error("Final delivery requires a model tool-call batch.");
	const calls = assistant.message.content.filter((part) => part.type === "toolCall");
	if (calls.length !== 1 || calls[0]?.id !== id || calls[0]?.name !== "subagent") {
		throw new Error("Final delivery must be the only tool call in its batch; do not wrap it in another tool.");
	}
}

/** Original artifacts take precedence over runner previews, which may be trimmed or truncated. */
function originalOutput(result: AgentToolResult<Details>): { text: string; outputPath?: string } {
	const child = result.details.results[0];
	if (result.isError || result.details.results.length !== 1 || !child || child.exitCode !== 0 || child.stopped || child.timedOut || child.outputSaveError) {
		const reason = child?.error ?? result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
		throw new Error(reason || "Final-delivery child did not complete successfully.");
	}
	const externalJob = result.details.asyncDir ? readStatus(result.details.asyncDir)?.steps?.[0]?.externalJob : undefined;
	const outputPath = externalJob ? externalJob.resultArtifactPath : child.savedOutputPath ?? child.artifactPaths?.outputPath;
	if (externalJob && !outputPath) throw new Error("Final-delivery external job has no original text artifact.");
	const text = outputPath ? fs.readFileSync(outputPath, "utf-8") : child.finalOutput;
	if (typeof text !== "string" || !text.trim()) throw new Error("Final-delivery child returned empty text.");
	return { text, ...(outputPath ? { outputPath } : {}) };
}

/** Owns the user-facing handoff, not execution. The existing executor owns launch, waiting and cancellation. */
export function createFinalDelivery(pi: ExtensionAPI, options: { execute: Execute; hasActiveWork: () => boolean }) {
	let fallbackActive = false;
	let failedCalls: Set<string> | undefined;
	pi.on("before_agent_start", () => { fallbackActive = false; });
	pi.on("session_start", () => { fallbackActive = false; failedCalls = undefined; });
	// Pi derives canonical isError from rejection or this hook, not result.isError.
	pi.on("tool_result", (event) => {
		const status = (event.details as Details | undefined)?.finalDelivery?.status;
		if (event.toolName === "subagent" && (status === "fallback" || status === "cancelled")) return { isError: true };
	});
	pi.on("context", (event) => {
		// Restore audit markers once; ordinary turns then pay only a constant-time check.
		failedCalls ??= fallbackCallIds(event.messages);
		if (!failedCalls.size && !fallbackActive) return;
		const messages = omitFailedFinalDelegations(event.messages, failedCalls);
		if (fallbackActive) {
			return { messages: [...messages, { role: "custom" as const, customType: "subagent-final-fallback", content: FALLBACK_INSTRUCTION, display: false, timestamp: Date.now() }] };
		}
		return messages === event.messages ? undefined : { messages };
	});

	return {
		async execute(id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((result: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext): Promise<AgentToolResult<Details>> {
			let result: AgentToolResult<Details> | undefined;
			try {
				signal.throwIfAborted();
				if (fallbackActive) throw new Error("Final delivery already failed for this request; parent continuation owns the answer.");
				assertExclusiveCall(id, ctx);
				if (options.hasActiveWork() || ctx.hasPendingMessages()) throw new Error("Final delivery requires no other active children or queued messages.");
				result = await options.execute(id, params, signal, onUpdate, ctx);
				signal.throwIfAborted();
				const output = originalOutput(result);
				if (ctx.hasPendingMessages()) throw new Error("A message was queued while final delivery was waiting; resume the parent instead.");
				pi.sendMessage({ customType: FINAL_DELIVERY_MESSAGE_TYPE, content: output.text, display: true, details: { runId: result.details.runId, agent: params.agent, ...(output.outputPath ? { outputPath: output.outputPath } : {}) } }, { triggerTurn: false });
				return {
					...result,
					content: [{ type: "text", text: "Original child answer delivered." }],
					details: { ...result.details, results: [], finalDelivery: { status: "delivered", ...(output.outputPath ? { outputPath: output.outputPath } : {}) } },
					terminate: true,
				};
			} catch (error) {
				const cancelled = signal.aborted || result?.details.results.some((child) => child.stopped === true && child.timedOut !== true) === true;
				if (!cancelled) {
					fallbackActive = true;
					(failedCalls ??= new Set()).add(id);
				}
				return {
					...(result?.usage ? { usage: result.usage } : {}),
					content: [{ type: "text", text: cancelled ? "Final delivery cancelled." : "Final delivery unavailable; continue the original request yourself." }],
					isError: true,
					...(cancelled ? { terminate: true } : {}),
					details: { ...(result?.details ?? { mode: "single" as const }), results: [], finalDelivery: { status: cancelled ? "cancelled" : "fallback", error: error instanceof Error ? error.message : String(error) } },
				};
			}
		},
	};
}
