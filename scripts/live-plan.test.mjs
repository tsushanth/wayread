// Run with: node --test scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate, normalize, shownStatus, waitsOn, analyze, actualChanges, addVerify, renderHtml } from './live-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'live-plan.mjs');
const step = (id, extra = {}) => ({ id, stage: 0, title: `Step ${id}`, ...extra });
const plan = (steps, extra = {}) => normalize({ task: 'Test task', stages: ['A', 'B'], steps, ...extra });
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-plan-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 't@example.test');
  sh(dir, 'config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'src/b.txt'), 'b\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

test('validate accepts the shipped example', () => {
  const ex = JSON.parse(fs.readFileSync(path.join(here, '../examples/plan.example.json'), 'utf8'));
  assert.deepEqual(validate(ex), []);
});

test('validate reports duplicate ids, unknown needs, bad stage and bad status', () => {
  const errs = validate({ task: 't', stages: ['A'], steps: [step('x'), step('x'), step('y', { stage: 5, status: 'nope', needs: ['ghost'] })] });
  assert.ok(errs.some((e) => /duplicate id/.test(e)));
  assert.ok(errs.some((e) => /stage must be an index/.test(e)));
  assert.ok(errs.some((e) => /status must be one of/.test(e)));
  assert.ok(errs.some((e) => /unknown step "ghost"/.test(e)));
});

test('validate reports a dependency cycle', () => {
  const errs = validate({ task: 't', stages: ['A'], steps: [step('a', { needs: ['b'] }), step('b', { needs: ['a'] })] });
  assert.ok(errs.some((e) => /cycle/.test(e)));
});

test('a pending step is Blocked until everything it needs is done, then Ready', () => {
  const p = plan([step('a'), step('b', { needs: ['a'] }), step('c', { needs: ['a'] })]);
  assert.equal(shownStatus(p, p.steps[1]), 'blocked');
  p.steps[0].status = 'running';
  assert.equal(shownStatus(p, p.steps[1]), 'blocked');
  p.steps[0].status = 'done';
  assert.equal(shownStatus(p, p.steps[1]), 'ready');
  assert.equal(shownStatus(p, p.steps[2]), 'ready');
});

test('waitsOn follows chains', () => {
  const p = plan([step('a'), step('b', { needs: ['a'] }), step('c', { needs: ['b'] }), step('d')]);
  assert.equal(waitsOn(p, 'c', 'a'), true);
  assert.equal(waitsOn(p, 'a', 'c'), false);
  assert.equal(waitsOn(p, 'd', 'a'), false);
});

test('steps drawn as independent that write the same file are flagged; chained ones are not', () => {
  const loose = plan([step('a', { writes: ['f.ts'] }), step('b', { writes: ['f.ts'] })]);
  assert.ok(analyze(loose, new Map([['f.ts', 'M']])).some((f) => f.tag === 'shared file'));
  const chained = plan([step('a', { writes: ['f.ts'] }), step('b', { writes: ['f.ts'], needs: ['a'] })]);
  assert.ok(!analyze(chained, new Map([['f.ts', 'M']])).some((f) => f.tag === 'shared file'));
});

test('a changed file no step plans to write is flagged, unless a running step lists it as temporary', () => {
  const p = plan([step('a', { writes: ['planned.ts'], temp: ['scratch.ts'] })]);
  const changed = new Map([['planned.ts', 'M'], ['surprise.ts', 'M'], ['scratch.ts', 'M']]);
  const flags = analyze(p, changed).filter((f) => f.tag === 'unplanned');
  assert.deepEqual(flags.map((f) => f.text.split(' ')[0]).sort(), ['scratch.ts', 'surprise.ts']);
  p.steps[0].status = 'running';
  assert.deepEqual(analyze(p, changed).filter((f) => f.tag === 'unplanned').map((f) => f.text.split(' ')[0]), ['surprise.ts']);
});

test('a done step whose planned file shows no change in git is flagged, and so is a done step with no recorded result', () => {
  const p = plan([step('a', { writes: ['x.ts'], status: 'done', needsEvidence: true })]);
  const tags = analyze(p, new Map()).map((f) => f.tag);
  assert.ok(tags.includes('not changed'));
  assert.ok(tags.includes('no result'));
  p.evidence.push({ step: 'a', label: 'tests', text: '3 passed' });
  assert.ok(!analyze(p, new Map([['x.ts', 'M']])).some((f) => f.tag === 'no result'));
});

test('a step that started before its dependencies finished is flagged', () => {
  const p = plan([step('a'), step('b', { needs: ['a'], status: 'running' })]);
  assert.ok(analyze(p, new Map()).some((f) => f.tag === 'order'));
});

test('actualChanges sees committed and uncommitted changes since base, and skips the plan directory', () => {
  const dir = tmpRepo();
  const base = sh(dir, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, 'src/a.txt'), 'a2\n');
  sh(dir, 'commit', '-q', '-am', 'change a');
  fs.writeFileSync(path.join(dir, 'src/b.txt'), 'b2\n');
  fs.mkdirSync(path.join(dir, '.plans'));
  fs.writeFileSync(path.join(dir, '.plans/plan.json'), '{}');
  const changed = actualChanges({ worktree: dir, base }, path.join(dir, '.plans'));
  assert.deepEqual([...changed.keys()].sort(), ['src/a.txt', 'src/b.txt']);
});

test('addVerify appends a chained Verify stage once', () => {
  const p = plan([step('a'), step('b', { needs: ['a'] })]);
  assert.deepEqual(addVerify(p), ['verify-code-review', 'verify-coverage', 'verify-guardrails']);
  assert.deepEqual(addVerify(p), []);
  assert.equal(p.stages.at(-1), 'Verify');
  const by = Object.fromEntries(p.steps.map((s) => [s.id, s]));
  assert.deepEqual(by['verify-code-review'].needs, ['a', 'b']);
  assert.deepEqual(by['verify-coverage'].needs, ['verify-code-review']);
  assert.deepEqual(validate(p), []);
});

test('the page escapes text from the plan and cannot be broken out of its script block', () => {
  const evil = '</script><img src=x onerror=alert(1)>';
  const p = plan([step('a', { title: evil, note: evil })], { task: evil });
  p.steps[0].short = evil;
  const html = renderHtml(p, new Map(), [], '');
  assert.ok(!html.includes('<img src=x'));
  const data = html.split('id="plan-data">')[1].split('</script>')[0];
  assert.doesNotThrow(() => JSON.parse(data));
});

test('CLI: render, status and add-verify write plan.html next to plan.json and keep the plan valid', () => {
  const repo = tmpRepo();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-plan-state-'));
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify({ task: 'CLI task', stages: ['Build'], steps: [step('a', { writes: ['src/a.txt'] }), step('b', { needs: ['a'], writes: ['src/b.txt'] })] }));
  const run = (...args) => execFileSync('node', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });
  assert.match(run('render', file), /0\/2 done, ready: a/);
  assert.ok(fs.existsSync(path.join(dir, 'plan.html')));
  assert.match(run('status', file, 'a', 'running', '--note', 'working on it'), /ready: none/);
  assert.match(run('status', file, 'a', 'done'), /ready: b/);
  run('evidence', file, 'a', 'tests', '4', 'passed');
  run('finding', file, 'looks', 'fine', '--kind', 'verified');
  assert.match(run('add-verify', file), /added: verify-code-review/);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.steps[0].note, 'working on it');
  assert.equal(saved.evidence[0].text, '4 passed');
  assert.equal(saved.findings[0].kind, 'verified');
  assert.equal(saved.repo, path.basename(fs.realpathSync(repo)));
  assert.ok(saved.base && saved.worktree);
  assert.throws(() => run('status', file, 'nope', 'done'), /no step "nope"/);
});
