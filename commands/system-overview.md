---
description: Publish an Artifact with a system architecture diagram and a request/user-journey diagram for this repo. Add "simple" to get a plain-language version instead.
argument-hint: [simple]
---

Build and publish a single Artifact giving a visual overview of this system: what it's made of, and what happens as requests/calls flow through it.

## Mode

- **No argument (default): technical.** Full precision — component names as they appear in code, exact signal/route/function names, the actual sequence of calls.
- **`$ARGUMENTS` contains "simple" (e.g. `/wayread:system-overview simple`): plain-language.** Same two diagrams, same underlying mechanism, but written for someone with no background in this stack. See "Simple mode" below for how the content should differ. This publishes to a **different, separate stable file path** from the technical version (see step 6) — companion pages, not one replacing the other.

## Steps

1. Load the `artifact-design` skill to calibrate the page's design before writing anything.
2. Load the `artifact-diagramming` skill for diagram mechanics (this page will use Mermaid diagrams).
3. **Discover the real architecture first — don't assume it.** Read whatever docs exist (`README.md`, `CLAUDE.md`, `PROBLEM.md`) for a starting mental model, then verify against the actual source: entry point(s) (`src/index.*`, `main.*`, a CLI entry, a server bootstrap — find it, don't guess a filename), the core packages/modules and how they import each other, and how a request/call actually enters and exits the system. If docs are stale relative to the code, trust the code.
4. Write a single HTML file with two diagrams:
   - **System architecture** — the real components of *this* repo (services, packages, the agent/LLM loop if there is one, external APIs it calls) and how they're wired together, sourced from what you actually found in step 3.
   - **Request / user journey** — a sequence diagram covering the main path(s) through the system for its actual purpose (e.g. an inbound call/request → lookup → action → response for an agent; a request → handler → response for an HTTP service) — model the paths that actually exist in this code, not a template from a different kind of system.
5. Add a short paragraph of context above each diagram — what it shows and why it matters — sourced from the real docs/code, not invented.
6. Publish via the `Artifact` tool with a stable file path so re-running this command later updates the same page instead of creating a new one. The technical and simple versions are separate pages with their own stable paths and their own stable favicons (pick a distinct favicon for simple mode and keep each stable across future updates of that mode).

### Simple mode

Keep the same two-diagram structure and the same real mechanism — don't invent a different, dumbed-down architecture. What changes:
- **Names**: replace jargon with plain equivalents on first use, keeping the real identifier alongside the plain-language gloss so the page still maps back to the code.
- **Framing**: lead each diagram's context paragraph with the everyday analogy or the "why should I care" before the mechanism.
- **Diagram labels**: shorter, plainer arrow/step labels; move precise details into the caption or a small "the exact detail" aside rather than crowding the diagram itself.
- **Scope**: do not add content beyond what the technical version covers — same two diagrams, same components, just explained for a newcomer.

Report the artifact URL(s) when done — both, if both were requested or already exist from prior runs; otherwise just the one built this run.
