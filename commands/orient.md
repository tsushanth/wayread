---
description: Orient yourself in this codebase before touching anything — system overview then derived intent, no changes intended
argument-hint: [optional: a subsystem to focus on, passed through to /wayread:intent]
---

Runs the orientation flow (`/wayread:system-overview` → `/wayread:intent`) as one command, so you don't have to invoke each step manually — but still stops for your review between steps, same as running them separately.

This is the **orientation / onboarding** pass — use it when you need to understand this codebase before touching anything, with no changes intended yet. It does not audit for problems (`/wayread:fix-repo-cycle` does that) and it does not implement anything (`/wayread:new-feature-cycle` does that). It just builds a map and states what the system is for.

## Steps

1. **Run `/wayread:system-overview`.** Report the artifact URL and a one-line summary. Ask: continue to intent derivation, or stop here?

2. **If continuing: run `/wayread:intent $ARGUMENTS`.** Report the artifact URL and a one-line summary of the derived intent and any doc-vs-code drift found.

## After the flow completes (or is stopped early)

State clearly which step the flow actually reached. This command ends here by design — it does not chain into `/wayread:blindspots` or any fix/build flow. If the user wants to act on what orientation surfaced, point them at `/wayread:runbook` to pick the next intent (fix/harden, new feature, etc.) rather than guessing which one they want.

## When to use this

When you're new to this codebase, or returning after a long gap, and want the map and the stated intent before deciding what to do next — not when you already know you want to find bugs or build something.
