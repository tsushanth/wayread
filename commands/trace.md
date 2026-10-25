---
description: "Trace one real use case through the code (\"a user resets their password\", \"an order is placed\") and publish a walkthrough Artifact: numbered steps, a sequence diagram, the key code with function names, optional live proof, and what to say when someone asks to see it."
argument-hint: <use case in plain words, e.g. "user resets their password"> [live] [save]
---

Build a demo pack for ONE use case in this codebase, for someone who needs to explain or show how it works without having written the code (including code AI wrote). The trace is the product, not a code tour.

`$ARGUMENTS` is the use case in plain words. If it contains the word **live**, also run the live proof in step 7. If it contains **save**, also save the Markdown copy (step 9). If there is no use case, ask for one; do not guess.

## Steps

1. **Load skills first.** Load `artifact-design`, then `artifact-diagramming` (the page uses inline SVG). If the repo has a code map (`docs/code-map*`, `ARCHITECTURE.md`, `CLAUDE.md`), read it first for orientation, and note its "Deployed state" section.
2. **Find the code that is actually live, not just what is checked out.** Check the working tree is the deployed version: look at the deploy files (`fly.toml`, CI), `git branch -a`, and if you have access, read-only release listings (`flyctl releases`). Say which branch/commit and release the trace is based on. If the checkout is stale or differs from what is deployed, trace the deployed version via `git show`, do not check anything out, and say so on the page.
3. **Trace the path end to end.** Start where the use case begins (an HTTP route, a webhook, a user action, an event) and follow it to where it ends (a side effect, a response, a stored row). Record, in order, each hop: function name, file, approximate line, what it decides, and what it hands to the next hop. Include the branches that matter (guards, fallbacks, safety nets, feature flags) and the external systems touched (carrier, database, payment, LLM). Every claim must come from code you read. Mark anything inferred as "inferred".
4. **Reduce it to six to eight steps in plain words**, no jargon without a gloss. One sentence each. Put the safety nets and guards in a short note under the steps.
5. **Choose 3 to 6 snippets**: only the lines where a decision is made, each with its function name, approximate line, the step it belongs to, and a one-sentence explanation. Prefer function names over line numbers and say line numbers drift. Never include secrets, keys, customer data or real phone numbers; redact them.
6. **Draw the sequence diagram** as hand-authored inline SVG (not Mermaid, so it renders reliably everywhere): one lane per participant (caller or user, the service, the model or database, external systems), numbered arrows that match the steps, solid for requests and dashed for replies, short arrow labels, and a figure caption stating the claim.
7. **Live proof (only if `live` is in `$ARGUMENTS`).** Reproduce the use case once against a SAFE environment (a test or proof-of-concept deployment or a local run, never production with real customers) and capture the log lines, mapping each to a step. Rules: use fictional numbers and test accounts; do not dial real people; do not touch production data; restore any flow or setting you changed; tear down anything you started (scale services to zero, stop databases). State what environment it ran in and how it differs from the deployed version. If no safe environment exists, skip this step and say so on the page instead of improvising.
8. **Write the page and publish it** via the `Artifact` tool with a stable file path per use case (kebab-case of the use case, so re-running updates the same page). Sections, in order: the one-line summary and source/version; the steps; the sequence diagram; the code (function names first, lines as hints); the live proof if run; then three short cards: "Say out loud" (what is true and how it is verified: tests, scripted calls, logs, guards; say plainly if AI wrote most of it), "Tell them first" (known gaps and anything that differs between main and deployed), "Do not show" (environment variables, customer data, real numbers, security-sensitive verification details; share excerpts, not repo access). Theme-aware, readable at phone width, diagram may scroll sideways inside its own container.
9. **Save a Markdown copy (only if `save` is in `$ARGUMENTS`)** to `.wayread/demo-packs/<use-case>.md` in the project (add `.wayread/` to `.gitignore` if it is not already ignored), or to the notes folder the user names, and open it for the user. Never write it into a public repo.
10. **Report** the artifact URL, which version of the code it describes, whether live proof was run and where, and the top gap you found while tracing (a guard missing, a doc that disagrees with code, a branch that is dead).

## Rules

- Read-only on the repo: no edits, commits or deploys. The live proof is the only action that touches anything, and only a safe environment.
- Accuracy over completeness. A smaller trace that is verified beats a long one with guesses; label inferred steps.
- The page must still be useful in a year: put the commit, release and date at the top so a reader knows how stale it is.
- Do not put exploitable weaknesses on the page. Describe known gaps in terms of behavior ("a user who asks for a refund on a flow with no refund path hears X"), and keep security findings in private notes and tell the user directly.
