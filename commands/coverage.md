---
description: Critically analyze test coverage — for the current uncommitted change by default, or the whole system with an argument
argument-hint: [full]
---

This command is a critical coverage analysis, not a coverage percentage. First locate the actual test files (search for `*.test.*`/`*.spec.*`/a `tests/`/`test/` dir — do not assume a single hardcoded path like `test/main.test.mjs`, this varies per repo, especially in a monorepo with per-package test dirs). Check `package.json` for a coverage tool (`nyc`/`c8`/`vitest --coverage`/`jest --coverage`) — if none configured, do this by manually reading the code against the actual test files and reasoning about what is and isn't exercised. Be skeptical by default: a test file existing, or a function being imported into it, is not evidence it's covered — check what each test actually asserts.

## Scope

- **No argument (default): the change.** Run `git status --porcelain` and `git diff HEAD` from the repo root. Scope the analysis to the files that changed — new/changed functions, branches, and routes — plus anything they touch that could plausibly break as a result (e.g. a changed shared helper used elsewhere). If there are no uncommitted changes, say so and stop.
- **With `$ARGUMENTS` (e.g. `/wayread:coverage full`): the whole system.** Ignore the working-tree diff and analyze every exported function/route/handler in the repo (or, in a monorepo, per package) against the full test suite.

## What to check, per unit in scope

For each function, route, or branch in scope:
1. **Is it exercised at all?** Search the real test files for a test that actually calls it (directly, or via the real entry point — HTTP route, CLI command, tool dispatcher, whatever this repo actually is) — not just a passing mention or an import.
2. **What does the test actually assert?** A test that calls a function but only checks a top-level success flag isn't the same as one that checks the response/return shape, error paths, or edge-case inputs. Call this out explicitly when it happens.
3. **What branches/edge cases are untested?** Malformed input, boundary values, missing/invalid config, concurrent access, error propagation — list concrete untested branches specific to this codebase, not generic "add more tests" advice.
4. **Is anything untestable as written?** e.g. shell scripts, infra config, or manual setup steps with no automated test runner configured — say this plainly rather than treating it as covered because a manual sanity-check sequence exists elsewhere. Manual/integration sanity checks are not unit coverage; note the difference.

## Output

Report, grouped by file/unit in scope:
- **Covered** — what's genuinely tested, and how strongly (shallow vs. thorough).
- **Gaps** — concrete untested code paths, named by function/branch, ranked by how likely they are to hide a real bug (not by how easy they'd be to test).
- **Untestable / out of automated scope** — anything that has no automated test path at all in this repo.

Don't recommend adding tests for trivial, unlikely-to-break code just to raise a number. If coverage is genuinely solid for what's in scope, say so plainly instead of inventing gaps to pad the report.

## When to use this

Before committing a change, to find out what's actually protected by tests versus what's untested and shipping on faith. Use the default (change-scoped) form during normal work; use `/wayread:coverage full` for a periodic whole-system gut check.
