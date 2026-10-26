import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { scanCwds, decideLocation, resolveRepoRoot, REPO_THRESHOLD, writeFlag, listPending, claimFlag, clearFlag, failFlag, locate, gitleaksCheck, writeAndPublish, writeFallbackEntry } from './session-log.mjs';

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

test('claimFlag rethrows non-ENOENT filesystem errors instead of treating them as a lost race', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-pending-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  // A regular file where the pending directory should be makes rename fail with ENOTDIR, not ENOENT.
  fs.writeFileSync(path.join(dir, 'session-map-pending'), 'not a directory');
  assert.throws(() => claimFlag('s1'), (err) => err.code !== 'ENOENT');
});

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

// Points core.hooksPath at an empty, isolated dir so test output doesn't inherit this
// machine's global pre-push hook noise (it would otherwise run gitleaks a second time itself).
function disableHooks(dir) {
  const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-nohooks-'));
  execFileSync('git', ['config', 'core.hooksPath', hooksDir], { cwd: dir });
}

function initRepoWithBareRemote(root, name) {
  const bare = path.join(root, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  disableHooks(dir);
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: dir });
  return dir;
}

// Brand-new repo: remote configured, but nothing ever committed or pushed yet — no `-u`,
// no pre-push. Covers the review-flagged "first push of a fresh branch" case.
function initFreshRepoWithUnpushedRemote(root, name) {
  const bare = path.join(root, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@example.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  disableHooks(dir);
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir });
  return { dir, bare };
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
  const bare = path.join(root, 'repo.git');
  const result = writeAndPublish({ repoRoot: dir, relPath: 'docs/session-log/2026-10-26-leak.md', content: "key: AKIAABCDEFGHIJKLMNOP\n", commitMessage: 'session log: leak' });
  assert.equal(result.ok, false);
  assert.match(result.error, /gitleaks|secret|leak/i); // it's specifically a leak finding, not just any failure
  const bareLog = execFileSync('git', ['--git-dir', bare, 'log', '--oneline', 'main'], { encoding: 'utf8' });
  assert.doesNotMatch(bareLog, /session log: leak/); // local commit may exist, but it never reached the remote itself
});

test('writeAndPublish refuses to touch a branch that already has other unpushed commits on it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-publish-scoped-'));
  const dir = initRepoWithBareRemote(root, 'repo');
  // Someone else's real, committed-but-unpushed work already on this branch.
  fs.writeFileSync(path.join(dir, 'someone-elses-wip.txt'), 'wip\n');
  execFileSync('git', ['add', 'someone-elses-wip.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'wip: not ready to push'], { cwd: dir });

  const result = writeAndPublish({ repoRoot: dir, relPath: 'docs/session-log/2026-10-26-scoped.md', content: '# scoped\n', commitMessage: 'session log: scoped' });
  assert.equal(result.ok, false);
  assert.match(result.error, /unpushed commit/i);
  assert.equal(fs.existsSync(path.join(dir, 'docs/session-log/2026-10-26-scoped.md')), false); // never even wrote the file
  const bareLog = execFileSync('git', ['--git-dir', path.join(root, 'repo.git'), 'log', '--oneline', 'main'], { encoding: 'utf8' });
  assert.doesNotMatch(bareLog, /scoped/); // and the remote never saw any of it
});

test('writeAndPublish succeeds even with an unrelated stash or another local branch ahead — only the current branch vs its own remote tracking matters', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-publish-stash-'));
  const dir = initRepoWithBareRemote(root, 'repo');
  // An unrelated stash and an unrelated second branch ahead of its own remote — neither is part
  // of what a scoped `git push HEAD:main` would ever send, so neither should block this.
  fs.writeFileSync(path.join(dir, 'scratch.txt'), 'scratch\n');
  execFileSync('git', ['add', 'scratch.txt'], { cwd: dir });
  execFileSync('git', ['stash', 'push', '-m', 'unrelated wip'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', '-b', 'other-branch'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'other-branch-file.txt'), 'x\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'unrelated branch work'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir });

  const result = writeAndPublish({ repoRoot: dir, relPath: 'docs/session-log/2026-10-26-stash.md', content: '# stash\n', commitMessage: 'session log: stash' });
  assert.equal(result.ok, true);
  const bareLog = execFileSync('git', ['--git-dir', path.join(root, 'repo.git'), 'log', '--oneline', 'main'], { encoding: 'utf8' });
  assert.match(bareLog, /session log: stash/);
});

test('writeAndPublish succeeds on a brand-new repo pushing its very first commit, with no upstream configured yet', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-publish-first-'));
  const { dir, bare } = initFreshRepoWithUnpushedRemote(root, 'repo');
  const result = writeAndPublish({ repoRoot: dir, relPath: 'docs/session-log/2026-10-26-first.md', content: '# first\n', commitMessage: 'session log: first' });
  assert.equal(result.ok, true);
  const bareLog = execFileSync('git', ['--git-dir', bare, 'log', '--oneline', 'main'], { encoding: 'utf8' });
  assert.match(bareLog, /session log: first/);
});

test('writeAndPublish reports a push rejection without force-pushing, leaving the local commit and the remote intact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-publish-reject-'));
  const dir = initRepoWithBareRemote(root, 'repo');
  const bare = path.join(root, 'repo.git');

  // A second clone pushes ahead first, so the original clone's next push is a non-fast-forward.
  // The bare repo's own HEAD symref still points at the never-created default branch (the
  // fixture only ever created "main" via push -u, never touched the bare's HEAD), so a plain
  // clone checks out an unrelated empty branch — explicitly track "main" instead.
  const clone2 = path.join(root, 'repo2');
  execFileSync('git', ['clone', '-q', bare, clone2]);
  execFileSync('git', ['config', 'user.email', 't@example.test'], { cwd: clone2 });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: clone2 });
  execFileSync('git', ['checkout', '-B', 'main', 'origin/main'], { cwd: clone2 });
  disableHooks(clone2);
  fs.writeFileSync(path.join(clone2, 'other.txt'), 'other\n');
  execFileSync('git', ['add', '.'], { cwd: clone2 });
  execFileSync('git', ['commit', '-q', '-m', 'other change'], { cwd: clone2 });
  execFileSync('git', ['push', '-q'], { cwd: clone2 });

  const beforeLog = execFileSync('git', ['--git-dir', bare, 'log', '--oneline', 'main'], { encoding: 'utf8' });

  const result = writeAndPublish({ repoRoot: dir, relPath: 'docs/session-log/2026-10-26-reject.md', content: '# reject\n', commitMessage: 'session log: reject' });
  assert.equal(result.ok, false);
  assert.match(result.error, /rejected|fetch first|non-fast-forward/i);

  const localLog = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
  assert.match(localLog, /session log: reject/); // the local commit is still there — never reset or dropped

  const afterLog = execFileSync('git', ['--git-dir', bare, 'log', '--oneline', 'main'], { encoding: 'utf8' });
  assert.equal(afterLog, beforeLog); // the remote is byte-for-byte unchanged by the failed attempt
});

test('writeAndPublish refuses to publish from a detached HEAD', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-publish-detached-'));
  const dir = initRepoWithBareRemote(root, 'repo');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  execFileSync('git', ['checkout', '-q', sha], { cwd: dir }); // detach

  const result = writeAndPublish({ repoRoot: dir, relPath: 'docs/session-log/2026-10-26-detached.md', content: '# detached\n', commitMessage: 'session log: detached' });
  assert.equal(result.ok, false);
  assert.match(result.error, /detached/i);
});

test('writeAndPublish rejects a relPath that escapes the repo root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-publish-traversal-'));
  const dir = initRepoWithBareRemote(root, 'repo');
  const result = writeAndPublish({ repoRoot: dir, relPath: '../escape.md', content: 'x', commitMessage: 'escape' });
  assert.equal(result.ok, false);
  assert.match(result.error, /relative|traverse/i);
  assert.equal(fs.existsSync(path.join(root, 'escape.md')), false);
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
