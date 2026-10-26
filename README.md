# wayread

Claude Code commands for understanding, reviewing and shipping a codebase. Each is a prompt you run inside Claude Code; they read your repo, publish results as Claude Artifacts where it helps, and pause for your review between steps.

Commands are namespaced `/wayread:<name>`. Run `/wayread:help` for the list, or `/wayread:runbook` if you are unsure where to start. `COMMANDS.md` is the full reference.

## What is in it

| Goal | Commands |
|---|---|
| Understand a codebase | `/wayread:system-overview`, `/wayread:intent`, `/wayread:orient` |
| Explain how one use case works end to end | `/wayread:trace "user resets their password"` (add `live` for a safe test-environment proof, `save` for a Markdown copy) |
| Map a product across several repos | `/wayread:product-map` (capability → repos/files, cross-repo links, verified against what's deployed; `change <description>` routes a planned change to the right repos) |
| Find and fix problems | `/wayread:blindspots`, `/wayread:harden`, `/wayread:fix-repo-cycle` |
| Build or refactor with review gates | `/wayread:explain-approach`, `/wayread:new-feature-cycle`, `/wayread:refactor-cycle` |
| See where a long conversation went, and restart what fell off | `/wayread:session-map latest` (a route map of the decisions, with branches for what was ruled out, parked, never pursued or left open; every node has a checked quote; copy a restart brief for any thread) |
| Write up close-out notes for sessions that ended without one | `/wayread:session-log-catchup` (three short paragraphs per pending session — where we started, where we ended, what is left — committed to git; also runs on its own at session start once configured) |
| Watch a multi-step change as it happens | `/wayread:live-plan "add rate limiting to login"` (plan graph, files touched, plan checked against git; also runs inside `new-feature-cycle` and `refactor-cycle`) |
| Find work that only exists on this machine | `/wayread:unpushed-work` (unpushed branches, stash entries, orphaned commits; `sweep <root>` for every repo under a folder; several other commands already run a quick version of this at the end of their own flow) |
| Review a change | `/wayread:code-review`, `/wayread:coverage`, `/wayread:guardrails`, `/wayread:explain-code-change`, `/wayread:catch-up`, `/wayread:change-full-review` |
| Release gate | `/wayread:ship-check` |
| Periodic health/security/usage checkups | `/wayread:code-health`, `/wayread:prod-audit`, `/wayread:usage-audit`, `/wayread:behavior-audit` (not tied to any specific change — run any time) |
| Pick for me | `/wayread:runbook` |

## Install
```
/plugin marketplace add tsushanth/wayread
/plugin install wayread@wayread-tools
```
For local development: `claude --plugin-dir /path/to/wayread`.

## Built on Claude's own tools

These commands are thin workflows around what Claude Code already has, not replacements for it:
- Review commands call the built-in `code-review` and `security-review` skills, then add repo sanity tests and a combined report.
- Commands that publish pages load the built-in `artifact-design` and `artifact-diagramming` skills.
- What is new here is the orchestration (overview, intent, blind spots, harden, ship gate) and `/wayread:trace`, which has no built-in equivalent.
- Missing a built-in on your setup? The command says so and carries on without it.

## Things to know
- These are prompts, not programs, with four exceptions: `/wayread:live-plan`, `/wayread:session-map`, `/wayread:session-log-catchup` and `/wayread:unpushed-work` do their rendering and checking in `scripts/live-plan.mjs`, `scripts/session-map.mjs`, `scripts/session-log.mjs` and `scripts/unpushed-work.mjs`, scripts with no dependencies that need Node 18+ and git. `node --test scripts/` runs their tests. Results depend on your model and your repo, and any finding should be checked against the code before you act on it.
- `/wayread:session-log-catchup` only runs automatically once a `SessionEnd`/`SessionStart` hook is configured in your own personal `~/.claude/settings.json` — it never ships as part of this plugin's own install, by design (see `docs/superpowers/specs/2026-10-26-session-close-summary-design.md`).
- `/wayread:unpushed-work` only reports; it never pushes, drops a stash, or runs `git gc`. Whether to push a given branch is your call.
- The plan graph changes only when it is republished, and step status is the model's own report. Only the plan-against-git file comparison comes from git.
- A session map is a model's reading of a conversation. Statuses are judgement calls; the quotes are checked against the transcript. Claude Code deletes session files after 30 days by default, and their format is internal and can change.
- Several commands publish Claude Artifacts and some can edit files or run tests in your repo when you ask them to. Read a command's file in `commands/` before running it on a repo you care about.
- `/wayread:trace` can run a live proof; it is instructed to use a safe test environment only, never production, but you are responsible for what it runs.
- Written for one person's workflow, shared as is. Issues and pull requests are welcome.

## License
MIT
