---
description: Write the close-out summaries for sessions that ended without one. Each pending session gets three short paragraphs (where we started, where we ended, what is left), committed to its repo's docs/session-log/ or to the cross-project session-logs folder. Runs on its own after a session starts, or by hand.
argument-hint: (no arguments)
---

When a Claude Code session ends, a hook leaves a pending flag for it. Nobody reads those flags unless someone comes back to them, so this command drains them: for each session that ended without a summary, it reads that session's transcript and writes a short close-out note into git. The work is done by `${CLAUDE_PLUGIN_ROOT}/scripts/session-log.mjs`, a script with no dependencies, plus `session-map.mjs digest` for reading the transcript. The script decides where each summary lives (the product repo's `docs/session-log/`, or the `session-logs` folder for sessions that span repos); this command never picks a path itself.

## What it needs

- **Node 18+ and git.** If `${CLAUDE_PLUGIN_ROOT}` is empty in the shell, find the scripts with `find ~/.claude/plugins -path '*wayread*/scripts/session-log.mjs' | head -1` and `find ~/.claude/plugins -path '*wayread*/scripts/session-map.mjs' | head -1`. Use full paths on every call: `node <path> <command> ...`. If `node` is not available, say so and stop.
- **The session files on disk.** A transcript that Claude Code has already deleted cannot be summarized; the script writes a one-line fallback note for it instead.

## Where the scratch files go

One folder per session: the session scratchpad directory if the system prompt names one, otherwise `${TMPDIR:-/tmp}/wayread/session-log/<first 8 characters of the session id>/`. It holds `digest/` (the chunks you read) and `summary.md` (the note you write). Nothing goes in a repo until `publish` runs.

## Steps

1. **List what is pending.** Run `node <script> pending --json`. It prints a JSON array of flags, each with `session_id`, `transcript_path`, `cwd`, `reason` and `ts`. If the array is empty, say "No session summaries pending." and stop.

2. **Handle each flag in turn, never in parallel.** Every publish is a git commit and push, and two sessions can share a repo. Do one flag fully before starting the next.

   a. **Claim it.** Run `node <script> claim <session_id>`. It prints the claimed flag as JSON and exits 0. If it exits 1 with no output, another session already claimed it (or it has gone). **Skip that flag and move on. Do not run `fallback` on it**: the other session owns that flag, and a fallback note would overwrite its work.

   b. **Check the transcript.** If `transcript_path` from the claimed JSON does not exist (`test -f`), run `node <script> fallback <session_id>`, check the exit code, and move on to the next flag.

   c. **Digest the transcript.** Run `node <session-map script> digest <transcript_path> --out <scratch folder>/digest`. Then Read every `digest-NNN.txt` it lists, in order. Do not sample. Turns are numbered: `H12` is the 12th message from the user, `A12` is Claude's reply to it.

   d. **Write the summary.** Write `<scratch folder>/summary.md` in exactly this shape, three short paragraphs and no other sections:

      ```
      # Session <short-session-id> — <date>

      **Where we started:** <one short paragraph>

      **Where we ended:** <one short paragraph>

      **What is left:** <one short paragraph>
      ```

      Use the session's short id (the first 8 characters) and the date from the flag's `ts`. Use the user's own words where the transcript shows a clear decision, and quote them rather than paraphrase. State outcomes and open items in plain words. If the transcript does not show something, say it is unclear rather than guess.

   e. **Publish it.** Run `node <script> publish <session_id> --content-file <scratch folder>/summary.md`. Exit 0 means the summary is committed and pushed and the flag is cleared. `publish` prints nothing on success. A non-zero exit means the flag is now marked `.failed` for the user to look at. Do not retry it.

3. **Report once.** After all flags are handled, give one short line: how many summaries were published, how many were fallbacks, how many were skipped because another session had them, and how many failed. Name the failed session ids. Do not narrate each repo lookup.

## What this does not do

- It does not run on a schedule. It runs when a session starts, through a SessionStart hook configured in your personal `~/.claude/settings.json` (the plugin itself does not ship or auto-install that hook), or when someone runs it by hand.
- It does not retry failures. A failed flag stays in the pending folder as `.failed` until someone looks at `errors.log` and decides.
- It does not read tool output or file contents beyond the conversation transcript the digest produces.
- It does not push to anything except the git remote of the repo `publish` writes to.
- It does not recover a flag stuck as `.processing` after a claim that never finished publishing or falling back (for example, the session crashed mid-catch-up). That file has to be found and deleted by hand under `~/.claude/session-map-pending/` (or `$CLAUDE_CONFIG_DIR/session-map-pending/` if that variable is set).

## When to use this

When you start a session and see a summary is waiting, or after several sessions have ended and you want their close-out notes written. Nothing else needs it: a session that ends normally gets flagged automatically.
