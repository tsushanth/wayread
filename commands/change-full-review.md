---
description: Comprehensive review — code review, unit tests, sanity/integration tests, a security review, and a published artifact report, all in one pass
---

Run this in five parts and finish with one combined summary. If `$ARGUMENTS` is given (a PR number, branch, or path), pass it through to the code review and security review parts as the target; otherwise review the current diff (i.e. `git diff HEAD` / `git status --porcelain` from the repo root — the working tree's git state, not session-local edit history).

## Part 1 — code review

Invoke the `code-review` skill on the target at the level the user last used, or `medium` if none was specified. Report correctness bugs and reuse/simplification/efficiency findings.

## Part 2 — unit tests

Discover the real test command from `package.json` `scripts` (root and per-workspace if this is a monorepo — prefer the workspace-aware runner, e.g. `pnpm -r test`, over guessing) or whatever `README.md`/`CLAUDE.md` documents. Run it and report the real pass/fail result and any failure output — do not fabricate a result. If the suite is missing or broken, say so explicitly rather than skipping silently.

## Part 3 — sanity / integration tests

Do not assume Docker or HTTP endpoints exist. First check what this repo actually is:
- If there's a `Dockerfile`, build and run it, and derive sanity checks from whatever ports/routes the code actually exposes (check for an HTTP framework and its route definitions before assuming `/health`-style endpoints).
- If it's a library/CLI/agent (no server), the sanity check is running the documented CLI/entry-point commands from `README.md`/`PROBLEM.md` against realistic inputs and confirming the output matches expectations — not inventing a Docker+HTTP sequence that doesn't apply.
- Use a distinct process/container name so this doesn't collide with anything the user has running manually, and always clean up (stop containers, kill background processes) when done.

Report pass/fail per step you actually ran. If an early step (build/install) fails, skip the remaining steps and note it.

## Part 4 — security review

Invoke the `security-review` skill on the target (pending changes on the current branch, or `$ARGUMENTS` if given). Focus on this repo's actual attack surface — determine it from the code (e.g. for an LLM agent: tool-call argument validation, auth/identity checks before privileged actions; for a payment path: server-side re-validation of amounts; for a service with subprocess/shell calls: injection risk) rather than assuming a prior project's surface (Docker crash-report scripts, S3 uploads) applies here.

## Part 5 — publish an artifact

Load the `artifact-design` skill to calibrate the page (this is a utilitarian report, not a landing page — polished but not flashy). Build a single HTML file with the combined report from Parts 1–4: code review findings, unit test results, sanity-test pass/fail per step, and security review findings. Use real status indicators (pass/fail/finding severity), not decorative styling.

Publish it via the `Artifact` tool using a stable file path (e.g. `<scratchpad-dir>/full-review-report.html`) so re-running this command later updates the same page instead of creating a new one — same convention as `/wayread:system-overview`. Reuse the favicon from the most recent `/wayread:system-overview` artifact if you can find one in this session's history; otherwise pick a new one and keep it stable across future `/wayread:change-full-review` runs specifically.

## Summary

After all five parts, give one combined report in chat:
- Code review: findings list (or "none").
- Unit tests: ran / not present, with results if run.
- Sanity tests: pass/fail per step, or "n/a — no server/Docker in this repo, ran CLI checks instead."
- Security review: findings list (or "none").
- Artifact: the published URL.