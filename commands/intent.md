---
description: Derive this system's intended purpose from the actual code — not from docs — then cross-check against any stated docs and flag drift in either direction
argument-hint: [optional: a subsystem to focus on, e.g. "payments"]
---

Part of the audit-and-harden flow (`/wayread:system-overview` → `/wayread:intent` → `/wayread:blindspots` → `/wayread:harden`), run as separate steps on purpose so each one's output can be sanity-checked by a person before the next step consumes it. This command does not fix anything and does not sanity-check behavior — it only establishes what the system is *trying* to do, as a foundation for `/wayread:blindspots` to check against.

If `$ARGUMENTS` is given, scope the derivation to that subsystem, but still note anything about the whole system's purpose that's needed for context.

## Steps

1. **Derive intent from code first, before reading any docs.** Read entry points, route/tool/API definitions, the domain model (types, entities, relationships), core service functions, and validation/business-rule logic (what does the code refuse to do, and why — those refusals are often the clearest statement of intent). From this alone, write down: the core entities, the core flows/use cases the system supports, and the invariants the code actually enforces (e.g. "a payment cannot exceed the remaining balance" is enforced in code — that's part of intent, whether or not any doc says so).

2. **Then read the stated docs** — README, PROBLEM.md/spec, CLAUDE.md, code comments describing purpose — and compare against what you derived in step 1. Flag drift in **both directions**:
   - Docs claiming a capability that the code doesn't actually have.
   - Docs claiming a limitation ("not implemented", "TODO", "doesn't support X") that the code has actually already solved.
   
   Cite specific evidence for every claim — a file:line for the code behavior, a quote for the doc claim — not a general impression.

3. **Write the output as a structured intent statement**, not prose alone:
   - Core entities and their relationships.
   - Core flows (numbered, in the order a real user/caller would hit them).
   - Invariants/business rules the code enforces, per flow.
   - Doc-vs-code drift found in step 2, listed separately from the intent statement itself.

4. **Publish via the `Artifact` tool** using a stable file path so re-running this command later updates the same page. Pick a favicon distinct from the other commands in this flow and keep it stable across revisions.

5. **Report the artifact URL** and a short inline summary. This is meant to be read and corrected by a person before `/wayread:blindspots` uses it — if something looks wrong, say so and I'll revise before moving on, don't assume it's right just because it's published.

## When to use this

Second step of the audit-and-harden flow, after `/wayread:system-overview`. Needed whenever the next question is "is this system actually doing what it's supposed to" — you can't answer that without first pinning down what "supposed to" means, sourced from the code rather than assumed from docs that might be stale.
