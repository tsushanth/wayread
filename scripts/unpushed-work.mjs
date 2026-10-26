#!/usr/bin/env node
// unpushed-work: find local git work that exists only on this machine.
// No dependencies. Needs Node 18+ and git.
//
//   node unpushed-work.mjs scan [path...]            # default path: .
//   node unpushed-work.mjs find-repos <root> [--max-depth N] [--days N]
//   node unpushed-work.mjs sweep <root> [--max-depth N] [--days N] [scan flags]
//
// scan flags: --no-fetch  --quiet  --json  --fetch-timeout-ms N
//
// For each repo: branches with commits not on any remote, stash entries, commits reachable
// from nowhere but the reflog (git fsck --unreachable --no-reflog; these are lost on the next
// git gc), and repos with no remote at all (everything on them is local-only by definition).
// `scan` exits 1 if anything was found in any scanned repo, 0 if every repo is clean, so a
// calling command can gate on it without parsing output.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function git(args, cwd, { timeoutMs = 15000 } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs }).trim();
  } catch (e) {
    return { error: (e.killed ? 'timed out' : (e.stderr || e.message || 'failed')).toString().trim().split('\n')[0] };
  }
}
const ok = (r) => typeof r === 'string';
const lines = (r) => (ok(r) && r ? r.split('\n') : []);

// ---------- discovery ----------

/** Repos under `root`: directories holding a `.git` dir (a worktree's `.git` is a file, and shares its
 * parent's branches, so it is not counted separately). Skips node_modules and other `.git`-less noise. */
export function findRepos(root, { maxDepth = 3, sinceDays = null } = {}) {
  const found = [];
  const skip = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.venv', '__pycache__']);
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isDirectory() && e.name === '.git')) { found.push(dir); return; } // don't recurse into a repo's own tree
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || skip.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(path.resolve(root), 0);
  if (sinceDays === null) return found.sort();
  const cutoff = Date.now() / 1000 - sinceDays * 86400;
  return found.filter((r) => {
    const t = git(['log', '-1', '--format=%ct'], r);
    return ok(t) && t && Number(t) >= cutoff;
  }).sort();
}

// ---------- scanning one repo ----------

/** All local branches, ahead-count, newest commit, and whether HEAD is on that branch right now. */
function branchesAhead(repoPath, headBranch) {
  const refs = lines(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repoPath));
  const out = [];
  for (const b of refs) {
    const countRaw = git(['rev-list', '--count', b, '--not', '--remotes'], repoPath);
    const count = ok(countRaw) ? Number(countRaw) : 0;
    if (!count) continue;
    const info = git(['log', '-1', '--format=%ad\t%s', '--date=short', b], repoPath);
    const [date, subject] = ok(info) ? info.split('\t') : ['?', '?'];
    out.push({ branch: b, commitsAhead: count, newestDate: date, newestSubject: subject, checkedOut: b === headBranch });
  }
  return out.sort((a, b) => b.commitsAhead - a.commitsAhead);
}

/** Stash entries, newest first, as git lists them (index 0 = newest). */
function stashEntries(repoPath) {
  return lines(git(['stash', 'list', '--format=%gd\t%s'], repoPath)).map((l) => {
    const [ref, desc] = l.split('\t');
    return { ref, description: desc || '' };
  });
}

// git's own stash plumbing: the "index" and "WIP" commits a stash creates internally. A dropped stash
// leaves these dangling forever; they are never individually meaningful, so they're not reported —
// a live stash is already covered by stashEntries() above.
const STASH_PLUMBING = /^(index on |WIP on |On )\S+:/;

/** Commits not reachable from any branch, remote or tag. Some may still be held by the reflog for a
 * while (git's default grace period is 90 days); once that expires, an ordinary `git gc` removes them.
 * Content from a squash-merged branch can show up here too, even though that content is safe on the
 * branch it was merged into — the tool can't tell the two apart from the commit alone. Capped at `limit`. */
function danglingCommits(repoPath, limit = 20) {
  const raw = git(['fsck', '--unreachable', '--no-reflog'], repoPath, { timeoutMs: 30000 });
  if (!ok(raw)) return { commits: [], truncated: false, totalCount: 0, error: raw.error };
  const shas = lines(raw).filter((l) => l.startsWith('unreachable commit ')).map((l) => l.split(' ')[2]);
  const withSubjects = shas.map((sha) => {
    const info = git(['log', '-1', '--format=%ad\t%s', '--date=short', sha], repoPath);
    const [date, subject] = ok(info) ? info.split('\t') : ['?', '?'];
    return { sha, date, subject };
  }).filter((c) => !STASH_PLUMBING.test(c.subject));
  const truncated = withSubjects.length > limit;
  const commits = withSubjects.slice(0, limit).map((c) => ({ ...c, sha: c.sha.slice(0, 10) }));
  return { commits, truncated, totalCount: withSubjects.length };
}

/** Scans one repo. `repoPathIn` may be any path inside it; the actual git root is resolved first. */
export function scanRepo(repoPathIn, { fetch = true, fetchTimeoutMs = 20000 } = {}) {
  const top = git(['rev-parse', '--show-toplevel'], repoPathIn);
  if (!ok(top)) return { path: repoPathIn, error: `not a git repository: ${top.error}` };
  const repoPath = top;
  const remotes = lines(git(['remote'], repoPath));
  const hasRemote = remotes.length > 0;
  let fetchError = null;
  if (fetch && hasRemote) {
    const r = git(['fetch', '--all', '--quiet'], repoPath, { timeoutMs: fetchTimeoutMs });
    if (!ok(r)) fetchError = r.error;
  }
  const headBranch = git(['branch', '--show-current'], repoPath);
  const result = {
    path: repoPath,
    name: path.basename(repoPath),
    hasRemote,
    fetchError,
    branchesAhead: hasRemote ? branchesAhead(repoPath, ok(headBranch) ? headBranch : null) : [],
    stash: stashEntries(repoPath),
    dangling: danglingCommits(repoPath),
  };
  if (!hasRemote) {
    // every local commit is local-only; report it the same shape as an ahead-branch so callers don't special-case it
    const refs = lines(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repoPath));
    result.branchesAhead = refs.map((b) => {
      const countRaw = git(['rev-list', '--count', b], repoPath);
      const info = git(['log', '-1', '--format=%ad\t%s', '--date=short', b], repoPath);
      const [date, subject] = ok(info) ? info.split('\t') : ['?', '?'];
      return { branch: b, commitsAhead: ok(countRaw) ? Number(countRaw) : 0, newestDate: date, newestSubject: subject, checkedOut: b === headBranch };
    }).filter((b) => b.commitsAhead > 0);
  }
  return result;
}

export function isClean(r) {
  if (r.error) return false;
  return !r.hasRemote ? r.branchesAhead.length === 0 && r.stash.length === 0 && r.dangling.commits.length === 0
    : r.branchesAhead.length === 0 && r.stash.length === 0 && r.dangling.commits.length === 0;
}

// ---------- reporting ----------

function formatRepo(r) {
  if (r.error) return [`${r.path} | ERROR: ${r.error}`];
  const lines_ = [];
  const label = r.hasRemote ? r.name : `${r.name} | NO REMOTE CONFIGURED`;
  for (const b of r.branchesAhead) {
    lines_.push(`${label} | branch:${b.branch} | ${b.commitsAhead} commit${b.commitsAhead === 1 ? '' : 's'} ahead | newest: ${b.newestDate} "${b.newestSubject}" | HEAD-here: ${b.checkedOut ? 'yes' : 'no'}`);
  }
  if (r.stash.length) lines_.push(`${label} | stash: ${r.stash.length} entr${r.stash.length === 1 ? 'y' : 'ies'}: ${r.stash.map((s) => `"${s.description}"`).join(', ')}`);
  if (r.dangling.commits.length) {
    const more = r.dangling.truncated ? ` (+${r.dangling.totalCount - r.dangling.commits.length} more)` : '';
    lines_.push(`${label} | orphaned: ${r.dangling.totalCount} commit${r.dangling.totalCount === 1 ? '' : 's'} not reachable from any branch, remote or tag (not necessarily lost — some may already be merged elsewhere, or still held by the reflog)${more}: ${r.dangling.commits.slice(0, 3).map((c) => `${c.sha} "${c.subject}"`).join(', ')}`);
  }
  if (r.fetchError) lines_.push(`${label} | fetch failed: ${r.fetchError}`);
  if (!r.hasRemote && !r.branchesAhead.length) lines_.push(`${label}`);
  return lines_;
}

function report(results, { quiet = false } = {}) {
  const clean = results.filter(isClean);
  const dirty = results.filter((r) => !isClean(r));
  const out = [];
  if (!quiet) for (const r of clean) out.push(`${r.error ? r.path : r.name}: clean`);
  for (const r of dirty) out.push(...formatRepo(r));
  out.push(`\nClean: ${clean.length} of ${results.length} repo${results.length === 1 ? '' : 's'}.${clean.length && quiet ? ' (' + clean.map((r) => r.name).join(', ') + ')' : ''}`);
  if (dirty.length) out.push(`Needs attention: ${dirty.length} repo${dirty.length === 1 ? '' : 's'}: ${dirty.map((r) => r.name).join(', ')}`);
  return out.join('\n');
}

// ---------- CLI ----------

function flag(args, name, def) { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; }
function bool(args, name) { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; }

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 15).map((l) => l.slice(3)).join('\n'));
    return cmd ? 0 : 2;
  }
  const json = bool(rest, '--json');
  const quiet = bool(rest, '--quiet');
  const noFetch = bool(rest, '--no-fetch');
  const fetchTimeoutMs = Number(flag(rest, '--fetch-timeout-ms', 20000));

  if (cmd === 'find-repos') {
    const root = rest[0];
    if (!root) throw new Error('usage: find-repos <root> [--max-depth N] [--days N]');
    const maxDepth = Number(flag(rest, '--max-depth', 3));
    const days = flag(rest, '--days', null);
    const repos = findRepos(root, { maxDepth, sinceDays: days === null ? null : Number(days) });
    console.log(json ? JSON.stringify(repos, null, 2) : repos.join('\n'));
    return 0;
  }

  if (cmd === 'scan' || cmd === 'sweep') {
    let paths;
    if (cmd === 'sweep') {
      const root = rest[0];
      if (!root) throw new Error('usage: sweep <root> [--max-depth N] [--days N] [scan flags]');
      const maxDepth = Number(flag(rest, '--max-depth', 3));
      const days = flag(rest, '--days', null);
      paths = findRepos(root, { maxDepth, sinceDays: days === null ? null : Number(days) });
    } else {
      paths = rest.length ? rest : ['.'];
    }
    const results = paths.map((p) => scanRepo(p, { fetch: !noFetch, fetchTimeoutMs }));
    console.log(json ? JSON.stringify(results, null, 2) : report(results, { quiet }));
    return results.some((r) => !isClean(r)) ? 1 : 0;
  }

  throw new Error(`unknown command ${JSON.stringify(cmd)}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`unpushed-work: ${e.message}`); process.exitCode = 2; }
}
