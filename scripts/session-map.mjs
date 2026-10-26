#!/usr/bin/env node
// session-map: turn a long Claude Code conversation into a route map of its decisions.
// No dependencies. Needs Node 18+.
//
//   node session-map.mjs digest <session-id|path|latest> [--out DIR] [--since-cursor MAP.json] [--chunk-kb 70] [--head 330] [--tail 220]
//   node session-map.mjs check  <map.json>
//   node session-map.mjs build  <map.json>
//   node session-map.mjs brief  <map.json> <id[,id...]|open> [--out DIR]
//
// `digest` strips a session file down to its dialogue, with turn ids, ready for a model to read in chunks.
// The model writes map.json (decisions, what was ruled out, parked, never pursued, left open) and cites a verbatim
// quote and a turn for every node. `build` checks each quote against the transcript, lays the map out, and writes
// map.html. `brief` writes a self-contained "restart this thread" prompt for a node.
//
// Transcript files are an internal Claude Code format that can change between versions. The parser reads only the
// fields it needs and fails loudly when it finds no conversation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const STATUSES = ['decided', 'rejected', 'deferred', 'unexplored', 'open', 'now'];
export const LABEL = { decided: 'Decided', rejected: 'Ruled out', deferred: 'Parked', unexplored: 'Never pursued', open: 'Open question', now: 'You are here' };
const RESTARTABLE = ['rejected', 'deferred', 'unexplored', 'open'];
const OPEN_THREADS = ['deferred', 'unexplored', 'open'];
const SRC_RE = /^(?:([A-Za-z0-9_-]+):)?([HA])(\d+)$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const norm = (t) => String(t).replace(/\s+/g, ' ').trim().normalize('NFC');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- transcripts ----------

export function projectsDir() { return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'); }

export function findSession(ref, cwd = process.cwd()) {
  if (ref && fs.existsSync(ref) && fs.statSync(ref).isFile()) return path.resolve(ref);
  const root = projectsDir();
  if (!fs.existsSync(root)) throw new Error(`no Claude Code projects folder at ${root}`);
  if (ref === 'latest') {
    const dir = path.join(root, cwd.replace(/[^A-Za-z0-9]/g, '-'));
    if (!fs.existsSync(dir)) throw new Error(`no sessions for ${cwd} (looked in ${dir})`);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    if (!files.length) throw new Error(`no sessions in ${dir}`);
    return path.join(dir, files[0].f);
  }
  const hits = [];
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl') && f.startsWith(ref)) hits.push(path.join(dir, f));
  }
  if (hits.length === 0) throw new Error(`no session file starting with "${ref}" under ${root}`);
  if (hits.length > 1) throw new Error(`"${ref}" matches ${hits.length} sessions; use more of the id:\n  ${hits.join('\n  ')}`);
  return hits[0];
}

export function humanText(d) {
  if (!d || d.type !== 'user' || d.isMeta || d.isSidechain) return null;
  const c = d.message && d.message.content;
  let t;
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) {
    const parts = c.filter((b) => b && b.type === 'text').map((b) => b.text || '');
    if (!parts.length || c.some((b) => b && b.type === 'tool_result')) return null;
    t = parts.join('\n');
  } else return null;
  t = t.trim();
  if (!t || t.startsWith('<') || t.startsWith('[Request interrupted') || t.startsWith('Caveat:')) return null;
  return t;
}
const SUMMARY_RE = /^This session is being continued from a previous conversation/;
const LIMIT_RE = /You've hit your (?:[a-z0-9-]+ )?(?:spend )?limit|You've hit your (?:weekly|monthly|daily|5-hour|session|usage) (?:spend )?limit/i;

/** Reads one session file into turns: { n, ts, human, assistant, kind }, plus compaction points. Streams, so large files are fine. */
export async function parseTranscript(file) {
  const turns = [], compactions = [];
  let cur = null, lines = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    lines++;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d && d.compactMetadata) { compactions.push({ after: turns.length, ts: d.timestamp || null }); continue; }
    const h = humanText(d);
    if (h !== null) {
      cur = { n: turns.length + 1, ts: d.timestamp || null, human: norm(h), assistant: '', kind: SUMMARY_RE.test(h) ? 'summary' : 'prompt' };
      turns.push(cur); continue;
    }
    if (cur && d && d.type === 'assistant' && !d.isSidechain) {
      const c = d.message && d.message.content;
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'text' && b.text) cur.assistant += ' ' + b.text;
    }
  }
  for (const t of turns) t.assistant = norm(t.assistant);
  if (!turns.length) throw new Error(`no conversation found in ${file} (${lines} lines read). The file format may have changed.`);
  return { file, turns, compactions };
}

const fmtTime = (ts) => ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : 'unknown time';
const dayKey = (ts) => ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?';

// ---------- digest ----------

export function digestChunks(parsed, { head = 330, tail = 220, promptMax = 700, from = 1, chunkKb = 70 } = {}) {
  const trim = (t, h, tl) => (t.length > h + tl + 40 ? `${t.slice(0, h)} [...] ${t.slice(-tl)}` : t);
  const blocks = [];
  for (const t of parsed.turns) {
    if (t.n < from) continue;
    const comp = parsed.compactions.filter((c) => c.after === t.n - 1 && t.n > 1);
    for (const c of comp) blocks.push(`\n==== COMPACTION after H${t.n - 1}${c.ts ? ' at ' + fmtTime(c.ts) : ''} ====`);
    const human = t.human.length > promptMax ? `${t.human.slice(0, promptMax - 180)} [...long or pasted, trimmed...] ${t.human.slice(-150)}` : t.human;
    blocks.push(`\n#### H${t.n} ${fmtTime(t.ts)}${t.kind === 'summary' ? ' [compaction summary, written by Claude]' : ''}\n${human}` + (t.assistant ? `\n  [A${t.n}] ${trim(t.assistant, head, tail)}` : ''));
  }
  const chunks = []; let cur = '';
  for (const b of blocks) {
    if (cur && Buffer.byteLength(cur) + Buffer.byteLength(b) > chunkKb * 1024) { chunks.push(cur); cur = ''; }
    cur += b;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ---------- map model ----------

export function parseSrc(src) {
  const m = SRC_RE.exec(String(src || ''));
  return m ? { sid: m[1] || null, role: m[2], n: Number(m[3]) } : null;
}

export function validate(map) {
  const errs = [];
  if (!map || typeof map !== 'object') return ['map must be a JSON object'];
  if (typeof map.title !== 'string' || !map.title.trim()) errs.push('title: a non-empty string is required');
  if (!Array.isArray(map.sessions) || !map.sessions.length) errs.push('sessions: at least one { id } is required');
  else for (const s of map.sessions) if (!s || typeof s.id !== 'string' || !s.id) errs.push('sessions: every entry needs an id');
  if (!Array.isArray(map.nodes) || !map.nodes.length) { errs.push('nodes: a non-empty array is required'); return errs; }
  const ids = new Set();
  const multi = Array.isArray(map.sessions) && map.sessions.length > 1;
  let roots = 0;
  for (const n of map.nodes) {
    const at = `node ${JSON.stringify(n && n.id)}`;
    if (!n || typeof n.id !== 'string' || !ID_RE.test(n.id)) { errs.push(`${at}: id must match ${ID_RE}`); continue; }
    if (ids.has(n.id)) errs.push(`${at}: duplicate id`);
    ids.add(n.id);
    if (!STATUSES.includes(n.status)) errs.push(`${at}: status must be one of ${STATUSES.join(', ')}`);
    if (typeof n.title !== 'string' || !n.title.trim()) errs.push(`${at}: title is required`);
    if (typeof n.quote !== 'string' || !n.quote.trim()) errs.push(`${at}: quote is required (a verbatim quote from the cited turn)`);
    const s = parseSrc(n.src);
    if (!s) errs.push(`${at}: src must look like H12 or A12 (or sessionid:H12 when there are several sessions)`);
    else if (multi && !s.sid) errs.push(`${at}: src needs a session prefix (sessionid:${n.src}) because the map has several sessions`);
    if (n.route && !n.parent) roots++;
    for (const k of ['row', 'lane']) if (n[k] !== undefined && !Number.isInteger(n[k])) errs.push(`${at}: ${k} must be an integer`);
  }
  for (const n of map.nodes) {
    if (!n || !ids.has(n.id)) continue;
    if (n.parent && !ids.has(n.parent)) errs.push(`node ${JSON.stringify(n.id)}: parent ${JSON.stringify(n.parent)} does not exist`);
    if (n.parent === n.id) errs.push(`node ${JSON.stringify(n.id)}: parent is itself`);
    if (!n.parent && !n.route) errs.push(`node ${JSON.stringify(n.id)}: a node with no parent must be a route node`);
  }
  if (roots !== 1) errs.push(`exactly one route node must have no parent (found ${roots}): that is where the conversation started`);
  if (!errs.length) { // cycles
    const by = Object.fromEntries(map.nodes.map((n) => [n.id, n]));
    for (const n of map.nodes) { const seen = new Set(); for (let c = n; c && c.parent; c = by[c.parent]) { if (seen.has(c.id)) { errs.push(`parent cycle through ${JSON.stringify(c.id)}`); break; } seen.add(c.id); } }
  }
  for (const l of map.links || []) if (!ids.has(l.from) || !ids.has(l.to)) errs.push(`link ${JSON.stringify(l)}: from and to must be node ids`);
  return errs;
}

/** Turn lookup: sessions is { id: parsed }. Resolves "H12" or "sid:H12". */
function turnFor(map, sessions, srcStr) {
  const s = parseSrc(srcStr); if (!s) return null;
  const sid = s.sid ? Object.keys(sessions).find((k) => k.startsWith(s.sid) || s.sid.startsWith(k)) : Object.keys(sessions)[0];
  const p = sid && sessions[sid]; if (!p) return null;
  const turn = p.turns[s.n - 1];
  return turn ? { sid, turn, role: s.role, n: s.n } : null;
}

export function verifyQuotes(map, sessions) {
  const out = {};
  for (const n of map.nodes) {
    const t = turnFor(map, sessions, n.src);
    const text = t ? (t.role === 'H' ? t.turn.human : t.turn.assistant) : '';
    out[n.id] = !!t && norm(n.quote).length > 0 && text.includes(norm(n.quote));
  }
  return out;
}

// ---------- layout ----------

const orderKey = (map, n) => {
  const s = parseSrc(n.src) || { sid: null, n: 0, role: 'H' };
  const si = Math.max(0, map.sessions.findIndex((x) => s.sid && (x.id.startsWith(s.sid) || s.sid.startsWith(x.id))));
  return [si, s.n, s.role === 'H' ? 0 : 1];
};

/**
 * Places every node on a row and a lane. Route nodes are lane 0, one row each. Everything else hangs off the route in
 * a "track": a fork from a node plus the chain of nodes that follow it. A node's first child continues its lane;
 * further children fork onto new lanes. Lanes are reserved for the span a track covers, so two tracks never share a
 * lane at the same time. Rows go top to bottom in time order: a node sits below its parent and below the latest route
 * node before it, on the first row where its connector and the connectors already drawn pass through no node.
 * `row` and `lane` on a node override all of this. Every search is capped; if a spot cannot be found the node is
 * placed anyway and the problem is reported in `warnings`.
 */
export function layout(map) {
  const nodes = map.nodes.map((n) => ({ ...n }));
  const by = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const sorted = nodes.map((n, i) => ({ n, i, k: orderKey(map, n) })).sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.i - b.i).map((o) => o.n);
  // chronological, but a node always comes after its parent: one that precedes its parent in time waits for it, then follows it directly
  const order = []; const placed = new Set(); const waiting = new Map();
  const emit = (n) => { order.push(n); placed.add(n.id); for (const c of waiting.get(n.id) || []) emit(c); waiting.delete(n.id); };
  for (const n of sorted) {
    if (!n.parent || placed.has(n.parent)) emit(n);
    else { if (!waiting.has(n.parent)) waiting.set(n.parent, []); waiting.get(n.parent).push(n); }
  }
  if (order.length !== nodes.length) throw new Error('layout: parent cycle');
  order.forEach((n, i) => { n.idx = i; });

  // tracks: a route child forks a new track; a side node's first child continues its track, later children fork new ones
  const tracks = [];
  for (const n of order) {
    if (n.route || !n.parent) { n.lane = 0; continue; }
    const p = by[n.parent];
    if (!p.route && p.track && !p.cont) { p.cont = n; n.track = p.track; p.track.members.push(n); continue; }
    const t = { first: n, members: [n], fork: p, lane: null }; tracks.push(t); n.track = t;
  }
  // lanes, reserved up front for the span each track covers
  const occ = new Map();
  const laneFree = (lane, t) => (occ.get(lane) || []).every(([s, e]) => !(t.s <= e && s <= t.e));
  tracks.forEach((t, k) => {
    t.s = t.first.idx; t.e = Math.max(...t.members.map((m) => m.idx));
    const explicit = Number.isInteger(t.first.lane) && t.first.lane !== 0 ? t.first.lane : null;
    const seq = []; for (let d = 1; d < 14; d++) seq.push(...(k % 2 === 0 ? [-d, d] : [d, -d]));
    t.alt = seq.filter((l) => laneFree(l, t));
    t.lane = explicit !== null ? explicit : t.alt[0];
    if (!occ.has(t.lane)) occ.set(t.lane, []); occ.get(t.lane).push([t.s, t.e]);
    for (const m of t.members) m.lane = t.lane;
  });

  const cells = new Map();     // "r:lane" -> node
  const hseg = [], vseg = [];  // connectors already drawn
  const corners = new Set();   // where a connector bends: no node may sit there
  const key = (r, l) => `${r}:${l}`;
  const segsOf = (lane, p, r, mode) => {
    const h = [], v = [];
    if (mode === 'J') { // drop along the parent's lane first, then turn: for a route parent that is the route line itself
      h.push({ row: r, a: Math.min(p.lane, lane), b: Math.max(p.lane, lane) });
      if (!p.route) v.push({ lane: p.lane, a: p.r, b: r });
      return { h, v };
    }
    if (p.lane === lane) v.push({ lane, a: p.r, b: r });
    else { h.push({ row: p.r, a: Math.min(p.lane, lane), b: Math.max(p.lane, lane) }); if (r > p.r) v.push({ lane, a: p.r, b: r }); }
    return { h, v };
  };
  const cornerOf = (p, r, lane, mode) => (mode === 'J' ? key(r, p.lane) : p.lane !== lane && r > p.r ? key(p.r, lane) : null);
  const fits = (p, r, lane, mode) => {
    if (cells.has(key(r, lane)) || corners.has(key(r, lane))) return false;
    const cn = cornerOf(p, r, lane, mode);
    if (cn && cells.has(cn)) return false;
    const { h, v } = segsOf(lane, p, r, mode);
    for (const sg of h) for (const y of cells.values()) if (y.r === sg.row && y.lane > sg.a && y.lane < sg.b) return false;
    for (const sg of v) for (const y of cells.values()) if (y.lane === sg.lane && y.r > sg.a && y.r < sg.b) return false;
    for (const sg of hseg) if (sg.row === r && lane > sg.a && lane < sg.b) return false;
    for (const sg of vseg) if (sg.lane === lane && r > sg.a && r < sg.b) return false;
    return true;
  };
  const put = (x, p, r, mode) => {
    x.r = r; x.mode = mode || 'H'; cells.set(key(r, x.lane), x);
    if (p) { const { h, v } = segsOf(x.lane, p, r, x.mode); hseg.push(...h); vseg.push(...v); const cn = cornerOf(p, r, x.lane, x.mode); if (cn) corners.add(cn); }
  };
  const CAP = 80;

  let lastRoute = null;
  for (const n of order) {
    const p = by[n.parent];
    if (Number.isInteger(n.row)) { put(n, p, n.row); if (n.route) lastRoute = n; continue; }
    if (n.route || !n.parent) {
      let r = lastRoute ? lastRoute.r + 1 : 0; const r0 = r;
      while (p && !fits(p, r, 0) && r < r0 + CAP) r++;
      put(n, p, r); lastRoute = n; continue;
    }
    const lo = Math.max(p.r + 1, lastRoute ? lastRoute.r : 0);
    const t = n.track;
    let lanes;
    if (t.first === n) lanes = [t.lane, ...t.alt.filter((l) => l !== t.lane).slice(0, 8)];
    else { // a continued thread keeps its lane if it can, and may jog to a free one if something blocks it
      const span = { s: n.idx, e: Math.max(...t.members.map((m) => m.idx)) };
      const seq = []; for (let d = 1; d < 14; d++) seq.push(-d, d);
      lanes = [n.lane, ...seq.filter((l) => l !== n.lane && laneFree(l, span)).slice(0, 8)];
    }
    // earliest row where any candidate lane works; the connector is tried both ways (turn then drop, drop then turn)
    let chosen = null;
    const modes = t.first === n ? ['H', 'J'] : ['H'];
    for (let r = lo; r < lo + CAP && !chosen; r++) {
      for (const lane of lanes) { for (const mode of modes) if (fits(p, r, lane, mode)) { chosen = { lane, r, mode }; break; } if (chosen) break; }
    }
    if (!chosen) { // keep looking down the first lane, then take the first free cell and let `warnings` say so
      for (let r = lo; r < lo + CAP && !chosen; r++) if (fits(p, r, lanes[0], 'H')) chosen = { lane: lanes[0], r, mode: 'H' };
      if (!chosen) { let r = lo; while (cells.has(key(r, lanes[0]))) r++; chosen = { lane: lanes[0], r, mode: 'H' }; }
    }
    if (chosen.lane !== n.lane) { // needed another lane: this node and the rest of its thread move there
      if (t.first === n) t.lane = chosen.lane;
      for (const m of t.members) if (m.idx >= n.idx) m.lane = chosen.lane;
      if (!occ.has(chosen.lane)) occ.set(chosen.lane, []); occ.get(chosen.lane).push([n.idx, Math.max(...t.members.map((m) => m.idx))]);
    }
    put(n, p, chosen.r, chosen.mode);
  }

  // compress unused rows, keeping order
  const used = [...new Set(nodes.map((n) => n.r))].sort((a, b) => a - b);
  const rm = new Map(used.map((r, i) => [r, i]));
  for (const n of nodes) n.r = rm.get(n.r);
  // verify: no connector passes through a node
  const warnings = [];
  for (const x of nodes) {
    const p = by[x.parent]; if (!p) continue;
    if (x.mode === 'J') {
      for (const y of nodes) {
        if (y === x || y === p) continue;
        if (y.r === x.r && Math.min(p.lane, x.lane) < y.lane && y.lane < Math.max(p.lane, x.lane)) warnings.push(`the branch to "${x.title}" passes through "${y.title}"`);
        if (!p.route && y.lane === p.lane && p.r < y.r && y.r < x.r) warnings.push(`the branch to "${x.title}" passes through "${y.title}"`);
      }
      continue;
    }
    if (p.lane !== x.lane) for (const y of nodes) {
      if (y === x || y === p) continue;
      if (y.r === p.r && Math.min(p.lane, x.lane) < y.lane && y.lane < Math.max(p.lane, x.lane)) warnings.push(`the branch to "${x.title}" passes through "${y.title}"`);
      if (x.r > p.r && y.r === p.r && y.lane === x.lane) warnings.push(`the branch to "${x.title}" bends at "${y.title}"`);
    }
    for (const y of nodes) {
      if (y === x || y === p) continue;
      if (y.lane === x.lane && Math.min(p.r, x.r) < y.r && y.r < Math.max(p.r, x.r)) warnings.push(`the branch to "${x.title}" passes through "${y.title}"`);
    }
  }
  const cellSeen = new Set();
  for (const n of nodes) { const k = key(n.r, n.lane); if (cellSeen.has(k)) warnings.push(`"${n.title}" is drawn on top of another node`); cellSeen.add(k); }
  const lanesUsed = nodes.map((n) => n.lane);
  return { nodes, by: Object.fromEntries(nodes.map((n) => [n.id, n])), rows: used.length, minLane: Math.min(0, ...lanesUsed), maxLane: Math.max(0, ...lanesUsed), warnings: [...new Set(warnings)] };
}

// ---------- restart briefs ----------

const DEFAULT_RULES = [
  'Work only on this thread. Leave other threads and unrelated changes alone.',
  "Don't spend money, start paid infrastructure, deploy, push, or contact anyone without asking first. If this thread needs spend, give the estimate and stop.",
  'Report what you tried, the result with evidence, and a recommendation. Say what you could not verify.',
];

export function makeBrief(map, laid, sessions, id) {
  const n = laid.by[id]; if (!n) throw new Error(`no node ${JSON.stringify(id)}`);
  const t = turnFor(map, sessions, n.src);
  const s = parseSrc(n.src);
  const who = s.role === 'H' ? 'You said' : 'Claude said';
  const ref = (sid, role, num) => (map.sessions.length > 1 ? `${sid.slice(0, 8)}:` : '') + role + num;
  const clip = (x, max) => (x.length > max ? x.slice(0, max).trimEnd() + '...' : x);
  const around = (text, quote, w) => {
    const q = norm(quote), i = text.indexOf(q);
    if (i < 0) return clip(text, 2 * w);
    const a = Math.max(0, i - w), b = Math.min(text.length, i + q.length + w);
    return (a > 0 ? '...' : '') + text.slice(a, b) + (b < text.length ? '...' : '');
  };
  const ex = [];
  if (t) {
    const p = sessions[t.sid], turn = t.turn;
    if (s.role === 'A') {
      ex.push(`- Claude (${ref(t.sid, 'A', t.n)}): "${around(turn.assistant, n.quote, 330)}"`);
      const next = p.turns[t.n];
      if (next && next.kind !== 'summary') ex.push(`- You, next (${ref(t.sid, 'H', t.n + 1)}): "${clip(next.human, 450)}"`);
    } else {
      ex.push(`- You (${ref(t.sid, 'H', t.n)}): "${clip(turn.human, 520)}"`);
      if (turn.assistant) ex.push(`- Claude's reply (${ref(t.sid, 'A', t.n)}): "${clip(turn.assistant, 450)}"`);
    }
  }
  const before = laid.nodes.filter((m) => m.route && !m.constraint && m.status !== 'now' && m.idx < n.idx).slice(-6).map((m) => `- ${m.title}${m.note ? ': ' + m.note : ''}`);
  const constraints = laid.nodes.filter((m) => m.constraint && m.status === 'decided').map((m) => `- ${m.title}${m.note ? ': ' + m.note : ''}`);
  return [
    `RESTART THIS THREAD: ${n.title}`,
    `Status in the session map: ${LABEL[n.status]}${t ? ' (' + fmtTime(t.turn.ts) + ')' : ''}`,
    `${who}${t ? ' in turn ' + ref(t.sid, s.role, s.n) : ''}: "${n.quote}"`,
    n.note ? `What happened to it: ${n.note}` : null,
    ex.length ? `\nWhere it came up:\n${ex.join('\n')}` : null,
    before.length ? `\nThe route so far (most recent decisions before this point):\n${before.join('\n')}` : null,
    constraints.length ? `\nStanding constraints:\n${constraints.join('\n')}` : null,
    `\nHow to work this thread:\n${(map.briefRules || DEFAULT_RULES).map((r) => '- ' + r).join('\n')}`,
  ].filter((x) => x !== null).join('\n');
}

// ---------- page ----------

const wrapText = (t, w) => { const out = []; let line = ''; for (const word of String(t).split(/\s+/)) { if (line && (line + ' ' + word).length > w) { out.push(line); line = word; } else line = line ? line + ' ' + word : word; } if (line) out.push(line); return out.length ? out : ['']; };

export function renderHtml(map, laid, sessions, verified, briefs) {
  const { nodes, by } = laid;
  const SP = 250, ROW_H = 92, TOP = 78, LEFT = 120, RIGHT = 190;
  const X0 = LEFT + (-laid.minLane) * SP + 60;
  const W = Math.max(1100, X0 + laid.maxLane * SP + RIGHT);
  const HEIGHT = TOP + (laid.rows - 1) * ROW_H + 90;
  for (const n of nodes) { n.x = X0 + n.lane * SP; n.y = TOP + n.r * ROW_H; }
  const turnOf = (n) => turnFor(map, sessions, n.src);
  const tsOf = (n) => { const t = turnOf(n); return t ? t.turn.ts : null; };
  const svg = [];

  // day bands
  const dayRows = new Map();
  for (let r = 0; r < laid.rows; r++) {
    const c = nodes.filter((n) => n.r === r); const pick = c.find((n) => n.route) || c[0];
    const d = dayKey(tsOf(pick)); if (!dayRows.has(d)) dayRows.set(d, []); dayRows.get(d).push(r);
  }
  [...dayRows.entries()].forEach(([d, rs], i) => {
    const y0 = i === 0 ? 0 : TOP + rs[0] * ROW_H - ROW_H / 2;
    if (i) svg.push(`<line x1="0" y1="${y0}" x2="${W}" y2="${y0}" class="dayline"/>`);
    svg.push(`<text x="${W - 14}" y="${y0 + 30}" class="day" text-anchor="end">${esc(d)}</text>`);
  });

  // links: a dotted line from a later node back to an earlier one (the arrow points at `to`)
  for (const l of map.links || []) {
    const a = by[l.from], b = by[l.to]; if (!a || !b) continue;
    const gx = 62, ax = a.x - (a.route ? 17 : 12), bx = b.x - (b.route ? 22 : 16);
    svg.push(`<path d="M${ax} ${a.y} H${gx} V${b.y} H${bx}" class="ret"/>`);
    svg.push(`<path d="M${bx} ${b.y - 5} L${bx + 8} ${b.y} L${bx} ${b.y + 5} Z" class="rethead"/>`);
    if (l.label) svg.push(`<text x="${gx + 12}" y="${a.y - 10}" class="retlab">${esc(l.label)}</text>`);
  }

  // edges
  const edgePath = (p, c) => {
    const rp = p.route ? 14 : 10, rc = c.route ? 14 : 10, R = 14;
    if (c.mode === 'J') { const s = c.x > p.x ? 1 : -1; return p.route ? `M${p.x} ${c.y} H${c.x - s * rc}` : `M${p.x} ${p.y + rp} V${c.y} H${c.x - s * rc}`; }
    if (c.y === p.y) { const s = c.x > p.x ? 1 : -1; return `M${p.x + s * rp} ${p.y} H${c.x - s * rc}`; }
    if (p.x === c.x) return `M${p.x} ${p.y + rp} V${c.y - rc}`;
    const s = c.x > p.x ? 1 : -1;
    return `M${p.x + s * rp} ${p.y} H${c.x - s * R} Q${c.x} ${p.y} ${c.x} ${p.y + R} V${c.y - rc}`;
  };
  for (const n of nodes) {
    const p = by[n.parent]; if (!p) continue;
    const isRoute = n.route && p.route;
    svg.push(`<path d="${edgePath(p, n)}" class="edge ${isRoute ? 'route' : 'side'} e-${n.status}" data-to="${esc(n.id)}"/>`);
  }

  // compactions and auto-detected limit messages
  const events = [];
  const lastNodeAtOrBefore = (sid, num) => nodes.filter((n) => { const s = parseSrc(n.src); const t = turnOf(n); return t && t.sid === sid && t.n <= num; }).sort((a, b) => b.idx - a.idx)[0];
  for (const [sid, p] of Object.entries(sessions)) {
    for (const c of p.compactions) {
      const a = lastNodeAtOrBefore(sid, c.after); if (!a) continue;
      const y = a.y + 74;
      svg.push(`<line x1="14" y1="${y}" x2="${W - 110}" y2="${y}" class="cmp"/>`);
      svg.push(`<text x="${W - 116}" y="${y - 7}" class="cmplab" text-anchor="end">context compacted${c.ts ? ' · ' + esc(fmtTime(c.ts)) : ''}</text>`);
    }
    const seen = new Set();
    for (const t of p.turns) {
      const m = LIMIT_RE.exec(t.assistant); if (!m) continue;
      const key = dayKey(t.ts) + m[0]; if (seen.has(key)) continue; seen.add(key);
      const a = lastNodeAtOrBefore(sid, t.n); if (!a) continue;
      events.push({ id: `auto-limit-${sid.slice(0, 4)}-${t.n}`, after: a, kind: 'limit', title: m[0].replace(/^You've hit your /, 'Hit the ') , quote: m[0], who: 'Claude', turn: 'A' + t.n, when: fmtTime(t.ts), ok: true });
    }
  }
  for (const e of map.events || []) {
    const a = by[e.after]; if (!a) continue;
    const t = turnFor(map, sessions, e.src);
    const text = t ? (t.role === 'H' ? t.turn.human : t.turn.assistant) : '';
    events.push({ id: 'ev-' + e.id, after: a, kind: e.kind || 'note', title: e.title, quote: e.quote, who: t && t.role === 'H' ? 'You' : 'Claude', turn: e.src, when: t ? fmtTime(t.turn.ts) : '', ok: !!t && text.includes(norm(e.quote)) });
  }

  // nodes
  const tips = {};
  for (const n of nodes) {
    const big = !!n.route; const r = big ? 15 : 10; const st = n.status;
    const lines = wrapText(n.title, big ? 20 : 24).slice(0, 4);
    const lx = big ? n.x + 28 : n.x;
    const lab = lines.map((l, i) => `<tspan x="${lx}" dy="${i === 0 ? 0 : 17}">${esc(l)}</tspan>`).join('');
    const ring = st === 'now' ? `<circle cx="${n.x}" cy="${n.y}" r="${r + 7}" class="pulse"/>` : '';
    const ok = verified[n.id];
    const glyph = st === 'decided' ? `<path d="M${(n.x - r * .45).toFixed(1)} ${(n.y + r * .02).toFixed(1)} L${(n.x - r * .1).toFixed(1)} ${(n.y + r * .38).toFixed(1)} L${(n.x + r * .5).toFixed(1)} ${(n.y - r * .36).toFixed(1)}" class="gl"/>`
      : st === 'rejected' ? (() => { const k = r * .38; return `<path d="M${(n.x - k).toFixed(1)} ${(n.y - k).toFixed(1)} L${(n.x + k).toFixed(1)} ${(n.y + k).toFixed(1)} M${(n.x + k).toFixed(1)} ${(n.y - k).toFixed(1)} L${(n.x - k).toFixed(1)} ${(n.y + k).toFixed(1)}" class="gl"/>`; })()
      : st === 'deferred' ? (() => { const k = r * .3; return `<path d="M${(n.x - k).toFixed(1)} ${(n.y - r * .38).toFixed(1)} V${(n.y + r * .38).toFixed(1)} M${(n.x + k).toFixed(1)} ${(n.y - r * .38).toFixed(1)} V${(n.y + r * .38).toFixed(1)}" class="gl"/>`; })()
      : st === 'open' ? `<text x="${n.x}" y="${(n.y + r * .36).toFixed(1)}" class="qm" text-anchor="middle">?</text>`
      : st === 'now' ? `<circle cx="${n.x}" cy="${n.y}" r="${(r * .38).toFixed(1)}" class="gf"/>` : `<circle cx="${n.x}" cy="${n.y}" r="2" class="gf"/>`;
    svg.push(`<g class="node st-${st}${big ? ' big' : ''}${ok ? '' : ' unver'}" data-id="${esc(n.id)}" data-st="${st}" tabindex="0" role="button" aria-label="${esc(n.title)}, ${LABEL[st]}">${ring}<circle cx="${n.x}" cy="${n.y}" r="${r}" class="dot${st === 'unexplored' ? ' unx' : ''}"/>${glyph}<text x="${lx}" y="${n.y + (big ? 26 : r + 17)}" class="lab${big ? ' labbig' : ''}" text-anchor="${big ? 'start' : 'middle'}">${lab}</text><circle cx="${n.x}" cy="${n.y}" r="${Math.max(r + 6, 20)}" class="hit"/></g>`);
    const t = turnOf(n);
    tips[n.id] = { title: n.title, st, stl: LABEL[st], when: t ? fmtTime(t.turn.ts) : '', who: parseSrc(n.src).role === 'H' ? 'You' : 'Claude', quote: n.quote, note: n.note || '', ok: !!ok, turn: n.src, brief: RESTARTABLE.includes(st) && briefs[n.id] ? 1 : 0 };
  }
  const evSeen = {};
  for (const e of events) {
    const k = evSeen[e.after.id] = (evSeen[e.after.id] || 0) + 1;
    const y = e.after.y + ROW_H / 2 + (k - 1) * 28, xg = W - 88;
    svg.push(`<g class="node evt" data-id="${esc(e.id)}" data-st="event" tabindex="0" role="button" aria-label="${esc(e.title)}"><circle cx="${xg}" cy="${y}" r="11" class="edot"/><text x="${xg}" y="${y + 4.5}" class="eg" text-anchor="middle">${e.kind === 'restart' ? '↻' : '!'}</text><circle cx="${xg}" cy="${y}" r="20" class="hit"/></g>`);
    tips[e.id] = { title: e.title, st: 'event', stl: 'Event', when: e.when, who: e.who, quote: e.quote, note: '', ok: e.ok, turn: e.turn, brief: 0 };
  }

  const cnt = Object.fromEntries(STATUSES.map((k) => [k, nodes.filter((n) => n.status === k).length]));
  const root = nodes.find((n) => n.route && !n.parent);
  const now = nodes.find((n) => n.status === 'now') || [...nodes].filter((n) => n.route).sort((a, b) => b.idx - a.idx)[0];
  const allTurns = Object.values(sessions).flatMap((p) => p.turns);
  const days = new Set(allTurns.map((t) => dayKey(t.ts)));
  const prompts = allTurns.filter((t) => t.kind === 'prompt').length;
  const comps = Object.values(sessions).reduce((a, p) => a + p.compactions.length, 0);
  const chips = ['decided', 'rejected', 'deferred', 'unexplored', 'open'].map((k) => `<button class="chip st-${k}" data-filter="${k}" aria-pressed="false"><i></i><b>${cnt[k]}</b> ${LABEL[k]}</button>`).join('');
  const openCount = nodes.filter((n) => OPEN_THREADS.includes(n.status)).length;
  const verifiedCount = nodes.filter((n) => verified[n.id]).length;
  const rootT = turnOf(root), nowT = turnOf(now);
  const css = CSS;
  return `<title>${esc(map.title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>${css}</style>
<div class="wrap">
  <header class="top">
    <div class="ends">
      <div class="end start"><span class="k">Started on</span><b>${esc(root.title)}</b><span class="d">${esc(rootT ? fmtTime(rootT.turn.ts) : '')}</span></div>
      <svg class="arrow" viewBox="0 0 120 20" aria-hidden="true"><path d="M2 10 H108"/><path d="M108 4 L118 10 L108 16 Z"/></svg>
      <div class="end now"><span class="k">Now</span><b>${esc(now.title)}</b><span class="d">${esc(nowT ? fmtTime(nowT.turn.ts) : '')}</span></div>
    </div>
    <div class="facts"><span><b>${days.size}</b> day${days.size === 1 ? '' : 's'}</span><span><b>${prompts}</b> of your prompts</span><span><b>${comps}</b> context compaction${comps === 1 ? '' : 's'}</span><span><b>${nodes.length}</b> choices mapped</span></div>
  </header>
  <div class="legend" role="group" aria-label="Filter by status">${chips}<button class="chip clear" data-filter="" hidden>Show all</button>${openCount ? `<button class="chip copyall" id="copyall"><b>Copy ${openCount} open thread${openCount === 1 ? '' : 's'} to restart</b></button>` : ''}</div>
  <div class="mapwrap" id="mapwrap"><svg id="map" viewBox="0 0 ${W} ${HEIGHT}" style="min-width:${Math.min(W, 900)}px" role="img" aria-label="Decision map of the conversation, newest at the bottom">
    ${svg.join('')}
  </svg></div>
  <p class="foot">${esc(map.note || 'Built from the conversation transcript. Statuses are a judgement call by the model that read it.')} Every quote is checked against the transcript: <b>${verifiedCount} of ${nodes.length}</b> found${verifiedCount < nodes.length ? ' (the rest are drawn with a dashed outline)' : ''}. Times are in your local time zone. This page is private.</p>
</div>
<div id="tip" role="tooltip" hidden></div>
<script type="application/json" id="tips">${JSON.stringify(tips).replace(/</g, '\\u003c').replace(new RegExp('\\u2028', 'g'), '\\u2028').replace(new RegExp('\\u2029', 'g'), '\\u2029')}</script>
<script type="application/json" id="briefs">${JSON.stringify(briefs).replace(/</g, '\\u003c').replace(new RegExp('\\u2028', 'g'), '\\u2028').replace(new RegExp('\\u2029', 'g'), '\\u2029')}</script>
<script>${CLIENT_JS}</script>`;
}

const CSS = `/* Layout: a vertical route map. The route runs down the middle, one station per decision. Side branches end in a mark: check, cross, pause, dotted ring, question. */
:root{--bg:#f3f5f4;--surface:#ffffff;--ink:#16211f;--muted:#5d6d69;--line:#d5dcda;--accent:#0f6f66;--accent-soft:#dff0ed;--ok:#1d7a3f;--bad:#b3261e;--warn:#9a6200;--open:#6a4bc4;--glyph:#ffffff;--shadow:0 8px 28px rgba(22,33,31,.18);
--sans:'Instrument Sans',system-ui,-apple-system,'Segoe UI',sans-serif;--mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0e1514;--surface:#162120;--ink:#e3ece9;--muted:#8fa29d;--line:#2a3a37;--accent:#4fc4b6;--accent-soft:#16312d;--ok:#6fd08f;--bad:#ff8a80;--warn:#e9b74d;--open:#b9a2ff;--glyph:#0e1514;--shadow:0 8px 28px rgba(0,0,0,.5);color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0e1514;--surface:#162120;--ink:#e3ece9;--muted:#8fa29d;--line:#2a3a37;--accent:#4fc4b6;--accent-soft:#16312d;--ok:#6fd08f;--bad:#ff8a80;--warn:#e9b74d;--open:#b9a2ff;--glyph:#0e1514;--shadow:0 8px 28px rgba(0,0,0,.5);color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.45;padding-block:22px 44px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.wrap{max-width:1240px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
h4,p{margin:0}
.top{display:flex;flex-direction:column;gap:12px}
.ends{display:flex;align-items:stretch;gap:14px;flex-wrap:wrap}
.end{display:flex;flex-direction:column;gap:2px;padding:12px 16px;border:1px solid var(--line);border-radius:8px;background:var(--surface);min-width:0;flex:1 1 260px;max-width:430px}
.end .k{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:600}
.end b{font-size:19px;line-height:1.25;font-weight:600;text-wrap:balance}
.end .d{font-family:var(--mono);font-size:12px;color:var(--muted)}
.end.now{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.end.now .k{color:var(--accent)}
.arrow{width:86px;align-self:center;flex:none;fill:var(--accent);stroke:var(--accent);stroke-width:2.5}
.arrow path:last-child{stroke:none}
.facts{display:flex;flex-wrap:wrap;gap:4px 20px;font-size:13px;color:var(--muted)}
.facts b{color:var(--ink);font-variant-numeric:tabular-nums}
.legend{display:flex;flex-wrap:wrap;gap:8px;position:sticky;top:env(safe-area-inset-top,0px);z-index:5;padding-block:8px;background:var(--bg)}
.chip{display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:13px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:5px 12px 5px 9px;cursor:pointer}
.chip i{width:12px;height:12px;border-radius:50%;background:var(--c);flex:none}
.chip b{font-variant-numeric:tabular-nums}
.chip[aria-pressed="true"]{border-color:var(--c);box-shadow:0 0 0 1px var(--c)}
.chip.clear{border-style:dashed;color:var(--muted);padding-left:12px}
.chip.copyall{margin-left:auto;padding-left:14px;border-color:var(--accent);color:var(--accent)}
.chip.copyall b{font-weight:600}
.chip:focus-visible,.node:focus-visible,.tipbtn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.st-decided{--c:var(--ok)}.st-rejected{--c:var(--bad)}.st-deferred{--c:var(--warn)}.st-unexplored{--c:var(--muted)}.st-open{--c:var(--open)}.st-now{--c:var(--accent)}
.st-unexplored.chip i{background:transparent;border:2px dashed var(--muted)}
.mapwrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--bg)}
#map{display:block;width:100%;height:auto}
.band{fill:var(--bg)}.dayline{stroke:var(--line);stroke-width:1}
.day{font:600 12px var(--mono);fill:var(--muted);letter-spacing:.04em}
.edge{fill:none;stroke-linecap:round;transition:opacity .15s}
.edge.route{stroke:var(--accent);stroke-width:6}
.edge.side{stroke:var(--c0,var(--muted));stroke-width:2.5;opacity:.75}
.e-decided{--c0:var(--ok)}.e-rejected{--c0:var(--bad)}.e-deferred{--c0:var(--warn)}.e-open{--c0:var(--open)}
.e-unexplored{--c0:var(--muted);stroke-dasharray:3 6}
.ret{fill:none;stroke:var(--accent);stroke-width:2.5;stroke-dasharray:2 7;stroke-linecap:round}
.rethead{fill:var(--accent)}
.retlab{font:italic 12px var(--sans);fill:var(--accent)}
.cmp{stroke:var(--warn);stroke-width:1.5;stroke-dasharray:7 6}
.cmplab{font:600 11px var(--mono);fill:var(--warn);letter-spacing:.03em}
.node{cursor:pointer}
.dot{fill:var(--c);stroke:var(--bg);stroke-width:3}
.dot.unx{fill:var(--bg);stroke:var(--muted);stroke-width:2.25;stroke-dasharray:3 3}
.unver .dot{stroke:var(--warn);stroke-dasharray:3 2;stroke-width:2.5}
.gl{fill:none;stroke:var(--glyph);stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
.gf{fill:var(--glyph)}
.st-unexplored .gf{fill:var(--muted)}
.qm{font:700 15px var(--sans);fill:var(--glyph)}
.hit{fill:transparent}
.lab{font:500 12.5px var(--sans);fill:var(--ink);pointer-events:none;paint-order:stroke;stroke:var(--bg);stroke-width:6px;stroke-linejoin:round}
.labbig{font-weight:600;font-size:14px}
.st-unexplored .lab{fill:var(--muted)}
.pulse{fill:none;stroke:var(--accent);stroke-width:2.5;opacity:.55}
@media (prefers-reduced-motion:no-preference){.pulse{animation:pl 1.8s ease-out infinite;transform-box:fill-box;transform-origin:center}@keyframes pl{0%{transform:scale(.7);opacity:.8}100%{transform:scale(1.35);opacity:0}}}
.node:hover .dot,.node:focus-visible .dot,.node.sel .dot{stroke:var(--ink);stroke-width:2.5}
.edot{fill:var(--bg);stroke:var(--warn);stroke-width:2}
.eg{font:700 13px var(--sans);fill:var(--warn)}
#map.filtering .node:not(.match),#map.filtering .evt{opacity:.16}
#map.filtering .edge.dimmed,#map.filtering .ret{opacity:.1}
#tip{position:fixed;z-index:20;max-width:340px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);padding:12px 14px;display:flex;flex-direction:column;gap:8px;pointer-events:none}
#tip.pinned{pointer-events:auto}
#tip[hidden]{display:none}
#tip .th{display:flex;justify-content:space-between;gap:10px;align-items:center}
#tip .pill{font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;color:var(--c,var(--muted));border:1px solid var(--c,var(--line))}
#tip .when{font:12px var(--mono);color:var(--muted)}
#tip h4{font-size:15px;line-height:1.3}
#tip blockquote{margin:0;padding:6px 10px;border-left:3px solid var(--c,var(--line));background:var(--bg);font-size:13px;border-radius:0 6px 6px 0;overflow-wrap:anywhere}
#tip cite{display:block;font:11.5px var(--mono);color:var(--muted);font-style:normal;margin-top:4px}
#tip cite.bad{color:var(--warn)}
#tip .note{font-size:13px;color:var(--muted)}
.tipbtn{font:inherit;font-size:13px;font-weight:600;color:var(--accent);background:transparent;border:1px solid var(--accent);border-radius:8px;padding:6px 10px;cursor:pointer;align-self:flex-start}
.tipfall{width:100%;height:90px;font:11px var(--mono);color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:6px}
.foot{font-size:12px;color:var(--muted);max-width:90ch}
.foot b{color:var(--ink)}
`;

const CLIENT_JS = `
(function () {
  var tips = JSON.parse(document.getElementById('tips').textContent);
  var briefs = JSON.parse(document.getElementById('briefs').textContent);
  var map = document.getElementById('map'), tip = document.getElementById('tip');
  var nodes = Array.prototype.slice.call(map.querySelectorAll('.node'));
  var edges = Array.prototype.slice.call(map.querySelectorAll('.edge'));
  var pinned = null;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  function copyText(text, btn, label) {
    function done(ok) { if (btn) { btn.textContent = ok ? 'Copied' : 'Copy failed. Select the text below.'; setTimeout(function () { btn.textContent = label; }, 2200); } }
    function fallback() {
      var ta = el('textarea', 'tipfall'); ta.value = text; ta.readOnly = true;
      var host = tip.hidden ? document.querySelector('.legend') : tip; host.appendChild(ta); ta.focus(); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} done(ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback); else fallback();
  }

  function show(node, pin) {
    var id = node.getAttribute('data-id'), t = tips[id]; if (!t) return;
    tip.innerHTML = ''; tip.className = 'st-' + t.st + (pin ? ' pinned' : '');
    var th = el('div', 'th'); th.appendChild(el('span', 'pill', t.stl)); th.appendChild(el('span', 'when', t.when)); tip.appendChild(th);
    tip.appendChild(el('h4', '', t.title));
    var bq = el('blockquote', '', '\\u201c' + t.quote + '\\u201d');
    bq.appendChild(el('cite', t.ok ? '' : 'bad', '\\u2014 ' + t.who + ', turn ' + t.turn + (t.ok ? ' \\u2713 found in transcript' : ' \\u26a0 not found verbatim')));
    tip.appendChild(bq);
    if (t.note) tip.appendChild(el('p', 'note', t.note));
    if (pin && t.brief && briefs[id]) { var b = el('button', 'tipbtn', 'Copy restart brief'); b.addEventListener('click', function (ev) { ev.stopPropagation(); copyText(briefs[id], b, 'Copy restart brief'); }); tip.appendChild(b); }
    else if (!pin && t.brief) tip.appendChild(el('p', 'note', 'Click to pin, then copy a restart brief.'));
    tip.hidden = false;
    var r = node.querySelector('.dot, .edot').getBoundingClientRect(), tw = tip.offsetWidth, th2 = tip.offsetHeight;
    var x = r.right + 14; if (x + tw > window.innerWidth - 12) x = r.left - tw - 14; if (x < 12) x = Math.max(12, Math.min(window.innerWidth - tw - 12, r.left - tw / 2));
    var y = r.top - 12; if (y + th2 > window.innerHeight - 12) y = window.innerHeight - th2 - 12; if (y < 12) y = 12;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
    nodes.forEach(function (n) { n.classList.toggle('sel', pin && n === node); });
    pinned = pin ? node : null;
  }
  function hide() { tip.hidden = true; tip.className = ''; nodes.forEach(function (n) { n.classList.remove('sel'); }); pinned = null; }
  tip.addEventListener('click', function (ev) { ev.stopPropagation(); });

  nodes.forEach(function (n) {
    n.addEventListener('mouseenter', function () { if (!pinned) show(n, false); });
    n.addEventListener('mouseleave', function () { if (!pinned) hide(); });
    n.addEventListener('focus', function () { if (!pinned) show(n, false); });
    n.addEventListener('blur', function () { if (!pinned) hide(); });
    n.addEventListener('click', function (ev) { ev.stopPropagation(); if (pinned === n) hide(); else show(n, true); });
    n.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (pinned === n) hide(); else show(n, true); } });
  });
  document.addEventListener('click', function () { if (pinned) hide(); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') hide(); });
  window.addEventListener('scroll', function () { if (pinned) hide(); }, { passive: true });

  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip[data-filter]'));
  var clear = document.querySelector('.chip.clear');
  function setFilter(f) {
    var on = !!f;
    map.classList.toggle('filtering', on);
    nodes.forEach(function (n) { n.classList.toggle('match', on && n.getAttribute('data-st') === f); });
    var ok = {}; nodes.forEach(function (n) { if (n.getAttribute('data-st') === f) ok[n.getAttribute('data-id')] = true; });
    edges.forEach(function (e) { e.classList.toggle('dimmed', on && !ok[e.getAttribute('data-to')]); });
    chips.forEach(function (c) { if (c !== clear) c.setAttribute('aria-pressed', on && c.getAttribute('data-filter') === f ? 'true' : 'false'); });
    clear.hidden = !on;
  }
  chips.forEach(function (c) { c.addEventListener('click', function () { var f = c.getAttribute('data-filter'); if (c === clear || c.getAttribute('aria-pressed') === 'true') setFilter(''); else setFilter(f); }); });

  var all = document.getElementById('copyall');
  if (all) all.addEventListener('click', function () {
    var ids = Object.keys(briefs).filter(function (id) { var t = tips[id]; return t && (t.st === 'unexplored' || t.st === 'open' || t.st === 'deferred'); });
    var label = all.textContent;
    copyText(ids.map(function (id) { return briefs[id]; }).join('\\n\\n==========\\n\\n'), all.querySelector('b') || all, all.querySelector('b') ? all.querySelector('b').textContent : label);
  });
})();
`;

// ---------- CLI ----------

function readMap(file) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`cannot read ${file}`); }
  let map; try { map = JSON.parse(raw); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
  const errs = validate(map);
  if (errs.length) throw new Error(`${file} is not a valid map:\n  - ${errs.join('\n  - ')}`);
  return map;
}
const writeMap = (file, map) => fs.writeFileSync(file, JSON.stringify(map, null, 2) + '\n');

async function loadSessions(map, mapFile) {
  const out = {};
  for (const s of map.sessions) {
    const candidates = [];
    if (s.file) candidates.push(path.isAbsolute(s.file) ? s.file : path.resolve(path.dirname(mapFile), s.file));
    let file = candidates.find((f) => fs.existsSync(f));
    if (!file) file = findSession(s.id);
    out[s.id] = await parseTranscript(file);
  }
  return out;
}

function flag(args, name, def) { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; }

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 13).map((l) => l.slice(3)).join('\n'));
    return cmd ? 0 : 2;
  }
  if (cmd === 'digest') {
    const out = flag(rest, '--out', path.join(process.cwd(), 'session-map-digest'));
    const sinceMap = flag(rest, '--since-cursor');
    const chunkKb = Number(flag(rest, '--chunk-kb', 70)), head = Number(flag(rest, '--head', 330)), tail = Number(flag(rest, '--tail', 220));
    let ref = rest[0], from = 1, map = null, key = null;
    if (sinceMap) { map = readMap(sinceMap); ref = ref || map.sessions[0].id; }
    if (!ref) throw new Error('usage: digest <session-id|path|latest> [--out DIR]');
    const file = findSession(ref);
    if (map) {
      const fileId = path.basename(file).replace(/\.jsonl$/, '');
      const sess = map.sessions.find((x) => fileId.startsWith(x.id) || x.id.startsWith(fileId) || (x.file && path.basename(x.file) === path.basename(file))) || (map.sessions.length === 1 ? map.sessions[0] : null);
      if (!sess) throw new Error(`${path.basename(file)} is not one of the sessions in ${sinceMap}`);
      key = sess.id; from = ((map.cursor || {})[key] || 0) + 1;
    }
    const parsed = await parseTranscript(file);
    const chunks = digestChunks(parsed, { head, tail, from, chunkKb });
    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(out)) if (/^digest-\d+\.txt$/.test(f)) fs.rmSync(path.join(out, f));
    chunks.forEach((c, i) => fs.writeFileSync(path.join(out, `digest-${String(i + 1).padStart(3, '0')}.txt`), c.trimStart() + '\n'));
    const prompts = parsed.turns.filter((t) => t.kind === 'prompt').length;
    console.log(`session ${path.basename(file)}\n  ${parsed.turns.length} turns (${prompts} prompts), ${parsed.compactions.length} compaction(s), ${fmtTime(parsed.turns[0].ts)} to ${fmtTime(parsed.turns.at(-1).ts)}\n  digest from H${from}: ${chunks.length} chunk(s) in ${out}${chunks.length ? '' : ' (nothing new since the last build)'}`);
    chunks.forEach((c, i) => console.log(`    digest-${String(i + 1).padStart(3, '0')}.txt  ${(Buffer.byteLength(c) / 1024).toFixed(0)} KB`));
    if (map && key) { map.pending = { ...(map.pending || {}), [key]: parsed.turns.length }; writeMap(sinceMap, map); }
    return 0;
  }
  const [file, which] = rest;
  if (!file) throw new Error(`usage: ${cmd} <map.json> ...`);
  const map = readMap(file);
  const keyed = await loadSessions(map, file);
  const laid = layout(map);
  const verified = verifyQuotes(map, keyed);
  const bad = map.nodes.filter((n) => !verified[n.id]);
  const report = () => {
    const cnt = Object.fromEntries(STATUSES.map((k) => [k, map.nodes.filter((n) => n.status === k).length]));
    console.log(`  ${map.nodes.length} nodes: ${STATUSES.map((k) => `${cnt[k]} ${LABEL[k].toLowerCase()}`).join(', ')}`);
    console.log(`  quotes found in the transcript: ${map.nodes.length - bad.length} of ${map.nodes.length}`);
    for (const n of bad) console.log(`  ! ${n.id} (${n.src}): quote not found verbatim: "${n.quote.slice(0, 80)}"`);
    for (const w of laid.warnings) console.log(`  ! layout: ${w}`);
  };
  if (cmd === 'check') { console.log(`ok: ${path.basename(file)}`); report(); return bad.length || laid.warnings.length ? 1 : 0; }
  if (cmd === 'build') {
    const briefs = {};
    for (const n of laid.nodes) if (RESTARTABLE.includes(n.status)) briefs[n.id] = makeBrief(map, laid, keyed, n.id);
    const out = path.join(path.dirname(path.resolve(file)), 'map.html');
    fs.writeFileSync(out, renderHtml(map, laid, keyed, verified, briefs));
    if (map.pending) { map.cursor = { ...(map.cursor || {}), ...map.pending }; delete map.pending; } else { map.cursor = map.cursor || {}; for (const s of map.sessions) map.cursor[s.id] = keyed[s.id].turns.length; }
    writeMap(file, map);
    console.log(`built ${out}`); report();
    return 0;
  }
  if (cmd === 'brief') {
    const outDir = flag(rest, '--out');
    const sel = which === 'open' ? laid.nodes.filter((n) => OPEN_THREADS.includes(n.status)).map((n) => n.id) : String(which || '').split(',').filter(Boolean);
    if (!sel.length) throw new Error('usage: brief <map.json> <id[,id...]|open> [--out DIR]');
    if (outDir) fs.mkdirSync(outDir, { recursive: true });
    for (const id of sel) {
      const text = makeBrief(map, laid, keyed, id);
      if (outDir) { fs.writeFileSync(path.join(outDir, `brief-${id}.md`), text + '\n'); console.log(`wrote ${path.join(outDir, `brief-${id}.md`)}  (${laid.by[id].title})`); }
      else console.log(text + '\n\n==========\n');
    }
    return 0;
  }
  throw new Error(`unknown command ${JSON.stringify(cmd)}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`session-map: ${e.message}`); process.exitCode = 2; });
}
