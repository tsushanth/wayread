#!/usr/bin/env node
// live-plan: validate a plan, update step status, and render the plan graph as one HTML page.
// No dependencies. Needs Node 18+ and git.
//
//   node live-plan.mjs check    <plan.json>
//   node live-plan.mjs render   <plan.json>
//   node live-plan.mjs status   <plan.json> <id[,id...]> <pending|running|done|flag> [--note "text"]
//   node live-plan.mjs evidence <plan.json> <id> <label> <text...>
//   node live-plan.mjs finding  <plan.json> <text...> [--kind verified|info|note]
//   node live-plan.mjs add-verify <plan.json> [--names code-review,coverage,guardrails]
//
// Every command except `check` writes plan.html next to plan.json. The plan is the model's claim about what it will do
// and has done. The "actual" files come from git (commits since `base`, plus uncommitted changes), so the page can show
// where the claim and the repo disagree.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STATUSES = ['pending', 'running', 'done', 'flag'];
export const KINDS = ['verified', 'info', 'note'];
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

// ---------- plan model ----------

export function validate(plan) {
  const errs = [];
  const isStrArr = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');
  if (!plan || typeof plan !== 'object') return ['plan must be a JSON object'];
  if (typeof plan.task !== 'string' || !plan.task.trim()) errs.push('task: a non-empty string is required');
  if (!isStrArr(plan.stages) || plan.stages.length === 0) errs.push('stages: a non-empty array of stage names is required');
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) { errs.push('steps: a non-empty array is required'); return errs; }
  const ids = new Set();
  for (const s of plan.steps) {
    const at = `step ${JSON.stringify(s && s.id)}`;
    if (!s || typeof s.id !== 'string' || !ID_RE.test(s.id)) { errs.push(`${at}: id must match ${ID_RE}`); continue; }
    if (ids.has(s.id)) errs.push(`${at}: duplicate id`);
    ids.add(s.id);
    if (typeof s.title !== 'string' || !s.title.trim()) errs.push(`${at}: title is required`);
    if (!Number.isInteger(s.stage) || s.stage < 0 || s.stage >= (plan.stages || []).length) errs.push(`${at}: stage must be an index into stages (0..${(plan.stages || []).length - 1})`);
    if (s.status !== undefined && !STATUSES.includes(s.status)) errs.push(`${at}: status must be one of ${STATUSES.join(', ')}`);
    for (const k of ['reads', 'writes', 'temp', 'needs']) if (s[k] !== undefined && !isStrArr(s[k])) errs.push(`${at}: ${k} must be an array of strings`);
  }
  for (const s of plan.steps) for (const n of s.needs || []) {
    if (!ids.has(n)) errs.push(`step ${JSON.stringify(s.id)}: needs unknown step ${JSON.stringify(n)}`);
    else if (n === s.id) errs.push(`step ${JSON.stringify(s.id)}: needs itself`);
  }
  if (!errs.length) { // cycle check
    const by = Object.fromEntries(plan.steps.map((s) => [s.id, s]));
    const state = {};
    const visit = (id, trail) => {
      if (state[id] === 2) return;
      if (state[id] === 1) { errs.push(`dependency cycle: ${[...trail, id].join(' -> ')}`); return; }
      state[id] = 1;
      for (const n of by[id].needs || []) visit(n, [...trail, id]);
      state[id] = 2;
    };
    for (const s of plan.steps) visit(s.id, []);
  }
  for (const f of plan.findings || []) if (!KINDS.includes(f.kind) || typeof f.text !== 'string') errs.push(`finding: needs kind (${KINDS.join('|')}) and text`);
  for (const e of plan.evidence || []) if (!ids.has(e.step)) errs.push(`evidence: unknown step ${JSON.stringify(e.step)}`);
  return errs;
}

function shortOf(title) {
  if (title.length <= 28) return title;
  const cut = title.slice(0, 28);
  return cut.slice(0, cut.lastIndexOf(' ') > 8 ? cut.lastIndexOf(' ') : 28);
}

/** Fills optional fields so every step has the same shape. Does not touch git. */
export function normalize(plan) {
  plan.findings ||= [];
  plan.evidence ||= [];
  for (const s of plan.steps) {
    s.status ||= 'pending';
    s.reads ||= []; s.writes ||= []; s.temp ||= []; s.needs ||= [];
    s.short ||= shortOf(s.title);
    s.note ||= '';
  }
  return plan;
}

const stepMap = (plan) => Object.fromEntries(plan.steps.map((s) => [s.id, s]));

/** Does `to` (transitively) wait on `from`? */
export function waitsOn(plan, to, from) {
  const by = stepMap(plan);
  const seen = new Set();
  const walk = (id) => {
    for (const n of by[id].needs) { if (n === from) return true; if (!seen.has(n)) { seen.add(n); if (walk(n)) return true; } }
    return false;
  };
  return walk(to);
}

/** The state shown for a step: a pending step is Ready when everything it needs is done, otherwise Blocked. */
export function shownStatus(plan, s) {
  if (s.status !== 'pending') return s.status;
  const by = stepMap(plan);
  return s.needs.every((n) => by[n].status === 'done') ? 'ready' : 'blocked';
}

// ---------- git ----------

function gitIn(worktree, args) {
  try { return execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

/** First render fills worktree, branch and base from the current directory, and writes them back so they stay fixed. */
function fillGit(plan, cwd) {
  const top = plan.worktree || (gitIn(cwd, ['rev-parse', '--show-toplevel']) || '').trim();
  if (!top) throw new Error('worktree: not inside a git repository, and the plan names no worktree');
  plan.worktree = top;
  plan.repo ||= path.basename(top);
  plan.branch ||= (gitIn(top, ['branch', '--show-current']) || '').trim() || 'detached HEAD';
  if (!plan.base) {
    let base = null;
    for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
      const mb = gitIn(top, ['merge-base', 'HEAD', ref]);
      if (mb) { base = mb.trim(); break; }
    }
    plan.base = base || (gitIn(top, ['rev-parse', 'HEAD']) || '').trim();
  }
  if (gitIn(top, ['rev-parse', '--verify', `${plan.base}^{commit}`]) === null) throw new Error(`base: ${JSON.stringify(plan.base)} is not a commit in ${top}`);
  return plan;
}

/** Files that differ from `base`: committed since then, plus anything uncommitted. Files under `ignoreDir` are skipped. */
export function actualChanges(plan, ignoreDir) {
  const map = new Map();
  const committed = gitIn(plan.worktree, ['diff', '--name-status', `${plan.base}..HEAD`]) || '';
  for (const l of committed.split('\n').filter(Boolean)) { const [code, ...f] = l.split('\t'); map.set(f[f.length - 1], code[0]); }
  const dirty = gitIn(plan.worktree, ['status', '--porcelain', '--untracked-files=all']) || '';
  for (const l of dirty.split('\n').filter(Boolean)) map.set(l.slice(3).replace(/^.* -> /, ''), l.slice(0, 2).trim() || '?');
  if (ignoreDir) {
    const rel = path.relative(plan.worktree, ignoreDir);
    if (rel && !rel.startsWith('..')) for (const f of [...map.keys()]) if (f === rel || f.startsWith(rel + '/')) map.delete(f);
  }
  return map;
}

// ---------- analysis: what the plan claims against what git shows ----------

export function analyze(plan, changed) {
  const by = stepMap(plan);
  const flags = [];
  const plannedWrites = new Set(plan.steps.flatMap((s) => s.writes));
  const tempAllowed = new Set(plan.steps.filter((s) => s.status === 'running').flatMap((s) => s.temp));
  for (const [file, code] of changed) {
    if (plannedWrites.has(file) || tempAllowed.has(file)) continue;
    flags.push({ level: 'bad', tag: 'unplanned', text: `${file} is modified (${code}) but no step plans to write it.` });
  }
  const writers = {};
  for (const s of plan.steps) for (const f of s.writes) (writers[f] ||= []).push(s.id);
  for (const [f, ids] of Object.entries(writers)) {
    const loose = ids.filter((a) => ids.some((b) => a !== b && !waitsOn(plan, a, b) && !waitsOn(plan, b, a)));
    if (loose.length > 1) flags.push({ level: 'warn', tag: 'shared file', text: `${loose.join(', ')} are drawn as independent but all write ${f}. They can only run one at a time, unless the writes are split across files.` });
  }
  for (const s of plan.steps) {
    if (s.status === 'pending') continue;
    const open = s.needs.filter((n) => by[n].status !== 'done');
    if (open.length) flags.push({ level: 'warn', tag: 'order', text: `${s.id} (${s.short}) started before ${open.join(', ')} finished.` });
    if (s.status === 'done') {
      const untouched = s.writes.filter((f) => !changed.has(f));
      if (untouched.length) flags.push({ level: 'warn', tag: 'not changed', text: `${s.id} (${s.short}) is done but git shows no change to ${untouched.join(', ')}.` });
      if (s.needsEvidence && !plan.evidence.some((e) => e.step === s.id)) flags.push({ level: 'warn', tag: 'no result', text: `${s.id} (${s.short}) is done but has no recorded result.` });
    }
  }
  const tagFor = { verified: 'verified', info: 'note', note: 'note' };
  for (const f of plan.findings) flags.push({ level: f.kind === 'verified' ? 'ok' : 'note', tag: tagFor[f.kind], text: f.text });
  return flags;
}

// ---------- page ----------

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const LABEL = { blocked: 'Blocked', ready: 'Ready', running: 'In progress', done: 'Done', flag: 'Flagged' };
const pill = (st) => (st === 'done' ? '<b aria-hidden="true">✓</b>' : st === 'flag' ? '<b aria-hidden="true">!</b>' : '<u aria-hidden="true"></u>') + LABEL[st];
const chip = (f, kind) => {
  const d = f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '';
  return `<span class="chip ${kind}"><i>${esc(d)}</i>${esc(f.slice(d.length))}</span>`;
};

export function pageTitle(plan) {
  return plan.title || plan.task.split(/\s+/).slice(0, 4).join(' ');
}

export function renderHtml(plan, changed, commits, diffStat, now = new Date()) {
  const by = stepMap(plan);
  const flags = analyze(plan, changed);
  const shown = Object.fromEntries(plan.steps.map((s) => [s.id, shownStatus(plan, s)]));
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const running = plan.steps.filter((s) => s.status === 'running');
  const readyNow = plan.steps.filter((s) => shown[s.id] === 'ready');
  const stamp = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

  const card = (s) => {
    const st = shown[s.id];
    const chips = [...s.reads.map((f) => chip(f, 'read')), ...s.writes.map((f) => chip(f, 'write')), ...s.temp.map((f) => chip(f, 'temp'))].join('');
    const ev = plan.evidence.filter((e) => e.step === s.id).map((e) => `<p class="ev"><b>${esc(e.label)}</b> ${esc(e.text)}</p>`).join('');
    const needs = s.needs.length ? `<p class="needs">Waits for ${s.needs.map((n) => esc(by[n].short)).join(', ')}</p>` : '';
    return `<article class="card ${st}" id="step-${esc(s.id)}" tabindex="0">
  <header><span class="id">${esc(s.id)}</span><span class="state ${st}">${pill(st)}</span></header>
  <h3>${esc(s.title)}</h3>
  ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
  ${chips ? `<div class="chips">${chips}</div>` : ''}
  ${ev}${needs}
</article>`;
  };
  const cols = plan.stages.map((name, i) => {
    const steps = plan.steps.filter((s) => s.stage === i);
    return `<section class="col"><h2>${esc(name)}<span>${steps.filter((s) => s.status === 'done').length}/${steps.length}</span></h2>${steps.map(card).join('')}</section>`;
  }).join('');

  const mapFiles = [...new Set([...plan.steps.flatMap((s) => [...s.reads, ...s.writes, ...s.temp]), ...changed.keys()])].sort();
  const tempAllowed = new Set(plan.steps.filter((s) => s.status === 'running').flatMap((s) => s.temp));
  const plannedWrites = new Set(plan.steps.flatMap((s) => s.writes));
  const groups = {};
  for (const f of mapFiles) { const d = f.slice(0, f.lastIndexOf('/') + 1); (groups[d] ||= []).push(f); }
  const fileRows = Object.entries(groups).map(([d, list]) => {
    const rows = list.map((f) => {
      const w = plan.steps.filter((s) => s.writes.includes(f)).map((s) => s.id);
      const t = plan.steps.filter((s) => s.temp.includes(f)).map((s) => s.id);
      const r = plan.steps.filter((s) => s.reads.includes(f)).map((s) => s.id);
      const act = changed.get(f);
      const unplanned = act && !plannedWrites.has(f) && !tempAllowed.has(f);
      const planCell = w.length ? `writes in ${w.join(', ')}` : t.length ? `temporary in ${t.join(', ')}` : r.length ? `read in ${r.join(', ')}` : 'not in the plan';
      const actual = act ? (act === 'A' || act === '??' ? 'added' : 'changed') : 'untouched';
      return `<tr class="${unplanned ? 'bad' : act ? 'touched' : ''}"><td class="fn">${esc(f.slice(d.length))}</td><td>${esc(planCell)}</td><td class="act">${actual}${unplanned ? ' <em>not planned</em>' : ''}</td></tr>`;
    }).join('');
    return `<tbody><tr class="dir"><th colspan="3">${esc(d || './')}</th></tr>${rows}</tbody>`;
  }).join('');
  const flagHtml = flags.length ? flags.map((f) => `<li class="${f.level}"><span class="tag">${esc(f.tag)}</span><span>${esc(f.text)}</span></li>`).join('') : '<li class="ok"><span class="tag">clear</span><span>Every changed file is one a step planned to write.</span></li>';
  const planData = JSON.stringify({ steps: plan.steps.map((s) => ({ id: s.id, short: s.short, status: s.status, needs: s.needs })) })
    .replace(/</g, '\\u003c').replace(new RegExp('\\u2028', 'g'), '\\u2028').replace(new RegExp('\\u2029', 'g'), '\\u2029');
  const nowText = running.length ? 'Now: ' + running.map((r) => r.short).join(', ') : readyNow.length ? 'Ready: ' + readyNow.map((r) => r.short).join(', ') : done === plan.steps.length ? 'Finished' : 'Between steps';

  return `<title>${esc(pageTitle(plan))}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>${CSS.replace('__COLS__', String(plan.stages.length))}</style>
<div class="wrap">
  <div class="top">
    <div>
      <h1>${esc(plan.task)}</h1>
      <div class="meta"><span>repo <b>${esc(plan.repo)}</b></span><span>branch <b>${esc(plan.branch)}</b></span><span>base <b>${esc(String(plan.base).slice(0, 10))}</b></span><span>${diffStat ? esc(diffStat) : `${changed.size} file${changed.size === 1 ? '' : 's'} changed`}</span></div>
    </div>
    <div class="prog" role="group" aria-label="Progress">
      <div class="lab"><span id="prog-now">${esc(nowText)}</span><span id="prog-count"><b>${done}</b> of ${plan.steps.length} steps · ${esc(stamp)}</span></div>
      <div class="bar"><i id="prog-bar" style="width:${Math.round((done / plan.steps.length) * 100)}%"></i></div>
    </div>
  </div>
  ${plan.rule ? `<p class="rule"><b>Plan rule.</b> ${esc(plan.rule)}</p>` : ''}
  <div class="tools">
    <div class="legend"><span>Steps:</span><span class="state blocked"><u></u>Blocked</span><span class="state ready"><u></u>Ready</span><span class="state running"><u></u>In progress</span><span class="state done"><b>✓</b>Done</span><span>Files:</span>${chip('read', 'read')}${chip('written', 'write')}${chip('temporary', 'temp')}</div>
    <label class="replay" for="replay"><span>Replay</span><input type="range" id="replay" min="0" max="${plan.steps.length}" value="${plan.steps.length}" step="1"><span id="replay-out">Actual run, as recorded</span></label>
  </div>
  <div class="graph" id="graph" aria-label="Plan graph: steps by stage, arrows point from a step to the steps that wait on it. Hover or focus a step to highlight its neighbours.">
    <svg class="edges" id="edges" aria-hidden="true"></svg>${cols}
  </div>
  <div class="lower">
    <section class="panel">
      <h2>Files: plan against git</h2>
      <div class="tablewrap"><table>${fileRows}</table></div>
      ${commits.length ? `<p class="commits">Commits since base: ${commits.map(esc).join(' · ')}</p>` : ''}
    </section>
    <section class="panel">
      <h2>Flags and findings</h2>
      <ul class="flags">${flagHtml}</ul>
    </section>
  </div>
  <p class="foot">Step status is the model's own report. The file column is read from git (commits since the base plus uncommitted changes) when this page is built. The page changes only when it is republished.</p>
</div>
<script type="application/json" id="plan-data">${planData}</script>
<script>${CLIENT_JS}</script>`;
}

const CSS = `
/* Layout: stage columns left to right; drawn edges show what waits on what; plan-vs-actual below. */
:root{--bg:#f3f5f4;--surface:#ffffff;--ink:#16211f;--muted:#5d6d69;--line:#d5dcda;--accent:#0f6f66;--accent-soft:#dff0ed;--ok:#1d7a3f;--ok-soft:#e1f2e6;--warn:#8a5a00;--warn-soft:#fbefd2;--bad:#b3261e;--bad-soft:#fbe3e0;--read:#3d5a80;--write:#0f6f66;--temp:#8a5a00;
--sans:'Instrument Sans',system-ui,-apple-system,'Segoe UI',sans-serif;--mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0e1514;--surface:#162120;--ink:#e3ece9;--muted:#8fa29d;--line:#2a3a37;--accent:#4fc4b6;--accent-soft:#16312d;--ok:#6fd08f;--ok-soft:#14301f;--warn:#e9b74d;--warn-soft:#33270c;--bad:#ff8a80;--bad-soft:#3a1816;--read:#8fb0dc;--write:#4fc4b6;--temp:#e9b74d;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0e1514;--surface:#162120;--ink:#e3ece9;--muted:#8fa29d;--line:#2a3a37;--accent:#4fc4b6;--accent-soft:#16312d;--ok:#6fd08f;--ok-soft:#14301f;--warn:#e9b74d;--warn-soft:#33270c;--bad:#ff8a80;--bad-soft:#3a1816;--read:#8fb0dc;--write:#4fc4b6;--temp:#e9b74d;color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;padding-block:20px 40px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.wrap{max-width:1400px;margin:0 auto;display:flex;flex-direction:column;gap:22px}
h1{font-size:22px;line-height:1.2;margin:0;font-weight:600;text-wrap:balance}
h2,h3,p{margin:0}
.top{display:flex;flex-wrap:wrap;gap:12px 28px;justify-content:space-between;align-items:flex-end}
.meta{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--muted);font-family:var(--mono);font-size:12px;margin-top:6px}
.meta b{color:var(--ink);font-weight:500}
.prog{min-width:220px;flex:0 1 300px}
.prog .lab{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--muted);margin-bottom:5px}
.prog .lab b{color:var(--ink);font-variant-numeric:tabular-nums}
.bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent)}
.rule{border:1px solid var(--line);border-left:3px solid var(--accent);background:var(--surface);padding:9px 12px;font-size:13px}
.rule b{font-weight:600}
.tools{display:flex;flex-wrap:wrap;gap:10px 28px;align-items:center;justify-content:space-between}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--muted);align-items:center}
.replay{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;font-size:12px;color:var(--muted)}
.replay input{width:200px;max-width:100%;accent-color:var(--accent)}
.replay #replay-out{min-width:0;font-family:var(--mono)}
.graph{position:relative;display:grid;grid-template-columns:repeat(__COLS__,minmax(230px,1fr));gap:34px;overflow-x:auto;padding-bottom:8px;align-items:start}
.edges{position:absolute;left:0;top:0;pointer-events:none;z-index:0;overflow:visible}
.edge{fill:none;stroke:var(--muted);stroke-width:1.75;opacity:.9}
.edge.open{stroke-dasharray:4 3;opacity:.6}
.edge.live{stroke:var(--accent);stroke-width:2.25;opacity:1}
.head{fill:var(--muted);opacity:.9}.head.open{opacity:.6}.head.live{fill:var(--accent);opacity:1}
.graph.focus .edge.dim,.graph.focus .head.dim{opacity:.12}
.graph.focus .edge.hot{stroke:var(--accent);stroke-width:2.25;opacity:1}
.graph.focus .head.hot{fill:var(--accent);opacity:1}
.col{display:flex;flex-direction:column;gap:12px;min-width:0}
.col>h2{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:600;display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:6px}
.col>h2 span{font-family:var(--mono);letter-spacing:0;font-variant-numeric:tabular-nums}
.card{position:relative;z-index:1;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:11px 12px;display:flex;flex-direction:column;gap:7px;min-width:0;transition:opacity .15s}
.card.running{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.card.ready{border-color:var(--accent)}
.card.flag{border-color:var(--bad)}
.card.blocked{background:var(--bg);border-style:dashed}
.card.dim{opacity:.35}
.card header{display:flex;justify-content:space-between;align-items:center;gap:8px}
.id{font-family:var(--mono);font-size:11px;color:var(--muted)}
.state{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;white-space:nowrap}
.state b{font-size:11px}
.state u{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;text-decoration:none}
.state.blocked{color:var(--muted);border:1px dashed var(--line)}
.state.blocked u{background:transparent;border:1px solid currentColor}
.state.ready{color:var(--accent);border:1px solid var(--accent)}
.state.ready u{background:transparent;border:1.5px solid currentColor}
.state.running{color:var(--accent);background:var(--accent-soft)}
.state.done{color:var(--ok);background:var(--ok-soft)}
.state.flag{color:var(--bad);background:var(--bad-soft)}
.card h3{font-size:14px;line-height:1.3;font-weight:600;text-wrap:balance}
.note{font-size:12.5px;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:5px}
.chip{font-family:var(--mono);font-size:11px;padding:1px 6px;border-radius:3px;border:1px solid var(--line);max-width:100%;overflow-wrap:anywhere}
.chip i{font-style:normal;color:var(--muted)}
.chip.read{color:var(--read)}.chip.write{color:var(--write);border-color:var(--write)}.chip.temp{color:var(--temp);border-style:dashed;border-color:var(--temp)}
.ev{font-size:12px;font-family:var(--mono);background:var(--ok-soft);color:var(--ok);padding:4px 7px;border-radius:3px}
.ev b{font-weight:500}
.needs{font-size:11.5px;color:var(--muted)}
.lower{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:22px}
@media (max-width:900px){.lower{grid-template-columns:minmax(0,1fr)}}
.panel{display:flex;flex-direction:column;gap:9px;min-width:0}
.panel>h2{font-size:15px;font-weight:600}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:6px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{text-align:left;padding:6px 10px;vertical-align:top}
tr.dir th{font-family:var(--mono);font-size:11.5px;font-weight:500;color:var(--muted);background:var(--bg);border-top:1px solid var(--line)}
tbody:first-of-type tr.dir th{border-top:0}
td.fn{font-family:var(--mono);font-size:12px;overflow-wrap:anywhere}
td.act{white-space:nowrap}
tr.touched td.act{color:var(--accent);font-weight:600}
tr.bad td{background:var(--bad-soft)}
tr.bad em{font-style:normal;color:var(--bad);font-weight:600}
ul.flags{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}
.flags li{display:flex;gap:9px;align-items:baseline;border:1px solid var(--line);border-radius:6px;background:var(--surface);padding:8px 10px;font-size:13px}
.flags li>span:last-child{min-width:0}
.flags .tag{font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;padding:1px 6px;border-radius:3px;white-space:nowrap;flex:none;border:1px solid var(--line);color:var(--muted)}
.flags li.bad{border-color:var(--bad)}.flags li.bad .tag{background:var(--bad-soft);color:var(--bad);border-color:var(--bad)}
.flags li.warn .tag{background:var(--warn-soft);color:var(--warn);border-color:var(--warn)}
.flags li.ok .tag{background:var(--ok-soft);color:var(--ok);border-color:var(--ok)}
.foot{color:var(--muted);font-size:12px;font-family:var(--mono)}
.commits{font-family:var(--mono);font-size:12px;color:var(--muted)}
@media (prefers-reduced-motion:no-preference){.card.running .state u{animation:p 1.4s ease-in-out infinite}@keyframes p{50%{opacity:.25}}}
.card:focus-visible,.graph:focus-visible,.replay input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`;

const CLIENT_JS = `
(function () {
  var data = JSON.parse(document.getElementById('plan-data').textContent);
  var graph = document.getElementById('graph'), svg = document.getElementById('edges');
  var slider = document.getElementById('replay'), readout = document.getElementById('replay-out');
  var NS = 'http://www.w3.org/2000/svg', N = data.steps.length;
  var LABEL = { blocked: 'Blocked', ready: 'Ready', running: 'In progress', done: 'Done', flag: 'Flagged' };
  var cards = {}, status = {}, actual = {};
  data.steps.forEach(function (s) { cards[s.id] = document.getElementById('step-' + s.id); actual[s.id] = s.status; });

  function derive(base) {
    var out = {};
    data.steps.forEach(function (s) {
      var st = base[s.id];
      if (st === 'pending') st = s.needs.every(function (n) { return base[n] === 'done'; }) ? 'ready' : 'blocked';
      out[s.id] = st;
    });
    return out;
  }
  function pillHtml(st) { return (st === 'done' ? '<b aria-hidden="true">\\u2713</b>' : st === 'flag' ? '<b aria-hidden="true">!</b>' : '<u aria-hidden="true"></u>') + LABEL[st]; }

  function draw() {
    svg.setAttribute('width', 0); svg.setAttribute('height', 0);
    svg.setAttribute('width', graph.scrollWidth); svg.setAttribute('height', graph.scrollHeight);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var g = graph.getBoundingClientRect();
    data.steps.forEach(function (s) {
      s.needs.forEach(function (n) {
        var a = cards[n].getBoundingClientRect(), b = cards[s.id].getBoundingClientRect(), d, head, vertical = Math.abs(a.left - b.left) < 6;
        var cls = 'edge' + (status[n] === 'done' ? ' done' : '') + (status[s.id] === 'running' || status[s.id] === 'ready' ? ' live' : '') + (status[n] !== 'done' ? ' open' : '');
        if (vertical) {
          var x = a.left + a.width / 2 - g.left + graph.scrollLeft, y1 = a.bottom - g.top + graph.scrollTop, y2 = b.top - g.top + graph.scrollTop - 1;
          if (y2 < y1) { var t = y1; y1 = y2; y2 = t; }
          d = 'M' + x + ' ' + y1 + ' L' + x + ' ' + y2;
          head = 'M' + (x - 4) + ' ' + (y2 - 7) + ' L' + (x + 4) + ' ' + (y2 - 7) + ' L' + x + ' ' + y2 + ' Z';
        } else {
          var x1 = a.right - g.left + graph.scrollLeft, y1b = a.top + a.height / 2 - g.top + graph.scrollTop;
          var x2 = b.left - g.left + graph.scrollLeft - 1, y2b = b.top + b.height / 2 - g.top + graph.scrollTop;
          var mx = (x1 + x2) / 2;
          d = 'M' + x1 + ' ' + y1b + ' C' + mx + ' ' + y1b + ' ' + mx + ' ' + y2b + ' ' + (x2 - 7) + ' ' + y2b + ' L' + x2 + ' ' + y2b;
          head = 'M' + (x2 - 7) + ' ' + (y2b - 4) + ' L' + x2 + ' ' + y2b + ' L' + (x2 - 7) + ' ' + (y2b + 4) + ' Z';
        }
        var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('class', cls); p.setAttribute('data-from', n); p.setAttribute('data-to', s.id); svg.appendChild(p);
        var h = document.createElementNS(NS, 'path'); h.setAttribute('d', head); h.setAttribute('class', 'head' + cls.slice(4)); h.setAttribute('data-from', n); h.setAttribute('data-to', s.id); svg.appendChild(h);
      });
    });
  }

  function apply(st) {
    status = st;
    data.steps.forEach(function (s) {
      var c = cards[s.id]; c.className = 'card ' + st[s.id];
      var p = c.querySelector('.state'); p.className = 'state ' + st[s.id]; p.innerHTML = pillHtml(st[s.id]);
    });
    draw();
  }

  function related(id) {
    var set = {}; set[id] = true;
    data.steps.forEach(function (s) {
      if (s.id === id) s.needs.forEach(function (n) { set[n] = true; });
      if (s.needs.indexOf(id) >= 0) set[s.id] = true;
    });
    return set;
  }
  function focusOn(id) {
    var set = related(id); graph.classList.add('focus');
    data.steps.forEach(function (s) { cards[s.id].classList.toggle('dim', !set[s.id]); });
    Array.prototype.forEach.call(svg.children, function (p) {
      var on = p.getAttribute('data-from') === id || p.getAttribute('data-to') === id;
      p.classList.toggle('hot', on); p.classList.toggle('dim', !on);
    });
  }
  function clearFocus() {
    graph.classList.remove('focus');
    data.steps.forEach(function (s) { cards[s.id].classList.remove('dim'); });
    Array.prototype.forEach.call(svg.children, function (p) { p.classList.remove('hot'); p.classList.remove('dim'); });
  }
  data.steps.forEach(function (s) {
    var c = cards[s.id];
    c.addEventListener('mouseenter', function () { focusOn(s.id); });
    c.addEventListener('focus', function () { focusOn(s.id); });
    c.addEventListener('mouseleave', clearFocus);
    c.addEventListener('blur', clearFocus);
  });

  var nowEl = document.getElementById('prog-now'), countEl = document.getElementById('prog-count'), barEl = document.getElementById('prog-bar');
  var orig = { now: nowEl.textContent, count: countEl.innerHTML, bar: barEl.style.width };
  function setReplay(v) {
    var base = {};
    if (v >= N) {
      data.steps.forEach(function (s) { base[s.id] = actual[s.id]; });
      readout.textContent = 'Actual run, as recorded';
      apply(derive(base));
      nowEl.textContent = orig.now; countEl.innerHTML = orig.count; barEl.style.width = orig.bar;
      return;
    }
    data.steps.forEach(function (s, i) { base[s.id] = i < v ? 'done' : i === v ? 'running' : 'pending'; });
    readout.textContent = 'Replay in listed order, not real timing: ' + v + ' of ' + N + ' finished';
    var st = derive(base); apply(st);
    var ready = data.steps.filter(function (s) { return st[s.id] === 'ready'; }).map(function (s) { return s.short; });
    nowEl.textContent = 'Replay. Now: ' + data.steps[v].short + (ready.length ? ' \\u00b7 Ready: ' + ready.join(', ') : '');
    countEl.innerHTML = '<b>' + v + '</b> of ' + N + ' steps';
    barEl.style.width = Math.round(v / N * 100) + '%';
  }
  slider.max = N; slider.value = N;
  slider.addEventListener('input', function () { clearFocus(); setReplay(+slider.value); });

  apply(derive(actual));
  window.addEventListener('resize', function () { draw(); });
  if (window.ResizeObserver) new ResizeObserver(function () { draw(); }).observe(graph);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { draw(); });
})();
`;

// ---------- add-verify ----------

const VERIFY_TITLES = { 'code-review': 'Code review', coverage: 'Coverage check', guardrails: 'Guardrails check' };

/** Appends a Verify stage: one step per name, chained, the first waiting on every non-verify step. Safe to run twice. */
export function addVerify(plan, names = ['code-review', 'coverage', 'guardrails']) {
  let stage = plan.stages.indexOf('Verify');
  if (stage < 0) { plan.stages.push('Verify'); stage = plan.stages.length - 1; }
  const build = plan.steps.filter((s) => !s.id.startsWith('verify-')).map((s) => s.id);
  let prev = null;
  const added = [];
  for (const name of names) {
    const id = `verify-${name}`;
    let step = plan.steps.find((s) => s.id === id);
    if (!step) {
      step = { id, stage, title: VERIFY_TITLES[name] || name, short: VERIFY_TITLES[name] || name, status: 'pending', reads: [], writes: [], temp: [], needs: prev ? [prev] : build, needsEvidence: true, note: '' };
      plan.steps.push(step);
      added.push(id);
    }
    prev = id;
  }
  return added;
}

// ---------- CLI ----------

function readPlan(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`cannot read ${file}`); }
  let plan;
  try { plan = JSON.parse(raw); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
  const errs = validate(plan);
  if (errs.length) throw new Error(`${file} is not a valid plan:\n  - ${errs.join('\n  - ')}`);
  return normalize(plan);
}
const writePlan = (file, plan) => fs.writeFileSync(file, JSON.stringify(plan, null, 2) + '\n');

function render(file, plan) {
  fillGit(plan, process.cwd());
  writePlan(file, plan);
  const dir = path.dirname(path.resolve(file));
  const changed = actualChanges(plan, dir);
  const commits = (gitIn(plan.worktree, ['log', '--format=%h %s', `${plan.base}..HEAD`]) || '').split('\n').filter(Boolean);
  const diffStat = (gitIn(plan.worktree, ['diff', '--shortstat', plan.base]) || '').trim();
  const out = path.join(dir, 'plan.html');
  fs.writeFileSync(out, renderHtml(plan, changed, commits, diffStat));
  const flags = analyze(plan, changed).filter((f) => f.level === 'bad' || f.level === 'warn');
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const ready = plan.steps.filter((s) => shownStatus(plan, s) === 'ready').map((s) => s.id);
  console.log(`rendered ${out}\n  ${done}/${plan.steps.length} done, ready: ${ready.join(',') || 'none'}, ${changed.size} changed file(s), ${flags.length} flag(s)`);
  for (const f of flags) console.log(`  ! ${f.tag}: ${f.text}`);
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function main(argv) {
  const [cmd, file, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || !file) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 12).map((l) => l.slice(3)).join('\n'));
    return cmd && cmd !== '--help' && cmd !== '-h' ? 2 : 0;
  }
  const plan = readPlan(file);
  if (cmd === 'check') { console.log(`ok: ${plan.steps.length} steps, ${plan.stages.length} stages`); return 0; }
  if (cmd === 'render') { render(file, plan); return 0; }
  if (cmd === 'status') {
    const note = flag(rest, '--note');
    const [idList, state] = rest;
    if (!idList || !STATUSES.includes(state)) throw new Error(`usage: status <plan.json> <id[,id...]> <${STATUSES.join('|')}> [--note "text"]`);
    const by = stepMap(plan);
    for (const id of idList.split(',')) {
      if (!by[id]) throw new Error(`no step ${JSON.stringify(id)}`);
      by[id].status = state;
      if (note !== undefined) by[id].note = note;
    }
  } else if (cmd === 'evidence') {
    const [id, label, ...text] = rest;
    if (!id || !label || !text.length) throw new Error('usage: evidence <plan.json> <id> <label> <text...>');
    if (!stepMap(plan)[id]) throw new Error(`no step ${JSON.stringify(id)}`);
    plan.evidence = plan.evidence.filter((e) => !(e.step === id && e.label === label));
    plan.evidence.push({ step: id, label, text: text.join(' ') });
  } else if (cmd === 'finding') {
    const kind = flag(rest, '--kind') || 'note';
    if (!KINDS.includes(kind) || !rest.length) throw new Error(`usage: finding <plan.json> <text...> [--kind ${KINDS.join('|')}]`);
    plan.findings.push({ kind, text: rest.join(' ') });
  } else if (cmd === 'add-verify') {
    const names = flag(rest, '--names');
    const added = addVerify(plan, names ? names.split(',').map((n) => n.trim()).filter(Boolean) : undefined);
    console.log(added.length ? `added: ${added.join(', ')}` : 'verify steps already present');
  } else {
    throw new Error(`unknown command ${JSON.stringify(cmd)}`);
  }
  const errs = validate(plan);
  if (errs.length) throw new Error(`update would make the plan invalid:\n  - ${errs.join('\n  - ')}`);
  render(file, plan);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`live-plan: ${e.message}`); process.exitCode = 2; }
}
