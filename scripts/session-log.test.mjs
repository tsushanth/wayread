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
