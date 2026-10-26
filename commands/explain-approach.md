---
description: Turn a requirement into a proposed approach — current state, proposed change, and detailed diff plan — published as an Artifact for review before any code is written
argument-hint: <requirement description>
---

This command does **not** write or edit code. It produces a reviewable proposal: given a requirement in `$ARGUMENTS`, explain the current system, propose an approach, and lay out the detailed changes it would take — as a single Artifact the user can approve or send back with edits.

If `$ARGUMENTS` is empty, ask the user what requirement to plan for and stop — don't guess one.

## Steps

1. **Understand the current system.** Read whatever docs exist (`README.md`, `CLAUDE.md`, `PROBLEM.md`) and the actual source relevant to the requirement — trust the code over any stale doc, same rule as `/wayread:system-overview`. Also check `git status --porcelain` for uncommitted changes already in flight, since the proposal should build on top of those, not ignore them. Check for a `GUARDRAILS.md` and read it if present.
2. **Load `artifact-design`** to calibrate the page (this is a utilitarian planning document, not a landing page — polished, scannable, no flashy hero) **and `artifact-diagramming`** for diagram mechanics.
3. **Think through the approach** before writing anything: what's the smallest change that satisfies the requirement, what are the realistic alternatives if more than one reasonable approach exists, what does it touch, what could it break, does it conflict with any rule in GUARDRAILS.md (if one exists). If the requirement is ambiguous or underspecified in a way that would change the approach, say so explicitly in the artifact rather than silently picking an interpretation.
4. **Write a single HTML file** with three sections, in this order:
   - **Current state** — a compact version of what `/wayread:system-overview` shows (component diagram and/or the relevant slice of the request/call journey), scoped to just the parts this requirement touches, not the whole system every time. Reuse its diagram conventions (labeled arrows, `currentColor` inline SVG) rather than reinventing a style.
   - **Proposed approach** — the requirement restated in the assistant's own words (to surface any misunderstanding early), the chosen approach, and why — including alternatives considered and rejected, if any, and one sentence each on why they lost out.
   - **Detailed changes** — a concrete, file-by-file plan: which files are touched, what changes in each (new functions/routes/tools, edited logic, new tests, doc updates), and a "what this does NOT change" line if that boundary is easy to get wrong. This is a plan, not a diff — no fabricated code that hasn't been written.
   - A short **open questions / risks** callout if genuinely applicable — skip it if there's nothing real to flag.
5. **Publish via the `Artifact` tool** using a stable file path so re-running this command (e.g. after the user asks for edits) updates the same page instead of creating a new one. Pick a favicon distinct from `/wayread:system-overview`'s and its `simple` companion, and keep it stable across revisions of a given proposal.

   Also save the same file-by-file plan as data, so `/wayread:live-plan` can follow the work once it starts: write `plan.json` (format and folder in `/wayread:live-plan`) with one step per cohesive change, the exact `writes` for each, real `needs`, every status `pending`, and stages `["Prepare", "Build"]`. Run `node <script> check <plan.json>` to validate it. Don't render or publish the graph here; it is published when implementation starts. If Node is not available, skip this and say so. Keep `plan.json` in step with the page whenever the plan is revised, and report its path with the artifact URL.
6. **Report the artifact URL**, then ask the user directly: approve as-is, or send back specific edits. Do not start implementing the change in this same command — that's a separate, explicit next step once the user approves.

## Revising after feedback

If the user asks for edits, re-run steps 3–6 incorporating their feedback, republish to the **same** file path (same URL), and briefly note what changed from the previous version at the top of the artifact or in your reply — don't make the user diff two versions themselves to find out.

## When to use this

Before writing code for anything non-trivial — to get alignment on the approach and its blast radius while it's still cheap to change, instead of discovering a disagreement after the diff already exists.
