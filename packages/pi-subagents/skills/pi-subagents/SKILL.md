---
name: pi-subagents
description: |
  Technical guidance for authorized delegation through local model profiles:
  single tasks, parallel or sequential batches, background results, and follow-ups.
---

# Pi Subagents

The parent works directly unless the user or applicable instructions authorize delegation. Use the smallest bounded assignment that earns its overhead through evidence, independent judgment, specialization, parallelism, or isolation.

## Before launching

1. Read `~/.pi/agent/references/subagent-routing.md` for local model profiles, skill-role mappings, supported launch shapes, and follow-ups. A skill's generic role name is a responsibility, not an executable agent name. Dedicated skill agents retain their own contracts.
2. If only `subagents_enable` is active, call it once and use `subagent` on the next model request. Select an advertised agent; call `subagent({action:"list"})` only when the needed agent or runner is not already known.
3. Hand off an independently acceptable result: objective, cwd/ref, effective decisions, material pointers, edit/operation authority, acceptance evidence, expected output, and stop/ask conditions. Confirm the material and required tools are available before dispatch.
4. Use the local launch shape and defaults. Ordinary calls need no options. For an additional field or control action, inspect the current schema or `subagent({action:"guide",options:{topic:"tool-reference"}})` before composing it.

## Ownership and acceptance

Keep one writer per cwd/worktree. Use isolated worktrees when concurrent mutation requires them; managed `worktree:true` requires a clean source checkout, including untracked files. Do not create commits or discard another task's changes just to satisfy allocation.

Children own investigation, technical decisions, execution, and verification inside the handoff. The parent integrates their artifacts and evidence rather than repeating their work. Return fixes to the responsible owner. Use fresh sessions for independent review; retaining the same model profile does not require retaining the implementer's conversation.

Children do not delegate again unless nested fanout was explicitly authorized and their tools permit it. Pass a research or review contract to the child, not a request to orchestrate another workflow.

Tool availability is not operation authority. Preserve project rules and the task's read-only, test, service, commit, publication, and external-access boundaries. A launch receipt, successful command, or existing test file is not evidence that the requested product behavior passed.

## Completion and follow-up

Continue independent parent work after a background launch; otherwise yield for the native completion notification. Do not poll or call bg_wait for ordinary native subagents. Read saved results before accepting work or reporting completion.

Use the latest child runId for resume or live child steering. A workflow ID does not identify one of several children. External jobs use their registered runner contract; do not add native-only options to them.

Treat launch, extension, prompt-runtime, and child-tool setup failures as infrastructure blockers. Report the exact error, run state, and any partial changes; do not silently switch to another runner, CLI, or model. Correct a schema error using the declared contract, not guessed fields.

For council deliberation, read `../council-mode/SKILL.md`. For dedicated Impeccable agents or designer work, use the routing document's collaboration pointers. Package docs describe the complete framework; currently enabled features and tool declarations determine which of those APIs this installation accepts.
