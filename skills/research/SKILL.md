---
name: research
description: Delegate primary-source research to a background agent and save cited findings as a Markdown file in the repo.
disable-model-invocation: true
---

In the parent session, delegate the research to a **background agent** using the local model-routing policy, so you keep working while it reads. When you are already the assigned research child, do the research directly rather than delegating again.

The researcher's job:

1. Investigate the question against **primary sources** (official docs, source code, specs, first-party APIs), not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
