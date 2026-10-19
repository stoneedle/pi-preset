# Issue tracker: GitHub

Issues, specs, Wayfinder maps, decision tickets, and implementation tickets live in this fork's GitHub Issues.

- Repository: https://github.com/stoneedle/pi-web
- CLI: `gh`
- Current product spec: https://github.com/stoneedle/pi-web/issues/1

Always specify `--repo stoneedle/pi-web` for repository-scoped commands. This clone also has an upstream remote; its issue tracker is not this project's tracker.

Before implementing the current product, read Issue #1 in full, including its comments. Keep requirements and unresolved work in Issues rather than copying the spec into repository documents.

## Conventions

- Create: `gh issue create --repo stoneedle/pi-web --title "..." --body-file <path>`
- Read: `gh issue view <number> --repo stoneedle/pi-web --json number,title,url,state,body,labels,comments`
- List: `gh issue list --repo stoneedle/pi-web --state open --json number,title,url,body,labels,assignees`
- Comment: `gh issue comment <number> --repo stoneedle/pi-web --body-file <path>`
- Add/remove labels: `gh issue edit <number> --repo stoneedle/pi-web --add-label "..." --remove-label "..."`
- Resolve: publish the conclusion as a comment, then run `gh issue close <number> --repo stoneedle/pi-web`.

Use UTF-8 body files for multiline content.

When a skill says "publish to the issue tracker", create an Issue and return its title and clickable URL.

When a skill says "fetch the relevant ticket", read its complete body, labels, and comments, not just a list summary.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding operations

- Map: one Issue labelled `wayfinder:map`, holding the destination, notes, decisions so far, unresolved questions, and out-of-scope items.
- Child: link it with `gh issue edit <map> --repo stoneedle/pi-web --add-sub-issue <child>`. If sub-issues are unavailable, put `Part of #<map>` at the top of the child body and list it in the map.
- Types: `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, and `wayfinder:task`.
- Blocking: use native issue dependencies. Get the blocker's database ID with `gh api repos/stoneedle/pi-web/issues/<blocker> --jq .id`, then run `gh api --method POST repos/stoneedle/pi-web/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. If unavailable, use `Blocked by: #<number>, #<number>` in the child body.
- Frontier: select the first open child in map order with no open blockers and no assignee.
- Claim: the session's first tracker write is `gh issue edit <number> --repo stoneedle/pi-web --add-assignee @me`.
- Resolve: comment with the complete conclusion, close the child, and append a short conclusion plus link to the map's decisions.
