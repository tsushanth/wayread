---
description: Map a multi-repo product — which repos/components implement which capabilities, the cross-repo links that don't show up in any single repo, and whether each component is verified against what's actually deployed. The multi-repo, product-level layer above /wayread:system-overview.
argument-hint: "[capability name | file path] | change <description> | update"
---

`/wayread:system-overview` sees one repo. A real product is usually several repos — a web app, a backend/engine, one or more SDK/client repos, a docs repo — and nobody keeps a single picture of "this capability lives in these repos, these folders, roughly these files" or "if I change X, here's every place that touches it." This command builds that picture, and flags the cross-repo links and deployment mismatches that are easy to miss when you read one repo at a time.

## Modes

- **No argument / `map`:** build the product-level map fresh and publish it.
- **A capability name or a file path as `$ARGUMENTS`:** drill into the file-level layer for just that one part, live. Don't precompute this for the whole product — it's produced on demand.
- **`change <description>`:** given a described change, list the repos and files it would likely touch, in a rough order. This is a lightweight companion to `/wayread:explain-approach` (which plans a change in depth for one repo) — use this mode first, to figure out which repos you even need to touch, before running the real planning command on each one.
- **`update`:** refresh a previously published map's component and deployment-verification layers without rebuilding every capability's file-level detail from scratch.

## Steps

1. Load the `artifact-design` skill, then `artifact-diagramming`, before writing anything.

2. **Discover the product's repos. Don't assume.** Look for a `CLAUDE.md`, `README.md`, or docs folder (in the current repo or a sibling one) that names the other repos making up this product and their roles. If repos sit as sibling directories (a common layout: a folder holding several repos side by side), scan sibling directories for `.git` folders and read each candidate's `README`/`package.json`/equivalent for a one-line sense of what it is. A repo can hold more than one architectural layer (a combined web+API repo contains both a frontend and a backend internally) — don't assume one repo equals one layer, and say explicitly which layers live inside which repo. **If it's ambiguous which repos belong to "the product," ask the user rather than guessing** — including an unrelated repo, or missing the engine repo, makes the whole map wrong, and that mistake isn't worth the time saved by guessing.

3. **Reuse an existing code-map doc per repo, if one exists**, the same way `/wayread:trace` does: check each repo for `docs/code-map/*`, `ARCHITECTURE.md`, or a `CLAUDE.md` with an architecture section before re-deriving it from scratch. Verify the doc's claims against the current code rather than trusting or ignoring it — note anything it claims that's no longer true, and anything it's missing that now exists.

4. **Build the ladder, one layer at a time:**
   - **Product level.** List the product's main capabilities in plain language — what a user can actually do. Source this from docs plus a skim of each repo's top-level structure, not from invented feature names.
   - **Component level.** For each capability, name the repo(s) that implement it and the top-level area within each repo (the folder, service, or module) that does the work. Reuse `/wayread:system-overview`'s own per-repo discovery approach (read entry points, top-level packages, how they're wired) but scoped to placing this one capability — don't regenerate a full single-repo architecture overview for every component.
   - **File level, on demand.** Only when `$ARGUMENTS` names a specific capability or file path: drill into the actual files, entry points, and data model involved, live, at the time the command runs.
   - **Cross-repo links.** Call this out as its own deliberate pass, not something that falls out of reading each repo on its own — this is usually the hardest part to find and the most valuable to document. Grep across repos for shared identifiers: a database table or column name two repos both read or write, an internal API/webhook path one repo calls on another, an env var or bearer-token name both sides reference, a queue or topic name, a shared constant or schema file duplicated across repos. Draw each one as a connection in the component diagram with a one-line description of what crosses the boundary (data, a call, an event) and in which direction.

5. **Check what's actually deployed, not just each repo's default branch.** Trust nothing here by default: a repo's running code can differ entirely from its default branch. For each repo/service in the map with an identifiable deployment (look for `fly.toml`, `Procfile`, `vercel.json`, a Dockerfile plus CI deploy step, or whatever platform config is actually present — don't assume Fly specifically), find what's actually live with read-only platform commands (`flyctl status` / `flyctl releases` for Fly; the equivalent read-only listing for whatever platform you find) and, where feasible, fingerprint the running code against git history:
   - For an interpreted/source-deployed service: hash files inside the live instance/container and diff against candidate commits.
   - For a compiled or bundled service: grep the deployed build output for distinctive symbols or strings instead, since minified/bundled output won't hash-match source directly.
   Mark each component with one of: **verified against production**, **matches branch `X` (not default)**, or **could not verify** — never silently present "what's on main" as "what's live." Record the timestamp of this check on the page; it goes stale.

6. **Read-only, always.** Never deploy, never change a secret, never start, stop, or wake a machine, never write to a production database. A read-only aggregate query against a database is fine if available and kept away from content/PII columns. This command only reads and reports — no exceptions for any mode, including `change`.

7. **`change <description>` mode.** Given the description, list the repos and files likely touched, roughly ordered by where the change probably needs to start (e.g. a schema or contract change before the consumers of it). Keep this shallow — it's a routing aid to tell you which repos to open `/wayread:explain-approach` against, not a substitute for that command's own depth.

8. **Report.**
   - Publish one Artifact via the `Artifact` tool, at a stable file path so `update` republishes the same page instead of creating a new one (same pattern as `/wayread:system-overview`).
   - Include a real diagram at the component level: repos as nodes, cross-repo links drawn as actual connections with their labels (data/call/event and direction) — not a bullet list. Follow `artifact-diagramming`'s guidance on when a diagram earns its place before adding more diagrams beyond this one.
   - Show each component/repo's deployment-verification status visibly on the page (a badge or tag next to the entry), not buried in prose — a reader should be able to tell at a glance which parts of the map are confirmed live and which are unverified.
   - For `change` mode, report the routing list directly; still publish/update the underlying map if one doesn't exist yet or is stale, since the change list depends on it.
   - State the date/time of the deployment check, and which repos were included in or excluded from the map and why (especially any the user resolved for you in step 2).

## When to use this

Onboarding to a product built from several repos, before planning a change that's likely to cross repo boundaries, or any time "which repos does this actually touch" needs answering fast rather than rediscovered by hand. Run `/wayread:system-overview` afterward on any one repo for its own internal detail.
