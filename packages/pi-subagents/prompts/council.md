---
description: Run a bounded supervisor-mediated council of advisors and write a decision memo
argument-hint: "<question> [--advisors name,name] [--max-passes 2|3] [--scope ...] [--non-goals ...]"
---

Run a bounded, supervisor-mediated council on this question. The parent selects the roster, curates cross-advisor packets, judges evidence, and writes the final memo. Advisors do not talk directly or see peer transcripts by default.

Before orchestrating, call `subagent({action:"guide",options:{topic:"council"}})` to load the council-mode skill and its references. If only `subagents_enable` is available, call it once and use subagent on the next model request. Follow the guide's local model-profile routing and direct/tasks launch protocol.

Parse these flags as invocation conventions, not runtime options. Default --max-passes to 2 and accept only 2 or 3. When --advisors is given, use exactly those available executable names and report an unknown name clearly. Otherwise select two or three available model profiles under the local routing policy; never exceed four. A model profile can serve as an advisor without a separate council-specific copy.

Keep the same decision frame and evidence targets across advisors. Use fresh, read-only Pass 1 sessions, preserve their child runIds for cross-exam, respect external runner contracts and configured capacity, and wait through native completion notifications without polling. Use the council report contracts and final memo requirements. If the question is trivial or settled, answer directly instead of convening a council.

Question and options:

$@
