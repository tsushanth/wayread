---
description: Build a new feature in one command — overview → explain-approach → implementation → code-review/coverage/guardrails — pausing for your review after each step. For a specific requirement, not for auditing existing code (see /wayread:fix-repo-cycle for that).
argument-hint: <requirement description>
---

Runs the feature-development flow (`/wayread:system-overview` → `/wayread:explain-approach` → implementation → `/wayread:code-review` → `/wayread:coverage` → `/wayread:guardrails`) as one command, so you don't have to invoke each step manually — but still stops for your review between steps, same as running them separately.

This is the **new-feature** cycle — use it when you have a specific requirement to build. For "find out what's wrong with this codebase and fix it" instead, use `/wayread:fix-repo-cycle`.

If `$ARGUMENTS` is empty, ask what the requirement is and stop — don't guess one, same rule as `/wayread:explain-approach`.

Note: individual file edits during the implementation step are separately gated by this project's own permission settings (edits require approval one at a time) regardless of this command's pauses. This command's pauses are at the phase level; the permission system's prompts are at the individual-edit level, underneath that.

## Steps

1. **Run `/wayread:system-overview`** if it hasn't already been run this session (skip and say so if a recent one is already available — no need to regenerate the whole map for every feature). Report the artifact URL. Ask: continue to approach planning, or stop here?

2. **Run `/wayread:explain-approach $ARGUMENTS`.** Report the artifact URL and a short summary of the proposed approach. Ask the same thing `/wayread:explain-approach` itself asks: approve as-is, or send back edits? **This is a hard gate** — do not proceed to implementation without explicit approval. If edits are requested, follow `/wayread:explain-approach`'s own revision process (re-run its steps 3–6, republish to the same URL, note what changed) and ask again. Loop here until approved or the user stops.

3. **Once approved: implement the change**, following the approved plan's file-by-file breakdown. Stay inside what the plan actually described — if implementation reveals the plan needs to change (a file needs different treatment than planned, an alternative turns out necessary), stop and say so rather than silently deviating from what was approved. Write tests as part of this step for the new behavior, not as an afterthought bolted on after `/wayread:coverage` finds the gap.

4. **Run `/wayread:code-review`** (current diff/session changes, at the level last used or `medium` if none specified) against the implementation. Report findings. Ask: fix findings now, or stop here to review them first? If fixing, apply fixes and re-run the review to confirm they landed clean before moving on.

5. **Run `/wayread:coverage`** (change-scoped, default form) against the implementation. Report gaps found. Ask: add the missing tests now, or stop here? If adding tests, confirm the suite passes afterward.

6. **Run `/wayread:guardrails`.** Report pass/fail per rule and any newly proposed rules (approving new rules follows its own convention — ask before adding). Ask: address any failures now, or stop here?

## After the flow completes (or is stopped early)

State clearly which step the flow actually reached and why. Don't imply the feature is fully built, reviewed, and guardrail-clean if any step was skipped or stopped early — be specific about what's actually done versus what's still open.

## When to use this

When you have a concrete requirement to implement and want the full plan → build → review → coverage → guardrails flow to happen without manually invoking each command, while still approving the plan before code gets written and reviewing findings before they're silently fixed.
