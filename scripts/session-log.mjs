import fs from 'node:fs';
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
