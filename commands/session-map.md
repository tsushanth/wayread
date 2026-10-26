---
description: Map how a long conversation moved: a route of the decisions made, with branches for what was ruled out, parked, never pursued, or left open, every node backed by a checked quote. Update it as the conversation goes on, and restart the missed threads in parallel.
argument-hint: [session id | latest | path] | update [session id] | resume <node ids | open>
---

Long conversations lose their shape. After days of work you remember where you are but not which options were dropped and why, or which questions were never answered. This command reads a Claude Code session and draws it as a route map: one line down the middle for the decisions that shaped the work, and branches off it for everything else, color-coded:

- **Decided** (green check): chosen, or accepted.
- **Ruled out** (red cross): rejected by you, or killed by evidence.
- **Parked** (amber pause): explicitly put off.
- **Never pursued** (dotted ring): an option someone raised and nobody picked up.
- **Open question** (purple ?): asked, not answered.
- **You are here** (teal): where the conversation stands now.

Every node carries a quote from the transcript, and a script checks that each quote really appears in the turn it cites. Anything that fails is drawn with a dashed outline. The map is a model's reading of a conversation, so statuses are judgement calls, but the quotes are checkable.

## Modes

- `/wayread:session-map [session id | latest | path]` builds a new map. With no argument it asks which session; `latest` is the newest session in this project.
- `/wayread:session-map update [session id]` adds what happened since the last build.
- `/wayread:session-map resume <node ids | open>` restarts threads from the map: the ones that were missed, parked or left open. `open` means every parked, never-pursued and open node.

## What it needs

- **Node 18+.** The work is done by `${CLAUDE_PLUGIN_ROOT}/scripts/session-map.mjs`, a script with no dependencies. If that variable is empty in the shell, find it with `find ~/.claude/plugins -path '*wayread*/scripts/session-map.mjs' | head -1`. Use the full path on every call: `node <path> <command> ...`. If `node` is not available, say so and stop.
- **The Artifact tool** to publish. Without it the script still writes `map.html`; give the user that path.
- **The session file on disk.** Claude Code keeps sessions under `~/.claude/projects/` and deletes them after 30 days by default. A map keeps its quotes, but it can only be rebuilt or updated while the session file still exists.

## Where the files go

One folder per session, outside any repo: the session scratchpad directory if the system prompt names one, otherwise `${TMPDIR:-/tmp}/wayread/session-maps/<first 8 characters of the session id>/`. It holds `digest/` (the chunks you read), `map.json` (the map, which you write), `map.html` (the page, written by `build`) and `briefs/`.

## Building a map

1. **Digest the session.** `node <script> digest <session> --out <folder>/digest`. It prints how many turns, prompts and compactions there are and lists the chunk files. Turns are numbered: `H12` is the 12th message from the user, `A12` is Claude's reply to it. Long pasted prompts and long replies are trimmed in the digest.

2. **Read every chunk, in order.** Use the Read tool on each `digest-NNN.txt`. Do not sample. The point of the map is the things that are easy to miss. Note, as you read: directions chosen, options rejected and why, anything put off, options offered that nobody picked, questions left hanging, standing rules that came up, and moments where an earlier thread was finally picked up.

3. **Write `map.json`.**
   - Top level: `title` (two to four words), `sessions` (`[{ "id": "<session id or first 8 characters>", "label": "<what the session is called>" }]`), optional `note` (one sentence for the footer), `nodes`, optional `links`, optional `events`.
   - Each node: `id` (short, unique), `status` (one of `decided`, `rejected`, `deferred`, `unexplored`, `open`, `now`), `title` (up to about six words), `src` (the turn the quote comes from: `H12` or `A12`; with several sessions, `<session id>:H12`), `quote` (copied exactly from that turn), and `note` (one line of what happened to it, up to about 110 characters).
   - **The route.** Mark the main line with `"route": true`. These are the decisions that shaped what came next. The first route node has no `parent`; every later route node's `parent` is the previous route node. A long session usually has 12 to 25 route stations. The last one has status `now`: where the conversation stands.
   - **Branches.** Every other node has a `parent`: the route node it branched from, or the previous node in the same side thread when a thread continued. Keep to the options that mattered; a long session is typically 40 to 70 nodes in all.
   - `constraint: true` on a decided node that is a standing rule for any continuation (a spending cap, a "never do X"). Restart briefs list these.
   - `links`: `[{ "from": "<later node>", "to": "<earlier node>", "label": "..." }]` draws a dotted line back, for when something set up early was finally used.
   - `events`: optional `{ "id", "after": "<node id>", "kind": "restart", "title", "src", "quote" }` for restarts and similar. Compactions and "you've hit your limit" messages are found automatically.
   - Do not set `row` or `lane`; the layout does that.

   **Rules for judging and quoting. These matter more than anything else here.**
   - **Never invent a branch.** "Never pursued" means someone actually raised the option in the transcript and it was not taken up. Do not add alternatives you think should have been considered.
   - **Quote exactly.** Copy the text from the digest, characters and all. Prefer short, distinctive quotes of 120 characters or fewer. The check ignores extra spaces and line breaks and nothing else. If the digest trimmed the part you want (it marks this with `[...]`), quote text that is visible, or use the user's own words.
   - **Prefer the user's words** for decisions. Use Claude's words for options that were offered and for outcomes.
   - **Say what you are unsure of.** If a status is a close call, say so in `note`.

4. **Build.** `node <script> build <folder>/map.json`. It validates the file, checks every quote, lays out the map, writes `map.html`, and records how far into the session you have read. Fix everything it reports:
   - "not found verbatim": go back to the cited turn and fix the quote or the turn number, or drop the node. Never loosen a quote just to make it pass.
   - validation errors: fix `map.json`.
   - "layout" warnings: report them to the user; do not hand-edit `map.html`.

5. **Publish.** Publish `map.html` with the `Artifact` tool at the same file path every time (so the link stays the same), icon `map`, and a one-sentence description. The page already follows the Artifact page rules; don't edit it by hand. Report the URL, the counts for each status, how many quotes were found, and the titles of the open threads (parked, never pursued, open). Offer to restart any of them.

## Updating a map

Run `node <script> digest <session> --since-cursor <folder>/map.json --out <folder>/digest`. If it says nothing is new, say so and stop. Otherwise read only the new chunks and edit `map.json`:
- Add nodes for what is new. The old `now` node becomes an ordinary route node (`decided`), and the new last route node becomes `now`.
- Change the status of an existing node only when the new turns show it changed (a parked thread was taken up, an open question was answered). Say so in its `note`.
- Build and republish to the same URL, then list what changed.

## Restarting threads (`resume`)

The page has two ways to do this by hand: click a node and choose **Copy restart brief**, or use **Copy N open threads to restart** at the top. Pasting a brief into the original session gives that session the quote, the passage around it, what was said next, the route so far, standing constraints and the working rules. This mode does it from here, in parallel:

1. `node <script> brief <folder>/map.json <ids|open> --out <folder>/briefs` writes one `brief-<id>.md` per thread. Read them.
2. **Stop and confirm before starting anything.** List each thread with its title, status, what you would try, and whether it could cost money or touch shared resources (a GPU, a repo, a deploy). Ask which to start and what spend limit applies to each. The default is none: reading, analysis and local work only. This is a hard gate. Do not start threads on an assumed yes.
3. Once confirmed, start one background `Agent` per approved thread, all in one message so they run side by side, with the brief as the prompt plus the user's limits. Start at most five without asking again. Threads that would write to the same files or use the same resource must be sequenced, not run together.
4. When a thread reports back, check its claims yourself before relaying them as fact. Then propose the map update: the node's new status and a `note` with the result. Apply it only after the user agrees, and rebuild. The node keeps its original quote; results from resumed work are not in the transcript, so they go in the `note`, not in new nodes.

## What this does not do

- It does not read tool output, file contents or subagent transcripts, only the conversation between the user and Claude.
- It cannot start work inside the original session. Copy a brief into that session, or use `resume` from this one.
- The transcript format is internal to Claude Code and can change between versions. If the digest finds no conversation, the script says so instead of guessing.
- A map of a conversation is a reading of it. Treat statuses as a starting point to correct, and the quotes as the part you can trust.

## When to use this

After a long or multi-day conversation, when you want to see where it went and what was left behind. Or at the start of a day, to pick up the threads that fell off. For a short chat, the conversation itself is enough.
