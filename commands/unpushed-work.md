---
description: Find git work that exists only on this machine — branches ahead of their remote, stash entries, and commits orphaned by a reset or a dropped stash — in this repo or swept across every repo under a folder. Reusable from other commands as a pre-flight check.
argument-hint: "[sweep <root>] [path...] — omit for the current repo"
---

Local disk is not durable. A commit that only exists on this laptop is one disk failure, one `git reset --hard`, or one accidental `rm -rf` away from gone, and it never shows up in `git status` once it's committed — only `git log` against the remote reveals it. This command finds that risk and reports it; it never pushes anything itself.

## What it finds, per repo

- **Branches ahead of their remote.** Includes the branch you're on. A repo with no remote at all has every commit on every branch reported this way, since none of it exists anywhere else.
- **Stash entries**, by their description.
- **Orphaned commits** — not reachable from any branch, remote or tag (from a `reset --hard`, a deleted branch, or a dropped stash). These are not necessarily lost: the reflog holds them for a while (90 days by default), and if the branch was squash-merged, the content may already be safe elsewhere under a different commit. They're still worth a glance, because sometimes they're real unmerged work nobody pointed a branch at.

## How to run it

The work is done by `${CLAUDE_PLUGIN_ROOT}/scripts/unpushed-work.mjs`, a script with no dependencies that needs Node 18+ and git. If that variable is empty in the shell, find it with `find ~/.claude/plugins -path '*wayread*/scripts/unpushed-work.mjs' | head -1`. Use the full path every time; shell state does not carry over between calls.

- **No arguments, or a path:** `node <script> scan [path...]` — scans the current repo (or the given paths), prints a report, and exits 1 if anything was found (0 if everything is clean). Fetches by default, which needs network access to each repo's remote; add `--no-fetch` to check only against what's already known locally (faster, and the right choice when sweeping many repos or when offline).
- **`sweep <root>`:** finds every git repo under `root` (default max depth 3, skipping `node_modules` and similar) and scans each one. Add `--days N` to skip repos with no commit in the last N days — the right call on a machine with hundreds of old or archived repos, where fetching all of them would be slow and mostly noise. Add `--max-depth N` if repos sit deeper or shallower than 3 directories down.
- **`--json`** for a machine-readable array (one object per repo) instead of the text report.
- **`--quiet`** lists clean repos only in the final summary line, not one by one — the right default when sweeping many repos and most are clean.

`$ARGUMENTS` maps straight onto these: empty means scan the current repo; `sweep <root> ...` sweeps; anything else is passed through as paths and flags to `scan`.

## What to do with the results

1. Run the scan (or sweep) and read the report.
2. **Report what was found, plainest risk first:** a repo with no remote, then branches ahead (especially ones not checked out, since those are the easiest to forget), then stash entries, then orphaned commits. Name specific branches and repos; don't summarize them away.
3. **Never push, drop a stash, or run `git gc` yourself.** Whether to push a given branch is the user's call — it might be deliberately unpushed (secrets, a half-finished spike, something another session is still using), and `git gc` can make an orphaned commit unrecoverable. Ask, and offer to push only the specific branches the user names.
4. If asked to push: confirm the exact branch and remote first (`git push <remote> <branch>`, or `-u` if it has never been pushed), run it, and report what happened. Follow this project's own git-hygiene rules (clean worktree, no force-push to a shared default branch) if `CLAUDE.md` or project memory states any.
5. For an orphaned commit worth keeping, the fix is a new branch, not a push: `git branch <name> <sha>`, then push that. Don't do this without being asked to.

## Using it from inside another command

A few of this plugin's commands finish a unit of work and are a natural point to check nothing from that work is about to be left behind. When wiring this in elsewhere:

- Call `node <script> scan --no-fetch --quiet` (no fetch: this is a quick local check, not a full audit) on the repo the other command is already working in.
- Report findings the same way this command would, in the same step where that command reports what it did.
- Never gate or block on the result — this is a surfaced fact, not a pass/fail check, and the other command's own flow and approvals still apply.
- Don't re-run the full scan logic by hand; call the script.

## When to use this

Run it standalone when you want to know what's at risk on this machine, or periodically as a sweep over everything. It's also worth running before trusting a codebase map or a release decision to be complete — `/wayread:system-overview` and `/wayread:code-review` only see what's committed and pushed to the ref they're reading, so real work sitting on an unpushed branch is invisible to them unless this command surfaces it first.
