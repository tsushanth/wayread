---
description: The entry point — given an intent (or none, to list all), shows or runs the command sequence that fills it. Maps "what are you here to do" to the right /wayread:* commands, in order.
argument-hint: "[intent, e.g. \"new feature\", \"fix bugs\", \"orient myself\", \"explain how a use case works\", \"ship readiness\", \"refactor\", \"catch up on changes\" — omit to list all intents]"
---

This is the runbook — the same idea as an incident-response runbook, but for "what am I here to do with this codebase," not "what alert just fired." Every entry below is an intent with a trigger, a command sequence, and whether a dedicated wrapper command already exists for it.

## Known intents

| Intent | Trigger — you're here because... | Sequence | Wrapper |
|---|---|---|---|
| **New feature** | You have a specific requirement to build. | `/wayread:system-overview` → `/wayread:explain-approach` (hard approval gate) → implement → `/wayread:code-review` → `/wayread:coverage` → `/wayread:guardrails` | `/wayread:new-feature-cycle` |
| **Fix / harden existing system** | Something's wrong, or you want to find out what is, and fix it. | `/wayread:system-overview` → `/wayread:intent` → `/wayread:blindspots` ↔ `/wayread:harden` (loops to 2 dry rounds) | `/wayread:fix-repo-cycle` |
| **Orientation / onboarding** | You need to understand this codebase before touching anything — no changes intended yet. | `/wayread:system-overview` → `/wayread:intent`, then stop | `/wayread:orient` |
| **Explain how a use case works** | Someone asked you to show how X happens ("what happens when a user resets their password"), or you want to learn one flow end to end. | `/wayread:trace "<use case>"` (add `live` for a test-call proof, `save` for a Markdown copy) | `/wayread:trace` |
| **Catch up on recent changes** | Returning after time away, or reviewing someone else's work, and want to know what changed. | `/wayread:explain-code-change` (add `/wayread:code-review` too if you also want a quality judgment, not just a description) | `/wayread:catch-up` |
| **Ship-readiness / pre-release gate** | "Can this go out the door?" — not hunting for problems, confirming there's nothing blocking a release. | `/wayread:coverage full` → `/wayread:guardrails` → `/wayread:code-review` (or the one-shot `/wayread:change-full-review` instead of the three separately) | `/wayread:ship-check` |
| **Refactor without behavior change** | Restructuring code without adding a capability or changing what it does. | Same shape as new-feature, but frame the requirement to `/wayread:explain-approach` as a refactor, and treat `/wayread:coverage` afterward as proof nothing behaviorally changed, not just "is it tested" | `/wayread:refactor-cycle` |
| **Follow a build visually** | You want to see where a multi-step change is and what it touches as it happens (steps, files, what waits on what), not just a chat summary. | `/wayread:live-plan "<task>"` (new-feature-cycle and refactor-cycle already run it for you after the plan is approved) | `/wayread:live-plan` |
| **Recover the thread of a long conversation** | A multi-day conversation has lost its shape: you want to see what was decided, ruled out, parked or left open, and pick up what fell off. | `/wayread:session-map latest`, then `update` as it continues and `resume open` to restart the missed threads | `/wayread:session-map` |
| **Incident triage** | Something is actively broken right now, you have a specific symptom, and need root cause fast. | **Not covered.** `/wayread:blindspots` is a broad, unhurried, whole-system sweep — wrong shape for "this one thing is on fire, trace it now." No dedicated command exists for symptom-first, time-pressured root-causing. | *(gap — see below)* |
| **Security / compliance sweep** | You want to check just the security surface, not the whole system. | **Partially covered** — some `GUARDRAILS.md` rules are security-shaped, and `/wayread:change-full-review`'s security-review step covers it as a side effect of a full review, but there's no standalone "security only" entry point. | *(partial — see below)* |

## Behavior

**No `$ARGUMENTS`**: print the table above (re-read from this file, don't paraphrase from memory in case it's been edited) and stop. Ask which intent to run — don't guess and start executing.

**`$ARGUMENTS` given**: match it against the intents above (loosely — "I need to add X" → new feature, "something's broken"/"audit" → fix/harden, "just want to understand"/"onboarding" → orientation, "can we ship"/"release" → ship-readiness, "what changed"/"catch up" → catch up, "refactor"/"cleanup" → refactor, "show me what it's doing"/"follow along"/"visual plan" → follow a build visually, "where did we get to"/"what did we drop"/"lost track of the conversation" → recover the thread). Then:

1. **State which intent matched and the exact sequence about to run** (name the specific commands, in order — e.g. "This looks like *fix/harden*: `/wayread:system-overview` → `/wayread:intent` → `/wayread:blindspots` ↔ `/wayread:harden`"). **Ask for explicit go-ahead before starting anything.** This is a hard gate — do not begin step 1 of the sequence on an assumed yes, and do not treat a vague or ambiguous reply as approval. This is separate from (and in addition to) the per-step pauses within the sequence itself once it's running.
2. Once approved:
   - **If the matched intent has a wrapper command**: invoke that wrapper directly, passing through whatever's left of `$ARGUMENTS` after the intent phrase (e.g. `/wayread:runbook new feature: add SMS notifications` → `/wayread:new-feature-cycle add SMS notifications`). Don't re-implement its sequence here — delegate. This now covers all eight defined intents (new feature, fix/harden, orientation, catch-up, ship-readiness, refactor, follow a build visually, recover the thread of a conversation) — each has a dedicated wrapper.
   - **If the matched intent is a gap or partial** (incident triage, security sweep): say so plainly, as part of step 1's "here's what's about to run" — don't silently run the nearest approximation as if it were the real thing. For incident triage specifically, offer the closest fallback (a `/wayread:blindspots` pass scoped to the symptom's subsystem via its argument) but name it as a fallback, not a fix for the gap, and the same go-ahead gate applies before running the fallback.
- **If nothing matches confidently**: ask the user to clarify rather than guessing which intent they meant — don't reach the go-ahead gate on a guess.

## When to use this

The first thing to run when you're not sure which command (or sequence of commands) fits what you're about to do. If you already know exactly which command you want, just run it directly — this is for the "what do I even start with" moment, not a required detour.
