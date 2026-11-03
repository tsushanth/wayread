#!/usr/bin/env node
// worktree-audit: map every git worktree to the Claude session that made it, compare what each one holds against what is in
// production, and give one decision per worktree: DROP it (already in prod, merged, nothing unique, or experimental), PUSH it
// (take it to production: push + open a PR), or KEEP it (dirty, in use, in review, merged-but-not-deployed, no remote).
//
// Read-only. It never pushes, removes, fetches (unless --fetch) or deploys; it prints the commands it would suggest.
//
//   node worktree-audit.mjs [--root DIR] [--repo SUBSTR] [--json] [--no-gh] [--no-prod] [--no-sessions] [--fetch]
//                           [--idle-min N] [--stale-days N] [--days N] [--all]
//                           [--json-out FILE] [--html FILE] [--from-json FILE]
//
// "In production" is judged from evidence, and the report says which kind:
//   * GitHub PR state (merged / open / closed) for the branch, via `gh` (skip with --no-gh).
//   * Fly: the app's latest completed release time vs the PR's merge time (merged after the last release = NOT deployed;
//     merged before it = deployed, "likely": a release does not record which commit it was built from).
//   * Android: a play/release/v* tag that contains the merge commit.
//   * Anything else (Cloudflare workers, Cloud Run, mini launchd jobs) is reported as "prod unknown", never guessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
export const DEFAULTS = { maxCommits: 40, root: path.join(HOME, 'Documents', 'GitHub'), idleMin: 120, staleDays: 14, freshDays: 7, sessionDays: 21, liveMin: 20 };

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: opts.timeout || 30000, maxBuffer: 64 * 1024 * 1024 }).trimEnd();
  } catch { return null; }
}
const git = (cwd, ...args) => run('git', args, { cwd });
const num = (s) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : 0; };

// ---------- pure helpers (unit-tested) ----------

/** Claude Code names a session's project folder after the directory it started in: every '/' and '.' becomes '-'. */
export function encodeProjectDir(p) { return p.replace(/[/.]/g, '-'); }

export function parsePorcelain(text) {
  const out = []; let cur = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null, detached: false, head: null, prunable: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}

const EXPERIMENTAL = /(^|[/_-])(exp|experiment|experimental|spike|poc|try|wip|tmp|scratch|sandbox|probe|diag|diagnose|prototype|test)([/_-]|$)/i;
export const isExperimental = (...names) => names.some((n) => n && EXPERIMENTAL.test(n));
export const touchesTests = (files) => (files || []).some((f) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i.test(f));

export function parseFlyApp(toml) {
  const m = String(toml || '').match(/^\s*app\s*=\s*['"]([^'"]+)['"]/m);
  return m ? m[1] : null;
}

/** Which deploy targets (fly dirs, android) do these changed files touch? targets: [{dir:'.'|'backend', kind:'fly'|'android', app?}] */
export function matchTargets(targets, files) {
  const hit = [];
  for (const t of targets) {
    const touched = (files || []).some((f) => t.dir === '.' ? true : f === t.dir || f.startsWith(t.dir + '/'));
    if (touched) hit.push(t);
  }
  return hit;
}

/** Repos whose worktrees must never be suggested for production. Set them in ~/.claude/worktree-audit-policy.json: {"hold":[{"match":"substring of repo or path","why":"..."}]} */
export const BUILTIN_HOLDS = []; // none are built in: holds are private policy and live in the policy file
export function loadHolds() {
  let extra = []; try { extra = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'worktree-audit-policy.json'), 'utf8')).hold || []; } catch { /* none */ }
  return [...BUILTIN_HOLDS, ...extra];
}
export const holdFor = (f, holds) => (holds.find((h) => `${f.repo} ${f.path}`.toLowerCase().includes(String(h.match).toLowerCase())) || {}).why || null;

/** Untracked build output is not "work": a worktree whose only changes are these can be removed. Tracked edits, staged files and other untracked files always count. */
const NOISE = /(^|\/)(node_modules|\.cxx|\.kotlin|__pycache__|\.gradle|\.next|dist|build|\.idea|\.dart_tool|Pods|DerivedData|\.pytest_cache|\.mypy_cache|\.turbo)(\/|$)|\.(pyc|log|class)$|(^|\/)\.DS_Store$/;
export function classifyDirty(lines) {
  const real = []; let noise = 0;
  for (const l of lines) {
    const code = l.slice(0, 2); const p = l.slice(3).replace(/^"|"$/g, '');
    if (code === '??' && NOISE.test(p)) noise++; else real.push(p);
  }
  return { real, noise };
}

/** Files whose deployment matters: tests, docs and markdown never make a merged PR "not deployed". */
export const deployableFiles = (files) => (files || []).filter((f) => !/(^|\/)(tests?|__tests__|spec|docs?)\//i.test(f) && !/\.(md|test\.[a-z]+|spec\.[a-z]+)$/i.test(f));

export const D = {
  MAIN: ['MAIN', 'main checkout (not a candidate)'],
  KEEP_DIRTY: ['KEEP', 'uncommitted changes'],
  KEEP_ACTIVE: ['KEEP', 'in use right now'],
  KEEP_REVIEW: ['KEEP', 'in review'],
  KEEP_DEPLOY: ['KEEP', 'merged, not deployed yet'],
  KEEP_NOREMOTE: ['KEEP', 'no remote: the only copy'],
  DECIDE_DIVERGED: ['DECIDE', 'history diverged from main: do not push'],
  KEEP_HOLD: ['KEEP', 'policy hold'],
  DROP_PROD: ['DROP', 'already in production'],
  DROP_EMPTY: ['DROP', 'nothing unique (at or behind main)'],
  DROP_MERGED: ['DROP', 'merged (production not checkable)'],
  DROP_NA: ['DROP', 'merged; touches nothing deployable'],
  DROP_ABANDONED: ['DROP', 'abandoned (PR closed unmerged)'],
  DROP_EXP: ['DROP', 'experimental / stale'],
  PUSH_PR: ['PUSH+PR', 'take to production'],
  PUSH_FIRST: ['PUSH FIRST', 'commits exist only here'],
  DECIDE: ['DECIDE', 'take to production or drop'],
};

/**
 * One decision per worktree, from facts only. Order matters: anything that could lose work or disturb a live session wins.
 * f: {isMain, dirty, dirtyFiles, live, liveWhy, detached, branch, name, noRemote, uniqueVsDefault, onlyHere, pushed, pr, headSha,
 *     prod:{status:'deployed'|'not-deployed'|'na'|'unknown', detail}, experimental, idleDays, hasTests, conflicts, mergedEquivalent}
 */
export function decide(f, o = DEFAULTS) {
  const r = (key, why, extra = {}) => ({ key, decision: D[key][0], label: D[key][1], why, ...extra });
  if (f.isMain) return r('MAIN', 'the repo itself');
  if (f.dirty > 0) return r('KEEP_DIRTY', `${f.dirty} changed/untracked file(s): ${(f.dirtyFiles || []).slice(0, 3).join(', ')}. Commit or discard first; never dropped automatically`);
  if (f.live) return r('KEEP_ACTIVE', f.liveWhy || 'recently touched or its session is live');
  if (f.hold) return r('KEEP_HOLD', `${f.hold}. Never suggested for production or push-to-prod; drop only if you decide to`);
  const maxC = o.maxCommits || 40;
  if (f.hasOrigin !== false && (f.noMergeBase || (f.uniqueVsDefault > maxC && f.onlyHere > maxC / 2))) {
    return r('DECIDE_DIVERGED', `${f.noMergeBase ? 'shares no history with main' : `${f.uniqueVsDefault} commits ahead of main, ${f.onlyHere} on no remote`}: this looks like history from before a rewrite (for example the secrets audit) or an unrelated branch. Do NOT push it: that could republish removed history, secrets included. Inspect with git log origin/main..HEAD, then drop it or cherry-pick what matters`);
  }
  const pr = f.pr;
  const prMerged = pr && pr.state === 'MERGED';
  const localAfterPr = prMerged && pr.headRefOid && f.headSha && pr.headRefOid !== f.headSha;
  if (!prMerged && f.uniqueVsDefault === 0 && f.onlyHere === 0) return r('DROP_EMPTY', `HEAD is already in the default branch${f.detached ? ' (detached)' : ''}; nothing would be lost`);
  if (prMerged && !localAfterPr || (!pr && f.mergedEquivalent)) {
    const how = prMerged ? `PR #${pr.number} merged ${String(pr.mergedAt || '').slice(0, 10)}` : 'every commit already exists in the default branch';
    const p = f.prod || { status: 'unknown', detail: 'not checked' };
    if (p.status === 'deployed') return r('DROP_PROD', `${how}; ${p.detail}`);
    if (p.status === 'not-deployed') return r('KEEP_DEPLOY', `${how}; ${p.detail}. Deploy it (or confirm it should not ship) before dropping`);
    if (p.status === 'na') return r('DROP_NA', `${how}; ${p.detail}`);
    return r('DROP_MERGED', `${how}; production state: ${p.detail}`);
  }
  if (localAfterPr) return r('PUSH_FIRST', `PR #${pr.number} merged, but this worktree has newer commits than the PR head: push them (or confirm they are throwaway)`);
  if (pr && pr.state === 'CLOSED') return r('DROP_ABANDONED', `PR #${pr.number} closed without merging; its commits stay on GitHub under refs/pull/${pr.number}/head`);
  if (pr && pr.state === 'OPEN') {
    const extra = f.onlyHere > 0 ? ` ${f.onlyHere} newer commit(s) are not pushed yet: push to update the PR.` : '';
    return r('KEEP_REVIEW', `PR #${pr.number}${pr.isDraft ? ' (draft)' : ''} is open${f.idleDays > o.staleDays ? `, untouched ${Math.round(f.idleDays)} days: review or close it` : ''}.${extra}`);
  }
  // No PR from here on.
  if (f.noRemote) return r('KEEP_NOREMOTE', 'this repo has no remote, so these commits exist nowhere else; add a remote and push before any cleanup');
  const fresh = f.idleDays <= o.freshDays;
  const stale = f.idleDays > o.staleDays;
  const prod = !f.experimental && fresh && (f.hasTests || f.uniqueVsDefault >= 1) && !f.conflicts;
  const warnLocal = f.onlyHere > 0 ? ` ${f.onlyHere} commit(s) are not on any remote (they stay on the local branch if the worktree is removed).` : '';
  if (prod) return r('PUSH_PR', `${f.uniqueVsDefault} unique commit(s), recent, ${f.hasTests ? 'touches tests, ' : ''}no conflicts with main, no PR yet: push the branch and open a PR.${warnLocal}`);
  if (f.experimental || stale) return r('DROP_EXP', `${f.experimental ? 'experimental name' : 'untouched ' + Math.round(f.idleDays) + ' days'}, ${f.uniqueVsDefault} unique commit(s), no PR.${warnLocal} Push first only if you might want it back`);
  return r('DECIDE', `${f.uniqueVsDefault} unique commit(s), idle ${Math.round(f.idleDays)} days, ${f.conflicts ? 'CONFLICTS with main' : 'no PR'}. Lean: ${f.conflicts ? 'drop or rebase first' : 'open a PR if still wanted'}.${warnLocal}`);
}

// ---------- discovery ----------

function isGitFile(d) { try { return fs.statSync(path.join(d, '.git')).isFile(); } catch { return false; } }
function isGitDir(d) { try { return fs.statSync(path.join(d, '.git')).isDirectory(); } catch { return false; } }

export function discover(root) {
  const worktreeDirs = new Set(); const repos = [];
  const add = (d) => { if (isGitFile(d)) { try { worktreeDirs.add(fs.realpathSync(d)); } catch { /* gone */ } } };
  for (const sub of ['worktrees', '_wt']) {
    const base = path.join(root, sub);
    try { for (const n of fs.readdirSync(base)) add(path.join(base, n)); } catch { /* none */ }
  }
  const walk = (d, depth) => {
    if (isGitDir(d)) {
      repos.push(d);
      const cw = path.join(d, '.claude', 'worktrees');
      try { for (const n of fs.readdirSync(cw)) add(path.join(cw, n)); } catch { /* none */ }
      return;
    }
    if (depth >= 2) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'worktrees', '_wt'].includes(e.name)) walk(path.join(d, e.name), depth + 1);
  };
  walk(root, 0);
  return { repos, worktreeDirs: [...worktreeDirs] };
}

/** Group by repository (git common dir) and list every registered worktree of each. */
export function collect(root) {
  const { repos, worktreeDirs } = discover(root);
  const groups = new Map();
  for (const d of [...repos, ...worktreeDirs]) {
    let common = git(d, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    if (!common) { const c = git(d, 'rev-parse', '--git-common-dir'); common = c ? path.resolve(d, c) : null; }
    if (!common) continue;
    if (!groups.has(common)) groups.set(common, { common, main: path.dirname(common), wts: new Map() });
  }
  for (const g of groups.values()) {
    const listed = parsePorcelain(git(g.main, 'worktree', 'list', '--porcelain'));
    listed.forEach((w, i) => {
      let real = w.path; try { real = fs.realpathSync(w.path); } catch { w.missing = true; }
      g.wts.set(real, { ...w, path: real, isMain: i === 0 });
    });
  }
  return [...groups.values()];
}

// ---------- per-worktree facts ----------

function newestMtime(dir, maxDepth = 4) {
  let newest = 0;
  const SKIP = new Set(['node_modules', '.git', 'build', '.gradle', '.next', 'dist', '.venv', 'venv', 'Pods', 'DerivedData', '__pycache__', '.cache']);
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      try { const st = fs.statSync(p); if (st.mtimeMs > newest) newest = st.mtimeMs; if (e.isDirectory() && depth < maxDepth) walk(p, depth + 1); } catch { /* raced */ }
    }
  };
  walk(dir, 0);
  return newest;
}

function defaultBranch(main) {
  const ref = git(main, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (ref) return ref.replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (git(main, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`)) return b;
  return 'main';
}

export function slugFromUrl(url) {
  const m = String(url || '').match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

function worktreeFacts(g, w, opts, now) {
  const wt = w.path;
  const def = g.def;
  const branch = w.detached ? null : w.branch;
  const f = {
    path: wt, name: path.basename(wt), repo: path.basename(g.main), main: g.main, branch: branch || '(detached)', detached: w.detached, isMain: w.isMain,
    missing: !!w.missing, headSha: w.head, slug: g.slug, noRemote: !g.hasOrigin,
  };
  if (w.missing) return { ...f, dirty: 0, onlyHere: 0, uniqueVsDefault: 0, idleDays: 9999, prunable: true };
  const st = git(wt, 'status', '--porcelain', '--untracked-files=normal') || '';
  const dirty = classifyDirty(st.split('\n').filter(Boolean));
  f.dirty = dirty.real.length; f.dirtyFiles = dirty.real.slice(0, 5); f.buildNoise = dirty.noise;
  f.subject = git(wt, 'log', '-1', '--format=%s') || '';
  const commitTs = num(git(wt, 'log', '-1', '--format=%ct')) * 1000;
  f.lastCommit = commitTs ? new Date(commitTs).toISOString() : null;
  const newest = Math.max(newestMtime(wt), commitTs);
  f.idleMin = Math.round((now - newest) / 60000); f.idleDays = (now - newest) / 86400000;
  f.onlyHere = num(git(wt, 'rev-list', '--count', 'HEAD', '--not', '--remotes'));
  const base = `origin/${def}`;
  f.uniqueVsDefault = g.hasOrigin ? num(git(wt, 'rev-list', '--count', `${base}..HEAD`)) : f.onlyHere;
  f.hasOrigin = g.hasOrigin; f.noMergeBase = g.hasOrigin && git(wt, 'merge-base', 'HEAD', base) === null;
  f.pushed = !!(branch && git(wt, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`));
  const cherry = git(wt, 'cherry', base, 'HEAD');
  f.mergedEquivalent = f.uniqueVsDefault > 0 && cherry !== null && cherry.split('\n').filter(Boolean).every((l) => l.startsWith('-'));
  const files = (git(wt, 'diff', '--name-only', `${base}...HEAD`) || '').split('\n').filter(Boolean).slice(0, 400);
  f.changedFiles = files; f.hasTests = touchesTests(files);
  f.experimental = isExperimental(branch, f.name) || /^wip\b/i.test(f.subject);
  if (g.mergeTreeOk === undefined) g.mergeTreeOk = run('git', ['merge-tree', '--write-tree', 'HEAD', 'HEAD'], { cwd: wt }) !== null; // needs git >= 2.38
  f.conflicts = g.mergeTreeOk && f.uniqueVsDefault > 0 && g.hasOrigin ? run('git', ['merge-tree', '--write-tree', base, 'HEAD'], { cwd: wt }) === null : false; // non-zero exit = conflicts
  return f;
}

// ---------- GitHub PRs ----------

const prCache = new Map();
export function loadPrs(slug) {
  if (!slug) return null;
  if (prCache.has(slug)) return prCache.get(slug);
  const out = run('gh', ['pr', 'list', '-R', slug, '--state', 'all', '--limit', '400', '--json', 'number,state,headRefName,headRefOid,mergedAt,mergeCommit,updatedAt,isDraft,url'], { timeout: 60000 });
  let by = null;
  if (out) { try { by = new Map(); for (const p of JSON.parse(out)) { const prev = by.get(p.headRefName); if (!prev || p.number > prev.number) by.set(p.headRefName, p); } } catch { by = null; } }
  prCache.set(slug, by); return by;
}

// ---------- production comparison ----------

const flyCache = new Map();
function flyLatest(app) {
  if (flyCache.has(app)) return flyCache.get(app);
  const out = run('flyctl', ['releases', '-a', app, '--json'], { timeout: 45000 });
  let v = null;
  if (out) { try { const r = JSON.parse(out).find((x) => /complete/i.test(x.Status)); if (r) v = { version: r.Version, at: Date.parse(r.CreatedAt) }; } catch { v = null; } }
  flyCache.set(app, v); return v;
}

function deployTargets(wt) {
  const t = [];
  const scan = (rel, depth) => {
    const dir = path.join(wt, rel);
    const toml = path.join(dir, 'fly.toml');
    if (fs.existsSync(toml)) { const app = parseFlyApp(fs.readFileSync(toml, 'utf8')); if (app) t.push({ dir: rel || '.', kind: 'fly', app }); }
    if (depth >= 2) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'build', 'dist'].includes(e.name)) scan(path.join(rel, e.name), depth + 1);
  };
  scan('', 0);
  if (fs.existsSync(path.join(wt, 'android', 'app')) || fs.existsSync(path.join(wt, 'app', 'build.gradle.kts'))) t.push({ dir: fs.existsSync(path.join(wt, 'android')) ? 'android' : 'app', kind: 'android' });
  if (!t.length) { try { if (fs.existsSync(path.join(wt, 'wrangler.toml'))) t.push({ dir: '.', kind: 'cloudflare' }); } catch { /* none */ } }
  return t;
}

function prodStatus(f, pr, opts) {
  if (opts.noProd) return { status: 'unknown', detail: 'production check skipped (--no-prod)' };
  const targets = deployTargets(f.path);
  let files = f.changedFiles || [];  // narrowed to deployable files below
  if (pr && pr.state === 'MERGED') {
    const v = opts.noGh ? null : run('gh', ['pr', 'view', String(pr.number), '-R', f.slug, '--json', 'files'], { timeout: 30000 });
    if (v) { try { files = JSON.parse(v).files.map((x) => x.path); } catch { /* keep */ } }
  }
  if (!targets.length) return { status: 'unknown', detail: 'no fly.toml / android / worktree-visible deploy target; production not checkable from here' };
  files = deployableFiles(files);
  const flyCount = targets.filter((x) => x.kind === 'fly').length;
  const hit = matchTargets(targets, files);
  if (!hit.length) return { status: 'na', detail: 'only docs/tests/non-deployed paths changed' };
  const mergedAt = pr && pr.mergedAt ? Date.parse(pr.mergedAt) : null;
  const parts = []; let worst = 'deployed';
  for (const t of hit) {
    if (t.kind === 'fly') {
      const rel = flyLatest(t.app);
      if (!rel) { parts.push(`${t.app}: release list unavailable`); worst = 'unknown'; continue; }
      if (!mergedAt) { parts.push(`${t.app}: merge time unknown`); worst = 'unknown'; continue; }
      if (rel.at >= mergedAt) parts.push(`${t.app} v${rel.version} released ${new Date(rel.at).toISOString().slice(0, 16)}Z, after the merge (likely live)`);
      else if (t.dir === '.' && flyCount > 1) { parts.push(`${t.app} last release v${rel.version} ${new Date(rel.at).toISOString().slice(0, 16)}Z is before the merge, but this repo has several apps and the change cannot be tied to this one`); if (worst === 'deployed') worst = 'unknown'; }
      else { parts.push(`${t.app} last release v${rel.version} ${new Date(rel.at).toISOString().slice(0, 16)}Z is BEFORE the merge: NOT deployed`); worst = 'not-deployed'; }
    } else if (t.kind === 'android') {
      const oid = pr && pr.mergeCommit && pr.mergeCommit.oid;
      const tags = oid ? (git(f.main, 'tag', '--contains', oid) || '').split('\n').filter((x) => /^(play|release|v\d)/i.test(x)) : [];
      if (tags.length) parts.push(`android: shipped in tag ${tags[0]}`);
      else { parts.push(`android: no release tag contains it (releases are not always tagged: check Play before assuming it did not ship)`); worst = 'unknown'; }
    } else { parts.push(`${t.kind}: not checkable here`); worst = 'unknown'; }
  }
  return { status: worst, detail: parts.join('; ') };
}

// ---------- sessions ----------

const PROJECTS = path.join(HOME, '.claude', 'projects');
const CACHE_FILE = path.join(HOME, '.claude', 'cache', 'worktree-sessions-v2.json');

function listTranscripts(days) {
  const cutoff = Date.now() - days * 86400000; const out = [];
  let projs = []; try { projs = fs.readdirSync(PROJECTS); } catch { return out; }
  for (const p of projs) {
    const pd = path.join(PROJECTS, p);
    let ents; try { ents = fs.readdirSync(pd, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const fp = path.join(pd, e.name);
      if (e.isFile() && e.name.endsWith('.jsonl')) { const st = fs.statSync(fp); if (st.mtimeMs >= cutoff) out.push({ file: fp, session: e.name.replace(/\.jsonl$/, ''), top: true, size: st.size, mtime: st.mtimeMs, project: p }); }
      else if (e.isDirectory() && /^[0-9a-f-]{36}$/.test(e.name)) {
        const walk = (d, depth) => {
          let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
          for (const x of es) {
            const xp = path.join(d, x.name);
            if (x.isFile() && x.name.endsWith('.jsonl')) { const st = fs.statSync(xp); if (st.mtimeMs >= cutoff) out.push({ file: xp, session: e.name, top: false, size: st.size, mtime: st.mtimeMs, project: p }); }
            else if (x.isDirectory() && depth < 4 && x.name !== 'tool-results') walk(xp, depth + 1);
          }
        };
        walk(path.join(pd, e.name, 'subagents'), 0);
      }
    }
  }
  return out;
}

const NAME_RE = /\/(?:worktrees|_wt)\/([A-Za-z0-9._+@-]{3,})/g;
const ADD_RE = /worktree add\s+((?:-{1,2}[A-Za-z-]+(?:\s+(?![/~.])[^\s]+)?\s+)*)([^\s'"`;|&]+)/;

/**
 * Attribution uses only what the session itself DID, not text that merely contains a name: tool listings, pasted reports and other
 * sessions' messages all print worktree names, and counting them credits the wrong session. So: a session "created" a worktree when one
 * of its own Bash commands ran `git worktree add <path>`, and "worked in" it when its own tool calls (commands, prompts to subagents)
 * name the path. Anything the model only READ (tool results, user text) is ignored.
 */
export function attributionFromAssistantLine(line) {
  let d; try { d = JSON.parse(line); } catch { return []; }
  if (d.type !== 'assistant') return [];
  const content = d.message && d.message.content; if (!Array.isArray(content)) return [];
  const ts = d.timestamp || null; const out = [];
  for (const b of content) {
    if (!b || b.type !== 'tool_use' || !b.input) continue;
    const text = JSON.stringify(b.input);
    const cmd = typeof b.input.command === 'string' ? b.input.command : '';
    const created = new Set();
    if (cmd.includes('worktree add')) { const m = cmd.match(ADD_RE); if (m) created.add(path.basename(m[2].replace(/\/+$/, ''))); }
    NAME_RE.lastIndex = 0; let m; const seen = new Set();
    while ((m = NAME_RE.exec(text))) { if (!seen.has(m[1])) { seen.add(m[1]); out.push({ name: m[1], add: created.has(m[1]), ts }); } }
    for (const c of created) if (!seen.has(c)) out.push({ name: c, add: true, ts });
  }
  return out;
}

async function scanTranscript(t) {
  const hits = {}; let title = null; let lines = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(t.file), crlfDelay: Infinity });
  for await (const line of rl) {
    lines++;
    if (t.top && !title && lines < 400 && line.includes('"type":"user"')) {
      try {
        const d = JSON.parse(line); const c = d.message && d.message.content;
        const txt = typeof c === 'string' ? c : (c || []).map((x) => x && x.text || '').join(' ');
        const s = txt.trim();
        if (s && !s.startsWith('<') && !s.startsWith('Base directory') && !s.startsWith('Caveat') && !s.startsWith('[Request')) title = s.replace(/\s+/g, ' ').slice(0, 110);
      } catch { /* partial line */ }
    }
    if (!line.includes('"type":"assistant"')) continue;
    if (!line.includes('worktrees/') && !line.includes('_wt/') && !line.includes('worktree add')) continue;
    for (const a of attributionFromAssistantLine(line)) {
      const h = hits[a.name] || (hits[a.name] = { n: 0, add: 0, first: a.ts, last: a.ts });
      h.n++; if (a.add) h.add++; if (a.ts) { if (!h.first || a.ts < h.first) h.first = a.ts; if (!h.last || a.ts > h.last) h.last = a.ts; }
    }
  }
  return { hits, title };
}

export async function buildSessionIndex(days, onProgress) {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { cache = {}; }
  const files = listTranscripts(days); const next = {}; const sessions = new Map(); let scanned = 0;
  for (const t of files) {
    let e = cache[t.file];
    if (!e || e.size !== t.size || e.mtime !== t.mtime) { e = { size: t.size, mtime: t.mtime, ...(await scanTranscript(t)) }; scanned++; if (onProgress) onProgress(scanned, files.length); }
    next[t.file] = e;
    const s = sessions.get(t.session) || { id: t.session, title: null, lastActive: 0, hits: {}, project: t.project };
    s.lastActive = Math.max(s.lastActive, t.mtime);
    if (t.top && e.title) s.title = e.title;
    for (const [name, h] of Object.entries(e.hits || {})) {
      const x = s.hits[name] || (s.hits[name] = { n: 0, add: 0, first: h.first, last: h.last });
      x.n += h.n; x.add += h.add; if (h.first && (!x.first || h.first < x.first)) x.first = h.first; if (h.last && (!x.last || h.last > x.last)) x.last = h.last;
    }
    sessions.set(t.session, s);
  }
  try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(next)); } catch { /* cache is optional */ }
  return sessions;
}

/** Sessions for one worktree: ones that started inside it, then the ones that created it, then the ones that mention it most. */
export function sessionsFor(wtPath, sessions) {
  const name = path.basename(wtPath);
  const enc = encodeProjectDir(wtPath);
  const out = [];
  for (const s of sessions.values()) {
    const h = s.hits[name];
    const startedHere = s.project === enc;
    if (!startedHere && !h) continue;
    out.push({ id: s.id, title: s.title, lastActive: s.lastActive, startedHere, created: !!(h && h.add), mentions: h ? h.n : 0, first: h && h.first, lastTouchMs: h && h.last ? Date.parse(h.last) : 0 });
  }
  out.sort((a, b) => (b.startedHere - a.startedHere) || (b.created - a.created) || (b.mentions - a.mentions));
  return out;
}

// ---------- main ----------

function parseArgs(argv) {
  const o = { ...DEFAULTS, json: false, noGh: false, noProd: false, noSessions: false, fetch: false, all: false, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') o.root = path.resolve(argv[++i]);
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--no-gh') o.noGh = true;
    else if (a === '--no-prod') o.noProd = true;
    else if (a === '--no-sessions') o.noSessions = true;
    else if (a === '--fetch') o.fetch = true;
    else if (a === '--all') o.all = true;
    else if (a === '--idle-min') o.idleMin = num(argv[++i]);
    else if (a === '--stale-days') o.staleDays = num(argv[++i]);
    else if (a === '--days') o.sessionDays = num(argv[++i]);
    else if (a === '--fast') { o.noGh = true; o.noProd = true; }
    else if (a === '--json-out') o.jsonOut = path.resolve(argv[++i]);
    else if (a === '--html') o.html = path.resolve(argv[++i]);
    else if (a === '--from-json') o.fromJson = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') { o.help = true; }
  }
  return o;
}

export async function audit(opts) {
  const now = Date.now();
  const groups = collect(opts.root).filter((g) => !opts.repo || g.main.includes(opts.repo));
  let sessions = new Map();
  if (!opts.noSessions) sessions = await buildSessionIndex(opts.sessionDays, (n, t) => { if (!opts.json && process.stderr.isTTY) process.stderr.write(`\rindexing sessions ${n}/${t}`); });
  const rows = []; const holds = loadHolds();
  for (const g of groups) {
    g.hasOrigin = !!git(g.main, 'remote', 'get-url', 'origin');
    g.slug = slugFromUrl(git(g.main, 'remote', 'get-url', 'origin'));
    if (opts.fetch && g.hasOrigin) run('git', ['fetch', '-q', '--prune', 'origin'], { cwd: g.main, timeout: 60000 });
    g.def = defaultBranch(g.main);
    const prs = !opts.noGh && g.slug ? loadPrs(g.slug) : null;
    for (const w of g.wts.values()) {
      const f = worktreeFacts(g, w, opts, now);
      f.pr = prs && f.branch !== '(detached)' ? (prs.get(f.branch) || null) : null;
      if (f.pr && f.pr.state === 'MERGED' && f.headSha === f.pr.headRefOid) f.mergedEquivalent = true;
      const need = !f.isMain && !f.missing && (f.pr && f.pr.state === 'MERGED' || f.mergedEquivalent);
      f.prod = need ? prodStatus(f, f.pr, opts) : null;
      f.hold = holdFor(f, holds);
      f.sessions = opts.noSessions ? [] : sessionsFor(f.path, sessions);
      // "In use" = files touched recently, or a session's OWN tool call named this worktree recently, or a session that started inside it is
      // active. A live session that merely owns dozens of older worktrees is NOT using each of them.
      const recentTouch = f.sessions.find((x) => x.lastTouchMs && (now - x.lastTouchMs) < opts.idleMin * 60000);
      const startedLive = f.sessions.find((x) => x.startedHere && (now - x.lastActive) < opts.liveMin * 60000);
      f.live = !f.isMain && (f.idleMin < opts.idleMin || !!recentTouch || !!startedLive);
      f.liveWhy = f.idleMin < opts.idleMin ? `files touched ${f.idleMin} min ago`
        : recentTouch ? `session ${recentTouch.id.slice(0, 8)} ran a command on it ${Math.round((now - recentTouch.lastTouchMs) / 60000)} min ago`
        : startedLive ? `session ${startedLive.id.slice(0, 8)} started inside it and is active` : '';
      f.decision = f.missing ? { key: 'DROP_EMPTY', decision: 'PRUNE', label: 'directory is gone', why: 'registered but missing on disk: `git worktree prune`' } : decide(f, opts);
      rows.push(f);
    }
  }
  return rows;
}

const ORDER = ['KEEP', 'PUSH FIRST', 'PUSH+PR', 'DECIDE', 'DROP', 'PRUNE', 'MAIN'];
const short = (p) => p.replace(HOME, '~');
const MERGED_KEYS = ['DROP_PROD', 'DROP_MERGED', 'DROP_NA', 'DROP_ABANDONED'];

/** The cleanup plan, shared by the text and HTML reports. Commands are only ever printed. A merged/closed PR's commits live on GitHub
 *  (squash merges delete the branch, so `onlyHere` is not meaningful there). */
export function plan(rows) {
  const cand = rows.filter((f) => !f.isMain);
  const safeDrop = cand.filter((f) => f.decision.decision === 'DROP' && (f.onlyHere === 0 || MERGED_KEYS.includes(f.decision.key)));
  const dropWithLocal = cand.filter((f) => f.decision.decision === 'DROP' && f.onlyHere > 0 && !MERGED_KEYS.includes(f.decision.key));
  const pushes = cand.filter((f) => f.decision.decision === 'PUSH+PR' || f.decision.decision === 'PUSH FIRST');
  const dropCmd = (f) => `git -C ${short(f.main)} worktree remove ${short(f.path)}`;
  const pushCmd = (f) => `git -C ${short(f.path)} push -u origin ${f.branch}`;
  const prune = cand.filter((f) => f.decision.decision === 'PRUNE');
  return { safeDrop, dropWithLocal, pushes, prune, dropCmd, pushCmd };
}

export function render(rows, opts) {
  const lines = [];
  const bySession = new Map();
  for (const f of rows) {
    if (f.isMain && !opts.all) continue;
    const k = (f.sessions && f.sessions[0] && f.sessions[0].id) || '(no session found)';
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k).push(f);
  }
  const sessMeta = new Map();
  for (const f of rows) for (const s of f.sessions || []) if (!sessMeta.has(s.id)) sessMeta.set(s.id, s);
  const keys = [...bySession.keys()].sort((a, b) => ((sessMeta.get(b) || {}).lastActive || 0) - ((sessMeta.get(a) || {}).lastActive || 0));
  for (const k of keys) {
    const m = sessMeta.get(k);
    lines.push('');
    lines.push(m ? `SESSION ${k.slice(0, 8)}  last active ${new Date(m.lastActive).toISOString().slice(0, 16)}Z  ${m.title ? '| ' + m.title : ''}` : `SESSION ${k}  (no transcript mentions these within --days ${opts.sessionDays}; widen with --days)`);
    const list = bySession.get(k).sort((a, b) => ORDER.indexOf(a.decision.decision) - ORDER.indexOf(b.decision.decision) || a.name.localeCompare(b.name));
    for (const f of list) {
      lines.push(`  ${f.decision.decision.padEnd(10)} ${f.name}  [${f.repo} @ ${f.branch}]  idle ${f.idleDays > 1 ? Math.round(f.idleDays) + 'd' : f.idleMin + 'm'}${f.pr ? `  PR #${f.pr.number} ${f.pr.state.toLowerCase()}` : ''}`);
      lines.push(`             ${f.decision.label}: ${f.decision.why}`);
    }
  }
  const counts = {}; for (const f of rows) if (!f.isMain) counts[f.decision.decision] = (counts[f.decision.decision] || 0) + 1;
  lines.push('', 'SUMMARY ' + ORDER.filter((x) => counts[x]).map((x) => `${x}: ${counts[x]}`).join('  |  '));
  const p = plan(rows);
  if (p.safeDrop.length) {
    lines.push('', 'SAFE TO DROP (clean, every commit already on a remote or in main/merged; the branch stays in the main repo). Not run for you:');
    for (const f of p.safeDrop) lines.push(`  ${p.dropCmd(f)}`);
  }
  if (p.dropWithLocal.length) {
    lines.push('', 'DROP DECIDED, BUT HAS COMMITS ON NO REMOTE (the branch survives in the main repo; push first if you may want it back):');
    for (const f of p.dropWithLocal) lines.push(`  ${f.name}: ${f.onlyHere} local-only commit(s)   push: ${p.pushCmd(f)}   drop: ${p.dropCmd(f)}`);
  }
  if (p.pushes.length) {
    lines.push('', 'TO TAKE TO PRODUCTION (push the branch, then open a PR). Not run for you:');
    for (const f of p.pushes) lines.push(`  ${p.pushCmd(f)}   # then: gh pr create`);
  }
  if (p.prune.length) { lines.push('', 'REGISTERED BUT MISSING ON DISK (run `git worktree prune` in each repo):'); for (const f of p.prune) lines.push(`  git -C ${short(f.main)} worktree prune   # ${f.name}`); }
  lines.push('', 'Evidence: PR state from GitHub; "likely live" = a Fly release came after the merge (a release does not record its commit); not checked: Cloudflare workers, Cloud Run, launchd jobs. Refs are as of the last fetch (use --fetch to refresh).');
  return lines.join('\n');
}

const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** One self-contained HTML page: summary, the cleanup plan with Copy buttons, and every worktree grouped by session with filters. */
export function renderHtml(rows, opts, meta = {}) {
  const p = plan(rows);
  const data = rows.filter((f) => !f.isMain).map((f) => ({
    name: f.name, repo: f.repo, branch: f.branch, path: short(f.path), key: f.decision.key, decision: f.decision.decision, label: f.decision.label, why: f.decision.why,
    idleMin: f.idleMin, idleDays: Math.round((f.idleDays || 0) * 10) / 10, dirty: f.dirty || 0, onlyHere: f.onlyHere || 0, unique: f.uniqueVsDefault || 0, pushed: !!f.pushed,
    pr: f.pr ? { n: f.pr.number, state: f.pr.state, url: f.pr.url } : null, prod: f.prod ? f.prod.status : null, subject: f.subject || '',
    safeDrop: p.safeDrop.includes(f), dropCmd: p.dropCmd(f), pushCmd: p.pushCmd(f),
    sessions: (f.sessions || []).slice(0, 3).map((s) => ({ id: s.id.slice(0, 8), title: s.title, lastActive: s.lastActive, startedHere: s.startedHere, created: s.created })),
  }));
  const json = JSON.stringify({ rows: data, generated: new Date().toISOString(), sessionDays: opts.sessionDays, idleMin: opts.idleMin, staleDays: opts.staleDays, gh: !opts.noGh, prod: !opts.noProd, ...meta }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Worktree Audit</title>
<style>
/* layout: summary strip, cleanup plan, filter bar, then one collapsible block per session */
:root{--bg:#f6f7f9;--panel:#fff;--ink:#16202b;--mute:#5d6b7a;--line:#dde2e8;--accent:#1f5fd1;
--drop:#14795a;--dropbg:#e2f3ec;--push:#1f5fd1;--pushbg:#e3ecfb;--keep:#5d6b7a;--keepbg:#eceff3;--decide:#9a6200;--decidebg:#fbf0d9;--warn:#b3261e;--warnbg:#fbe4e2;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#10151b;--panel:#171d25;--ink:#e6ebf0;--mute:#98a5b3;--line:#27313c;--accent:#6aa0ff;--drop:#52c9a1;--dropbg:#12332a;--push:#7fb0ff;--pushbg:#16284a;--keep:#98a5b3;--keepbg:#212a34;--decide:#f0b950;--decidebg:#3a2c0e;--warn:#ff8a80;--warnbg:#3d1a18;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#10151b;--panel:#171d25;--ink:#e6ebf0;--mute:#98a5b3;--line:#27313c;--accent:#6aa0ff;--drop:#52c9a1;--dropbg:#12332a;--push:#7fb0ff;--pushbg:#16284a;--keep:#98a5b3;--keepbg:#212a34;--decide:#f0b950;--decidebg:#3a2c0e;--warn:#ff8a80;--warnbg:#3d1a18;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--ink);font:14px/1.45 var(--sans)}
main{max-width:1180px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:22px;margin:0 0 2px;text-wrap:balance}h2{font-size:15px;margin:0 0 10px;text-wrap:balance}
.sub{color:var(--mute);margin:0 0 16px;max-width:75ch}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}
.tile{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--keep);border-radius:6px;padding:10px 12px}
.tile b{display:block;font-size:26px;font-variant-numeric:tabular-nums;line-height:1.1}.tile span{color:var(--mute);font-size:12px}
.tile.drop{border-left-color:var(--drop)}.tile.push{border-left-color:var(--push)}.tile.decide{border-left-color:var(--decide)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:14px;margin-bottom:16px}
.planrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px}.planrow p{margin:0;flex:1 1 360px}
button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:5px;padding:5px 10px;cursor:pointer}
button:hover{border-color:var(--accent)}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}
.chip{border:1px solid var(--line);border-radius:999px;padding:3px 11px;background:var(--panel)}.chip[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
input[type=search]{font:inherit;padding:6px 9px;border:1px solid var(--line);border-radius:5px;background:var(--panel);color:var(--ink);min-width:220px;flex:1 1 220px}
details.sess{background:var(--panel);border:1px solid var(--line);border-radius:6px;margin-bottom:10px}
details.sess>summary{cursor:pointer;padding:10px 12px;list-style:none;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
details.sess>summary::-webkit-details-marker{display:none}.sid{font-family:var(--mono);font-size:12px;color:var(--accent)}.stitle{flex:1 1 280px;color:var(--ink)}.smeta{color:var(--mute);font-size:12px}
.wt{display:grid;grid-template-columns:104px minmax(0,1.1fr) minmax(0,2fr);gap:4px 12px;padding:9px 12px;border-top:1px solid var(--line);align-items:start}
.pill{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;padding:2px 8px;border-radius:4px;background:var(--keepbg);color:var(--keep);white-space:nowrap}
.pill.drop{background:var(--dropbg);color:var(--drop)}.pill.push{background:var(--pushbg);color:var(--push)}.pill.decide{background:var(--decidebg);color:var(--decide)}.pill.warn{background:var(--warnbg);color:var(--warn)}
.nm{font-weight:600;overflow-wrap:anywhere}.br{font-family:var(--mono);font-size:12px;color:var(--mute);overflow-wrap:anywhere}
.why{color:var(--ink)}.facts{color:var(--mute);font-size:12px;margin-top:2px}
.cmd{font-family:var(--mono);font-size:12px;background:var(--keepbg);border-radius:4px;padding:3px 6px;display:inline-block;margin-top:4px;overflow-wrap:anywhere}
.empty{color:var(--mute);padding:20px;text-align:center}
.foot{color:var(--mute);font-size:12px;max-width:90ch;margin-top:22px}
textarea.fallback{width:100%;height:120px;font-family:var(--mono);font-size:12px;margin-top:8px}
@media (max-width:700px){.wt{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style>
</head>
<body>
<main>
<h1>Worktree Audit</h1>
<p class="sub" id="sub"></p>
<div class="tiles" id="tiles"></div>
<section class="panel" id="plan"></section>
<div class="bar" id="chips"></div>
<div class="bar"><input type="search" id="q" placeholder="Filter by worktree, repo, branch, session or reason" aria-label="Filter worktrees"><button id="all" type="button"></button></div>
<div id="list"></div>
<p class="foot" id="foot"></p>
</main>
<script id="data" type="application/json">${json}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent),R=D.rows;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
var CLS={'DROP':'drop','PUSH+PR':'push','PUSH FIRST':'push','DECIDE':'decide','KEEP':'','PRUNE':'warn'};
var ORDER=['PUSH FIRST','PUSH+PR','DECIDE','DROP','KEEP','PRUNE'];
var count={};R.forEach(function(r){count[r.decision]=(count[r.decision]||0)+1});
var safe=R.filter(function(r){return r.safeDrop}),withLocal=R.filter(function(r){return r.decision==='DROP'&&!r.safeDrop});
var pushes=R.filter(function(r){return r.decision==='PUSH+PR'||r.decision==='PUSH FIRST'});
document.getElementById('sub').textContent=R.length+' worktrees, checked '+D.generated.slice(0,16).replace('T',' ')+' UTC. Each one gets a decision: drop it, push it to take it to production, keep it, or decide. Nothing on this page runs a command; it only prints them for you to copy.';
document.getElementById('tiles').innerHTML=[['DROP','drop','safe to remove or already shipped'],['PUSH+PR','push','take to production'],['PUSH FIRST','push','commits only on this machine'],['DECIDE','decide','needs your call'],['KEEP','','uncommitted, in use, in review, held']].map(function(t){return '<div class="tile '+t[1]+'"><b>'+(count[t[0]]||0)+'</b><span>'+esc(t[0])+': '+esc(t[2])+'</span></div>'}).join('');
function copy(text,btn,box){var done=function(){var o=btn.textContent;btn.textContent='Copied';setTimeout(function(){btn.textContent=o},1400)};
 try{navigator.clipboard.writeText(text).then(done,function(){fb()})}catch(e){fb()}
 function fb(){var ta=box.querySelector('textarea');if(!ta){ta=document.createElement('textarea');ta.className='fallback';ta.readOnly=true;box.appendChild(ta)}ta.value=text;ta.focus();ta.select()}}
var plan=document.getElementById('plan');
plan.innerHTML='<h2>Cleanup plan</h2>'+
 '<div class="planrow"><p><b>'+safe.length+' worktrees are safe to remove now.</b> Each is clean and every commit is already on a remote, merged, or in main. <code>git worktree remove</code> leaves the branch in its repo, so you can recreate any of them.</p><button class="primary" type="button" id="cp-safe"'+(safe.length?'':' disabled')+'>Copy '+safe.length+' remove commands</button></div>'+
 '<div class="planrow"><p><b>'+withLocal.length+' more are marked drop but hold commits on no remote.</b> Push them first if you might want them back.</p><button type="button" id="cp-local"'+(withLocal.length?'':' disabled')+'>Copy push-then-remove commands</button></div>'+
 '<div class="planrow"><p><b>'+pushes.length+' have work to take to production.</b> Push the branch, then open a PR.</p><button type="button" id="cp-push"'+(pushes.length?'':' disabled')+'>Copy push commands</button></div>';
document.getElementById('cp-safe').onclick=function(){copy(safe.map(function(r){return r.dropCmd}).join('\\n'),this,plan)};
document.getElementById('cp-local').onclick=function(){copy(withLocal.map(function(r){return r.pushCmd+'  &&  '+r.dropCmd}).join('\\n'),this,plan)};
document.getElementById('cp-push').onclick=function(){copy(pushes.map(function(r){return r.pushCmd+'   # then: gh pr create'}).join('\\n'),this,plan)};
var on={};ORDER.forEach(function(k){on[k]=(k!=='KEEP'&&k!=='PRUNE')});var showAll=false;
var chips=document.getElementById('chips');
function drawChips(){chips.innerHTML=ORDER.filter(function(k){return count[k]}).map(function(k){return '<button type="button" class="chip" aria-pressed="'+(on[k]?'true':'false')+'" data-k="'+esc(k)+'">'+esc(k)+' '+count[k]+'</button>'}).join('');
 Array.prototype.forEach.call(chips.querySelectorAll('.chip'),function(b){b.onclick=function(){on[b.dataset.k]=!on[b.dataset.k];draw()}});
 var a=document.getElementById('all');a.textContent=showAll?'Hide KEEP':'Show everything incl. KEEP';}
document.getElementById('all').onclick=function(){showAll=!showAll;ORDER.forEach(function(k){on[k]=showAll?true:(k!=='KEEP'&&k!=='PRUNE')});draw()};
var q=document.getElementById('q');q.oninput=draw;
function pill(r){var c=CLS[r.decision]||'';return '<span class="pill '+c+'">'+esc(r.decision)+'</span>'}
function age(r){return r.idleDays>1?Math.round(r.idleDays)+' days idle':r.idleMin+' min idle'}
function row(r){var facts=[age(r)];if(r.dirty)facts.push(r.dirty+' uncommitted');if(r.onlyHere)facts.push(r.onlyHere+' commit(s) on no remote');if(r.unique)facts.push(r.unique+' unique vs main');if(r.pr)facts.push('<a href="'+esc(r.pr.url)+'">PR #'+r.pr.n+' '+esc(r.pr.state.toLowerCase())+'</a>');if(r.prod&&r.prod!=='unknown')facts.push('prod: '+esc(r.prod));
 var cmd=r.safeDrop?'<div class="cmd">'+esc(r.dropCmd)+'</div>':(r.decision==='PUSH+PR'||r.decision==='PUSH FIRST')?'<div class="cmd">'+esc(r.pushCmd)+'</div>':'';
 return '<div class="wt"><div>'+pill(r)+'</div><div><div class="nm">'+esc(r.name)+'</div><div class="br">'+esc(r.repo)+' @ '+esc(r.branch)+'</div></div><div><div class="why"><b>'+esc(r.label)+'.</b> '+esc(r.why)+'</div><div class="facts">'+facts.join(' &middot; ')+'</div>'+cmd+'</div></div>'}
function draw(){drawChips();var term=q.value.trim().toLowerCase();var groups={};
 R.forEach(function(r){if(!on[r.decision])return;var s=r.sessions[0];var k=s?s.id:'none';var hay=(r.name+' '+r.repo+' '+r.branch+' '+r.why+' '+(s?s.id+' '+(s.title||''):'')).toLowerCase();if(term&&hay.indexOf(term)<0)return;(groups[k]=groups[k]||{s:s,rows:[]}).rows.push(r)});
 var keys=Object.keys(groups).sort(function(a,b){var x=groups[a].s?groups[a].s.lastActive:0,y=groups[b].s?groups[b].s.lastActive:0;return y-x});
 if(!keys.length){document.getElementById('list').innerHTML='<div class="empty">No worktrees match the current filters.</div>';return}
 document.getElementById('list').innerHTML=keys.map(function(k){var g=groups[k];g.rows.sort(function(a,b){return ORDER.indexOf(a.decision)-ORDER.indexOf(b.decision)||a.name.localeCompare(b.name)});
  var head=g.s?'<span class="sid">'+esc(g.s.id)+'</span><span class="stitle">'+esc(g.s.title||'(untitled session)')+'</span><span class="smeta">last active '+new Date(g.s.lastActive).toISOString().slice(0,16).replace('T',' ')+' UTC &middot; '+g.rows.length+' shown</span>':'<span class="sid">no session</span><span class="stitle">No session found for these within the last '+D.sessionDays+' days of transcripts</span><span class="smeta">'+g.rows.length+' shown</span>';
  return '<details class="sess" open><summary>'+head+'</summary>'+g.rows.map(row).join('')+'</details>'}).join('')}
document.getElementById('foot').textContent='How to read this: "in production" comes from GitHub PR state and, for Fly apps, whether a release came after the merge ("likely live": a release does not record which commit it was built from); Android uses release tags. Cloudflare workers, Cloud Run and launchd jobs are not checkable and are never guessed. A worktree is "in use" only if its files or a session command touched it in the last '+D.idleMin+' minutes. Remote branches are as of the last fetch.';
draw();
})();
</script>
</body>
</html>`;
}

if (import.meta.url === `file://${process.argv[1]}` || (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 24).join('\n')); process.exit(0); }
  // --from-json re-renders a saved audit without touching git, GitHub or Fly (the page and text report change in seconds).
  const rows = opts.fromJson ? JSON.parse(fs.readFileSync(opts.fromJson, 'utf8')) : await audit(opts);
  if (process.stderr.isTTY && !opts.json) process.stderr.write('\r' + ' '.repeat(40) + '\r');
  if (opts.jsonOut) fs.writeFileSync(opts.jsonOut, JSON.stringify(rows.map((f) => ({ ...f, changedFiles: undefined }))));
  if (opts.html) fs.writeFileSync(opts.html, renderHtml(rows, opts));
  if (opts.json) console.log(JSON.stringify(rows.map((f) => ({ ...f, changedFiles: undefined })), null, 1));
  else console.log(render(rows, opts));
}
