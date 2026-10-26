---
description: Show a task's plan as a graph you can glance at while work happens — steps, the files each one touches, what waits on what — and compare it with what git shows actually changed. Published as an Artifact that is updated at each step boundary.
argument-hint: <requirement> | <path to an existing plan.json>
---

This command makes a plan visible and keeps it honest. It writes the plan as data, renders it as a graph (steps in stage columns, arrows for dependencies, a state per step: Blocked, Ready, In progress, Done), publishes the page, and then updates it as the work proceeds. Under the graph it lists every file the plan expects to change next to what `git` says changed, and flags the differences.

It does not replace the chat. It is for the moments you would otherwise skim a long stream of output and lose track of where the work is and what it touches.

If `$ARGUMENTS` is empty, ask what task to plan and stop — don't guess one. If it is the path to an existing `plan.json` (for example one saved by `/wayread:explain-approach`), use that plan instead of writing a new one.

## What it needs

- **Node 18+ and git.** The graph is rendered by `scripts/live-plan.mjs` in this plugin, a script with no dependencies. If `node` is not available, say so and stop. Don't hand-draw a stand-in and present it as the same thing.
- **The script's path:** `${CLAUDE_PLUGIN_ROOT}/scripts/live-plan.mjs`. If that variable is empty in the shell, find it with `find ~/.claude/plugins -path '*wayread*/scripts/live-plan.mjs' | head -1`. Shell state does not carry over between calls, so use the full path every time: `node <path> <command> <plan.json> ...`.
- **Run it from inside the repo.** The first `render` reads the repo, branch and base from the current directory and saves them into `plan.json`.
- **The Artifact tool** to publish. Without it, the script still writes `plan.html`; give the user that path.

## Where the files go

One folder per task, outside the repo: the session scratchpad directory if the system prompt names one, otherwise `${TMPDIR:-/tmp}/wayread/plans/<short-task-slug>/`. It holds `plan.json` (the plan and its current state) and `plan.html` (the page, rewritten by every script call). Keeping it outside the repo means it never shows up as a change.

## Steps

1. **Understand the task and the repo's current state.** Read the code the task touches. Run `git status --porcelain`. If files are already modified before the work starts, tell the user, because they will appear as unplanned in the comparison.

2. **Write `plan.json`.** Fields:
   - `task` (what is being done, one line), optional `title` (two to four words, used as the page title), optional `rule` (one line shown as a banner, such as "Tests only; src/ must not change").
   - `stages`: column names, left to right. Default `["Prepare", "Build", "Verify"]`.
   - `steps`, each with `id` (short, unique), `stage` (index into `stages`), `title`, `short` (a few words, used where space is tight), `status` (`pending` for all at the start), and optionally:
     - `writes`: the exact paths this step creates or edits. This is what the plan-vs-git comparison runs on, so list real paths, not directories.
     - `reads`: paths it only reads. `temp`: paths it changes on purpose and reverts within the step.
     - `needs`: ids of the steps that must be done first. Only real ordering. Do not chain everything, and do not leave two steps unlinked if they write the same file; one has to wait for the other.
     - `needsEvidence: true` for steps whose "done" is a result (tests run, a command executed). The page flags such a step if it is done with no recorded result.
     - `note`: one or two sentences of what the step does.
   - Aim for 4 to 12 steps, one cohesive change each. Add the checks that actually matter as steps of their own (run the tests, an end-to-end check), not just the edits.
   - Leave `base`, `repo`, `branch` and `worktree` out. The script fills them in on the first render: `base` is the merge-base with the default branch, so "actual" means everything since the work began.
   - Run `node <script> check <plan.json>`. Fix whatever it reports. A complete example is `examples/plan.example.json` in this plugin.

3. **Render and publish.** Run `node <script> render <plan.json>`, then publish `plan.html` with the `Artifact` tool at that same file path every time (so the link stays the same), icon `graph`, and a one-sentence description. The page already follows the Artifact page rules, so don't edit it by hand. Report the URL.

4. **Update the page as the work happens.** At each step boundary, one call does the update and the re-render, then republish the page:
   - Before starting a step: `node <script> status <plan.json> <id> running`
   - After finishing it: `node <script> status <plan.json> <id> done --note "<what actually happened>"`
   - For a step that has a result: `node <script> evidence <plan.json> <id> <label> <text>` (for example `tests` and `66 passed`)
   - Something worth knowing that is not a step: `node <script> finding <plan.json> <text> [--kind verified|info|note]`
   - Several steps at once: `status <plan.json> a,b running`, but only if you really are working on both.

   Rules that make the page worth looking at:
   - Update **before** you start a step, not after. A page that says "waiting" while the work is under way is worse than none.
   - Mark a step `done` only when it is done. Mark it `flag` if it failed or needs a decision, and say why in `--note`.
   - Do steps one at a time unless you are actually running them in parallel (separate subagents, or independent tool calls). Steps with no dependency between them are Ready together, which says they could run in parallel, not that they are.
   - If the plan has to change (a step added, a file moved), edit `plan.json`, run `render`, and record why with `finding`. Don't leave the page describing a plan you are no longer following.

5. **Finish.** Set the last statuses, render, and publish once more. Report the URL and the flags the script printed: unplanned files, steps drawn as independent that share a file, done steps with no recorded result, planned files that git shows unchanged, steps started out of order. Say plainly which were resolved and which are still open. Do not describe a clean page as proof the work is correct; it shows that the repo matches the plan.

## What this does not do

- The page changes only when you republish it. It is not live between updates, so say when it was last updated if there has been a long gap.
- Step status is your own report. Only the file comparison comes from git.
- A comment left on the Artifact is not read while you are working. Feedback goes back through chat.
- Inside `/wayread:new-feature-cycle` and `/wayread:refactor-cycle` this runs automatically from the approved plan. Run it on its own for anything else.

## When to use this

When a task has several steps across several files and you want to see where it is and what it touches without reading the whole transcript. For a one-file change, the chat is enough.
