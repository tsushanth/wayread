# wayread

Claude Code commands for understanding, reviewing and shipping a codebase. Each is a prompt you run inside Claude Code; they read your repo, publish results as Claude Artifacts where it helps, and pause for your review between steps.

Commands are namespaced `/wayread:<name>`. Run `/wayread:help` for the list, or `/wayread:runbook` if you are unsure where to start. `COMMANDS.md` is the full reference.

## What is in it

| Goal | Commands |
|---|---|
| Understand a codebase | `/wayread:system-overview`, `/wayread:intent`, `/wayread:orient` |
| Explain how one use case works end to end | `/wayread:trace "user resets their password"` (add `live` for a safe test-environment proof, `save` for a Markdown copy) |
| Find and fix problems | `/wayread:blindspots`, `/wayread:harden`, `/wayread:fix-repo-cycle` |
| Build or refactor with review gates | `/wayread:explain-approach`, `/wayread:new-feature-cycle`, `/wayread:refactor-cycle` |
| Watch a multi-step change as it happens | `/wayread:live-plan "add rate limiting to login"` (plan graph, files touched, plan checked against git; also runs inside `new-feature-cycle` and `refactor-cycle`) |
| Review a change | `/wayread:code-review`, `/wayread:coverage`, `/wayread:guardrails`, `/wayread:explain-code-change`, `/wayread:catch-up`, `/wayread:change-full-review` |
| Release gate | `/wayread:ship-check` |
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
- These are prompts, not programs, with one exception: `/wayread:live-plan` renders its graph with `scripts/live-plan.mjs`, a script with no dependencies that needs Node 18+ and git (`node --test scripts/` runs its tests). Results depend on your model and your repo, and any finding should be checked against the code before you act on it.
- The plan graph changes only when it is republished, and step status is the model's own report. Only the plan-against-git file comparison comes from git.
- Several commands publish Claude Artifacts and some can edit files or run tests in your repo when you ask them to. Read a command's file in `commands/` before running it on a repo you care about.
- `/wayread:trace` can run a live proof; it is instructed to use a safe test environment only, never production, but you are responsible for what it runs.
- Written for one person's workflow, shared as is. Issues and pull requests are welcome.

## License
MIT
