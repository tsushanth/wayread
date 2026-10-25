---
description: Check the codebase against GUARDRAILS.md, report pass/fail per rule, and propose new rules for risks not yet covered
---

Read `GUARDRAILS.md` at the repo root. If it doesn't exist, create it first by asking the user whether to seed it with the standard code-content + process rules (no secrets, validate external/boundary input, handle async/subprocess errors explicitly, dependencies locked, tests exist and pass, docs stay current, review commands present, CI status) before proceeding — don't invent rules unilaterally on a first run without at least flagging what you're about to add.

## Part 1 — check existing guardrails

Go through every numbered rule in GUARDRAILS.md and check the current codebase against it. For each rule report: **PASS** or **FAIL**, plus the concrete evidence (file:line, command output) — not just an assertion. Don't assume which language/tooling the rule applies to (shell script, Dockerfile, TypeScript, etc.) — read the rule and check it against whatever files actually exist in this repo that match its intent.

- Code-content rules: grep/read the actual source files the rule concerns.
- Test rules: discover the real test command from `package.json` `scripts` (or per-workspace scripts in a monorepo), actually run it, and report its real output — don't assume `npm test`.
- Doc-currency rules: compare the referenced doc's described architecture/commands against the real files.
- Review-tooling rules: confirm the referenced `.claude/commands/*.md` files exist and their content (referenced paths and commands) actually matches this repo, not a different project's.
- CI rules: check for `.github/workflows/` or equivalent; report present/absent only if the rule says absence isn't itself a failure.

## Part 2 — propose new guardrails

Separately from the check, look at the current codebase for any real risk pattern that isn't covered by an existing rule (e.g. a new script added without input validation, a new external call with no pinned version, a new route/tool with no test, money-moving code that doesn't re-validate server-side). For each one found:

1. State the specific risk and where it lives.
2. Propose exact wording for a new numbered rule.
3. Ask the user for approval before appending it to GUARDRAILS.md. Never add a rule without asking first.

If nothing new is found, say so — don't invent filler rules to pad the list.

## Summary

End with a compact table: rule number, one-line description, PASS/FAIL/N-A, and a list of any newly proposed (not yet approved) rules.