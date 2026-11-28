// R-LP-81: one retry with a changed launch for a start failure that change tests (an MCP SDK that floated to 2.x).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as LP from '../corpus/live-probe.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const FX = join(root, 'test', 'fixtures', 'live-probe');
const fx = (f) => readFileSync(join(FX, f), 'utf8');
const MARKER = 'liveprobe-MARKERMARKERMARKER0000';

/** corpus/live-probe.mjs with `from` replaced by `to`, imported fresh (a mutation check). */
async function mutant(from, to) {
  const src = readFileSync(join(root, 'corpus', 'live-probe.mjs'), 'utf8');
  assert.ok(src.includes(from), 'the mutation text is in corpus/live-probe.mjs: ' + from.slice(0, 80));
  const out = join(root, 'corpus', '.mutant-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
  writeFileSync(out, src.replace(from, to));
  try { return await import(pathToFileURL(out).href); } finally { rmSync(out, { force: true }); }
}

/** A work folder as corpus/live-probe-sandbox.sh leaves it, from the fixtures. */
function workFolder({ marker = MARKER, selftestRc = 0, items: its = null, swept = true, subjectsRc = 0, known = 'probe-known.json', drop = [], left = {} } = {}) {
  const w = mkdtempSync(join(tmpdir(), 'live-probe-test-'));
  const put = (p, s) => { mkdirSync(join(w, p, '..'), { recursive: true }); writeFileSync(join(w, p), typeof s === 'string' ? s : JSON.stringify(s)); };
  const rk = (c) => c.repeat(64);
  const resolution = (type) => ({ status: 'runnable', detail: null, registry: { name: 'io.github.isokron-ai/mcp-check', version: '1.3.1', entries: 1, transports: ['stdio'], remotes: 0 }, choice: { type, identifier: '@isokron/mcp-check', version: '1.3.1', transport: 'stdio', runtime_hint: 'npx', args_n: 1, args_unfilled: 0, env_names: [], oci_digest: null, purl: 'pkg:npm/%40isokron/mcp-check@1.3.1', matched_by: 'repository+namespace+seed', verified_by: 'seed' }, candidates: [], launch: { kind: 'npm' }, subdir: null, seed_packages: 1 });
  const plan = {
    format: LP.PLAN_FORMAT, shard_id: 's', attempt_id: 'attempt-1', marker, planned_at: '2026-11-23T10:00:00.000Z', subject_timeout_s: 147, runnable: 3,
    items: its || [
      { index: 0, subject: 'isokron-ai/mcp-check', repo: 'isokron-ai/mcp-check', run_key: rk('1'), fence: 1, target_id: 's001', resolution: resolution('npm'), resolve_ms: 120 },
      { index: 1, subject: 'isokron-ai/kronicle-lite', repo: 'isokron-ai/kronicle-lite', run_key: rk('2'), fence: 2, target_id: 's002', resolution: resolution('npm'), resolve_ms: 80 },
      { index: 2, subject: 'isokron-ai/tool-qa', repo: 'isokron-ai/tool-qa', run_key: rk('3'), fence: 3, target_id: null, resolution: { status: 'skipped', detail: 'no_package', registry: null, choice: null, candidates: [], launch: null, subdir: null, seed_packages: 0 }, resolve_ms: 50 },
      { index: 3, subject: 'acme/late', repo: 'acme/late', run_key: rk('4'), fence: 4, target_id: 's004', resolution: resolution('npm'), resolve_ms: 50 },
    ],
  };
  put('plan.json', plan);
  put('sandbox.json', { install_rc: 0, guard_rc: 0, selftest_rc: 0, selftest_check_rc: selftestRc, controls_rc: 0, subjects_rc: subjectsRc, swept, left: { labelled: 0, containers: 0, volumes: 0, uid_65534_processes: swept ? 0 : 1, runsc_processes: 0, ...left }, msc_commit: '3b43c19a3b84950732379ea5beee06a8f73512a6', gvisor_release: '20261103', worker_kit_ref: 'b1f25a9b0b7655f45eb353f31562a93d9319d5a4' });
  put('selftest/results.json', { format: 'x', cases: ['direct-ip', 'doh-ip', 'output-forgery'].map((c) => ({ case: c, blocked: true, logged: true, pass: true })), passed: 3, total: 3 });
  const forgery = fx('probe-forgery.json').split('liveprobe-MARKERMARKERMARKER0000').join(marker);
  put('driver-controls/s901/probe-bare.json', fx(known));
  put('driver-controls/s901/record.json', fx('record-ok.json'));
  put('driver-controls/s902/probe-bare.json', forgery);
  put('driver-controls/s902/record.json', JSON.parse(fx('record-ok.json')));
  put('driver-controls/_shard/telemetry.jsonl', '');
  put('driver-subjects/_shard/shard.json', { runner: { os: 'linux', arch: 'x64', kernel: '6.11.0-1018-azure', node: 'v22.21.0', docker: '28.0.4', container_platform: 'linux/amd64' } });
  put('driver-subjects/_shard/telemetry.jsonl', fx('telemetry.jsonl'));
  put('driver-subjects/s001/record.json', fx('record-ok.json'));
  put('driver-subjects/s001/probe-bare.json', fx('probe-known.json'));
  put('driver-subjects/s001/static.json', fx('static-known.json'));
  put('driver-subjects/s001/steps.log', 'npm install ...\n');
  // kronicle-lite: installed, then exited before answering (a native module was not built).
  const rec2 = JSON.parse(fx('record-ok.json')); rec2.layers.live = false;
  put('driver-subjects/s002/record.json', rec2);
  put('driver-subjects/s002/probe-bare.json', { format: 'isokron-surface-probe/1', era: null, initialize: null, error: 'the server exited before answering', lists: {}, transport: { exit: 1 }, timing: { total_ms: 2000 } });
  for (const p of drop) { try { writeFileSync(join(w, p), ''); } catch { /* */ } }
  return w;
}

// The drift as the lane saw it (run 45796339215 item 6): pip resolved mcp>=1.25 to mcp 2.3.0.
const DRIFT_ERR = 'Traceback (most recent call last):\n  File "/work/venv/bin/frontend-design-loop-mcp", line 5, in <module>\n    from fdl.server import main\n  File "/work/venv/lib/python3.13/site-packages/fdl/server.py", line 3, in <module>\n    from mcp.server.fastmcp import FastMCP\nModuleNotFoundError: No module named \'mcp.server.fastmcp\'. This is mcp 2.x: FastMCP moved to the mcp-server package.\n';
const PYDEPS = { top: ['fdl'], base: ['mcp', 'httpx'], uncapped: ['mcp', 'httpx'], extra_only: [], extras: [] };
const pyItem = (o = {}) => ({ index: 1, subject: 'alexalexalex222/frontend-design-loop-mcp', repo: 'alexalexalex222/frontend-design-loop-mcp', target_id: 's002', target: { id: 's002', repo: 'alexalexalex222/frontend-design-loop-mcp', ref: 'HEAD', launch: { kind: 'pypi', package: 'frontend-design-loop-mcp', version: '0.4.0', entry: 'frontend-design-loop-mcp', ...(o.launch || {}) } }, resolution: { status: 'runnable', choice: { type: 'pypi', pydeps: o.pydeps === undefined ? PYDEPS : o.pydeps, args_n: 0, args_unfilled: 0, env_names: [], matched_by: 'repository+namespace' } } });
const okRec = { install: { kind: 'pypi', ok: true, steps: [{ name: 'install', exit: 0 }] }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 30000 }, timed_out: false };
const crashed = (err = DRIFT_ERR) => ({ format: 'isokron-surface-probe/1', era: null, initialize: null, initialize_error: 'the server exited (exit 1, signal null)', lists: {}, transport: { exit: 1, signal: null }, stderr: err, timing: { total_ms: 2500 } });

test('R-LP-81: a PyPI server that failed on an import the MCP SDK 2.x removed gets one retry with mcp<2; nothing else does', () => {
  assert.deepEqual(LP.retryFor(pyItem(), { rec: okRec, bare: crashed() }), { reason: 'mcp_drift', change: { constraints: ['mcp<2'] } });
  // The other shapes of the same drift: a name or attribute of mcp that 2.x no longer has.
  for (const e of ["ImportError: cannot import name 'FastMCP' from 'mcp.server'\n", "AttributeError: module 'mcp.types' has no attribute 'ToolAnnotations'\n"]) assert.equal(LP.retryFor(pyItem(), { rec: okRec, bare: crashed(e) }).reason, 'mcp_drift', e);
  // No retry: a list came; the install failed; not PyPI; another module; mcp capped by the release; already capped by us.
  const listedP = { ...crashed(), lists: { 'tools/list': { ok: true, raw_pages: ['{"tools":[]}'] } } };
  assert.equal(LP.retryFor(pyItem(), { rec: okRec, bare: crashed(), envp: listedP }), null);
  assert.equal(LP.retryFor(pyItem(), { rec: { ...okRec, install: { kind: 'pypi', ok: false, steps: [] } }, bare: crashed() }), null);
  assert.equal(LP.retryFor({ ...pyItem(), target: { id: 's002', launch: { kind: 'npm', package: 'x' } } }, { rec: okRec, bare: crashed() }), null);
  assert.equal(LP.retryFor(pyItem(), { rec: okRec, bare: crashed("ModuleNotFoundError: No module named 'pydantic_settings'\n") }), null);
  assert.equal(LP.retryFor(pyItem({ pydeps: { ...PYDEPS, uncapped: ['httpx'] } }), { rec: okRec, bare: crashed() }), null, 'a release that caps mcp cannot have floated');
  assert.equal(LP.retryFor(pyItem({ pydeps: null }), { rec: okRec, bare: crashed() }).reason, 'mcp_drift', 'no facts: it may have');
  assert.equal(LP.retryFor(pyItem({ launch: { constraints: ['mcp<1.20'] } }), { rec: okRec, bare: crashed() }), null);
  assert.deepEqual(LP.retryLaunch({ kind: 'pypi', package: 'x', constraints: ['anyio<5'] }, { constraints: ['mcp<2'] }).constraints, ['anyio<5', 'mcp<2']);
});

test('R-LP-81: the retries are planned from the first runs, each target checked by the sandbox; the bundle uses a retry that lists tools, and a failed retry leaves the first cause and its fault; both runs are kept', async () => {
  const listedProbe = JSON.parse(fx('probe-known.json'));
  const w = workFolder({ items: [
    { index: 0, subject: 'isokron-ai/mcp-check', repo: 'isokron-ai/mcp-check', run_key: '1'.repeat(64), fence: 1, target_id: 's001', target: { id: 's001', repo: 'isokron-ai/mcp-check', ref: 'HEAD', launch: { kind: 'npm', package: '@isokron/mcp-check', version: '1.3.1' } }, resolution: { status: 'runnable', detail: null, registry: null, choice: { type: 'npm', identifier: '@isokron/mcp-check', version: '1.3.1', transport: 'stdio', args_n: 0, args_unfilled: 0, env_names: [], matched_by: 'repository+namespace', verified_by: 'namespace' }, candidates: [], launch: { kind: 'npm', package: '@isokron/mcp-check', version: '1.3.1' }, subdir: null, seed_packages: 0 }, resolve_ms: 10 },
    { ...pyItem(), run_key: '2'.repeat(64), fence: 2, resolve_ms: 10, resolution: { ...pyItem().resolution, detail: null, registry: null, candidates: [], launch: pyItem().target.launch, subdir: null, seed_packages: 0, choice: { ...pyItem().resolution.choice, identifier: 'frontend-design-loop-mcp', version: '0.4.0', transport: 'stdio', verified_by: 'namespace' } } },
    { ...pyItem(), index: 2, subject: 'acme/also-drifts', repo: 'acme/also-drifts', run_key: '3'.repeat(64), fence: 3, target_id: 's003', target: { ...pyItem().target, id: 's003', repo: 'acme/also-drifts' }, resolve_ms: 10, resolution: { ...pyItem().resolution, detail: null, registry: null, candidates: [], launch: pyItem().target.launch, subdir: null, seed_packages: 0, choice: { ...pyItem().resolution.choice, identifier: 'frontend-design-loop-mcp', version: '0.4.0', transport: 'stdio', verified_by: 'namespace' } } },
  ] });
  const put = (p, s) => { mkdirSync(join(w, p, '..'), { recursive: true }); writeFileSync(join(w, p), typeof s === 'string' ? s : JSON.stringify(s)); };
  const plan = JSON.parse(readFileSync(join(w, 'plan.json'), 'utf8'));
  put('targets-subjects.json', { format: LP.TARGETS_FORMAT, targets: plan.items.map((x) => x.target) });
  for (const id of ['s002', 's003']) { put(`driver-subjects/${id}/record.json`, okRec); put(`driver-subjects/${id}/probe-bare.json`, crashed()); put(`driver-subjects/${id}/steps.log`, 'Collecting mcp>=1.25.0\n  Downloading mcp-2.3.0-py3-none-any.whl\n'); }
  // The sandbox's own check refuses nothing here; one that refused a target would leave it out.
  const seen = [];
  const retries = LP.planRetries({ work: w, validateTarget: (t) => { seen.push(t.id); if (t.launch.constraints.at(-1) !== 'mcp<2') throw new Error('x'); } });
  assert.deepEqual(retries.map((x) => [x.id, x.reason]), [['s002', 'mcp_drift'], ['s003', 'mcp_drift']]);
  assert.deepEqual(seen, ['s002', 's003']);
  const list = JSON.parse(readFileSync(join(w, 'targets-retry.json'), 'utf8'));
  assert.deepEqual(list.targets.map((t) => [t.id, t.launch.constraints]), [['s002', ['mcp<2']], ['s003', ['mcp<2']]]);
  assert.equal(LP.planRetries({ work: w, validateTarget: () => { throw new Error('refused'); } }).length, 0, 'a target the sandbox refuses is not retried');
  LP.planRetries({ work: w });
  // The retries ran: s002 listed tools with mcp<2; s003 failed again.
  put('driver-retry/s002/record.json', JSON.parse(fx('record-ok.json')));
  put('driver-retry/s002/probe-bare.json', listedProbe);
  put('driver-retry/s002/steps.log', 'Collecting mcp<2\n  Downloading mcp-1.26.0-py3-none-any.whl\n');
  put('driver-retry/s003/record.json', okRec);
  put('driver-retry/s003/probe-bare.json', crashed("Traceback (most recent call last):\n  File \"/work/venv/lib/python3.13/site-packages/fdl/server.py\", line 9, in <module>\nKeyError: 'x'\n"));
  put('driver-retry/_shard/telemetry.jsonl', '');
  const summary = LP.bundleShard({ work: w });
  assert.deepEqual(summary.map((s) => [s.status, s.detail]), [['graded', null], ['graded', null], ['skipped', 'start_dependency_drift']]);
  const result = (i) => JSON.parse(readFileSync(join(w, 'out', String(i), 'bundle', LP.RESULT_PATH), 'utf8'));
  assert.deepEqual(result(1).retry, { reason: 'mcp_drift', change: { constraints: ['mcp<2'] }, ran: true, listed: true, detail: null });
  // The install the result describes says what ran differs from the plan (data honesty); the observation is behind
  // EMIT_LAUNCH_RETRY_FIELD until tool-qa's pinned registry declares launch_retry.
  assert.deepEqual(result(1).install.retry, { reason: 'mcp_drift', change: { constraints: ['mcp<2'] } });
  assert.equal(LP.EMIT_LAUNCH_RETRY_FIELD, false);
  const obsOf = (i) => readFileSync(join(w, 'out', String(i), 'bundle', 'observations', 'live.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(!obsOf(1).some((o) => o.field === 'launch_retry'));
  assert.ok(existsSync(join(w, 'out', '1', 'bundle', 'raw', 'first', 'probe-bare.json')), 'the first run is kept');
  assert.match(readFileSync(join(w, 'out', '1', 'bundle', 'raw', 'steps.txt'), 'utf8'), /mcp-1\.26\.0/, 'the item is the retry\'s run');
  // The failed retry: the first cause and its fault stand (tool); the retry's own detail is recorded.
  const r3 = result(2);
  assert.deepEqual([r3.detail, r3.fault, r3.retry.listed, r3.retry.ran], ['start_dependency_drift', 'tool', false, true]);
  assert.equal(typeof r3.retry.detail, 'string');
  assert.ok(existsSync(join(w, 'out', '2', 'bundle', 'raw', 'retry', 'probe-bare.json')), 'the retry is kept');
  assert.equal(result(0).retry, undefined, 'no retry, no field');
  // A retry.json that is not ours is ignored (the first runs stand).
  writeFileSync(join(w, 'retry.json'), JSON.stringify({ format: LP.RETRY_FORMAT, retries: [{ id: 's002', reason: 'other', change: { constraints: ['mcp<2'] } }, { id: 's003', reason: 'mcp_drift', change: { constraints: ['--index-url=https://evil'] } }] }));
  assert.deepEqual(LP.retriesOf(join(w, 'retry.json')), {});
  // Mutation checks: without the retry in the bundle step, the drifted server that lists tools under mcp<2 stays skipped.
  const M = await mutant("    const retry = !oci && !build && !listed(envp) && !listed(bare) && isObj(ctx.retries) ? ctx.retries[item.target_id] : null;", '    const retry = null;');
  LP.planRetries({ work: w });
  assert.deepEqual(M.bundleShard({ work: w }).map((s) => s.detail), [null, 'start_dependency_drift', 'start_dependency_drift']);
  // ...and without the cap check a release that caps mcp would be retried with a second, conflicting cap.
  const C = await mutant("  if (cons.length >= 10 || cons.some((c) => /^mcp\\s*[<>=~!]/i.test(String(c)))) return null;\n", '');
  assert.equal(C.retryFor(pyItem({ launch: { constraints: ['mcp<1.20'] } }), { rec: okRec, bare: crashed() }).reason, 'mcp_drift');
});

test('R-LP-81: the sandbox script plans and runs the retries after every first run, within the deadline, and records retry_rc', () => {
  const sh = readFileSync(join(root, 'corpus', 'live-probe-sandbox.sh'), 'utf8');
  const at = (re) => { const m = re.exec(sh); assert.ok(m, String(re)); return m.index; };
  const oci = at(/\n# 4b\. OCI subjects/); const retry = at(/\n# 4c\. One retry/); const sweep = at(/\n# 5\. Nothing of a target/);
  assert.ok(oci < retry && retry < sweep);
  assert.match(sh, /node "\$here\/live-probe\.mjs" retry "\$work" --msc "\$msc"/);
  assert.match(sh, /drive "\$work\/targets-retry\.json" "\$work\/driver-retry" "\$left" <\/dev\/null; retry_rc=\$\?/);
  assert.match(sh, /retry_rc: n\(v\[17\]\)/);
});

test('R-LP-81: the MCP SDK\'s own "This is mcp 2.x" is drift (tool) before any crash check, and once a retry is planned the first run is never the server\'s fault', async () => {
  // A traceback with the SDK's message and no import line we can read: drift, not start_failed.
  const msg = 'Traceback (most recent call last):\n  File "/work/venv/bin/x-mcp", line 8, in <module>\n    sys.exit(main())\nRuntimeError: FastMCP is gone. This is mcp 2.x; pin mcp<2 or move to mcp-server.\n';
  const ctx = { launch: pyItem().target.launch, argsUnfilled: 0, owned: true, pydeps: PYDEPS };
  assert.equal(LP.failureDetail(okRec, crashed(msg), null, ctx), 'start_dependency_drift');
  assert.deepEqual(LP.DETAILS.start_dependency_drift.slice(-1), ['tool']);
  const M = await mutant("  if (on('drift') && (imp === 'drift' || MCP2_TEXT.test(err))) return 'start_dependency_drift';", "  if (on('drift') && imp === 'drift') return 'start_dependency_drift';");
  assert.equal(M.failureDetail(okRec, crashed(msg), null, ctx), 'start_failed', 'without the rule the SDK\'s own message is the server\'s crash');
  // A first run whose detail alone would be the server's (start_failed), with a retry planned that did not list: tool.
  const panic = "Traceback (most recent call last):\n  File \"/work/venv/bin/frontend-design-loop-mcp\", line 5, in <module>\nKeyError: 'port'\n";
  const it = { ...pyItem(), index: 0, run_key: '1'.repeat(64), fence: 1, resolve_ms: 1, resolution: { ...pyItem().resolution, detail: null, registry: null, candidates: [], launch: pyItem().target.launch, subdir: null, seed_packages: 0, choice: { ...pyItem().resolution.choice, identifier: 'frontend-design-loop-mcp', version: '0.4.0', transport: 'stdio', verified_by: 'namespace' } } };
  const w = workFolder({ items: [it] });
  const put = (p, x) => { mkdirSync(join(w, p, '..'), { recursive: true }); writeFileSync(join(w, p), typeof x === 'string' ? x : JSON.stringify(x)); };
  put('driver-subjects/s002/record.json', okRec); put('driver-subjects/s002/probe-bare.json', crashed(panic));
  assert.equal(LP.failureDetail(okRec, crashed(panic), null, ctx), 'start_failed', 'alone, this first run would be the server\'s');
  put('retry.json', { format: LP.RETRY_FORMAT, retries: [{ id: 's002', reason: 'mcp_drift', change: { constraints: ['mcp<2'] } }] });
  put('driver-retry/s002/record.json', okRec); put('driver-retry/s002/probe-bare.json', crashed(panic)); put('driver-retry/_shard/telemetry.jsonl', '');
  const [one] = LP.bundleShard({ work: w });
  const res = JSON.parse(readFileSync(join(w, 'out', '0', 'bundle', LP.RESULT_PATH), 'utf8'));
  assert.deepEqual([one.detail, res.fault, res.retry.first_detail], ['start_dependency_drift', 'tool', 'start_failed']);
  // Mutation checks: without the guard the planned retry's first run is the server's fault; switched on, the
  // launch_retry observation is written for a retry whose run is the item's.
  const G = await mutant("      if (retry && (DETAILS[detail] || [])[3] === 'subject') { result.retry.first_detail = detail; detail = retry.reason === 'mcp_drift' ? 'start_dependency_drift' : 'start_env_limited'; }", '');
  assert.equal(G.bundleShard({ work: w })[0].detail, 'start_failed');
  const On = await mutant('export const EMIT_LAUNCH_RETRY_FIELD = false;', 'export const EMIT_LAUNCH_RETRY_FIELD = true;');
  put('driver-retry/s002/record.json', JSON.parse(fx('record-ok.json'))); put('driver-retry/s002/probe-bare.json', JSON.parse(fx('probe-known.json')));
  On.bundleShard({ work: w });
  const o = readFileSync(join(w, 'out', '0', 'bundle', 'observations', 'live.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.field === 'launch_retry');
  assert.deepEqual(o.value, { reason: 'mcp_drift', change: { constraints: ['mcp<2'] } });
});
