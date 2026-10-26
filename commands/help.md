---
description: List every /wayread:* command with its actual description and when to use it — an in-chat alternative for when the editor's slash-command picker doesn't show descriptions
---

Read the `description:` frontmatter from every `*.md` file in the `wayread` plugin's `commands/` folder (find it: look under `~/.claude/plugins/` for the installed `wayread` plugin's `commands/` directory; if the plugin is not installed, fall back to `sush-*.md` in `.claude/commands/` or `~/.claude/commands/`) fresh each time this runs. Don't answer from memory — descriptions change as commands get edited, and this command's whole purpose is to never go stale.

Group the output the same way the plugin's `COMMANDS.md` groups it (read that file for the grouping/wording conventions, but re-derive the actual descriptions from each command's own frontmatter rather than copying README.md's text verbatim, in case they've drifted):

1. **Flow 1 — auditing and fixing an existing codebase**: system-overview, intent, blindspots, harden, fix-repo-cycle
2. **Flow 2 — building a new feature**: system-overview, explain-approach, code-review, coverage, guardrails, new-feature-cycle
3. **Other wrapped intents**: orient, catch-up, ship-check, refactor-cycle
4. **Standalone utilities**: explain-code-change, change-full-review, trace, live-plan, session-map, unpushed-work, runbook

For each command, print: the command name, its actual current one-line description, and if the description doesn't already make it obvious, a short "use this when..." clause.

End with the same quick-decision cheat sheet style as README.md's bottom section (what to run for "what is this codebase," "I need to build X," "what changed just now," "give me everything on this diff once") — but keep it in sync with whatever commands actually exist at run time, don't hardcode a list that could drift from reality.

If `COMMANDS.md` doesn't exist, just build the grouped list directly from the frontmatter without it — this command should work even if that file is missing or gets out of sync.

## When to use this

Whenever the editor's own `/` picker isn't showing descriptions next to command names (this varies by client) and you want the same information without leaving the chat.
