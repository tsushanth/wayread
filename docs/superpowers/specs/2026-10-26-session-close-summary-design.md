# Session-close summary tracking — design

## Intent

Right now, understanding what happened in a Claude Code session requires either remembering it or running `/sush-session-map` by hand on a specific session. There's no running record. The user wants to be able to look at git history and see, across every project, what he worked on, session by session — without asking Claude to reconstruct it each time.

## Goals

- A compact, readable, three-part summary per session: **where we started, where we ended, what is left.**
- Git-committed automatically — not something the user has to remember to run.
- Stored **alongside the product repo** when a session was centered on one repo (so the history of that repo shows its own work log in context); stored in a **dedicated, date-organized root folder** when a session was genuinely cross-cutting (spanned many repos, like this one did).
- **No new recurring, unattended API spend.** The summary gets *written* only as part of a session the user already started for his own reasons — never by a background process Claude spawns on its own after the user has left.

## Non-goals

- This does **not** replace `/sush-session-map`'s full interactive node graph + published Artifact. That stays a separate, on-demand, deep-dive tool for understanding one long or tangled session. This feature is the lightweight, always-on log; the full map is the thing you reach for when a log entry isn't enough.
- This does **not** guarantee the summary exists within seconds of the session closing. It lags until the next Claude Code session starts (anywhere, not necessarily in the same repo). Accepted explicitly by the user to avoid the spend tradeoff.
- This does **not** auto-push blindly. Pushing (even of a markdown-only file) goes through the same secrets-scan habit already established in this environment before anything leaves the laptop.

## Anti-goals

- Silently failing to flag a closed session. Losing track of a session is the exact failure this feature exists to prevent — if the flag-write fails, it should fail loudly in the hook's own stderr/log, not swallow the error.
- Nagging. If the user starts ten sessions in a row, he should not see "N sessions need summaries" ten times in a way that feels like noise. One quiet line, then get on with the actual session.

## Constraints (from how Claude Code actually works)

Confirmed via Claude Code's hooks docs (code.claude.com/docs/en/hooks) during this design conversation:

- **`SessionEnd` fires on session close** (`reason` ∈ `clear`, `resume`, `logout`, `prompt_input_exit`, `other`), with `session_id`, `transcript_path`, `cwd` in its payload. It runs a **shell command only** — it cannot invoke Claude itself, and it has a tight default timeout (1.5s, extendable to 60s via config).
- Writing a real "where we started / ended / left" summary needs Claude's judgment (the same kind of reading `/sush-session-map` already does) — a shell hook can't do that work itself.
- **Resolution:** `SessionEnd` only *flags* the session (writes a small sentinel: `session_id`, `transcript_path`, `cwd`, `reason`, timestamp) to a pending-queue location. The actual digest → write → commit happens later, triggered by a `SessionStart` check in some *future* session — any session, not necessarily one touching the same repo.
- The docs don't confirm `SessionEnd` fires on every real-world exit path (terminal close, Ctrl+C, `kill`). This needs to be tested, not assumed, once built.

## Builder-check: gaps found, and the calls made to resolve them

A fresh builder read this design cold and raised 11 real gaps. None of them changed what the user already decided (the 3-part content, the repo-vs-root split, the no-new-spend trigger) — each is resolved below using that plus the hard rules already in force in this environment (`~/Documents/GitHub/CLAUDE.md`'s mandatory pre-push secrets scan; wayread being a *public*, distributed plugin). Flagged for the user to correct if any of these guesses are wrong.

1. **Hook installation scope.** wayread is a public plugin installed by other people. The `SessionEnd`/`SessionStart` hooks must **not** ship in the plugin's own `hooks/hooks.json` (that would silently turn this on for every wayread install everywhere). The hook *wiring* goes in the user's own personal `~/.claude/settings.json`, added via the `update-config` skill, opt-in, on this machine only. wayread ships the script/command logic the hooks call; it ships no hook registration itself.
2. **Who actually writes the prose — a hook can't invoke Claude.** The `SessionStart` hook's only job is to inject additional context into the new session noting how many flags are pending. From there, it's ordinary work inside that already-running session: Claude reads the flagged transcript(s) with normal tool calls (Read/Bash) and writes + commits the summary itself, early in that session, before or alongside the user's actual request. This is exactly the "no *new* spend, just incorporated into a session you were already having" tradeoff the user already chose — not a separate background job.
3. **Dirty/worktree/deleted repos.** Always `git add` only the one new summary file, never the whole tree — a dirty, mid-rebase, or worktree-based repo doesn't block adding one new file at a known path. If the repo directory itself no longer exists, fail loudly into the catch-up step's own output (never silently drop) and leave the flag marked skipped rather than deleted.
4. **`session-map.mjs` doesn't parse tool-call content today (no `cd`/`git -C`/file-path extraction).** Confirmed real, accepted scope — this is net-new parsing work for whoever builds this, not a tweak to existing code. Noted here so the plan accounts for it rather than discovering it mid-build.
5. **80% threshold ties / zero-repo sessions.** Default to the **root folder** on any tie, ambiguity, or a session that touched no repo at all (a pure planning/chat session has nowhere single to attach to anyway) — the inclusive bucket is the safe default, not the specific one.
6. **Does `session-logs` skip the secrets scan?** No. `~/Documents/GitHub/CLAUDE.md` already mandates the scan on every push, no exceptions, and nothing about a personal tracking repo overrides that. Corrected: the secrets scan runs before every push this feature makes, product repo or `session-logs` alike.
7. **Multiple pending flags, processing order, indefinite accumulation.** Every `SessionStart` catch-up processes **all** currently-pending flags, not just one — each written to its own correct repo/root-folder location, synchronously, before the user's first prompt gets a real response. Processing the whole queue every time means it can't silently grow forever.
8. **A flag whose transcript was already deleted (30-day retention).** Don't silently drop it. Write a minimal fallback entry — "session `<id>` ended on `<date>`; its transcript was no longer available to summarize" — so there's still a visible trace, then clear the flag.
9. **Concurrency on the pending-flag directory.** One file per `session_id` means `SessionEnd` writers never collide. On the read side, a `SessionStart` catch-up claims a flag by renaming it to a `.processing` suffix before working on it and deleting it on success, so two near-simultaneous catch-ups can't double-process the same flag.
10. **"What's left" needs model judgment — isn't that the same cost as the full map this is supposed to be lighter than?** No: this log entry skips the full map's node-graph/status/quote-verification machinery entirely. It's three short paragraphs written directly from the plain digest chunks (`session-map.mjs digest`'s existing output), not a `map.json` build. Genuinely cheaper, not a re-run of the heavy tool.
11. **No registry linking a session to a published Artifact URL, so "link the full map if one exists" is undetectable in general.** Dropped for v1. The link only gets included when `/sush-session-map` itself is what triggers a write for its own session (it already knows the URL in that moment); the general catch-up path never attempts to detect this and omits the link.

## Resolved: storage layout

- **Pending-flag location:** one JSON file per ended session at `~/.claude/session-map-pending/<session_id>.json` — machine-level, not inside any repo (the repo isn't known until the flag is processed).
- **Root folder (cross-cutting sessions):** a new, dedicated git repo at `~/Documents/GitHub/session-logs/`, laid out `YYYY-MM-DD/<slug-or-session-id>.md`.
- **Per-repo location (centered sessions):** `docs/session-log/YYYY-MM-DD-<slug>.md` inside the product repo, mirroring wayread's own `docs/superpowers/specs/` dated-file convention.

## Decided (the user's own words, this conversation)

- *"alongside in the product repo makes sense. that way we have some sense of where the work went. if it was across all then have a rootfolder for them across date."* — the repo-vs-root split above.
- *"3 things. where we started. where we ended. what is left."* — the content shape.
- Chose the deferred, flag-now/write-at-next-start trigger specifically to avoid a new recurring, unattended API cost against the user's self-set spend cap.

## Decided: push behavior

Auto-push, always — committed summaries push immediately (after the mandatory secrets scan), no manual step. Confirmed by the user.

## Backfill (once this is built)

Once the flag/catch-up tooling above exists, retroactively run the same digest → summarize → write → commit → push flow across every session Claude Code still has a transcript for (subject to the 30-day retention limit — older ones are already gone, see item 8 above). Each session's summary is independent of every other session's (no shared state, same digest script, different output file) — this is exactly the shape `superpowers:dispatching-parallel-agents` is for: one agent per session, dispatched concurrently, each given one `session_id`/`transcript_path` and told to run the catch-up logic for just that one session and report back where it wrote the summary. Not done now — explicitly deferred until the tooling itself exists to run.

## Phase 2 (deferred, not designed yet)

Once summaries have been accumulating for a while, build a **pull-on-demand** (not a standing report) analysis layer on top of the `session-logs`/per-repo history: time spent, hands-on (user actively watching/answering) vs. hands-off (Claude working autonomously) ratio, spend vs. the user's self-set cap, and pattern-mining across recurring manual tasks to propose new commands/automation. The query shape is time-bounded — "last week," "last month," or an explicit start/end date range — not a single running total.

**What "propose new automation" means, concretely (the user's own example):** if the logs show the user repeatedly doing something manually — his example is manually checking sound quality from voice models — the suggestion isn't just "you did this 9 times, consider automating it." It's Claude actually going and researching whether something existing already solves it, or scoping out what a build would look like to cut the manual step, and bringing back that research/scope, not just the pattern observation.

Deliberately not designed in this document — there's nothing real to design against until phase 1 has produced actual log data to shape it around.
