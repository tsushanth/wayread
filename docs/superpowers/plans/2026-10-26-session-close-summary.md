# Session-Close Summary Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Claude Code session ends, flag it; the next session that starts digests the flagged transcript(s), writes a three-part markdown summary (where we started / where we ended / what is left), and commits + pushes it — alongside the product repo it was centered on, or to a dedicated cross-project `session-logs` repo when it wasn't centered on one.

**Architecture:** A new wayread script, `scripts/session-log.mjs`, provides the deterministic half (flag lifecycle, repo-vs-root detection from the `cwd` field already present on every transcript line, git mechanics). A new command, `commands/session-log-catchup.md`, carries the half that needs Claude's judgment (reading a digest, writing the three paragraphs) — it is what a `SessionStart` hook's injected context tells a future session to run. Nothing here invokes Claude from a hook; hooks only ever run `session-log.mjs` subcommands.

**Tech Stack:** Node 18+, no dependencies (matches every other wayread script). Reuses `parseTranscript`/`digestChunks`/`norm` from `scripts/session-map.mjs` rather than re-implementing transcript parsing. `node:test` + `node:assert/strict`, matching `unpushed-work.test.mjs`'s existing style, including its real-bare-remote git fixture pattern.

**Spec:** `docs/superpowers/specs/2026-10-26-session-close-summary-design.md`

## Global Constraints

- Hooks never ship in wayread's plugin manifest — they go only in the user's personal `~/.claude/settings.json`, opt-in, this machine only (spec item 1).
- `SessionEnd`/`SessionStart` hook commands can only run shell commands; writing the prose happens as ordinary tool use inside the next real session, not in a spawned process (spec item 2).
- Repo-vs-root threshold: a single repo accounting for **≥ 80%** of a session's `cwd`-tagged transcript lines → write alongside that repo; otherwise (tie, ambiguity, or zero repos touched) → the root folder (spec item 5).
- Pending-flag location: `~/.claude/session-map-pending/<session_id>.json` (respecting `CLAUDE_CONFIG_DIR` like `session-map.mjs`'s `projectsDir()` does).
- Root folder: `~/Documents/GitHub/session-logs/YYYY-MM-DD/<slug-or-session-id>.md`, a dedicated new git repo.
- Per-repo path: `docs/session-log/YYYY-MM-DD-<slug>.md` inside the product repo.
- Every catch-up processes **all** currently-pending flags, not one at a time (spec item 7).
- Every push this feature makes runs an explicit `gitleaks git` scan first, scoped to the commits about to be pushed — never relying solely on the ambient global pre-push hook, which is documented to sometimes skip scanning a brand-new branch's first push (spec items 6 and the design doc's backfill/first-push risk).
- Auto-push always, no manual step (user confirmed).
- Claiming a flag renames it to `<id>.json.processing` before work starts and deletes it on success, so two near-simultaneous catch-ups can't double-process the same flag (spec item 9).
- A flag whose transcript no longer exists gets a minimal fallback entry, never a silent drop (spec item 8).
- Failures write loudly to `~/.claude/session-map-pending/errors.log`, in addition to a non-zero exit code — a `SessionEnd` hook's own stderr is easy to miss since the session has already ended.

## Review Focus

- A session that touches **no git repo at all** (pure planning/chat from `$HOME` or similar) — must still get flagged and routed to the root folder, not crash the repo-detection step. Pinned in Task 1.
- **Two sessions ending within the same second** write two separate flag files and never collide. Pinned in Task 2.
- **Two near-simultaneous `SessionStart` catch-ups** must not both claim and process the same flag. Pinned in Task 2.
- A flagged session's **transcript file is missing** (already past the 30-day retention window) — write the fallback entry, don't throw, don't silently drop the flag unprocessed. Pinned in Task 2 and Task 5.
- The **first-ever push** to the brand-new `session-logs` repo must not skip the secrets scan, even though that's exactly the scenario where the ambient global hook is documented to sometimes do nothing. Pinned in Task 4.
- A **non-fast-forward push rejection** (the remote moved since the local commit) must fail loudly and leave the commit intact locally, not force-push and not silently lose the summary. Pinned in Task 4.

---

## Task 1: Repo-vs-root detection

**Files:**
- Create: `scripts/session-log.mjs`
- Test: `scripts/session-log.test.mjs`

**Interfaces:**
- Consumes: nothing yet (first task).
- Produces: `export function scanCwds(file: string): Promise<Map<string, number>>` — reads a transcript file line by line, tallies the `cwd` field of every parseable JSONL record that has one. `export function resolveRepoRoot(cwd: string): string | null` — `git -C <cwd> rev-parse --show-toplevel`, trimmed; `null` if not inside a repo or `git` fails. `export const REPO_THRESHOLD = 0.8`. `export function decideLocation(cwdTally: Map<string, number>): { kind: 'repo', repoPath: string } | { kind: 'root' }` — resolves each cwd to a repo root (memoized within one call), sums counts per root (unresolvable cwds join a `null` bucket), and returns `{ kind: 'repo', repoPath }` only when one repo root's share of the total is `>= REPO_THRESHOLD`; otherwise `{ kind: 'root' }`.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { scanCwds, decideLocation, resolveRepoRoot, REPO_THRESHOLD } from './session-log.mjs';

function writeJsonl(file, cwds) {
  fs.writeFileSync(file, cwds.map((cwd) => JSON.stringify({ type: 'user', cwd, timestamp: new Date().toISOString() })).join('\n') + '\n');
}

test('scanCwds tallies the cwd field across every line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const file = path.join(dir, 't.jsonl');
  writeJsonl(file, ['/a', '/a', '/b']);
  const tally = await scanCwds(file);
  assert.equal(tally.get('/a'), 2);
  assert.equal(tally.get('/b'), 1);
});

test('scanCwds skips unparseable lines without throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, 'not json\n' + JSON.stringify({ cwd: '/a' }) + '\n');
  const tally = await scanCwds(file);
  assert.equal(tally.get('/a'), 1);
});

test('resolveRepoRoot returns the git top-level, or null outside a repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  assert.equal(resolveRepoRoot(dir), fs.realpathSync(dir));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-noRepo-'));
  assert.equal(resolveRepoRoot(outside), null);
});

test('decideLocation: one repo at or above the threshold wins', () => {
  const tally = new Map([['/repo-a', 9], ['/repo-b', 1]]);
  // Fake resolver via a tally pre-resolved to repo roots is awkward here, so
  // the implementer wires decideLocation to accept an already-cwd-keyed tally
  // and resolve internally — this test exercises it through a real repo.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const real = fs.realpathSync(dir);
  const t = new Map([[real, 9], ['/does/not/exist', 1]]);
  const result = decideLocation(t);
  assert.deepEqual(result, { kind: 'repo', repoPath: real });
});

test('decideLocation: a tie, or a session that touched no repo at all, goes to root', () => {
  assert.deepEqual(decideLocation(new Map()), { kind: 'root' });
  const t = new Map([['/not/a/repo/a', 5], ['/not/a/repo/b', 5]]);
  assert.deepEqual(decideLocation(t), { kind: 'root' });
});

test('REPO_THRESHOLD is 0.8', () => { assert.equal(REPO_THRESHOLD, 0.8); });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/session-log.test.mjs`
Expected: FAIL — `session-log.mjs` does not exist yet.

- [ ] **Step 3: Implement `scanCwds`, `resolveRepoRoot`, `REPO_THRESHOLD`, `decideLocation` in `scripts/session-log.mjs`**

`scanCwds` streams the file with `readline` exactly like `parseTranscript` in `session-map.mjs` does (same `fs.createReadStream(file, { encoding: 'utf8' })` + `readline.createInterface`), `JSON.parse`-ing each line inside a `try/catch` that skips the line on failure, incrementing a `Map` count keyed by `d.cwd` wherever that field is a non-empty string. `resolveRepoRoot` wraps `execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()` in a `try/catch` returning `null` on any throw. `decideLocation` builds a second `Map<string|null, number>` keyed by `resolveRepoRoot(cwd)` (memoize resolutions in a local `Map` so a repeated `cwd` isn't shelled out to `git` twice), sums, finds the entry with the highest count, and returns `{ kind: 'repo', repoPath }` only if `top.count / totalOfAllEntries >= REPO_THRESHOLD` and `top.key !== null`; otherwise `{ kind: 'root' }`. An empty input tally returns `{ kind: 'root' }` directly (no division by zero).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/session-log.test.mjs`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/session-log.mjs scripts/session-log.test.mjs
git commit -m "feat(session-log): repo-vs-root detection from transcript cwd tally"
```

---

## Task 2: Pending-flag lifecycle

**Files:**
- Modify: `scripts/session-log.mjs`
- Modify: `scripts/session-log.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1 directly (parallel concern), but lives in the same file.
- Produces: `export function pendingDir(): string` (mirrors `session-map.mjs`'s `projectsDir()` — `path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'session-map-pending')`). `export function writeFlag({ session_id, transcript_path, cwd, reason, ts }): void` — writes `<pendingDir()>/<session_id>.json`, creating the directory if needed. `export function listPending(): Array<{ session_id, transcript_path, cwd, reason, ts }>` — reads every `*.json` (not `*.json.processing`) in `pendingDir()`. `export function claimFlag(session_id: string): object | null` — renames `<id>.json` to `<id>.json.processing` and returns its parsed contents; returns `null` if the file doesn't exist or the rename fails (already claimed by a concurrent process). `export function clearFlag(session_id: string): void` — deletes `<id>.json.processing`. `export function failFlag(session_id: string, message: string): void` — appends a timestamped line to `<pendingDir()>/errors.log` and renames `<id>.json.processing` to `<id>.json.failed` (left for manual follow-up, never auto-retried).

- [ ] **Step 1: Write the failing tests**

```js
test('writeFlag then listPending round-trips the flag data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-pending-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  writeFlag({ session_id: 's1', transcript_path: '/t.jsonl', cwd: '/x', reason: 'other', ts: 1 });
  const pending = listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].session_id, 's1');
});

test('two sessions ending at once write two separate flag files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-pending-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  writeFlag({ session_id: 'a', transcript_path: '/a.jsonl', cwd: '/x', reason: 'other', ts: 1 });
  writeFlag({ session_id: 'b', transcript_path: '/b.jsonl', cwd: '/y', reason: 'other', ts: 2 });
  assert.equal(listPending().length, 2);
});

test('claimFlag removes the flag from listPending and returns its data; a second claim of the same id fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-pending-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  writeFlag({ session_id: 's1', transcript_path: '/t.jsonl', cwd: '/x', reason: 'other', ts: 1 });
  const claimed = claimFlag('s1');
  assert.equal(claimed.session_id, 's1');
  assert.equal(listPending().length, 0);
  assert.equal(claimFlag('s1'), null); // already claimed — simulates a second, racing catch-up
});

test('clearFlag removes the claimed (.processing) file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-pending-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  writeFlag({ session_id: 's1', transcript_path: '/t.jsonl', cwd: '/x', reason: 'other', ts: 1 });
  claimFlag('s1');
  clearFlag('s1');
  assert.equal(fs.existsSync(path.join(dir, 'session-map-pending', 's1.json.processing')), false);
});

test('failFlag logs the error and leaves a .failed marker instead of retrying silently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-pending-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  writeFlag({ session_id: 's1', transcript_path: '/missing.jsonl', cwd: '/x', reason: 'other', ts: 1 });
  claimFlag('s1');
  failFlag('s1', 'transcript not found');
  const log = fs.readFileSync(path.join(dir, 'session-map-pending', 'errors.log'), 'utf8');
  assert.match(log, /s1/);
  assert.match(log, /transcript not found/);
  assert.equal(fs.existsSync(path.join(dir, 'session-map-pending', 's1.json.failed')), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/session-log.test.mjs`
Expected: FAIL with "writeFlag is not a function" (or similar) for the five new tests; the Task 1 tests still pass.

- [ ] **Step 3: Implement `pendingDir`, `writeFlag`, `listPending`, `claimFlag`, `clearFlag`, `failFlag`**

Each file write uses `fs.mkdirSync(pendingDir(), { recursive: true })` first. `claimFlag` uses `fs.renameSync` inside a `try/catch` returning `null` on `ENOENT` (covers both "never existed" and "already claimed by someone else," which is exactly the race Task-2's third test exercises) — read and `JSON.parse` the file's contents *after* the rename succeeds, from the new `.processing` path.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/session-log.test.mjs`
Expected: PASS, all 11 tests (6 from Task 1 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add scripts/session-log.mjs scripts/session-log.test.mjs
git commit -m "feat(session-log): pending-flag lifecycle with claim/clear/fail"
```

---

## Task 3: Locate — where a transcript's summary belongs

Digesting a transcript for Claude to *read* doesn't need a new function: the catch-up command (Task 6) shells out to the existing, already-tested `node session-map.mjs digest <file>` directly, the same way `/sush-session-map` already does. The only new piece here is the repo-vs-root decision, wired to a real transcript file instead of a bare tally.

**Files:**
- Modify: `scripts/session-log.mjs`
- Modify: `scripts/session-log.test.mjs`

**Interfaces:**
- Consumes: `scanCwds`, `decideLocation` (Task 1).
- Produces: `export async function locate(transcriptFile: string): Promise<{ kind: 'repo', repoPath: string } | { kind: 'root' }>` — `await scanCwds(transcriptFile)` piped into `decideLocation(...)`.

- [ ] **Step 1: Write the failing test**

```js
function makeTranscript(dir, cwds) {
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, cwds.map((cwd) => JSON.stringify({ type: 'user', cwd, timestamp: new Date().toISOString() })).join('\n') + '\n');
  return file;
}

test('locate resolves a transcript file straight through to a repo-vs-root decision', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-locate-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const real = fs.realpathSync(dir);
  const file = makeTranscript(dir, Array.from({ length: 9 }, () => real).concat(['/elsewhere']));
  const result = await locate(file);
  assert.deepEqual(result, { kind: 'repo', repoPath: real });
});

test('locate falls back to root for a transcript that never touched a repo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-locate-'));
  const file = makeTranscript(dir, ['/tmp/scratch', '/tmp/scratch']);
  assert.deepEqual(await locate(file), { kind: 'root' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/session-log.test.mjs`
Expected: FAIL — `locate` not defined; prior tests still pass.

- [ ] **Step 3: Implement `locate`**

A thin pass-through per the Interfaces block above — no algorithm beyond calling the already-tested `scanCwds` and `decideLocation` in sequence.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/session-log.test.mjs`
Expected: PASS, all 13 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/session-log.mjs scripts/session-log.test.mjs
git commit -m "feat(session-log): locate — resolve a transcript to its repo-vs-root destination"
```

---

## Task 4: Publish — write, commit, scan, push

**Files:**
- Modify: `scripts/session-log.mjs`
- Modify: `scripts/session-log.test.mjs`

**Interfaces:**
- Consumes: nothing new from earlier tasks (the caller passes an already-decided `{ kind, repoPath }` and already-written markdown string).
- Produces: `export function gitleaksCheck(repoRoot: string): void` — throws with the raw gitleaks output in its message if leaks are found or the command errors; returns normally (no value) if clean. `export function writeAndPublish({ repoRoot, relPath, content, commitMessage }): { ok: true, path: string, sha: string } | { ok: false, error: string }` — writes the file, `git add`, `git commit`, `gitleaksCheck`, `git push` (catching a push rejection as a reported failure, never force-pushing). `export function writeFallbackEntry({ repoRoot, relPath, sessionId, endedAt }): ReturnType<typeof writeAndPublish>` — builds the "transcript was no longer available" markdown itself (the one piece of prose this script writes, since there's no transcript left to ask Claude about) and calls `writeAndPublish`.

- [ ] **Step 1: Write the failing tests**

```js
function initRepoWithBareRemote(root, name) {
  const bare = path.join(root, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: dir });
  return dir;
}

test('gitleaksCheck passes on a clean repo and throws on an obvious secret', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-leaks-'));
  const dir = initRepoWithBareRemote(root, 'clean');
  assert.doesNotThrow(() => gitleaksCheck(dir));
  fs.writeFileSync(path.join(dir, 'oops.env'), "AWS_SECRET_ACCESS_KEY=AKIAABCDEFGHIJKLMNOP\n");
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'leak'], { cwd: dir });
  assert.throws(() => gitleaksCheck(dir));
});

test('writeAndPublish writes, commits, scans, and pushes one new file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-publish-'));
  const dir = initRepoWithBareRemote(root, 'repo');
  const result = writeAndPublish({ repoRoot: dir, relPath: 'docs/session-log/2026-10-26-test.md', content: '# test\n', commitMessage: 'session log: test' });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'docs/session-log/2026-10-26-test.md')), true);
  const log = execFileSync('git', ['log', '--oneline', 'origin/main'], { cwd: dir, encoding: 'utf8' });
  assert.match(log, /session log: test/); // confirms it actually reached the remote, not just a local commit
});

test('writeAndPublish never pushes a commit that trips the secrets scan', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-publish-leak-'));
  const dir = initRepoWithBareRemote(root, 'repo');
  const result = writeAndPublish({ repoRoot: dir, relPath: 'docs/session-log/2026-10-26-leak.md', content: "key: AKIAABCDEFGHIJKLMNOP\n", commitMessage: 'session log: leak' });
  assert.equal(result.ok, false);
  const log = execFileSync('git', ['log', '--oneline', 'origin/main'], { cwd: dir, encoding: 'utf8' });
  assert.doesNotMatch(log, /session log: leak/); // local commit may exist, but it never reached the remote
});

test('writeFallbackEntry writes a minimal, honest note when the transcript is gone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-fallback-'));
  const dir = initRepoWithBareRemote(root, 'repo');
  const result = writeFallbackEntry({ repoRoot: dir, relPath: 'docs/session-log/2026-10-26-gone.md', sessionId: 'abc123', endedAt: '2026-10-26' });
  assert.equal(result.ok, true);
  const text = fs.readFileSync(path.join(dir, 'docs/session-log/2026-10-26-gone.md'), 'utf8');
  assert.match(text, /abc123/);
  assert.match(text, /no longer available/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/session-log.test.mjs`
Expected: FAIL — the four new functions don't exist; everything from Tasks 1–3 still passes.

- [ ] **Step 3: Implement `gitleaksCheck`, `writeAndPublish`, `writeFallbackEntry`**

`gitleaksCheck` picks its scan range the same way this session's own manual runs did: if `git -C <repoRoot> rev-parse --abbrev-ref --symbolic-full-name @{u}` succeeds, scan `@{u}..HEAD`; otherwise (no upstream yet — the very first commit of a brand-new repo) scan with no range restriction. Run `gitleaks git --log-opts="<range or omitted>" --redact .` with `cwd: repoRoot`; a non-zero exit means leaks were found — throw an `Error` whose message includes gitleaks's own stdout/stderr so a human can see exactly what it flagged. `writeAndPublish` runs the steps in its Interfaces description in order, wrapping `git push` specifically in its own `try/catch` (a push rejection — non-fast-forward, network failure — becomes `{ ok: false, error }`, never a force-push retry); a `gitleaksCheck` throw also becomes `{ ok: false, error }` and happens *before* any push attempt. `writeFallbackEntry`'s markdown body is exactly: `` `# Session ${sessionId}\n\n${sessionId} ended on ${endedAt}; its transcript was no longer available to summarize.\n` ``.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/session-log.test.mjs`
Expected: PASS, all 17 tests. (Requires `gitleaks` on `PATH` — already true on this machine per the existing global pre-push hook.)

- [ ] **Step 5: Commit**

```bash
git add scripts/session-log.mjs scripts/session-log.test.mjs
git commit -m "feat(session-log): publish — write, commit, explicit secrets scan, push"
```

---

## Task 5: CLI assembly

Claude, running inside the catch-up command, has no way to import a JS function — only Bash and Read. So every exported function from Tasks 1–4 needs a CLI door, and `publish`/`fallback` need to do their own location math internally: Claude's only job is to hand over the markdown text and a session id, never a repo path it would have had to compute itself (there is no `locate`/CLI equivalent exposed standalone — it only ever runs as part of `publish`).

**Files:**
- Modify: `scripts/session-log.mjs`

**Interfaces:**
- Consumes: every exported function from Tasks 1–4.
- Produces: a `main(argv)` CLI, structured like `session-map.mjs`'s own `main`, with subcommands `flag`, `pending`, `claim`, `publish`, `fallback`, `--help`; invoked when run directly (same `fileURLToPath(import.meta.url)` guard `session-map.mjs` already uses). `export async function destinationFor(flag: { session_id, transcript_path, ts }): Promise<{ repoRoot: string, relPath: string }>` — **async, because it awaits `locate`** (Task 3's `locate` is itself `async`, since it awaits `scanCwds`'s file read; every caller of `destinationFor`, including the CLI's `publish`/`fallback` handlers, must `await` it). Calls `await locate(flag.transcript_path)`; for `{ kind: 'repo', repoPath }` returns `{ repoRoot: repoPath, relPath: `docs/session-log/${date}-${shortId}.md` }`; for `{ kind: 'root' }`, ensures `~/Documents/GitHub/session-logs` exists as a git repo (running the same `git init` + README-commit sequence Task 7 Step 1 uses, but only when the directory is missing — idempotent) and returns `{ repoRoot: '~/Documents/GitHub/session-logs' (expanded), relPath: `${date}/${shortId}.md` }`. `date` is `new Date(flag.ts).toISOString().slice(0, 10)`; `shortId` is `flag.session_id.slice(0, 8)`.

- [ ] **Step 1: Write the failing tests**

```js
test('destinationFor a repo-centered session uses the product repo and docs/session-log/', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-dest-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const real = fs.realpathSync(dir);
  // destinationFor calls locate(), which reads the transcript at flag.transcript_path — build one that's 100% this repo.
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, Array.from({ length: 5 }, () => JSON.stringify({ type: 'user', cwd: real, timestamp: new Date().toISOString() })).join('\n'));
  const dest = await destinationFor({ session_id: 'abcdefgh1234', transcript_path: file, ts: Date.parse('2026-10-26T00:00:00Z') });
  assert.equal(dest.repoRoot, real);
  assert.equal(dest.relPath, 'docs/session-log/2026-10-26-abcdefgh.md');
});

test('destinationFor a cross-cutting session creates and uses the session-logs root, dated', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-home-'));
  process.env.HOME = home; // destinationFor must resolve ~/Documents/GitHub/session-logs against this
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-dest-root-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: '/scratch', timestamp: new Date().toISOString() }));
  const dest = await destinationFor({ session_id: 'xyz99999aaaa', transcript_path: file, ts: Date.parse('2026-10-27T00:00:00Z') });
  assert.equal(dest.repoRoot, path.join(home, 'Documents/GitHub/session-logs'));
  assert.equal(dest.relPath, '2026-10-27/xyz99999.md');
  assert.equal(fs.existsSync(path.join(dest.repoRoot, '.git')), true); // created on demand
});

test('CLI: flag reads hook stdin JSON and writes a pending flag; pending lists it; claim removes it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cli-'));
  const stdin = JSON.stringify({ session_id: 'cli1', transcript_path: '/t.jsonl', cwd: '/x', reason: 'other' });
  execFileSync('node', [SCRIPT, 'flag'], { input: stdin, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
  const pendingOut = execFileSync('node', [SCRIPT, 'pending', '--json'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
  const pending = JSON.parse(pendingOut);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].session_id, 'cli1');
  execFileSync('node', [SCRIPT, 'claim', 'cli1'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
  const after = JSON.parse(execFileSync('node', [SCRIPT, 'pending', '--json'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } }));
  assert.equal(after.length, 0);
});

test('CLI: publish writes the content to the claimed flag\'s computed destination and clears the flag', () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cli-pub-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cli-pub-repo-'));
  const repoDir = initRepoWithBareRemote(root, 'repo'); // same helper Task 4 defines
  const transcriptFile = path.join(root, 't.jsonl');
  fs.writeFileSync(transcriptFile, JSON.stringify({ type: 'user', cwd: repoDir, timestamp: new Date().toISOString() }));
  const contentFile = path.join(root, 'content.md');
  fs.writeFileSync(contentFile, '# test session\n');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  execFileSync('node', [SCRIPT, 'flag'], { input: JSON.stringify({ session_id: 'pub12345678', transcript_path: transcriptFile, cwd: repoDir, reason: 'other' }), encoding: 'utf8', env });
  execFileSync('node', [SCRIPT, 'claim', 'pub12345678'], { encoding: 'utf8', env });
  execFileSync('node', [SCRIPT, 'publish', 'pub12345678', '--content-file', contentFile], { encoding: 'utf8', env });
  const files = fs.readdirSync(path.join(repoDir, 'docs/session-log'));
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(execFileSync('node', [SCRIPT, 'pending', '--json'], { encoding: 'utf8', env })).length, 0);
});

test('CLI with no arguments prints usage and exits non-zero; --help exits 0', () => {
  assert.throws(() => execFileSync('node', [SCRIPT], { encoding: 'utf8' }));
  const out = execFileSync('node', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(out, /session-log/);
});
```

(Add near the top of the test file, matching `unpushed-work.test.mjs`'s own setup: `const here = path.dirname(fileURLToPath(import.meta.url)); const SCRIPT = path.join(here, 'session-log.mjs');`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/session-log.test.mjs`
Expected: FAIL — `destinationFor` and the CLI don't exist yet; Tasks 1–4's tests still pass.

- [ ] **Step 3: Implement `destinationFor`, `main(argv)`, and the run-if-main guard**

`destinationFor` matches its Interfaces description exactly. `flag` reads all of stdin (`fs.readFileSync(0, 'utf8')` or accumulate on `process.stdin`), `JSON.parse`s it, and calls `writeFlag` with its `session_id`/`transcript_path`/`cwd`/`reason` plus `ts: Date.now()`; on any error (bad JSON, missing `session_id`), append to `errors.log` directly (`pendingDir()` may not exist yet — create it) and exit non-zero rather than throwing an uncaught exception that a hook's timeout would otherwise mask. `pending` calls `listPending()`; with `--json` prints `JSON.stringify(result)`, otherwise a one-line human summary (`N session(s) pending a summary`). `claim <id>` calls `claimFlag` and prints its JSON (or exits 1 if `null`). `publish <id> --content-file <path>` reads the already-claimed flag's own JSON straight from `<pendingDir>/<id>.json.processing` (not re-claiming — `claim` must have run first), `await destinationFor(flag)` on it (both `main` and every handler that reaches `destinationFor` must be `async` — `main` already is, matching `session-map.mjs`'s own `async function main`), reads the markdown from `--content-file` (or stdin if the value is `-`), calls `writeAndPublish({ repoRoot, relPath, content, commitMessage: `session log: ${id.slice(0,8)}` })`, then `clearFlag(id)` on `{ ok: true }` or `failFlag(id, error)` on `{ ok: false }`. `fallback <id>` does the same `await destinationFor(...)` + clear/fail dance but calls `writeFallbackEntry` instead, using the claimed flag's own `session_id`/`ts` for `sessionId`/`endedAt`. `--help` prints a short synopsis of all five subcommands (mirror `session-map.mjs`'s `--help`, which prints its own leading `//` comment block).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/session-log.test.mjs`
Expected: PASS, all 23 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/session-log.mjs scripts/session-log.test.mjs
git commit -m "feat(session-log): wire the flag/pending/claim/publish/fallback CLI"
```

---

## Task 6: The catch-up command and plugin metadata

**Files:**
- Create: `commands/session-log-catchup.md`
- Modify: `.claude-plugin/plugin.json`

**Interfaces:**
- Consumes: the `session-log.mjs` CLI from Task 5 (`pending --json`, `claim`, `publish`, `fallback` — all of Claude's own path/location math already happens inside `publish`/`fallback` via `destinationFor`, so this command never computes a repo path itself), plus the existing `session-map.mjs digest` command for reading a transcript.
- Produces: nothing further downstream — this is the end of the chain that a `SessionStart` hook's injected context points at, and that a user can also run by hand as `/wayread:session-log-catchup` or (via the private mirror, matching the `live-plan`/`session-map` precedent) `/sush-session-log-catchup`.

- [ ] **Step 1: Write `commands/session-log-catchup.md`**

Follow the house style already visible in `commands/session-map.md` and `commands/unpushed-work.md` (frontmatter with `description`/`argument-hint`, a short "what this does" section, then numbered steps). Content to include, as instructions for whichever Claude session runs it:

1. Run `node <script> pending --json` (resolve `<script>` the same way `session-map.md` tells the user to: `~/Documents/GitHub/wayread/scripts/session-log.mjs`, or find it under `~/.claude/plugins` if invoked as the published `wayread:` command). If empty, say so and stop — nothing to do.
2. For each pending flag, in turn (not in parallel — these are git operations against potentially the same repo, which is exactly the kind of shared-mutable-state case `superpowers:dispatching-parallel-agents` says NOT to parallelize): `claim <id>` it. If the claim returns null (another session's catch-up already took it — a real possibility now that any session start can trigger this) or its `transcript_path` no longer exists, run `fallback <id>` and move to the next flag. Otherwise, digest the transcript with the existing `node <script's directory>/session-map.mjs digest <transcript_path> --out <scratch dir>` and read every chunk it writes (don't sample — same discipline `/sush-session-map` already uses).
3. Write exactly three short paragraphs — **Where we started**, **Where we ended**, **What is left** — as a markdown file in a scratch location (template below), using the user's own words where the digest shows a clear decision, and Claude's words for outcomes and open items, the same quoting discipline `/sush-session-map` uses but without that command's node-graph or quote-verification machinery (this is a lighter, prose-only artifact). This command never decides *where* the file permanently lives — that's `publish`'s job, below.
4. `publish <id> --content-file <path to the markdown just written>`. `publish` internally resolves the real destination (the product repo's `docs/session-log/`, or the `session-logs` root, creating it if it doesn't exist yet) and does the git work. Report the path `publish` printed, or the failure if it returned non-zero — a failed publish leaves the flag in `.failed` state for the user to look at later, not retried automatically.
5. After all flags are handled, tell the user one short line: how many summaries were written and where, or that there was nothing pending. Do not narrate each individual repo lookup — the anti-nagging goal from the spec applies here too.

Markdown template:
```
# Session <short-session-id> — <date>

**Where we started:** <one short paragraph>

**Where we ended:** <one short paragraph>

**What is left:** <one short paragraph>
```

- [ ] **Step 2: Bump `.claude-plugin/plugin.json`**

Increment `version` (currently `0.4.0`) to `0.5.0` and extend `description` to mention session-close summary tracking, matching how every prior command addition this session bumped the version.

- [ ] **Step 3: Confirm the plugin still loads**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8')); console.log('ok')"`
Expected: prints `ok` (catches a JSON typo before it reaches the marketplace).

- [ ] **Step 4: Commit**

```bash
git add commands/session-log-catchup.md .claude-plugin/plugin.json
git commit -m "feat(session-log): catch-up command and plugin version bump"
```

---

## Task 7: Wire the personal hooks and create the session-logs repo

**Files:**
- Modify: `~/.claude/settings.json` (outside this repo — the user's personal, machine-level config; not committed to wayread)
- Create: `~/Documents/GitHub/session-logs/` (a new, separate git repo; not part of wayread)

This task has no automated test cycle — it's config and infrastructure, verified the way the `update-config` skill's own workflow verifies a hook (pipe-test, `jq -e` schema check, prove-it-fires), not with `node --test`.

- [ ] **Step 1: Create the `session-logs` repo**

```bash
mkdir -p ~/Documents/GitHub/session-logs
cd ~/Documents/GitHub/session-logs
git init -q -b main
echo "# session-logs

Session-close summaries written automatically by wayread's session-log tooling. One file per session, organized by date." > README.md
git add README.md
git commit -q -m "init: session-logs"
```

Do **not** push yet — there is no remote configured. Ask the user for the remote (a new, presumably private, personal GitHub repo) before running `git remote add origin <url> && git push -u origin main`, since creating a new remote repo is the user's call, not something to invent a URL for.

- [ ] **Step 2: Read `~/.claude/settings.json`**

Per the `update-config` skill's "Read Before Write" rule — never overwrite existing hooks or other keys.

- [ ] **Step 3: Construct the `SessionEnd` hook command and pipe-test it raw**

```json
{ "type": "command", "command": "node ~/Documents/GitHub/wayread/scripts/session-log.mjs flag 2>>~/.claude/session-map-pending/errors.log" }
```

Pipe-test: `echo '{"session_id":"test123","transcript_path":"/tmp/fake.jsonl","cwd":"/tmp","reason":"other"}' | node ~/Documents/GitHub/wayread/scripts/session-log.mjs flag` — then confirm with `node ~/Documents/GitHub/wayread/scripts/session-log.mjs pending` that it shows up, and clean it up with `rm ~/.claude/session-map-pending/test123.json` before moving on.

- [ ] **Step 4: Construct the `SessionStart` hook command and pipe-test it raw**

```json
{ "type": "command", "command": "n=$(node ~/Documents/GitHub/wayread/scripts/session-log.mjs pending --json | node -e 'process.stdin.resume();let d=\"\";process.stdin.on(\"data\",c=>d+=c);process.stdin.on(\"end\",()=>console.log(JSON.parse(d).length))'); if [ \"$n\" -gt 0 ]; then echo '{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"'\"$n\"' session(s) ended without a summary. Before anything else, run the session-log-catchup command to process them, then continue with the actual request.\"}}'; else echo '{}'; fi" }
```

Pipe-test: `echo '{}' | sh -c "<the command above>"` with at least one real pending flag present (reuse the one from Step 3) and confirm it prints the `hookSpecificOutput.additionalContext` JSON; with zero pending flags, confirm it prints `{}`.

- [ ] **Step 5: Write the JSON and validate**

Merge both hooks into `~/.claude/settings.json`'s `hooks.SessionEnd` / `hooks.SessionStart` arrays (array of `{ hooks: [...] }`, no `matcher` needed — these events aren't tool-matched). Validate: `jq -e '.hooks.SessionEnd[0].hooks[0].command' ~/.claude/settings.json` and the equivalent for `SessionStart`; both should print the command strings with exit code 0.

- [ ] **Step 6: Note the watcher caveat and hand off**

Per the `update-config` skill: `SessionStart`/`SessionEnd` fire outside this turn, so there's no in-turn way to prove them firing for real. Tell the user: open `/hooks` once (or restart Claude Code) to pick up the new config, then the next time a session actually ends and a new one starts, check `~/.claude/session-map-pending/` and, after that session runs the catch-up, `~/Documents/GitHub/session-logs/` or the relevant product repo's `docs/session-log/` for the result.

- [ ] **Step 7: No commit** — this task touches no file inside the wayread repo (`plugin.json`'s bump already landed in Task 6). Tell the user what changed instead of committing.

---

## Deferred, not part of this plan

Backfilling every existing session, and the pull-on-demand analytics layer (phase 2), are both explicitly out of scope here per the spec's own "Backfill" and "Phase 2" sections — they depend on this plan's tooling existing first and are picked up as separate work afterward.
