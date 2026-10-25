---
description: Fix everything /wayread:blindspots finds, with a regression test per fix, re-checking each round via /wayread:blindspots until two consecutive rounds find nothing new — then codify guardrails and run full verification
argument-hint: [optional: a subsystem to focus on, passed through to /wayread:blindspots]
---

Fourth and last step of the audit-and-harden flow (`/wayread:system-overview` → `/wayread:intent` → `/wayread:blindspots` → `/wayread:harden`). This is the only command in the flow that changes code. It owns the fix/test/guardrail loop and the exit condition.

## Before starting

If `/wayread:blindspots` hasn't been run this session, stop and say so — run it first (or ask whether to). Don't re-derive findings inline; that skips the review checkpoint `/wayread:blindspots` exists for. Use its most recent findings report as round 1's input.

## Per round

1. **Triage each finding.** For each one, decide: fixable as a normal diff, or a design-level/architectural issue too large for one (e.g. it requires rethinking a data flow or a system boundary, not just correcting logic). Don't force-fix the second kind — log it under "open architectural work" instead and move on. Say why it doesn't fit a diff-sized fix.

2. **For each fixable finding**: fix it, then write a regression test that would have failed before the fix and passes after. Nothing counts as resolved without that test existing and actually being run (not assumed).

3. **Run full verification** (real test suite + typecheck, discovered fresh from this repo's actual tooling, across the whole workspace) before closing out the round. Report the real pass/fail.

4. **Re-run `/wayread:blindspots`** (same arguments as this command's `$ARGUMENTS`, if any) to get the next round's findings. Compare against everything already fixed or already logged as open architectural work this run — count only genuinely new findings, not restatements of what's already tracked.

5. **Publish a per-round summary** via the `Artifact` tool at a stable path (updated each round, not a new page per round) — what was fixed, what tests were added, what's newly open, what the fresh `/wayread:blindspots` pass found. Report the URL. This is the checkpoint for a person to sanity-check the round before the loop continues.

## Exit condition

Track a dry-round counter. If a round's fresh `/wayread:blindspots` findings are all things already fixed or already logged (i.e. nothing new), increment the counter; otherwise reset it to 0 and continue fixing. **Stop after 2 consecutive dry rounds.** Before starting each new round, state briefly why it's warranted (what's still unverified or what the last round changed) — don't loop mechanically once returns have clearly diminished.

## After the loop exits

1. **Guardrail codification.** For every finding fixed this run, write or update a `GUARDRAILS.md` rule in generalized form — the pattern the bug represents, not just the specific instance. Ask before adding or editing any rule (same convention as `/wayread:guardrails`). If `GUARDRAILS.md` doesn't exist, ask before seeding it.

2. **Final full verification** — the real test suite, typecheck, and build/run commands for this repo, across the whole workspace.

3. **Final report**, published via the `Artifact` tool at a stable path distinct from the per-round one: total rounds taken, every finding fixed (with a pointer to its regression test and its guardrail rule if one was added), the open-architectural-work list (unfixed by design, with why), and the final verification result. Report the URL plus an inline summary.

## When to use this

Only after `/wayread:blindspots` has produced a findings report you've reviewed and are ready to act on. This command will make changes to the codebase, unlike the first three steps of the flow.
