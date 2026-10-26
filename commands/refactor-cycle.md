---
description: Refactor without behavior change in one command — same shape as /wayread:new-feature-cycle, but the requirement is framed as a refactor and coverage afterward proves nothing behaviorally changed
argument-hint: <what to restructure and why — no new capability, no behavior change>
---

Runs the same flow as `/wayread:new-feature-cycle` (`/wayread:system-overview` → `/wayread:explain-approach` → implementation → `/wayread:code-review` → `/wayread:coverage` → `/wayread:guardrails`), with two differences specific to refactors:

- The requirement handed to `/wayread:explain-approach` is explicitly framed as a refactor — no new capability, behavior must stay identical — not as a feature request.
- The `/wayread:coverage` step afterward is treated as proof that nothing behaviorally changed, not just as a check for "is this tested." If coverage is thin, that's a gap in being able to prove the refactor is safe, not just a gap in general test hygiene — call that out explicitly rather than treating it as routine.

If `$ARGUMENTS` is empty, ask what's being restructured and why, and stop — don't guess one, same rule as `/wayread:explain-approach`.

Note: individual file edits during the implementation step are separately gated by this project's own permission settings (edits require approval one at a time) regardless of this command's pauses. This command's pauses are at the phase level; the permission system's prompts are at the individual-edit level, underneath that.

## Steps

1. **Run `/wayread:system-overview`** if it hasn't already been run this session (skip and say so if a recent one is already available). Report the artifact URL. Ask: continue to approach planning, or stop here?

2. **Run `/wayread:explain-approach`** with `$ARGUMENTS` framed explicitly as a refactor requirement (state plainly in the prompt to that command that this is a restructuring with no intended behavior change, so its proposed-approach output is judged against "does behavior stay identical," not "does this add the requested capability"). Report the artifact URL, the path of the `plan.json` it saved, and a short summary. Ask: approve as-is, or send back edits? **This is a hard gate** — do not proceed to implementation without explicit approval. Loop here until approved or the user stops.

3. **Once approved: implement the change**, following the approved plan's file-by-file breakdown. Before the first edit, start the live plan: run `/wayread:live-plan` on the `plan.json` from step 2 (write one from the approved plan if there isn't one), run `add-verify` on it so review, coverage and guardrails appear as steps, then render and publish it. Update it at each step boundary as `/wayread:live-plan` describes, and report the URL. If Node is not available, say so and carry on without the graph. Stay inside what the plan described. If implementation reveals the plan needs to change, stop and say so. Write or update tests as part of this step, aimed specifically at pinning down existing behavior before/while restructuring it, not just covering new code paths (there shouldn't be new ones).

4. **Run `/wayread:code-review`** against the implementation. Mark `verify-code-review` running first and done after, record the result with `evidence`, and republish the graph. Report findings, paying particular attention to any finding that implies a behavior change slipped in — flag those distinctly from ordinary quality findings, since a refactor introducing behavior change is a correctness failure of the refactor itself. Ask: fix findings now, or stop here?

5. **Run `/wayread:coverage`** (change-scoped). Update `verify-coverage` the same way, recording whether the coverage supports "behavior unchanged" as its result. Report gaps found, and explicitly state whether the resulting coverage is sufficient to demonstrate behavior didn't change — not just "tests exist." Ask: add the missing tests now, or stop here?

6. **Run `/wayread:guardrails`.** Update `verify-guardrails` the same way and record the result. Report pass/fail per rule and any newly proposed rules. Ask: address any failures now, or stop here?

## After the flow completes (or is stopped early)

State clearly which step the flow actually reached. End with an explicit statement of whether the evidence gathered (tests, coverage, review) actually supports "behavior is unchanged," or whether that claim is still unproven — don't let a completed flow imply behavioral equivalence was verified if it wasn't. If a live plan was running, publish it a last time, give its URL, and list the flags it shows as open or resolved.

## When to use this

When you're restructuring code without adding a capability or changing what it does, and want the plan → build → review → coverage → guardrails flow to happen without manually invoking each command, with coverage treated as proof of behavioral equivalence rather than routine test hygiene. For adding a new capability instead, use `/wayread:new-feature-cycle`.
