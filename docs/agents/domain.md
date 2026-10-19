# Domain Docs

This repo uses a single domain context.

## Reading

Before exploring a domain area, read root `GLOSSARY.md` if present and relevant decisions under `docs/adr/`.

If they do not exist, proceed silently. Create them lazily when terminology or an architectural decision is actually resolved.

Use glossary vocabulary consistently in Issues, designs, code, and tests. Surface conflicts with an existing ADR explicitly before proposing a different decision.

Continue following `AGENTS.md` for the existing architecture, design, and development documentation.

## Ownership

- `GLOSSARY.md`: shared, easily confused domain terminology; not behavior specifications or implementation details.
- `docs/adr/`: confirmed, surprising or hard-to-reverse architectural choices, with concise rationale.
- GitHub Issues: current requirements, open decisions, work items, and acceptance criteria.
- Code: implemented behavior; nearby comments explain reasons that the code cannot express clearly.

Link to the authoritative Issue instead of keeping another copy of its specification.
