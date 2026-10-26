---
description: Ship-readiness / pre-release gate — coverage, guardrails, and code review run in parallel, converging on one combined go/no-go gate, and re-run automatically after fixes until clear
argument-hint: [optional: passed through to the coverage and code-review checks as scope/focus]
---

Runs the ship-readiness flow — `/wayread:coverage full`, `/wayread:guardrails`, and `/wayread:code-review` — as one command. Unlike `/wayread:fix-repo-cycle` and `/wayread:new-feature-cycle`, this does **not** pause between each check. The three checks are read-only (none of them edit anything) and none depends on another's output, so they run concurrently and converge on a single combined review gate instead of three sequential ones. Once you choose to fix, the whole three-check round re-runs automatically after the fixes land, looping until the gate comes back clear or gets stuck — see the loop step below.

This is the **ship-readiness / pre-release gate** pass — use it when the question is "can this go out the door?" and you're confirming there's nothing blocking a release, not hunting for problems from scratch. It reuses the same three checks `/wayread:change-full-review` bundles, minus the sanity/integration-test and security-review passes that command adds — if you want the fuller bundle instead of this three-check gate, use `/wayread:change-full-review` directly.

**Why parallel is safe here, specifically:** all three checks read the repo state and produce a report; none of them writes code, so there's no ordering dependency and no risk of one check clobbering another's inputs. That's different from `/wayread:harden`'s fix loop or implementation steps in the other cycles, which mutate files and must stay sequential. Don't reuse this parallel-then-gate pattern for any step that edits files.

## Steps

1. **First, a quick unpushed-work check on the current repo**, per `/wayread:unpushed-work`: run `node <script> scan --no-fetch --quiet` (no fetch — this is a fast local check, not a full sweep). This is a direct call, not an agent; it takes a moment and doesn't need to run concurrently with the three checks below. Hold the result for the combined report in step 4 — a release with real work sitting unpushed is worth knowing about even though it isn't itself a code-quality gate. If `node` isn't available, say so and skip this step.

2. **Launch all three checks at once, in a single message with three concurrent `Agent` tool calls** (not three sequential invocations — they must genuinely run together, so batch them in one response):
   - One agent runs the full `/wayread:coverage full $ARGUMENTS` flow (whole-system scope, not just the current diff) and reports back its findings and artifact URL.
   - One agent runs the full `/wayread:guardrails` flow and reports back pass/fail per rule plus any newly proposed rules.
   - One agent runs the full `/wayread:code-review $ARGUMENTS` flow (at the level last used, or `medium` if none specified) and reports back its findings.

   Each agent should be briefed with the same context a manual invocation of that command would have (repo root, `$ARGUMENTS`, and that this is a pre-release gate, not a routine check) so its output matches what running the command directly would produce.

3. **Wait for all three to complete, then combine.** Do not act on or report any single check's results before the other two land — the whole point of the combined gate is judging all three together. If one check finishes and surfaces something alarming while the others are still running, don't jump ahead; note it and wait.

4. **Present one combined report**: coverage gaps, guardrail pass/fail, code-review findings, and the unpushed-work result from step 1, grouped by severity/blocking-ness rather than by which check found them — the user shouldn't have to mentally merge several separate reports. Cross-reference where useful (e.g. a coverage gap and a code-review finding pointing at the same file). Unpushed work isn't itself a go/no-go blocker the way the other three are — name it plainly, but don't let it alone turn a clear gate into a no-go.

5. **Ask once per round**: fix everything now, fix a subset, or stop here to review first? This is the single combined gate replacing what would otherwise be three separate pauses.

## The re-check loop

This is what makes the command "keep going until clear" instead of a one-shot check — you trigger it once, and every fix round automatically re-triggers the next check round without you having to re-invoke `/wayread:ship-check` yourself.

6. **If the user chose to fix (all or a subset) in step 5: apply those fixes**, then **automatically re-run step 2** (relaunch all three checks concurrently, same as the first round; no need to re-run the unpushed-work check unless the user also asked to push something) **without waiting to be asked** — the retrigger is implicit in having chosen "fix," not a separate confirmation. Present the new combined report (step 4) and increment a round counter you track for this invocation (Round 2, Round 3, ...).

7. **Loop condition**: keep repeating fix → re-check (steps 5–6) until one of exactly two things happens:
   - **Clear**: all three checks come back clean (zero coverage gaps, all guardrails pass, zero code-review findings) — report this plainly as the exit condition, give the go verdict, and stop looping.
   - **User skips**: at any round's gate (step 5), the user declines to fix (stops, or explicitly skips remaining findings) — exit the loop there and report the no-go/conditional verdict with whatever's still outstanding.

   There is no other exit condition — the loop does not give up on its own. If a round makes no progress (same findings recur, or a fix introduces a new one), say so plainly in that round's report so the user can see it's not converging, but keep looping on the user's next fix decision rather than stopping automatically. Since this can loop indefinitely if fixes aren't landing, call out stalled rounds clearly enough that the user can choose to skip — that's the only way out besides clear.

   Report which of the two exit conditions ended the loop — don't let "it stopped" be ambiguous between "it's clear" and "the user skipped."

## After the flow completes (or is stopped early)

Give a direct yes/no/conditional answer to "is this ready to ship" based on the combined findings — don't just list findings without synthesizing a verdict. If any check surfaced blocking issues, say so plainly rather than letting the user infer it from a findings list. If one of the three agent calls failed or timed out, say so explicitly and treat the gate as incomplete — don't render a go/no-go verdict on two-thirds of the picture without flagging the gap.

## When to use this

Right before a release, when you want the standard three-check gate run with minimal wall-clock time and exactly one review checkpoint at the end — not three. If you'd rather review each check's findings before the next one runs (e.g. because you expect to fix coverage gaps in a way that would change what code-review sees), don't use this — run `/wayread:coverage full`, `/wayread:guardrails`, and `/wayread:code-review` manually in sequence instead.
