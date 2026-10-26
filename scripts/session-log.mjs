// session-log: flag a session for a close-out summary, then write that summary to its repo (or
// the cross-project session-logs root) and push it. No dependencies. Needs Node 18+.
//
//   node session-log.mjs flag                                  (reads hook JSON from stdin, writes a pending flag)
//   node session-log.mjs pending [--json]                       (list sessions pending a summary)
//   node session-log.mjs claim <session_id>                     (claim one pending flag, prints its JSON)
//   node session-log.mjs publish <session_id> --content-file <path|->   (write/commit/push the summary, clear the flag)
//   node session-log.mjs fallback <session_id>                  (write a minimal fallback note when no transcript was available)
//
// `claim` must run before `publish`/`fallback` — they read the already-claimed `.processing` file, never re-claim.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO_THRESHOLD = 0.8;

// Tally the `cwd` field of every parseable JSONL record in a transcript.
export async function scanCwds(file) {
  const tally = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d && typeof d.cwd === 'string' && d.cwd) tally.set(d.cwd, (tally.get(d.cwd) || 0) + 1);
  }
  return tally;
}

// Git top-level for a directory, or null if it is not inside a repo (or git fails).
export function resolveRepoRoot(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Decide whether a session belongs alongside one repo or in the cross-project root.
export function decideLocation(cwdTally) {
  const total = [...cwdTally.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return { kind: 'root' };

  const resolved = new Map();
  const memo = new Map();
  for (const [cwd, count] of cwdTally) {
    if (!memo.has(cwd)) memo.set(cwd, resolveRepoRoot(cwd));
    const root = memo.get(cwd);
    resolved.set(root, (resolved.get(root) || 0) + count);
  }

  let top = null;
  for (const [key, count] of resolved) {
    if (!top || count > top.count) top = { key, count };
  }
  if (top.key !== null && top.count / total >= REPO_THRESHOLD) return { kind: 'repo', repoPath: top.key };
  return { kind: 'root' };
}

// Resolve a transcript file to its destination: alongside one repo, or in the cross-project root.
export async function locate(transcriptFile) {
  return decideLocation(await scanCwds(transcriptFile));
}

// Pending flags: one JSON file per session that ended, written by the SessionEnd hook
// and drained later by a SessionStart-triggered catch-up.
export function pendingDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'session-map-pending');
}

export function writeFlag({ session_id, transcript_path, cwd, reason, ts }) {
  fs.mkdirSync(pendingDir(), { recursive: true });
  const data = { session_id, transcript_path, cwd, reason, ts };
  fs.writeFileSync(path.join(pendingDir(), `${session_id}.json`), JSON.stringify(data));
}

export function listPending() {
  const dir = pendingDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// Atomic claim: rename is all-or-nothing, so only one racing process can win.
// Returns null when the flag is missing or another process already claimed it;
// any other filesystem error is rethrown so it is not mistaken for a benign race.
export function claimFlag(session_id) {
  const from = path.join(pendingDir(), `${session_id}.json`);
  const to = path.join(pendingDir(), `${session_id}.json.processing`);
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(fs.readFileSync(to, 'utf8'));
}

export function clearFlag(session_id) {
  fs.rmSync(path.join(pendingDir(), `${session_id}.json.processing`), { force: true });
}

// Failed flags are kept for manual follow-up and never auto-retried.
export function failFlag(session_id, message) {
  const dir = pendingDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'errors.log'), `${new Date().toISOString()} ${session_id} ${message}\n`);
  fs.renameSync(path.join(dir, `${session_id}.json.processing`), path.join(dir, `${session_id}.json.failed`));
}

// Fails loudly (process exits non-zero) instead of hanging on a stalled network or a credential prompt —
// this runs unattended, with nobody at a terminal to answer a prompt.
const GIT_EXEC_SAFETY = { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30000 };

function assertSafeRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) throw new Error('relPath must be a non-empty relative path');
  if (path.isAbsolute(relPath)) throw new Error(`relPath must be relative, not absolute: ${relPath}`);
  const segments = relPath.split(/[\\/]/);
  if (segments.includes('..')) throw new Error(`relPath must not traverse outside the repo: ${relPath}`);
}

// The branch HEAD is on, including an unborn branch that has no commits yet (symbolic-ref still
// resolves, where `rev-parse --abbrev-ref HEAD` errors out). Returns the literal 'HEAD' for a
// detached HEAD (symbolic-ref fails there, by definition), which callers treat as "not a branch".
function currentBranch(repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'HEAD';
  }
}

// Prefers 'origin' (this project's convention); falls back to whatever single remote exists.
function pickRemote(repoRoot) {
  const remotes = execFileSync('git', ['-C', repoRoot, 'remote'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (remotes.includes('origin')) return 'origin';
  return remotes[0] || null;
}

function remoteRefExists(repoRoot, remote, branch) {
  if (!remote || !branch) return false;
  try {
    execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', `${remote}/${branch}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// Local-only, no-network check for history already on this branch beyond its last-known remote
// state: counts commits on `branch` that aren't reachable from `<remote>/<branch>`. Returns null
// (nothing to compare against — the legitimate first-push-ever case) when that remote-tracking
// ref doesn't exist locally yet.
function commitsAheadOfRemoteTracking(repoRoot, remote, branch) {
  if (!remoteRefExists(repoRoot, remote, branch)) return null;
  const out = execFileSync('git', ['-C', repoRoot, 'rev-list', '--count', branch, '--not', `${remote}/${branch}`], { encoding: 'utf8' }).trim();
  return Number(out);
}

// Scans exactly the commits the subsequent push will send: `<remote>/<branch>..HEAD` when that
// remote-tracking ref already resolves locally, or everything on this branch not already on some
// remote (`HEAD --not --remotes`) when it doesn't yet — the same branch/remote this function's
// caller is about to push to, not `@{u}`, so the scanned range can never silently diverge from
// the pushed range, and a brand-new branch's first push isn't blocked by pre-existing findings
// deep in history it shares with other branches already on a remote. Throws with gitleaks's own
// output (plus the offending commit SHA) on any finding or error; returns normally when clean.
export function gitleaksCheck(repoRoot) {
  const branch = currentBranch(repoRoot);
  const remote = pickRemote(repoRoot);
  const range = remoteRefExists(repoRoot, remote, branch) ? `${remote}/${branch}..HEAD` : 'HEAD --not --remotes';
  const args = ['git', `--log-opts=${range}`, '--redact', '.'];
  try {
    execFileSync('gitleaks', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...GIT_EXEC_SAFETY });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n');
    const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    throw new Error(
      `gitleaks detected potential secrets (or failed to run) on commit ${sha}:\n${output || error.message}\n\n` +
      `Commit ${sha} is now sitting locally on this branch, unpushed. Remove it or amend it before anything can be ` +
      `pushed from this branch again — do not rely on the global pre-push hook alone here, since it can skip ` +
      `scanning a brand-new branch's very first push.`
    );
  }
}

// Write a file, commit it, scan exactly the commits about to be pushed, then push.
// Order of operations, each a hard gate on the next:
//   1. relPath is validated (no absolute paths, no `..` traversal); HEAD must be a real branch,
//      not detached (a detached HEAD has no branch name to push, so `HEAD:HEAD` would be wrong).
//   2. The current branch must already match its last-known remote-tracking state (no network
//      call — purely local refs): if `<remote>/<branch>` exists locally and `branch` has commits
//      not reachable from it, this tool refuses rather than sweeping unrelated local-only
//      history into what it pushes. If no such remote-tracking ref exists yet, there's nothing
//      to compare against (the legitimate first-push-ever case) and this check is skipped.
//      Stashes, other branches, and dangling commits are irrelevant to a scoped
//      `git push HEAD:<branch>` and are deliberately NOT checked here.
//   3. The file is written and committed, scoped to exactly that one file (`commit -- relPath`),
//      so nothing else staged in the index gets swept into the commit.
//   4. gitleaksCheck runs on the new commit — a leak throws, and writeAndPublish returns
//      `{ ok: false, error }` *before any push is attempted*.
//   5. Only then does `git push <remote> HEAD:<branch>` run, with an explicit refspec (never a
//      bare `git push`, which can follow push.default/triangular-remote config into pushing a
//      different ref than the one just scanned). A push rejection (non-fast-forward, network
//      failure, credential prompt, timeout) is caught in its own try/catch and reported as
//      `{ ok: false, error }` — never retried, never force-pushed.
export function writeAndPublish({ repoRoot, relPath, content, commitMessage }) {
  try {
    assertSafeRelPath(relPath);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  const branchBefore = currentBranch(repoRoot);
  if (branchBefore === 'HEAD') {
    return { ok: false, error: `${repoRoot} has a detached HEAD, not a branch; refusing to publish from it` };
  }
  const remoteBefore = pickRemote(repoRoot);
  let ahead;
  try {
    ahead = commitsAheadOfRemoteTracking(repoRoot, remoteBefore, branchBefore);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  if (ahead !== null && ahead > 0) {
    return {
      ok: false,
      error: `${repoRoot} branch "${branchBefore}" has ${ahead} unpushed commit${ahead === 1 ? '' : 's'} relative ` +
        `to ${remoteBefore}/${branchBefore}; refusing to commit onto it to avoid pushing something unrelated — ` +
        `resolve that first (see /sush-unpushed-work)`,
    };
  }

  const fullPath = path.join(repoRoot, relPath);
  let sha;
  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    execFileSync('git', ['-C', repoRoot, 'add', relPath]);
    execFileSync('git', ['-C', repoRoot, 'commit', '-q', '-m', commitMessage, '--', relPath]);
    sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (error) {
    const output = [error.stdout?.toString?.(), error.stderr?.toString?.()].filter(Boolean).join('\n');
    return { ok: false, error: output || error.message };
  }

  try {
    gitleaksCheck(repoRoot);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  try {
    const branch = currentBranch(repoRoot);
    const remote = pickRemote(repoRoot);
    if (!remote) return { ok: false, error: `${repoRoot} has no git remote configured; commit ${sha} is local only` };
    execFileSync('git', ['-C', repoRoot, 'push', remote, `HEAD:${branch}`], { stdio: ['ignore', 'pipe', 'pipe'], ...GIT_EXEC_SAFETY });
  } catch (error) {
    const output = [error.stdout?.toString?.(), error.stderr?.toString?.()].filter(Boolean).join('\n');
    return { ok: false, error: output || error.message };
  }

  return { ok: true, path: fullPath, sha };
}

// Builds the "transcript was no longer available" markdown — the one piece of prose this
// script writes itself, since there's no transcript left to ask Claude about — and publishes it.
export function writeFallbackEntry({ repoRoot, relPath, sessionId, endedAt }) {
  const content = `# Session ${sessionId}\n\n${sessionId} ended on ${endedAt}; its transcript was no longer available to summarize.\n`;
  return writeAndPublish({ repoRoot, relPath, content, commitMessage: `session log: ${sessionId} (fallback)` });
}

// The cross-cutting-session repo, created on first use. Same git init + README-commit sequence
// as Task 7 Step 1's manual setup, so either one happening first is harmless.
function ensureSessionLogsRoot() {
  const root = path.join(os.homedir(), 'Documents/GitHub/session-logs');
  if (fs.existsSync(root)) return root;
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  fs.writeFileSync(
    path.join(root, 'README.md'),
    '# session-logs\n\nSession-close summaries written automatically by wayread\'s session-log tooling. One file per session, organized by date.\n'
  );
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init: session-logs'], { cwd: root });
  return root;
}

// Where a claimed flag's summary should be written: alongside the repo it was mostly about,
// or in the cross-project session-logs root, created on demand.
export async function destinationFor(flag) {
  const date = new Date(flag.ts).toISOString().slice(0, 10);
  const shortId = flag.session_id.slice(0, 8);
  const decision = await locate(flag.transcript_path);
  if (decision.kind === 'repo') {
    return { repoRoot: decision.repoPath, relPath: `docs/session-log/${date}-${shortId}.md` };
  }
  return { repoRoot: ensureSessionLogsRoot(), relPath: `${date}/${shortId}.md` };
}

// ---------- CLI ----------

function cliFlag(args, name, def) { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; }

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const usage = () => {
    const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    const header = [];
    for (const l of lines) {
      if (!l.startsWith('//')) break;
      header.push(l.slice(3));
    }
    return header.join('\n');
  };
  if (!cmd) {
    console.error(usage());
    return 2;
  }
  if (cmd === '--help' || cmd === '-h') {
    console.log(usage());
    return 0;
  }

  if (cmd === 'flag') {
    let data;
    try {
      const raw = JSON.parse(readStdin());
      if (!raw || typeof raw.session_id !== 'string' || !raw.session_id) throw new Error('missing session_id');
      data = { session_id: raw.session_id, transcript_path: raw.transcript_path, cwd: raw.cwd, reason: raw.reason, ts: Date.now() };
      writeFlag(data);
    } catch (error) {
      fs.mkdirSync(pendingDir(), { recursive: true });
      fs.appendFileSync(path.join(pendingDir(), 'errors.log'), `${new Date().toISOString()} flag: ${error.message}\n`);
      return 1;
    }
    return 0;
  }

  if (cmd === 'pending') {
    const asJson = rest.includes('--json');
    const result = listPending();
    console.log(asJson ? JSON.stringify(result) : `${result.length} session(s) pending a summary`);
    return 0;
  }

  if (cmd === 'claim') {
    const [id] = rest;
    if (!id) throw new Error('usage: claim <session_id>');
    const claimed = claimFlag(id);
    if (!claimed) return 1;
    console.log(JSON.stringify(claimed));
    return 0;
  }

  if (cmd === 'publish') {
    const [id] = rest;
    const contentFileArg = cliFlag(rest, '--content-file');
    if (!id || !contentFileArg) throw new Error('usage: publish <session_id> --content-file <path>');
    const processingPath = path.join(pendingDir(), `${id}.json.processing`);
    if (!fs.existsSync(processingPath)) throw new Error(`${id} is not claimed; run claim first`);
    const flagData = JSON.parse(fs.readFileSync(processingPath, 'utf8'));
    const { repoRoot, relPath } = await destinationFor(flagData);
    const content = contentFileArg === '-' ? readStdin() : fs.readFileSync(contentFileArg, 'utf8');
    const result = writeAndPublish({ repoRoot, relPath, content, commitMessage: `session log: ${id.slice(0, 8)}` });
    if (result.ok) { clearFlag(id); return 0; }
    failFlag(id, result.error);
    console.error(`publish failed for ${id}: ${result.error}`);
    return 1;
  }

  if (cmd === 'fallback') {
    const [id] = rest;
    if (!id) throw new Error('usage: fallback <session_id>');
    const processingPath = path.join(pendingDir(), `${id}.json.processing`);
    if (!fs.existsSync(processingPath)) throw new Error(`${id} is not claimed; run claim first`);
    const flagData = JSON.parse(fs.readFileSync(processingPath, 'utf8'));
    const { repoRoot, relPath } = await destinationFor(flagData);
    const result = writeFallbackEntry({ repoRoot, relPath, sessionId: flagData.session_id, endedAt: new Date(flagData.ts).toISOString() });
    if (result.ok) { clearFlag(id); return 0; }
    failFlag(id, result.error);
    console.error(`fallback failed for ${id}: ${result.error}`);
    return 1;
  }

  throw new Error(`unknown command ${JSON.stringify(cmd)}`);
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`session-log: ${e.message}`); process.exitCode = 2; });
}
