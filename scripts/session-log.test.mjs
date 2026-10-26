import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { scanCwds, decideLocation, resolveRepoRoot, REPO_THRESHOLD, writeFlag, listPending, claimFlag, clearFlag, failFlag, locate } from './session-log.mjs';

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
