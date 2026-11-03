---
description: Map every git worktree to the Claude session that made it, compare what it holds against what is in production (GitHub PR state, Fly release time, Android tags), and decide per worktree: drop it, push it to take it to production, or keep it. Read-only; prints the commands, runs none.
argument-hint: "[--fast] [--repo <text>] [--json] [--fetch] [--idle-min N] [--stale-days N]"
---

Worktrees pile up: every agent and every session makes one, and after a few days nobody can say which hold unshipped work, which are already in production, and which were experiments. Dropping the wrong one loses work; keeping them all fills the disk (and below ~6 GB free, Android builds stall). This command answers, for every worktree: **drop it, push it to take it to production, or keep it, and why.**

## What it reports

For each git worktree it finds (under `~/Documents/GitHub`: `worktrees/`, `_wt/`, each repo's `.claude/worktrees/`, plus anything registered with a repo):

- **Which Claude session made it.** A session that started inside the worktree's folder, else the session whose transcript shows `git worktree add` for it (subagent transcripts count toward their parent session), else the one that mentions it most. Sessions are listed newest first with their first prompt as a title and a note when a session is still active.
- **What it holds.** Uncommitted files, commits that exist on no remote, commits not in the default branch, whether the branch is pushed, whether it would conflict with main, whether it touches tests, how long it has been idle.
- **How that compares with production.** PR state from GitHub (merged / open / closed). For merged work, Fly: the app's latest completed release against the merge time (merged after the last release means NOT deployed; before it means "likely live", because a release does not record which commit it was built from). Android: a play/release/v tag that contains the merge commit. Cloudflare workers, Cloud Run and launchd jobs are reported as "not checkable", never guessed.

## The decisions

| Decision | Meaning |
|---|---|
| **DROP: already in production** | Merged, and a release came after the merge. Safe. |
| **DROP: nothing unique / merged / abandoned / experimental** | Nothing would be lost (at or behind main; PR merged with no deployable paths; PR closed unmerged; experimental or untouched for weeks). If it still has commits on no remote, it is listed separately with the push command first. |
| **PUSH+PR: take to production** | Unique recent work, not experimental, no conflicts with main, no PR yet: push the branch and open a PR. |
| **PUSH FIRST** | Commits made after its PR merged, so they exist only here. |
| **KEEP: merged, not deployed yet** | Merged to main but the last release is older than the merge: deploy it (or decide it should not ship) before dropping. |
| **KEEP: in review / uncommitted changes / in use right now / no remote / policy hold** | Not touched. Worktrees matching a hold in your policy file are kept and never suggested for production. |
| **DECIDE** | Between fresh and stale, or it conflicts with main: the facts are printed with a lean. |

## How to run it

The work is done by `${CLAUDE_PLUGIN_ROOT}/scripts/worktree-audit.mjs`, a script with no dependencies (Node 18+, git; `gh` and `flyctl` give the production comparison). It is read-only: it never pushes, removes, fetches (unless `--fetch`) or deploys. If `node` or that file is missing, say so and stop. Use the full path every time.

`node ${CLAUDE_PLUGIN_ROOT}/scripts/worktree-audit.mjs $ARGUMENTS` (if that variable is empty, find the script with `find ~/.claude/plugins -path "*wayread*/scripts/worktree-audit.mjs" | head -1`) with:

- **no arguments:** everything, with GitHub, Fly and session lookups. The first run indexes recent session transcripts (it can take a few minutes; later runs reuse a cache). Run it in the background if the shell has a timeout.
- `--fast`: git facts only (no GitHub, no production check). About 1.5 minutes for ~160 worktrees. Good for a disk cleanup.
- `--repo <text>`: only repos whose path contains the text. `--json`: machine-readable. `--all`: also list main checkouts.
- `--fetch`: `git fetch --prune` each repo first (network). Without it, remote branches are as of the last fetch, and the report says so.
- `--idle-min N` (default 120): a worktree is "in use" if its files were touched, or a session's own command named it, within that many minutes, or a session that started inside it is active (a live session that merely owns many older worktrees does not make them all "in use"); `--stale-days N` (default 14); `--days N` how many days of sessions to index (default 21); `--no-gh`, `--no-prod`, `--no-sessions`.
- `~/.claude/worktree-audit-policy.json` adds holds: `{"hold":[{"match":"repo or path text","why":"..."}]}`.

## What to do with the results

1. Run it and read the report. **Report by decision, safest first:** what can be dropped now (the printed `git worktree remove` lines), what needs a push, what is merged but not live, what needs a human decision, what is untouchable. Name the session behind each group so the owner can see whose work it is.
2. **Say how sure each production claim is.** "Likely live" is an inference from release time, not proof; "not checkable" means the script could not look. Before telling the owner a feature is in production, confirm with a read-only check of the live app (see the compare-against-production rule), not from this report alone.
3. **Never remove, push, deploy or merge from this report on your own.** Removal is the owner's go (or the disk-cleanup tier-2 rules). Never touch a worktree whose session is active, with uncommitted changes, or that holds the only copy of commits. `git worktree remove` leaves the branch and its commits in the main repo, but a repo with no remote is one disk failure from losing them.
4. If asked to act: drop only the "safe to drop" list; for PUSH+PR confirm the branch and remote, push, then `gh pr create` (private repos end the PR body with the standard Claude Code line; public repos get no AI attribution); for KEEP-deploy, follow the deploy hygiene (clean worktree at origin/main, rollback image recorded, verify live) rather than deploying from the worktree.
5. Pair it with `/wayread:unpushed-work` (stash entries and orphaned commits) and `/sush-disk-cleanup` (the disk side).

## When to use this

After a busy day of parallel sessions, before a disk cleanup, before trusting "it's in prod", and whenever the question is "which of these branches should I ship and which can go".
