---
description: A flat, file-by-file reference for this repo — one line per source file stating what it does, grouped by directory. For onboarding and explaining a codebase to someone, not architecture or one use case — see /wayread:system-overview and /wayread:trace for those.
argument-hint: "[optional: a subdirectory to scope to — omit for the whole repo]"
---

`/wayread:system-overview` draws the architecture. `/wayread:trace` walks one use case. Neither tells you, in five minutes, what any given file actually does — and nobody keeps that list by hand once a repo gets past a few dozen files. This command builds it: one line per file, every file, grouped by directory, so a reader (including a newcomer, or someone you're explaining the codebase to) can skim the whole tree and know roughly what's where without opening anything.

This is deliberately the lightest-weight command in this plugin. No diagram, no architecture judgment, no live verification — just "this file does X," file by file.

## Scope

- **No `$ARGUMENTS`:** the whole repo.
- **A path as `$ARGUMENTS`:** scope to that subdirectory only. Use this on a large monorepo rather than indexing everything in one pass — scope to one top-level area at a time and publish each as its own page (see Reporting).

## Steps

1. **Build the file list, excluding what isn't worth a line.** Walk the tree from the scope root. Respect `.gitignore` if one exists (don't hardcode exclusions that duplicate what it already says) and additionally always skip, regardless of `.gitignore`: dependency directories (`node_modules`, `vendor`, `venv`/`.venv`, `__pycache__`), build/output directories (`dist`, `build`, `out`, `.next`, `.turbo`, `target`, `coverage`), lock files (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`), and binary/media assets (images, fonts, audio, video, archives, PDFs — anything not meaningfully readable as text). Keep test files — what's tested is part of understanding a codebase, not noise.

2. **Split the work across concurrent read-only `Agent` tool calls, one per top-level directory (or a sensible grouping if there are many small ones, or one per file if a single directory is huge)** — same parallel-dispatch pattern as `/wayread:code-health` and the other audit commands: launched together in one message, not sequentially, since none of them depends on another. Brief each agent with its slice of the file list and the instructions below.

3. **For every file in its slice, write exactly one line: what the file does.** Not a restatement of the filename, not a guess from the path alone — actually look at the file (its exports, its main function/class, its top-of-file comment if one exists and is accurate) and say what role it plays. Calibrate the read to the file: a short file, read it fully; a long one, its signature/exports and structure are usually enough — you don't need to trace every function to state the file's job in one line. For a generated or vendored file that slipped past exclusion (a committed lockfile-adjacent artifact, a `*.g.ts`, a `*_pb2.py`), say so plainly (`generated, not hand-written — <what it's generated from>`) rather than inventing a description as if it were authored. For a file genuinely too large or unusual to summarize in one line confidently, say that too, rather than guessing.

4. **Each agent returns its slice as a flat list: path → one-line description**, nothing else — no commentary, no grouping of its own (that happens once, centrally, in step 5).

5. **Wait for every agent, then combine into one outline, grouped by directory.** Nested by path (a top-level directory's files first, then its subdirectories, same order a file tree would show), not alphabetical-flat and not a giant table — the point is that someone can scan it the way they'd scan a folder tree, with the "what it does" line right next to each name. If one agent's slice is still pending when others finish, wait — don't publish a partial index.

## Reporting

Load the `artifact-design` skill, then publish one Artifact via the `Artifact` tool: a clean, scannable reference page — directory headers, then one line per file indented under it, file name and its one-line description side by side. This is a reference document, not a visual showpiece; keep styling utilitarian (matching the periodic-diagnostic commands' reports), and skip `artifact-diagramming` entirely — there's no diagram here, just an outline.

Use a stable file path so running this command again on the same scope updates the same page instead of creating a new one (same pattern as `/wayread:system-overview`). If `$ARGUMENTS` scoped this run to a subdirectory, give that page its own stable path distinct from a whole-repo run, and say in the page which scope it covers.

Also give a short plain-text summary in chat: how many files were indexed, how many were excluded as generated/vendored/unreadable (and why, briefly), and the artifact URL.

## When to use this

Before explaining a codebase to someone else, when picking up a repo you haven't touched in a while and want a fast "what's where" pass, or alongside `/wayread:orient` when its architecture-level view isn't granular enough and you need the file level too. For a large monorepo, run it scoped to one area at a time (`$ARGUMENTS` as a path) rather than the whole thing in one pass — a repo-wide run on a huge codebase will be a long page and a long wait, by design, since completeness is the point; scoping is the escape valve when that's too much at once.
