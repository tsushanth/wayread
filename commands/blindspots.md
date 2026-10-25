---
description: Check whether the system actually achieves the intent from /wayread:intent — top-down (whole system, then each component in isolation) — report gaps, broken behavior, and missing pieces. Diagnostic only, does not fix anything.
argument-hint: [optional: a subsystem to focus the component-level pass on]
---

Third step of the audit-and-harden flow (`/wayread:system-overview` → `/wayread:intent` → `/wayread:blindspots` → `/wayread:harden`). This command finds and reports; it does not fix. `/wayread:harden` is the command that fixes what this one finds, and re-runs this command each round to check progress — kept separate so a person can review what was found before anything gets changed.

If `$ARGUMENTS` is given, still do the whole-system pass, but go deeper on that subsystem in the component-level pass.

## Before starting

If `/wayread:intent` hasn't been run this session (no artifact or in-context intent statement to reference), stop and say so — ask whether to run it now or supply the intent statement directly. Don't silently re-derive intent inline; that skips the human-review checkpoint the separate command exists for.

## Step 1 — Whole-system pass

For each core flow listed in the intent statement, check whether the system actually delivers it, top-down:
- Prefer **real exercise of the system** — run it, hit its actual entry points (HTTP routes, CLI commands, the actual conversation/agent loop), using its real test/run commands (discovered fresh from `package.json` etc., not assumed). If a flow can be driven end-to-end this way, do it and report the real outcome.
- Where real exercise isn't practical (e.g. requires a live third-party credential, or a channel this environment can't simulate), fall back to tracing the flow through code, and say explicitly that this flow was checked by reading, not running — don't blur the two together as if they were equally strong evidence.

Mark each flow: **works as intended** / **broken** (works but wrong) / **missing** (doesn't exist despite being in the intent statement). For broken/missing, cite the specific file:line or the specific absence.

## Step 2 — Component-level pass, in isolation

Enumerate the individual components/subsystems (each service, each route module, each independently-deployable or independently-testable unit). For each one, ask: **can this be sanity-checked or tested in isolation, separate from the whole system?**

- If yes and a check already exists (unit tests, an isolated script): run it, report the real result.
- If yes but no check exists: that absence is itself a finding — name the component and what an isolated check would need to cover.
- If no (the component can't be meaningfully isolated — e.g. it's pure glue with no independent behavior): say so, don't force a check that doesn't mean anything.

## Step 3 — Cross-reference

For every whole-system-level gap from Step 1, trace whether it's caused by a single component's bug (Step 2 will have found it too) or is **systemic** — spans multiple components in a way no single component's isolated check would ever catch (e.g. a cache in one service never invalidated by a write in another). Call out systemic findings explicitly and separately; they're usually the highest-value findings and the easiest to miss.

## Output

A ranked findings report — most consequential first, each with: what's wrong, concrete evidence (file:line, or the real command output that demonstrated it), whether it's component-local or systemic, and a rough severity. Don't pad the list — if a round finds nothing, say that plainly rather than inventing minor items.

Publish via the `Artifact` tool, stable file path (so `/wayread:harden` re-running this command updates the same page each round rather than spawning a new one), distinct favicon from `/wayread:intent`'s.

Report the artifact URL and an inline summary. This is a checkpoint for a person to review before `/wayread:harden` acts on it — don't proceed to fixing anything from within this command.
