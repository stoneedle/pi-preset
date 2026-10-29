---
name: council-mode
description: Run a bounded supervisor-mediated advisor council. Use when the user asks for council mode, asks to convene advisors, debate a decision, cross-examine recommendations, or run /council.
---

# Council Mode

Council mode is parent-supervised advice for a material decision with real tradeoffs. It is not implementation authority, free-form agent chat, or transcript sharing. The parent selects the roster, relays curated claims, judges the evidence, and writes the memo. Advisors stay read-only and do not see peer transcripts by default.

Before launch, read `../pi-subagents/SKILL.md`, the local routing document it names, and `references/pass-contracts.md`.

## Roster

Choose two or three available model profiles through the local routing policy; never exceed four. Reuse those profiles as advisors for this task instead of requiring a separate agent name or persistent council persona. Give each advisor the same decision frame, scope, constraints, and evidence targets so model diversity is not confused with different questions.

When the user supplies an explicit roster, resolve exactly those current agent names. Report an unavailable name instead of silently replacing it. If fewer than two executable advisors are available, report the limitation and offer a single-agent consultation rather than presenting it as a council.

All council tasks are read-only, including tasks assigned to profiles with write tools. Use fresh sessions for independent Pass 1 reports. External-job agents participate only within their existing authorization and provider contract: include evidence they cannot read, request JSON text rather than native outputSchema, and honor their async and follow-up limits.

## Passes

Pass 1 is independent reports. Pass 2 is one cross-exam. Run Pass 3 only when `--max-passes 3` was requested and a material dispute can still be settled by evidence. Stop at convergence, the pass cap, infrastructure failure, or user interruption; do not add a round for polish or symmetry.

## Protocol

1. Write the brief: question, scope, non-goals, evidence targets, roster, known context modes, and pass cap. Tell the user the roster and cap.
2. Launch Pass 1 through the local direct or tasks API. A shared native batch may use `options.outputSchema` for the Pass 1 contract; external jobs receive that shape in task text instead. Keep native and external calls separate when their options differ, and respect configured capacity.
3. Continue independent work or yield for native notifications. Read each saved report, then return one aggregate receipt with advisor names, child runIds, context modes, and reports.
4. Synthesize agreements, disputed claims, missing proof, owner decisions, and at most five material relay claims per advisor. Tell the user completion, agreement and dispute counts, and whether Pass 2 is needed.
5. For Pass 2, resume each completed advisor with a curated challenge packet and the Pass 2 report contract. Use `action:"resume"`, its latest child runId, and message; replace the native output schema as described in the report contract, and do not resend agent or model. Record the newly returned runIds for a possible Pass 3. If a runner cannot resume, report that limitation; a fresh continuation with the prior report is labeled as such, not true retained-context cross-exam.
6. Write the final memo. Implementation requires a separate user request or existing implementation authorization; council advice does not grant it.

Use the report contracts to bound the work, not worktrees, acceptance gates, tool budgets, or execution-mode changes. Infrastructure failures follow the local delegation failure policy rather than triggering an improvised replacement roster.

## Memo

Convergence means no disputed claim remains that both affects the recommendation and can plausibly be settled by advisor evidence. Put unresolved choices with the user.

The memo states the question and scope; recommendation and rationale; accepted and rejected feedback with reasons; unresolved owner decisions; evidence and runIds; confidence and what would change the decision; roster, actual passes, context modes, and any fresh continuations. Identify advisors by their executable profile names.
