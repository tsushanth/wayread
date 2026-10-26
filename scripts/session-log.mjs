import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

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
