// Run with: node --test scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate, parseSrc, parseTranscript, digestChunks, verifyQuotes, layout, makeBrief, renderHtml, findSession, toolLine } from './session-map.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'session-map.mjs');
const EX_DIR = path.join(here, '../examples');
const exMap = () => JSON.parse(fs.readFileSync(path.join(EX_DIR, 'session-map.example.json'), 'utf8'));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function exSessions() {
  const parsed = await parseTranscript(path.join(EX_DIR, 'session.example.jsonl'));
  return { 'example-session': parsed };
}
const N = (id, extra = {}) => ({ id, status: 'decided', title: `Node ${id}`, src: 'H1', quote: 'q', ...extra });
const M = (nodes, extra = {}) => ({ title: 't', sessions: [{ id: 's' }], nodes, ...extra });

test('the shipped example is a valid map', () => assert.deepEqual(validate(exMap()), []));

test('validate reports the common mistakes', () => {
  const errs = validate(M([N('a', { route: true }), N('a', { parent: 'a' }), N('b', { parent: 'ghost', status: 'maybe', src: 'X9' }), N('c', { quote: '' })]));
  assert.ok(errs.some((e) => /duplicate id/.test(e)));
  assert.ok(errs.some((e) => /parent "ghost" does not exist/.test(e)));
  assert.ok(errs.some((e) => /status must be one of/.test(e)));
  assert.ok(errs.some((e) => /src must look like/.test(e)));
  assert.ok(errs.some((e) => /quote is required/.test(e)));
  assert.ok(errs.some((e) => /no parent must be a route node/.test(e)));
});

test('validate needs exactly one starting route node, a session prefix when there are several sessions, and no cycles', () => {
  assert.ok(validate(M([N('a', { route: true }), N('b', { route: true })])).some((e) => /exactly one route node/.test(e)));
  assert.ok(validate(M([N('a', { route: true })], { sessions: [{ id: 'one' }, { id: 'two' }] })).some((e) => /session prefix/.test(e)));
  assert.deepEqual(validate(M([N('a', { route: true, src: 'one:H1' })], { sessions: [{ id: 'one' }, { id: 'two' }] })), []);
  assert.ok(validate(M([N('r', { route: true }), N('a', { parent: 'b' }), N('b', { parent: 'a' })])).some((e) => /cycle/.test(e)));
});

test('parseSrc reads H12, A12 and a session prefix', () => {
  assert.deepEqual(parseSrc('H12'), { sid: null, role: 'H', n: 12 });
  assert.deepEqual(parseSrc('abc123:A7'), { sid: 'abc123', role: 'A', n: 7 });
  assert.equal(parseSrc('12'), null);
});

test('parseTranscript keeps only the conversation: skips tool results, sidechains and injected messages, flags the compaction summary', async () => {
  const p = (await exSessions())['example-session'];
  assert.equal(p.turns.length, 11);
  assert.equal(p.turns.filter((t) => t.kind === 'prompt').length, 10);
  assert.equal(p.turns[8].kind, 'summary');
  assert.deepEqual(p.compactions.map((c) => c.after), [8]);
  assert.ok(!p.turns.some((t) => /subagent/.test(t.assistant)));
  assert.match(p.turns[6].assistant, /Booking table and migration are done/);
});

test('parseTranscript fails loudly when there is no conversation in the file', async () => {
  const f = path.join(tmp('sm-empty-'), 'x.jsonl');
  fs.writeFileSync(f, '{"type":"system","x":1}\nnot json\n');
  await assert.rejects(() => parseTranscript(f), /no conversation found/);
});

test('findSession resolves a path, and reports an unknown id clearly', () => {
  assert.equal(findSession(path.join(EX_DIR, 'session.example.jsonl')), path.join(EX_DIR, 'session.example.jsonl'));
  const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = tmp('sm-cfg-');
  fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
  assert.throws(() => findSession('nope'), /no session file starting with "nope"/);
  if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old;
});

test('digest keeps turn ids, marks the compaction, and splits chunks at turn boundaries', async () => {
  const p = (await exSessions())['example-session'];
  const one = digestChunks(p, { chunkKb: 70 });
  assert.equal(one.length, 1);
  assert.match(one[0], /#### H1 /);
  assert.match(one[0], /==== COMPACTION after H8/);
  assert.match(one[0], /\[compaction summary, written by Claude\]/);
  const many = digestChunks(p, { chunkKb: 1 });
  assert.ok(many.length > 1);
  assert.ok(many.every((c) => c.trimStart().startsWith('#### H') || c.trimStart().startsWith('==== COMPACTION')));
  assert.ok(!digestChunks(p, { from: 10 }).join('').includes('#### H9'));
});

test('verifyQuotes accepts a verbatim quote from the cited turn and rejects a paraphrase or the wrong turn', async () => {
  const s = await exSessions();
  const map = { sessions: [{ id: 'example-session' }], nodes: [
    N('ok', { src: 'H2', quote: 'Go with Postgres' }),
    N('para', { src: 'H2', quote: 'Use Postgres please' }),
    N('wrong', { src: 'H3', quote: 'Go with Postgres' }),
    N('asst', { src: 'A3', quote: 'a cache layer such as Redis' }),
  ] };
  const v = verifyQuotes(map, s);
  assert.deepEqual([v.ok, v.para, v.wrong, v.asst], [true, false, false, true]);
});

test('the example lays out with no collisions: unique cells, route on lane 0, route rows in order', () => {
  const l = layout(exMap());
  assert.deepEqual(l.warnings, []);
  const cells = l.nodes.map((n) => `${n.r}:${n.lane}`);
  assert.equal(new Set(cells).size, cells.length);
  const route = l.nodes.filter((n) => n.route);
  assert.ok(route.every((n) => n.lane === 0));
  assert.deepEqual(route.map((n) => n.r), [...route.map((n) => n.r)].sort((a, b) => a - b));
});

function randomMap(seed0, { realistic }) {
  let seed = seed0; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const nodes = [N('r0', { route: true, src: 'H1' })];
  const route = ['r0']; const side = [];
  for (let i = 1; i < 45; i++) {
    const roll = rnd();
    if (roll < 0.3) { nodes.push(N(`r${i}`, { route: true, parent: route.at(-1), src: `H${i + 1}` })); route.push(`r${i}`); }
    else if (roll < 0.65 || !side.length) { nodes.push(N(`s${i}`, { parent: route.at(-1 - Math.floor(rnd() * Math.min(2, route.length - 1))), status: 'rejected', src: `H${i + 1}` })); side.push(`s${i}`); }
    else {
      // realistic: a thread continues, or something forks off a recent branch. adversarial: anything, however old.
      const par = realistic ? side.at(-1 - Math.floor(rnd() * Math.min(3, side.length))) : (rnd() < 0.7 ? side.at(-1) : side[Math.floor(rnd() * side.length)]);
      nodes.push(N(`s${i}`, { parent: par, status: 'open', src: `H${i + 1}` })); side.push(`s${i}`);
    }
  }
  return M(nodes);
}

test('layout of realistic trees (branches off the route, continued threads, forks off recent branches): unique cells always, and a warning only for the minority where no clean path exists', () => {
  let warned = 0;
  for (let round = 0; round < 200; round++) {
    const map = randomMap(round + 1, { realistic: true });
    assert.deepEqual(validate(map), []);
    const l = layout(map);
    const cells = l.nodes.map((n) => `${n.r}:${n.lane}`);
    assert.equal(new Set(cells).size, cells.length, `round ${round}: two nodes share a cell`);
    if (l.warnings.length) warned++;
  }
  assert.ok(warned <= 40, `${warned} of 200 realistic maps needed a warning`); // measured: about 28 of 200 (14%)
});

test('layout of adversarial trees (forks off branches from anywhere earlier) always finishes with unique cells, and reports what it could not avoid', () => {
  let warned = 0;
  for (let round = 0; round < 100; round++) {
    const map = randomMap(1000 + round, { realistic: false });
    const l = layout(map);
    const cells = l.nodes.map((n) => `${n.r}:${n.lane}`);
    assert.equal(new Set(cells).size, cells.length, `round ${round}: two nodes share a cell`);
    for (const n of l.nodes) assert.ok(n.r >= 0 && Number.isInteger(n.lane));
    if (l.warnings.length) warned++;
  }
  assert.ok(warned <= 40, `${warned} of 100 adversarial maps needed a warning`); // measured: about 21%
});

test('explicit row and lane on a node are respected', () => {
  const map = M([N('r', { route: true, src: 'H1' }), N('a', { parent: 'r', src: 'H2', lane: -2, row: 5 })]);
  const l = layout(map);
  assert.equal(l.by.a.lane, -2);
  assert.equal(l.by.a.r, 1); // rows are compressed, but order is kept
});

test('a restart brief carries the quote, the passage around it, what was said next, constraints and the rules', async () => {
  const s = await exSessions(); const map = exMap(); const l = layout(map);
  const b = makeBrief(map, l, s, 'redis');
  assert.match(b, /RESTART THIS THREAD: Redis cache layer/);
  assert.match(b, /Never pursued/);
  assert.match(b, /a cache layer such as Redis/);
  assert.match(b, /You, next \(H4\): "Agreed, hold off on multi-region/);
  assert.match(b, /Standing constraints:\n- Postgres/);
  assert.match(b, /Don't spend money/);
  assert.throws(() => makeBrief(map, l, s, 'nope'), /no node/);
});

test('the page escapes text from the map and the embedded JSON cannot close its script tag', async () => {
  const s = await exSessions(); const map = exMap();
  const evil = '</script><img src=x onerror=alert(1)>';
  map.title = evil; map.nodes[0].title = evil; map.nodes[3].note = evil; map.note = evil;
  const l = layout(map); const v = verifyQuotes(map, s);
  const briefs = { redis: makeBrief(map, l, s, 'redis') + evil };
  const html = renderHtml(map, l, s, v, briefs);
  assert.ok(!html.includes('<img src=x'));
  for (const id of ['tips', 'briefs']) {
    const data = html.split(`id="${id}">`)[1].split('</script>')[0];
    assert.doesNotThrow(() => JSON.parse(data));
  }
});

test('an unverified quote is drawn with a dashed outline and counted in the footer', async () => {
  const s = await exSessions(); const map = exMap(); map.nodes[1].quote = 'something nobody said';
  const l = layout(map); const v = verifyQuotes(map, s);
  const html = renderHtml(map, l, s, v, {});
  assert.match(html, /class="node st-decided big unver"/);
  assert.match(html, /<b>11 of 12<\/b> found/);
});

test('CLI: check fails on a bad quote, build writes map.html and advances the cursor, brief writes a file', () => {
  const dir = tmp('sm-cli-');
  fs.copyFileSync(path.join(EX_DIR, 'session.example.jsonl'), path.join(dir, 'session.example.jsonl'));
  const mapFile = path.join(dir, 'map.json');
  const map = exMap(); fs.writeFileSync(mapFile, JSON.stringify(map));
  const run = (...a) => execFileSync('node', [SCRIPT, ...a], { encoding: 'utf8' });
  assert.match(run('check', mapFile), /12 of 12/);
  assert.match(run('build', mapFile), /built .*map\.html/);
  assert.ok(fs.existsSync(path.join(dir, 'map.html')));
  assert.equal(JSON.parse(fs.readFileSync(mapFile, 'utf8')).cursor['example-session'], 11);
  const out = path.join(dir, 'briefs');
  assert.match(run('brief', mapFile, 'open', '--out', out), /brief-redis\.md/);
  assert.deepEqual(fs.readdirSync(out).sort(), ['brief-provider.md', 'brief-redis.md', 'brief-region.md', 'brief-sms.md', 'restart-part-1.md']);
  map.nodes[2].quote = 'invented'; fs.writeFileSync(mapFile, JSON.stringify(map));
  assert.throws(() => run('check', mapFile), (e) => e.status === 1 && /not found verbatim/.test(e.stdout));
});

test('CLI: digest --since-cursor prints only new turns and records what it covered', () => {
  const dir = tmp('sm-dig-');
  const file = path.join(dir, 'session.example.jsonl');
  fs.copyFileSync(path.join(EX_DIR, 'session.example.jsonl'), file);
  const mapFile = path.join(dir, 'map.json');
  const map = exMap(); map.cursor = { 'example-session': 9 }; fs.writeFileSync(mapFile, JSON.stringify(map));
  const out = path.join(dir, 'd');
  const text = execFileSync('node', [SCRIPT, 'digest', file, '--since-cursor', mapFile, '--out', out], { encoding: 'utf8' });
  assert.match(text, /digest from H10/);
  const d = fs.readFileSync(path.join(out, 'digest-001.txt'), 'utf8');
  assert.ok(d.includes('#### H10') && !d.includes('#### H9'));
  assert.equal(JSON.parse(fs.readFileSync(mapFile, 'utf8')).pending['example-session'], 11);
});

// ---------- tool calls (digest --with-tools) ----------

function toolSession() {
  const dir = tmp('sm-tools-'), f = path.join(dir, 'tools-session.jsonl');
  const L = (o) => JSON.stringify(o);
  fs.writeFileSync(f, [
    L({ type: 'user', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'ship the fix' } }),
    L({ type: 'assistant', timestamp: '2026-11-01T10:00:05Z', message: { role: 'assistant', content: [
      { type: 'text', text: 'Starting with the build.' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: "curl -H 'Authorization: " + ['Bear', 'er abc123def456ghi789jkl'].join('') + "' https://x.test && echo " + ['sk', '-live1234567890abcdefgh'].join('') } },
    ] } }),
    L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'Exit code 22: mail jane@example.com or call +1 415 555 0100' }] } }),
    L({ type: 'assistant', timestamp: '2026-11-01T10:00:09Z', message: { role: 'assistant', content: [
      { type: 'text', text: 'That failed, so I will write the config instead.' },
      { type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: '/tmp/app.env', content: 'API_KEY=supersecretvalue123456' } },
      { type: 'tool_use', id: 'tu3', name: 'Read', input: { file_path: '/tmp/ok.txt' } },
    ] } }),
    L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu3', content: 'a long successful output that must never appear' }] } }),
  ].join('\n') + '\n');
  return f;
}

test('parseSrc reads a tool-call id, only on Claude turns', () => {
  assert.deepEqual(parseSrc('A3.t2'), { sid: null, role: 'A', n: 3, tool: 2 });
  assert.deepEqual(parseSrc('abc:A3.t12'), { sid: 'abc', role: 'A', n: 3, tool: 12 });
  assert.equal(parseSrc('H3.t2'), null);
  assert.deepEqual(parseSrc('A3'), { sid: null, role: 'A', n: 3 });
});

test('tool calls are kept per turn: inputs only, failures with their error, nothing from successful output or written files, secrets redacted', async () => {
  const p = await parseTranscript(toolSession());
  assert.equal(p.turns.length, 1);
  const [bash, write, read] = p.turns[0].tools;
  assert.ok(bash.err && /Exit code 22/.test(bash.err));
  assert.ok(!/abc123def456|sk-live|jane@example|555 0100/.test(toolLine(bash)), toolLine(bash));
  assert.match(write.text, /\/tmp\/app\.env \(\d+ bytes written\)/);
  assert.ok(!/supersecret/.test(toolLine(write)));
  assert.equal(read.err, null);
  assert.ok(!/long successful output/.test(JSON.stringify(p.turns[0].tools)));
});

test('digest lists tool calls in order with their own ids only when asked', async () => {
  const p = await parseTranscript(toolSession());
  const off = digestChunks(p).join('');
  assert.ok(!/\[A1\.t1\]/.test(off));
  const on = digestChunks(p, { withTools: true }).join('');
  assert.ok(on.indexOf('[A1.t1]') > on.indexOf('Starting with the build.') && on.indexOf('[A1.t1]') < on.indexOf('[A1.t2]'));
  assert.ok(on.indexOf('That failed') > on.indexOf('[A1.t1]') && on.indexOf('That failed') < on.indexOf('[A1.t2]'));
  assert.match(on, /\[A1\.t1\] Bash: .*-> ERROR: Exit code 22/);
  assert.ok(!/abc123def456|supersecret|jane@example/.test(on));
});

test('a quote citing a tool call is checked against that call, not the prose', async () => {
  const p = await parseTranscript(toolSession());
  const sessions = { s: p };
  const map = M([N('a', { route: true, src: 'A1.t3', quote: 'Read: /tmp/ok.txt' }), N('b', { parent: 'a', src: 'A1.t1', quote: '-> ERROR: Exit code 22' }),
    N('c', { parent: 'a', src: 'A1.t2', quote: 'supersecretvalue' }), N('d', { parent: 'a', src: 'A1.t9', quote: 'Read' }), N('e', { parent: 'a', src: 'A1', quote: 'That failed, so I will write the config instead.' })]);
  assert.deepEqual(verifyQuotes(map, sessions), { a: true, b: true, c: false, d: false, e: true });
});

test('CLI: digest --with-tools writes the tool lines and reports the count', () => {
  const f = toolSession(), out = tmp('sm-tools-out-');
  const on = execFileSync('node', [SCRIPT, 'digest', f, '--out', out, '--with-tools'], { encoding: 'utf8' });
  assert.match(on, /3 tool call\(s\) included/);
  assert.match(fs.readFileSync(path.join(out, 'digest-001.txt'), 'utf8'), /\[A1\.t3\] Read: \/tmp\/ok\.txt/);
  const off = execFileSync('node', [SCRIPT, 'digest', f, '--out', out], { encoding: 'utf8' });
  assert.match(off, /not in the digest; add --with-tools/);
  assert.ok(!/\[A1\.t3\]/.test(fs.readFileSync(path.join(out, 'digest-001.txt'), 'utf8')));
});

test('redaction hides keys but leaves file names, paths and ids readable', async () => {
  const { redact } = await import('./session-map.mjs');
  const keep = 'cat ~/.claude/projects/-Users-sushanth/memory/project_markets_harness_2026_11_01.md --sid 56756f27-902d-4f61-af54-a4dabb6b3e59 /private/tmp/claude-501/scratchpad/session-map';
  assert.equal(redact(keep), keep);
  for (const bad of ['Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MFhZWmFiY2RlZg', 'api_key=hunter2hunter2', 'sk-ant-api03-AbCdEf123456', 'postgres://u:pw@host/db', 'a@b.co', '+1 415 555 0100'])
    assert.notEqual(redact(`x ${bad} y`), `x ${bad} y`, bad);
});
