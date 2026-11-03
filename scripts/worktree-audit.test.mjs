// Run with: node --test scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyDirty, deployableFiles, sessionsFor, attributionFromAssistantLine, encodeProjectDir, parsePorcelain, isExperimental, touchesTests, parseFlyApp, matchTargets, decide, holdFor, slugFromUrl, DEFAULTS } from './worktree-audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'worktree-audit.mjs');
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const write = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const commit = (dir, file, text, msg) => { write(dir, file, text); sh(dir, 'add', '.'); sh(dir, 'commit', '-q', '-m', msg); };

test('encodeProjectDir matches how Claude Code names a session folder', () => {
  assert.equal(encodeProjectDir('/Users/x/Documents/GitHub/.scripts/feature-harness'), '-Users-x-Documents-GitHub--scripts-feature-harness');
  assert.equal(encodeProjectDir('/Users/x/Documents/GitHub/worktrees/ra-deploy-main3'), '-Users-x-Documents-GitHub-worktrees-ra-deploy-main3');
});

test('parsePorcelain reads branch, detached and prunable entries', () => {
  const w = parsePorcelain('worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/w1\nHEAD bbb\ndetached\n\nworktree /gone\nHEAD ccc\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n');
  assert.deepEqual(w.map((x) => [x.path, x.branch, x.detached, x.prunable]), [['/r', 'main', false, false], ['/r/w1', null, true, false], ['/gone', 'x', false, true]]);
});

test('experimental names, test files, fly app and deploy-target matching', () => {
  assert.ok(isExperimental('spike/foo') && isExperimental('feat-exp-1') && isExperimental(null, 'wip-thing') && isExperimental('diag-schema'));
  assert.ok(!isExperimental('feat/lead-planner') && !isExperimental('restart/scout-rubric-v2') && !isExperimental('fix/contest'));
  assert.ok(touchesTests(['src/a.ts', 'backend/test/x.test.ts']) && touchesTests(['a/__tests__/b.js']) && !touchesTests(['src/a.ts', 'README.md']));
  assert.equal(parseFlyApp("# c\napp = 'summary-ai-backend'\nprimary_region='sjc'"), 'summary-ai-backend');
  const targets = [{ dir: 'backend', kind: 'fly', app: 'b' }, { dir: 'web', kind: 'fly', app: 'w' }];
  assert.deepEqual(matchTargets(targets, ['backend/src/a.ts', 'docs/x.md']).map((t) => t.app), ['b']);
  assert.deepEqual(matchTargets(targets, ['docs/x.md']), []);
  assert.deepEqual(matchTargets([{ dir: '.', kind: 'fly', app: 'r' }], ['anything']).map((t) => t.app), ['r']);
  assert.equal(slugFromUrl('https://github.com/tsushanth/wayread.git'), 'tsushanth/wayread');
  assert.equal(slugFromUrl('git@github.com:tsushanth/ops-notes-private.git'), 'tsushanth/ops-notes-private');
});

const base = { isMain: false, dirty: 0, live: false, detached: false, branch: 'feat/x', name: 'x', noRemote: false, uniqueVsDefault: 3, onlyHere: 0, pushed: true, pr: null, headSha: 'h1', prod: null, experimental: false, idleDays: 2, hasTests: true, conflicts: false, mergedEquivalent: false };
const d = (over) => decide({ ...base, ...over }, DEFAULTS).key;

test('decide: anything that could lose work or disturb a live session wins first', () => {
  assert.equal(d({ isMain: true }), 'MAIN');
  assert.equal(d({ dirty: 2, dirtyFiles: ['a', 'b'], pr: { state: 'MERGED', number: 1, headRefOid: 'h1' } }), 'KEEP_DIRTY');
  assert.equal(d({ live: true, liveWhy: 'touched 3 min ago' }), 'KEEP_ACTIVE');
  assert.equal(d({ hold: 'policy hold' }), 'KEEP_HOLD');
});

test('decide: nothing unique is dropped; merged work is judged by production', () => {
  assert.equal(d({ uniqueVsDefault: 0 }), 'DROP_EMPTY');
  const merged = { state: 'MERGED', number: 7, mergedAt: '2026-11-01T00:00:00Z', headRefOid: 'h1' };
  assert.equal(d({ pr: merged, prod: { status: 'deployed', detail: 'x' } }), 'DROP_PROD');
  assert.equal(d({ pr: merged, prod: { status: 'not-deployed', detail: 'x' } }), 'KEEP_DEPLOY');
  assert.equal(d({ pr: merged, prod: { status: 'na', detail: 'docs only' } }), 'DROP_NA');
  assert.equal(d({ pr: merged, prod: { status: 'unknown', detail: 'cloudflare' } }), 'DROP_MERGED');
  assert.equal(d({ pr: null, mergedEquivalent: true, prod: { status: 'deployed', detail: 'x' } }), 'DROP_PROD');
});

test('decide: commits made after the PR was merged must be pushed, not silently dropped', () => {
  assert.equal(d({ pr: { state: 'MERGED', number: 7, headRefOid: 'OLD' }, headSha: 'NEW', prod: { status: 'deployed', detail: 'x' } }), 'PUSH_FIRST');
});

test('decide: open and closed PRs', () => {
  assert.equal(d({ pr: { state: 'OPEN', number: 3 } }), 'KEEP_REVIEW');
  assert.equal(d({ pr: { state: 'CLOSED', number: 3 } }), 'DROP_ABANDONED');
});

test('decide: no PR, the take-to-prod vs drop call', () => {
  assert.equal(d({ noRemote: true, onlyHere: 4 }), 'KEEP_NOREMOTE');
  assert.equal(d({}), 'PUSH_PR'); // fresh, has tests, no conflicts
  assert.equal(d({ experimental: true }), 'DROP_EXP');
  assert.equal(d({ idleDays: 30, hasTests: false }), 'DROP_EXP'); // stale
  assert.equal(d({ conflicts: true }), 'DECIDE'); // recent but conflicting: needs a human
  assert.equal(d({ idleDays: 10, hasTests: true }), 'DECIDE'); // between fresh and stale
});

test('holdFor matches configured hold entries by repo or path, case-insensitively', () => {
  assert.ok(holdFor({ repo: 'Some-Repo', path: '/x' }, [{ match: 'some-repo', why: 'rule' }]));
  assert.equal(holdFor({ repo: 'other', path: '/x' }, [{ match: 'some-repo', why: 'rule' }]), null);
  assert.equal(holdFor({ repo: 'other', path: '/x' }, []), null);
});

// ---- end to end on real temporary repos ----
function setup() {
  const root = tmp('wtaudit-');
  const origin = path.join(root, 'origin.git'); fs.mkdirSync(origin); sh(origin, 'init', '-q', '--bare', '-b', 'main');
  const repo = path.join(root, 'app'); fs.mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main'); sh(repo, 'config', 'user.email', 't@example.test'); sh(repo, 'config', 'user.name', 'T');
  commit(repo, 'a.txt', 'a\n', 'init');
  sh(repo, 'remote', 'add', 'origin', origin); sh(repo, 'push', '-q', '-u', 'origin', 'main');
  sh(repo, 'fetch', '-q', 'origin'); sh(repo, 'remote', 'set-head', 'origin', 'main');
  const wts = path.join(root, 'worktrees'); fs.mkdirSync(wts);
  const mk = (name, branch) => { const p = path.join(wts, name); sh(repo, 'worktree', 'add', '-q', '-b', branch, p, 'main'); sh(p, 'config', 'user.email', 't@example.test'); sh(p, 'config', 'user.name', 'T'); return p; };
  // empty: at main
  mk('wt-empty', 'empty-branch');
  // dirty
  write(mk('wt-dirty', 'dirty-branch'), 'scratch.txt', 'x');
  // fresh local work with a test, never pushed
  const feat = mk('wt-feat', 'feat/planner'); commit(feat, 'src/p.js', 'p\n', 'planner'); commit(feat, 'test/p.test.js', 't\n', 'planner test');
  // experimental, unpushed
  const exp = mk('wt-exp', 'spike/idea'); commit(exp, 'idea.js', 'i\n', 'idea');
  // pushed branch (commits on a remote), experimental name
  const pushed = mk('wt-pushed', 'try/pushed'); commit(pushed, 'p2.js', 'p\n', 'pushed work'); sh(pushed, 'push', '-q', '-u', 'origin', 'try/pushed');
  // work that was later merged into main by fast-forward
  const ff = mk('wt-merged', 'feat/merged'); commit(ff, 'm.js', 'm\n', 'merged work'); sh(repo, 'merge', '-q', '--ff-only', 'feat/merged'); sh(repo, 'push', '-q', 'origin', 'main'); sh(repo, 'fetch', '-q', 'origin');
  // a repo with no remote at all
  const solo = path.join(root, 'solo'); fs.mkdirSync(solo); sh(solo, 'init', '-q', '-b', 'main'); sh(solo, 'config', 'user.email', 't@example.test'); sh(solo, 'config', 'user.name', 'T'); commit(solo, 'a.txt', 'a\n', 'init');
  const sw = path.join(wts, 'wt-solo'); sh(solo, 'worktree', 'add', '-q', '-b', 'only-here', sw, 'main'); sh(sw, 'config', 'user.email', 't@example.test'); sh(sw, 'config', 'user.name', 'T'); commit(sw, 's.js', 's\n', 'solo work');
  return root;
}

test('end to end: each worktree gets the right decision', () => {
  const root = setup();
  const out = execFileSync('node', [SCRIPT, '--root', root, '--fast', '--no-sessions', '--idle-min', '0', '--json'], { encoding: 'utf8' });
  const rows = JSON.parse(out);
  const by = Object.fromEntries(rows.filter((r) => !r.isMain).map((r) => [r.name, r.decision.key]));
  assert.equal(by['wt-empty'], 'DROP_EMPTY');
  assert.equal(by['wt-dirty'], 'KEEP_DIRTY');
  assert.equal(by['wt-feat'], 'PUSH_PR');
  assert.equal(by['wt-exp'], 'DROP_EXP');
  assert.equal(by['wt-pushed'], 'DROP_EXP');
  assert.equal(by['wt-merged'], 'DROP_EMPTY'); // already in main
  assert.equal(by['wt-solo'], 'KEEP_NOREMOTE');
  const exp = rows.find((r) => r.name === 'wt-exp'); assert.equal(exp.onlyHere, 1);
  const pushed = rows.find((r) => r.name === 'wt-pushed'); assert.equal(pushed.onlyHere, 0);
});

test('end to end: the text report never runs anything and lists safe drops separately from local-only commits', () => {
  const root = setup();
  const out = execFileSync('node', [SCRIPT, '--root', root, '--fast', '--no-sessions', '--idle-min', '0'], { encoding: 'utf8' });
  assert.match(out, /SAFE TO DROP/);
  assert.match(out, /worktree remove .*wt-empty/);
  assert.match(out, /worktree remove .*wt-pushed/);
  assert.match(out, /HAS COMMITS ON NO REMOTE/);
  assert.match(out, /wt-exp: 1 local-only commit/);
  assert.match(out, /push -u origin feat\/planner/);
  assert.ok(fs.existsSync(path.join(root, 'worktrees', 'wt-empty')), 'nothing was removed');
});

test('attribution counts only a session\'s own tool calls, never text that merely lists worktree names', () => {
  const asst = (input, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-03T10:00:00Z', message: { content: [{ type: 'tool_use', name: 'Bash', input, ...extra }] } });
  const created = attributionFromAssistantLine(asst({ command: 'cd /r && git worktree add -b feat/x ~/Documents/GitHub/worktrees/my-wt origin/main' }));
  assert.deepEqual(created.map((a) => [a.name, a.add]), [['my-wt', true]]);
  const worked = attributionFromAssistantLine(asst({ command: 'git -C /Users/x/Documents/GitHub/worktrees/other-wt status' }));
  assert.deepEqual(worked.map((a) => [a.name, a.add]), [['other-wt', false]]);
  // a tool RESULT (type user) listing every worktree must not credit anyone
  const listing = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '/x/worktrees/aaa-1\n/x/worktrees/bbb-2' }] } });
  assert.deepEqual(attributionFromAssistantLine(listing), []);
  // assistant plain text that mentions a path is not a tool call either
  const prose = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'see /x/worktrees/ccc-3' }] } });
  assert.deepEqual(attributionFromAssistantLine(prose), []);
  // placeholders in prompts are not worktree names
  assert.deepEqual(attributionFromAssistantLine(asst({ prompt: 'git worktree add ~/Documents/GitHub/worktrees/<name> -b <branch>' })), []);
});

test('sessionsFor ranks started-here, then creator, and exposes when the session last touched the worktree', () => {
  const wt = '/Users/x/Documents/GitHub/worktrees/wt-a';
  const sessions = new Map([
    ['s-mention', { id: 's-mention', title: 'a', lastActive: 5, project: '-other', hits: { 'wt-a': { n: 9, add: 0, first: '2026-11-03T01:00:00Z', last: '2026-11-03T02:00:00Z' } } }],
    ['s-creator', { id: 's-creator', title: 'b', lastActive: 6, project: '-other', hits: { 'wt-a': { n: 1, add: 1, first: '2026-11-02T01:00:00Z', last: '2026-11-02T01:05:00Z' } } }],
    ['s-here', { id: 's-here', title: 'c', lastActive: 7, project: encodeProjectDir(wt), hits: {} }],
    ['s-unrelated', { id: 's-unrelated', title: 'd', lastActive: 8, project: '-other', hits: { 'other-wt': { n: 5, add: 0 } } }],
  ]);
  const r = sessionsFor(wt, sessions);
  assert.deepEqual(r.map((x) => x.id), ['s-here', 's-creator', 's-mention']);
  assert.equal(r[1].lastTouchMs, Date.parse('2026-11-02T01:05:00Z'));
  assert.equal(r[0].lastTouchMs, 0);
});

test('HTML report: self-contained, embeds the rows safely, and --from-json re-renders without touching git', () => {
  const root = setup();
  const out = tmp('wthtml-'); const json = path.join(out, 'rows.json'); const html = path.join(out, 'a.html'); const html2 = path.join(out, 'b.html');
  execFileSync('node', [SCRIPT, '--root', root, '--fast', '--no-sessions', '--idle-min', '0', '--json-out', json, '--html', html], { encoding: 'utf8' });
  const page = fs.readFileSync(html, 'utf8');
  assert.match(page, /^<!DOCTYPE html>/);
  assert.match(page, /<title>Worktree Audit<\/title>/);
  assert.ok(!/https?:\/\/(?!github\.com)/.test(page.replace(/<a href=[^>]*>/g, '')), 'no external resources');
  const data = JSON.parse(page.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const names = data.rows.map((r) => r.name).sort();
  assert.deepEqual(names, ['wt-dirty', 'wt-empty', 'wt-exp', 'wt-feat', 'wt-merged', 'wt-pushed', 'wt-solo']);
  assert.equal(data.rows.find((r) => r.name === 'wt-feat').decision, 'PUSH+PR');
  assert.ok(data.rows.find((r) => r.name === 'wt-empty').safeDrop);
  assert.ok(!data.rows.find((r) => r.name === 'wt-exp').safeDrop, 'a drop with commits on no remote is not in the safe list');
  // re-render from the saved rows: same worktrees, no repo access needed
  execFileSync('node', [SCRIPT, '--from-json', json, '--html', html2, '--root', '/nonexistent'], { encoding: 'utf8' });
  const data2 = JSON.parse(fs.readFileSync(html2, 'utf8').match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(data2.rows.map((r) => r.name).sort(), names);
});

test('HTML report escapes markup that appears in branch names or reasons', async () => {
  const { renderHtml } = await import('./worktree-audit.mjs');
  const row = { isMain: false, name: 'x</script><b>', repo: 'r', main: '/m', path: '/p', branch: '"><img src=x>', decision: { key: 'DROP_EMPTY', decision: 'DROP', label: 'l', why: '</script><script>alert(1)</script>' }, idleMin: 5, idleDays: 0, dirty: 0, onlyHere: 0, uniqueVsDefault: 0, sessions: [] };
  const page = renderHtml([row], { sessionDays: 21, idleMin: 120, staleDays: 14 });
  assert.equal((page.match(/<\/script>/g) || []).length, 2, 'only the two real script closers');
  assert.ok(!page.includes('<script>alert(1)'));
});

test('classifyDirty: build noise is not work, real edits and other untracked files are', () => {
  const r = classifyDirty([
    '?? android/app/.cxx/RelWithDebInfo/abc/arm64-v8a/.cmake/api/x.json', '?? ai-email-backend/node_modules/.bin/tsc', '?? tts/__pycache__/a.cpython-314.pyc',
    ' M src/real.ts', '?? pnpm-lock.yaml', '?? shots/', 'A  new.txt', ' D gone.txt', '?? run.log']);
  assert.deepEqual(r.real, ['src/real.ts', 'pnpm-lock.yaml', 'shots/', 'new.txt', 'gone.txt']);
  assert.equal(r.noise, 4);
  // a TRACKED file inside a noise-named folder is still a real change
  assert.deepEqual(classifyDirty([' M build/config.json']).real, ['build/config.json']);
});

test('deployableFiles ignores tests, docs and markdown', () => {
  assert.deepEqual(deployableFiles(['src/a.ts', 'backend/test/x.test.ts', 'docs/y.md', 'README.md', 'web/spec/z.js', 'lib/a.spec.ts']), ['src/a.ts']);
});

test('decide: diverged history is never suggested for a push', () => {
  const merged = { state: 'MERGED', number: 34, headRefOid: 'OLD' };
  // 120+ local-only commits and a merged PR: looks like pre-rewrite history, not "work after the merge"
  assert.equal(d({ pr: merged, headSha: 'NEW', uniqueVsDefault: 143, onlyHere: 127 }), 'DECIDE_DIVERGED');
  assert.equal(d({ noMergeBase: true, uniqueVsDefault: 5, onlyHere: 5 }), 'DECIDE_DIVERGED');
  assert.equal(d({ uniqueVsDefault: 3, onlyHere: 1 }), 'PUSH_PR'); // ordinary small work is unaffected
  assert.equal(d({ uniqueVsDefault: 60, onlyHere: 2 }), 'PUSH_PR'); // many commits that ARE on a remote are fine
});
