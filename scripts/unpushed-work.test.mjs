// Run with: node --test scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRepos, scanRepo, isClean } from './unpushed-work.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'unpushed-work.mjs');
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
const commit = (dir, file, text, msg) => { write(dir, file, text); sh(dir, 'add', '.'); sh(dir, 'commit', '-q', '-m', msg); };

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@example.test');
  sh(dir, 'config', 'user.name', 'T');
  commit(dir, 'a.txt', 'a\n', 'init');
  return dir;
}

/** A repo with a real bare remote, so `rev-list --not --remotes` and `fetch` both behave like a real clone. */
function initRepoWithRemote(root, name) {
  const bare = path.join(root, `${name}.git`);
  sh(root, 'init', '-q', '--bare', bare);
  const dir = initRepo(path.join(root, name));
  sh(dir, 'remote', 'add', 'origin', bare);
  sh(dir, 'push', '-q', '-u', 'origin', 'main');
  return dir;
}

test('a repo pushed up to date is clean', () => {
  const root = tmp('uw-clean-');
  const dir = initRepoWithRemote(root, 'repo');
  const r = scanRepo(dir);
  assert.equal(isClean(r), true);
  assert.equal(r.hasRemote, true);
  assert.deepEqual(r.branchesAhead, []);
});

test('a branch with local commits the remote lacks is reported, with the checked-out flag correct', () => {
  const root = tmp('uw-ahead-');
  const dir = initRepoWithRemote(root, 'repo');
  commit(dir, 'b.txt', 'b\n', 'local only');
  const r = scanRepo(dir);
  assert.equal(isClean(r), false);
  assert.equal(r.branchesAhead.length, 1);
  assert.equal(r.branchesAhead[0].branch, 'main');
  assert.equal(r.branchesAhead[0].commitsAhead, 1);
  assert.equal(r.branchesAhead[0].newestSubject, 'local only');
  assert.equal(r.branchesAhead[0].checkedOut, true);
});

test('a branch that is not checked out is still found, and checkedOut is false', () => {
  const root = tmp('uw-other-branch-');
  const dir = initRepoWithRemote(root, 'repo');
  sh(dir, 'checkout', '-q', '-b', 'feature');
  commit(dir, 'c.txt', 'c\n', 'feature work');
  sh(dir, 'checkout', '-q', 'main');
  const r = scanRepo(dir);
  const feat = r.branchesAhead.find((b) => b.branch === 'feature');
  assert.ok(feat);
  assert.equal(feat.commitsAhead, 1);
  assert.equal(feat.checkedOut, false);
});

test('stash entries are reported with their description', () => {
  const root = tmp('uw-stash-');
  const dir = initRepoWithRemote(root, 'repo');
  write(dir, 'a.txt', 'changed\n');
  sh(dir, 'stash', 'push', '-m', 'wip thing');
  const r = scanRepo(dir);
  assert.equal(r.stash.length, 1);
  assert.match(r.stash[0].description, /wip thing/);
});

test('a repo with no remote reports every branch as local-only, and is never "clean" if it has commits', () => {
  const root = tmp('uw-noremote-');
  const dir = initRepo(path.join(root, 'solo'));
  const r = scanRepo(dir);
  assert.equal(r.hasRemote, false);
  assert.equal(r.branchesAhead.length, 1);
  assert.equal(r.branchesAhead[0].commitsAhead, 1);
  assert.equal(isClean(r), false);
});

test('a commit reachable only via the reflog is found as dangling, and survives being "lost" from the branch', () => {
  const root = tmp('uw-dangling-');
  const dir = initRepoWithRemote(root, 'repo');
  commit(dir, 'd.txt', 'd\n', 'will be reset away');
  const sha = sh(dir, 'rev-parse', 'HEAD').trim();
  sh(dir, 'reset', '-q', '--hard', 'HEAD~1'); // the commit above is now reachable only via the reflog
  const r = scanRepo(dir);
  assert.ok(r.dangling.commits.some((c) => sha.startsWith(c.sha)));
  assert.equal(isClean(r), false);
});

test('a dropped stash leaves its internal "index on"/"WIP on" commits dangling, and those are filtered out', () => {
  const root = tmp('uw-stashplumbing-');
  const dir = initRepoWithRemote(root, 'repo');
  write(dir, 'a.txt', 'changed\n');
  sh(dir, 'stash', 'push', '-m', 'temp');
  sh(dir, 'stash', 'drop');
  const r = scanRepo(dir);
  assert.equal(r.stash.length, 0); // the stash itself is gone
  assert.ok(!r.dangling.commits.some((c) => /^(index on |WIP on |On )/.test(c.subject)));
});

test('scanning a non-repo path reports an error, not a throw', () => {
  const dir = tmp('uw-notrepo-');
  const r = scanRepo(dir);
  assert.match(r.error, /not a git repository/);
  assert.equal(isClean(r), false);
});

test('findRepos finds nested repos but does not recurse into one', () => {
  const root = tmp('uw-find-');
  initRepoWithRemote(root, 'one');
  const nested = path.join(root, 'group', 'two');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  initRepoWithRemote(path.join(root, 'group'), 'two');
  fs.mkdirSync(path.join(root, 'one', 'src', 'deep'), { recursive: true }); // a dir inside a repo, must not be found as its own repo
  const found = findRepos(root);
  assert.equal(found.length, 2);
  assert.ok(found.some((f) => f.endsWith('one')));
  assert.ok(found.some((f) => f.endsWith('two')));
});

test('findRepos --days filters by the newest commit date', () => {
  const root = tmp('uw-days-');
  const old = path.join(root, 'old');
  fs.mkdirSync(old, { recursive: true });
  sh(old, 'init', '-q', '-b', 'main');
  sh(old, 'config', 'user.email', 't@example.test');
  sh(old, 'config', 'user.name', 'T');
  write(old, 'a.txt', 'a\n');
  sh(old, 'add', '.');
  execFileSync('git', ['commit', '-q', '-m', 'old'], {
    cwd: old,
    env: { ...process.env, GIT_AUTHOR_DATE: '2000-01-01T00:00:00', GIT_COMMITTER_DATE: '2000-01-01T00:00:00' },
  });
  const oldBare = path.join(root, 'old.git');
  sh(root, 'init', '-q', '--bare', oldBare);
  sh(old, 'remote', 'add', 'origin', oldBare);
  sh(old, 'push', '-q', '-u', 'origin', 'main');
  const dir = old;
  const recent = initRepoWithRemote(root, 'recent');
  const all = findRepos(root);
  assert.equal(all.length, 2);
  const filtered = findRepos(root, { sinceDays: 30 });
  assert.equal(filtered.length, 1);
  assert.ok(filtered[0].endsWith('recent'));
  void recent;
});

test('CLI: scan exits 1 when something is found and 0 when everything is clean, --json is parseable', () => {
  const root = tmp('uw-cli-');
  const dirty = initRepoWithRemote(root, 'dirty');
  commit(dirty, 'x.txt', 'x\n', 'unpushed');
  const clean = initRepoWithRemote(root, 'clean');
  const run = (args, { expectFail = false } = {}) => {
    try {
      return { out: execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' }), code: 0 };
    } catch (e) {
      if (!expectFail) throw e;
      return { out: e.stdout, code: e.status };
    }
  };
  const dirtyRes = run(['scan', dirty], { expectFail: true });
  assert.equal(dirtyRes.code, 1);
  assert.match(dirtyRes.out, /unpushed/);
  const cleanRes = run(['scan', clean]);
  assert.equal(cleanRes.code, 0);
  const jsonRes = run(['scan', dirty, '--json'], { expectFail: true });
  const parsed = JSON.parse(jsonRes.out);
  assert.equal(parsed[0].branchesAhead[0].commitsAhead, 1);
});

test('CLI: sweep finds and scans repos under a root in one call', () => {
  const root = tmp('uw-sweep-');
  initRepoWithRemote(root, 'a');
  const dirtyB = initRepoWithRemote(root, 'b');
  commit(dirtyB, 'y.txt', 'y\n', 'local work');
  let out;
  try { out = execFileSync('node', [SCRIPT, 'sweep', root, '--quiet'], { encoding: 'utf8' }); }
  catch (e) { assert.equal(e.status, 1); out = e.stdout; }
  assert.match(out, /Clean: 1 of 2/);
  assert.match(out, /local work/);
});

test('CLI with no arguments prints usage and exits non-zero; --help exits 0', () => {
  assert.throws(() => execFileSync('node', [SCRIPT], { encoding: 'utf8' }));
  const out = execFileSync('node', [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(out, /unpushed-work/);
});
