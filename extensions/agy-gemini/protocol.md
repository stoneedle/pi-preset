# agy adapter

The user-level `agy-gemini` Pi extension registers the permanent `gemini` role and an `agy` external-job provider with pi-subagents. The generic `subagent` tool owns delegation, completion notifications, public run references, and resume. The user-level `APPEND_SYSTEM.md` owns invocation policy; `collaboration.md` owns the shared collaboration identity and authority boundaries; `role.md` adds Gemini's exploration, design and human-facing writing remit; `adapter.mjs` owns agy CLI invocation, parsing, process lifetime, and conversation mapping. The extension injects the shared contract into the parent's prompt sections before each run and prepends the same contract to Gemini's registered system prompt.

## Execution

Each request launches agy once. Model and schema travel as immutable external-job runner options. Continuation uses plugin `resume`, provider `followUp`, and the stored agy conversation ID. A missing parent, mismatched workspace/model/schema, or unknown execution fails directly. Reattachment observes the same job and never dispatches another model request.

The adapter writes each complete UTF-8 task to the job's `task.md`. The CLI receives a short instruction to read that file in full; role, context and task length never grow the Windows command line. The adapter uses argv arrays with `shell:false`. Read-only inspection uses `--mode plan --dangerously-skip-permissions`; this relies on a trusted workspace and agy's planning policy. OS-level isolation requires its own boundary. Skill/slash expansion is disabled in print mode so relayed user text stays task data.

## Results

The current process exit and `AGY_ERROR:` diagnostics determine success. A historical recovered `ERROR` summary is accepted only after a successful current process outcome. Permission-denied operations, missing conversation IDs, incomplete status, and empty replies fail explicitly.

Structured replies validate against the requested JSON Schema. CLI-only root string fields `toolAction` and `toolSummary` are removed when the closed schema does not declare them. Adjacent JSON values are accepted only when the current schema and `structured_output` identify the finish result.

Full replies live in adapter-owned artifacts. The provider returns both the body and its artifact path. Native completion exposes the body as `results[0].output` and the exact original as `results[0].externalJob.resultArtifactPath`; the artifact preserves whitespace across the external runner's display trimming. The parent keeps the public run reference and never parses the CLI envelope.

## State and failure

SQLite records job identity, workspace, immutable execution contract, parent mapping, conversation ID, terminal state, and artifact path. Schema text and reply artifacts represent external protocol documents. The state store lives in the system temporary directory. A unique successor relation permits continuation only from a confirmed latest result; a failed/cancelled successor blocks its old parent reference. The extension registers the permanent role at session startup; Pi retains the original run's recovery descriptor and execution contract for resume after a host restart.

The adapter holds running process handles in the owning Pi runtime. On shutdown it terminates those owned local processes. A reattachment with a running database row but no owned process fails with `execution_unknown`; it cannot prove remote outcome. The plugin's external provider protocol has no cancel callback, so this extension connects public child-stop and observed owner-terminal events to its process controller.

Errors include invalid input/model/schema, missing CLI, launch failure, permission denial, CLI failure, conversation mismatch, incomplete/empty/ambiguous/schema-invalid result, deadline, and cancellation. They retain failure meaning rather than converting it to a new conversation or fallback model.
