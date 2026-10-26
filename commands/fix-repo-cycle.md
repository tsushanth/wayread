---
description: Audit-and-harden an existing codebase in one command. With no argument, fully open-ended (overview → intent → blind spots → harden). Given a specific known issue, skips straight to a scoped fix instead of open-ended discovery.
argument-hint: [optional: either a subsystem to focus open-ended discovery on, OR a specific known issue to fix directly — see mode detection below]
---

Runs the audit-and-harden flow as one command, so you don't have to type each step manually — but still stops for your review between steps, the same checkpoints as running them separately. This command does not skip or weaken those checkpoints; it just automates the "run the next one" part.

This is the **existing-code audit** cycle — use it when the goal is "find out what's wrong with this codebase and fix it," not "add a specific feature." For the latter, use `/wayread:new-feature-cycle`, which wraps `/wayread:system-overview` → `/wayread:explain-approach` → implementation → `/wayread:code-review`/`/wayread:coverage`/`/wayread:guardrails` instead.

Note: individual file edits inside `/wayread:harden` are separately gated by this project's own permission settings (`.claude/settings.json` — edits require approval one at a time) regardless of this command's pauses. This command's pauses are at the phase level (whole steps); the permission system's prompts are at the individual-edit level, underneath that.

## Mode detection

Read `$ARGUMENTS` before doing anything else:

- **Empty** → **Open-ended mode.** No idea yet what's wrong; let the full flow find out.
- **Names a specific, known issue** — describes a concrete bug, broken behavior, or a particular fix already in mind (e.g. "the retry logic in loop.ts drops the last message on reconnect", "fix the race condition in the session cache", a specific file:line with a described problem) → **Targeted mode.**
- **Names only a subsystem or area, with no specific problem stated** (e.g. "auth", "the billing module", "focus on the API layer") → stays **Open-ended mode**, just scoped to that area, same as before — this is not enough information to skip discovery, it's just a search boundary.
- **Ambiguous** (unclear whether it's a known issue or just an area name) → ask the user to clarify which they mean rather than guessing. Guessing wrong in either direction is costly: treating a vague area name as a known issue skips discovery that was actually needed; treating a real known issue as a mere scope hint wastes a full open-ended pass on something already understood.

State which mode was detected and why, before proceeding, so the user can correct it if the detection is wrong.

## Open-ended mode

Same four-step flow as always (`/wayread:system-overview` → `/wayread:intent` → `/wayread:blindspots` → `/wayread:harden`):

1. **Run `/wayread:system-overview`.** Report the artifact URL and a one-line summary. Ask: continue to intent derivation, or stop here? If the user says stop, end the command — don't proceed on assumed consent.

2. **If continuing: run `/wayread:intent $ARGUMENTS`.** Report the artifact URL and a one-line summary of the derived intent and any doc-vs-code drift found. Ask: continue to the blind-spots check, or stop here to correct the intent statement first?

3. **If continuing: run `/wayread:blindspots $ARGUMENTS`.** Report the artifact URL and the finding count. Ask: continue into the fix/harden loop, or stop here to review the findings first? If the finding count is zero, say so plainly and ask whether to stop here rather than running `/wayread:harden` for nothing.

4. **If continuing and there are findings: run `/wayread:harden $ARGUMENTS`.** This step owns its own internal loop (fix → test → re-check via `/wayread:blindspots` → repeat until 2 consecutive dry rounds) and publishes its own per-round and final artifacts — let it run to its own completion. When it exits, report its final artifact URL and summary: rounds taken, findings fixed, guardrails added, any open architectural work left unfixed by design.

## Targeted mode

Skips the parts of the flow that exist to *find out* what's wrong, since that's already known. Still keeps the review checkpoints for what remains.

1. **Skip `/wayread:system-overview` and `/wayread:intent` entirely** — say explicitly that these are being skipped and why (the issue is already known; deriving a whole-system map and intent statement for a single stated problem is the open-ended overhead this mode exists to avoid). If the user wants the map anyway, they can run `/wayread:orient` separately.

2. **Run `/wayread:blindspots $ARGUMENTS`, but scoped to confirm and detail the stated issue** rather than a full whole-system sweep — brief it explicitly that the goal is to verify the described problem is real, pin down its exact location and cause, and report that as a findings entry, not to go hunting for unrelated issues. This still produces a real findings report (satisfying `/wayread:harden`'s precondition that `/wayread:blindspots` has run this session) but takes a fraction of the time of the open-ended pass. Report the finding. Ask: continue to harden, or stop here to review first? If `/wayread:blindspots` can't actually confirm the stated issue (it doesn't reproduce, or the description doesn't match what's in the code), say so plainly and stop rather than handing `/wayread:harden` a fix for something that isn't actually there.

3. **If continuing: run `/wayread:harden $ARGUMENTS`.** Same fix/test/guardrail discipline and same 2-dry-round exit condition as open-ended mode — targeted mode only changes how round 1's findings were produced, not how fixing and verification work afterward.

## After the flow completes (or is stopped early)

State clearly which mode ran, which step the flow actually reached, and why (completed fully, stopped at your request, stopped because a step found nothing to act on, or stopped because a targeted issue didn't confirm). Don't imply the full flow ran if it didn't, and don't let "targeted mode" read as a lesser or incomplete run — it's a deliberate scope choice, not a shortcut that skipped verification.

If `/wayread:harden` landed any fixes this run, check they're not about to be stranded: run `node <script> scan --no-fetch --quiet` on the current repo, per `/wayread:unpushed-work`, and report anything found. If `node` isn't available, say so and skip this.

## When to use this

When you want the audit-and-harden flow to happen without manually invoking each command yourself, but still want to see and approve each stage's findings before the next stage acts on them. Use it with no argument when you don't know what's wrong yet; use it with a specific known issue when you do and want to skip straight to a scoped, verified fix. If you want zero pauses and full autonomy instead, don't use this command — invoke `/wayread:harden` directly in a loop yourself, understanding that skips the review checkpoints this flow is built around.
