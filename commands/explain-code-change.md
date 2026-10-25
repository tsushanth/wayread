---
description: Explain code changes currently in the git working tree (uncommitted, vs HEAD) at the root of the repo, in plain terms; add a file argument for a diff-level deep dive on that file
argument-hint: [file]
---

This command explains **the repo's current uncommitted changes** — it runs `git diff` (and `git status` for untracked files) against HEAD from the root of the repository, regardless of which session or tool made them. It is meant to answer "what's currently changed in this repo" in plain language.

Run these first, from the repo root:
- `git status --porcelain` — to see modified/added/deleted/untracked files
- `git diff HEAD` — to see the actual changes to tracked files
- For untracked files, read their contents directly (there's no diff to show, so present the whole file as new content)

## No argument: full working-tree summary

For each file with uncommitted changes (modified, added, deleted, or untracked), report:
- **File path**
- **One-line plain-English comment**: what changed, in terms a non-expert could follow (no jargon, no diff syntax) — e.g. "added a check so the upload doesn't crash if the bucket name is missing," not "wrapped `aws s3 cp` in a conditional."
- Whether it's **modified**, **new/untracked**, or **deleted**.

Then a short **verification** section: state plainly what was actually run to check the change, sourced only from actual commands/output in this session (e.g. "ran `npm test`, 4/4 passed"). If nothing was run this session, say so directly — "not verified this session" — never imply testing happened if it didn't, and never suggest additional checks unless asked.

If `git status --porcelain` is empty, say so plainly and stop — there are no uncommitted changes to explain.

## With a file argument: `/explain-code-change $ARGUMENTS`

Run `git diff HEAD -- $ARGUMENTS` (or, if the file is untracked, read it directly and present it as entirely new content).

Provide:
1. **The diff itself** — the real before/after diff from git, not paraphrased.
2. **Per-hunk walkthrough** — for each distinct hunk, explain *why* the change plausibly was made and what it does, referencing actual line numbers.
3. **Risk/edge cases** — anything non-obvious this change could affect, only if genuinely applicable; don't invent caveats for padding.
4. **Verification** — report only checks actually run against this specific file's change this session (e.g. a targeted test, a manual curl, `npm test` output). State plainly if nothing was verified.

If the named file has no uncommitted changes (not in `git status --porcelain`), say so — do not describe its current contents as if they were a "change."

## Publish an artifact

After producing the chat report (whichever mode above ran), also publish it as an Artifact:

1. Load the `artifact-design` skill to calibrate the page — this is a utilitarian diff report, not a landing page: polished typography and layout, no flashy hero, no decoration beyond what clarifies the diff.
2. Build a single HTML file containing the same content just reported in chat: per-file summaries (or the single-file deep dive, diff included) and the verification section, using real diff formatting (e.g. `+`/`-` line coloring) rather than plain paragraphs.
3. Publish via the `Artifact` tool using a stable file path so re-running this command later updates the same page instead of creating a new one — same convention as `/wayread:system-overview`. Pick a favicon distinct from `/wayread:system-overview`'s and keep it stable across future `/wayread:explain-code-change` runs.
4. Report the artifact URL as the last line of the response.

If `git status --porcelain` was empty and there was nothing to explain, skip publishing — there's nothing to show.

## When to use this

When you want a plain-language recap of whatever is currently uncommitted in the repo — whether it came from this session, a previous session, or manual edits — faster than reading a raw diff.
