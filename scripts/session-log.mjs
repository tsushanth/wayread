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

// Scan only the commits about to be pushed (mirrors this project's own pre-push convention),
// or the whole (cheap, fresh) history when there's no upstream yet. Throws with gitleaks's
// own output on any finding or error; returns normally when clean.
export function gitleaksCheck(repoRoot) {
  let range = null;
  try {
    execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { stdio: ['ignore', 'pipe', 'ignore'] });
    range = '@{u}..HEAD';
  } catch {
    range = null;
  }
  const args = ['git', `--log-opts=${range ?? ''}`, '--redact', '.'];
  try {
    execFileSync('gitleaks', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n');
    throw new Error(`gitleaks detected potential secrets (or failed to run):\n${output || error.message}`);
  }
}

// Write a file, commit it, scan the commits about to be pushed, then push.
// The secrets scan happens strictly before any push attempt; a push rejection
// (non-fast-forward, network failure, etc.) is reported, never retried as a force-push.
export function writeAndPublish({ repoRoot, relPath, content, commitMessage }) {
  const fullPath = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);

  execFileSync('git', ['-C', repoRoot, 'add', relPath]);
  execFileSync('git', ['-C', repoRoot, 'commit', '-q', '-m', commitMessage]);
  const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  try {
    gitleaksCheck(repoRoot);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  try {
    execFileSync('git', ['-C', repoRoot, 'push'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
