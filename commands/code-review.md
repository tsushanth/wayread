---
description: Run /code-review, then sanity-check the change against this repo's actual test/build/run setup
---

Run this in two parts.

## Part 1 — code review

Invoke the `code-review` skill on the current diff (or on `$ARGUMENTS` if given, e.g. a PR number or branch) at the level the user last used, or `medium` if none was specified.

## Part 2 — repo sanity tests

Do not assume Docker, `npm`, or any specific file layout — this repo's actual toolchain may differ from other projects. Discover it first:

1. Read `package.json` (root, and per-workspace if this is a monorepo) for a `scripts` block. Identify the real test command (`test`), typecheck command (`typecheck`/`tsc`), and dev/run command (`dev`/`start`). If there's a `pnpm-workspace.yaml`/`lerna.json`/`turbo.json`, prefer the workspace-aware runner (`pnpm -r test`, etc.) over guessing a single package manager.
2. Check `README.md` / `CLAUDE.md` / `PROBLEM.md` (whichever exists) for a documented "getting started" sequence — use it instead of inventing one.
3. Only reach for Docker if a `Dockerfile` actually exists in the repo. Only reach for HTTP sanity checks (`curl` against local routes) if the code under test is actually an HTTP server — check for `express`/`fastify`/`http.createServer`/etc. before assuming request/response endpoints exist.

Then run whatever the real sequence is (e.g. install deps if needed, run the test command, run typecheck) and report pass/fail with real output — do not fabricate results. If no automated tests exist, say so plainly and fall back to reading the changed code against its stated behavior.

Report a concise pass/fail summary for Part 2, plus the code-review findings from Part 1. If an early step (install/build) fails, skip the remaining steps and report the failure.