// R-LP-82: the console script the registry names, or a package's only one, is run; our pick is never evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as LP from '../corpus/live-probe.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));

/** corpus/<file> with `from` replaced by `to`, imported fresh (a mutation check). */
async function mutant(from, to, file = 'live-probe.mjs') {
  const src = readFileSync(join(root, 'corpus', file), 'utf8');
  assert.ok(src.includes(from), 'the mutation text is in corpus/' + file + ': ' + from.slice(0, 80));
  const out = join(root, 'corpus', '.mutant-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
  writeFileSync(out, src.replace(from, to));
  try { return await import(pathToFileURL(out).href); } finally { rmSync(out, { force: true }); }
}
import { deflateRawSync } from 'node:zlib';
import * as PE from '../corpus/pypi-entry.mjs';
// A minimal zip writer: [{ name, data, deflate }].
function zip(entries) {
  const locals = []; const cds = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name); const raw = Buffer.from(e.data ?? '');
    const body = e.deflate ? deflateRawSync(raw) : raw; const method = e.deflate ? 8 : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(e.csize ?? body.length, 20); ch.writeUInt32LE(e.usize ?? raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(e.offset ?? off, 42);
    locals.push(lh, name, body); cds.push(ch, name); off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(cds); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
// pypiEntry's answer without its dependency facts (R-LP-61 reads those).
const nd = ({ deps, ...r }) => r;
const EP = (lines) => '[console_scripts]\n' + lines.join('\n') + '\n\n[other]\nnot-a-script = x:y\n';
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))) });
function pypiFetch({ pkg = 'widget-mcp', version = '1.0.0', wheel, files, status = 200 } = {}) {
  const url = 'https://files.pythonhosted.org/packages/aa/widget_mcp-1.0.0-py3-none-any.whl';
  const calls = [];
  const f = async (u) => {
    calls.push(String(u));
    if (String(u).startsWith('https://pypi.org/pypi/' + pkg)) return status === 200 ? res(200, { info: { version }, urls: files ?? [{ packagetype: 'bdist_wheel', url, filename: 'widget_mcp-1.0.0-py3-none-any.whl', size: wheel ? wheel.length : 0 }] }) : res(status, {});
    if (String(u) === url) return res(200, wheel);
    throw new Error('unexpected fetch ' + u);
  };
  f.calls = calls; return f;
}

const wheelOf = (scripts) => zip([{ name: 'widget_mcp/__init__.py', data: '' }, { name: 'widget_mcp-1.0.0.dist-info/entry_points.txt', data: EP(scripts), deflate: true }]);
const server = (args) => ({ name: 'io.github.acme/widget', repository: { url: 'https://github.com/acme/widget' }, packages: [{ registryType: 'pypi', identifier: 'widget-mcp', version: '1.0.0', transport: { type: 'stdio' }, ...(args ? { packageArguments: args } : {}) }] });
const world = (wheel, args) => { const pf = pypiFetch({ wheel }); return async (u, init) => (new URL(u).hostname === 'registry.modelcontextprotocol.io' ? res(200, { servers: [{ server: server(args) }] }) : pf(u, init)); };
const resolve = (M, wheel, args) => M.resolveSubject({ subject: 'acme/widget', repo: 'acme/widget' }, { fetch: world(wheel, args) });

test('R-LP-82: the registry\'s first package argument names the console script (datasentry); a package\'s only script is run (bawbel); neither pick is ever evidence against the server', async () => {
  // The publisher's launch: `<script> <rest>` among several scripts.
  const three = [['datasentry', 'ds.cli:main'], ['datasentry-demo', 'ds.demo:main'], ['datasentry-server', 'ds.web:main']];
  assert.deepEqual(PE.scriptChoice(three, 'widget-mcp', ['datasentry', 'mcp']), { entry: 'datasentry', drop: 1, source: 'registry_args' });
  assert.equal(PE.scriptChoice(three, 'widget-mcp', ['nope']), null, 'an argument that names no script is no choice');
  // A package's only script: run even with no server signal in its name, but marked as our pick.
  assert.deepEqual(PE.scriptChoice([['bawbel', 'bawbel.cli:main']], 'bawbel-scanner'), { entry: 'bawbel', drop: 0, source: 'lone_script' });
  assert.deepEqual(PE.scriptChoice([['widget-server', 'w.server:main']], 'widget-mcp'), { entry: 'widget-server', drop: 0, source: 'console_script' });
  // Through resolveSubject: the entry takes the argument that named it; the rest stay.
  let r = await resolve(LP, wheelOf(['datasentry = ds.cli:main', 'datasentry-demo = ds.demo:main', 'datasentry-server = ds.web:main']), [{ type: 'positional', value: 'datasentry' }, { type: 'positional', value: 'mcp' }]);
  assert.deepEqual([r.launch.entry, r.launch.args, r.choice.entry_source], ['datasentry', ['mcp'], 'registry_args']);
  r = await resolve(LP, wheelOf(['datasentry = ds.cli:main', 'datasentry-demo = ds.demo:main']), [{ type: 'positional', value: 'datasentry' }]);
  assert.deepEqual([r.launch.entry, r.launch.args], ['datasentry', undefined], 'no args left: none passed');
  r = await resolve(LP, wheelOf(['bawbel = bawbel.cli:main']));
  assert.deepEqual([r.launch.entry, r.choice.entry_source], ['bawbel', 'lone_script']);
  // A crash of our pick is no evidence; of the registry's or a signalled script, it is.
  const rec = { install: { kind: 'pypi', ok: true, steps: [{ name: 'install', exit: 0 }] }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false };
  const crash = { initialize_error: 'the server exited (exit 1, signal null)', lists: {}, transport: { exit: 1, signal: null }, timing: { total_ms: 2000 }, stderr: 'Traceback (most recent call last):\n  File "/work/venv/bin/bawbel", line 8, in <module>\nTypeError: unsupported operand\n' };
  const launch = { kind: 'pypi', package: 'bawbel-scanner', entry: 'bawbel' };
  assert.equal(LP.failureDetail(rec, crash, null, { launch, argsUnfilled: 0, entryGuess: true }), 'start_env_limited');
  assert.equal(LP.failureDetail(rec, crash, null, { launch, argsUnfilled: 0 }), 'start_failed');
  // Both our picks are guesses for blame: a lone script, and the script read from the registry's first argument
  // (`uvx <package> <args>` passes them to the package's own script, so args[0] naming a script is our reading).
  assert.deepEqual(['lone_script', 'registry_args', 'console_script', 'module_main'].map((x) => LP.entryGuessOf({ entry_source: x })), [true, true, false, false]);
  const viaArgs = await resolve(LP, wheelOf(['datasentry = ds.cli:main', 'datasentry-demo = ds.demo:main']), [{ type: 'positional', value: 'datasentry' }]);
  assert.equal(LP.failureDetail(rec, crash, null, { launch: viaArgs.launch, argsUnfilled: 0, entryGuess: LP.entryGuessOf(viaArgs.choice) }), 'start_env_limited', 'a registry_args pick that crashes is never start_failed');
  // Mutation checks: without the registry rule the datasentry package is ambiguous (the package-name guess runs);
  // without the lone rule bawbel's only script is not run; without the guess flag its crash would be the server's.
  let M = await mutant("  if (first && BIN.test(first)) { const named = scripts.find(([n]) => n === first); if (named) return { entry: named[0], drop: 1, source: 'registry_args' }; }\n", '', 'pypi-entry.mjs');
  assert.equal(M.scriptChoice(three, 'widget-mcp', ['datasentry', 'mcp']), null);
  M = await mutant("  if (scripts.length === 1) return { entry: scripts[0][0], drop: 0, source: 'lone_script' };\n", '', 'pypi-entry.mjs');
  assert.equal(M.scriptChoice([['bawbel', 'bawbel.cli:main']], 'bawbel-scanner'), null);
  M = await mutant("export const ENTRY_GUESS_SOURCES = Object.freeze(['lone_script', 'registry_args']);", "export const ENTRY_GUESS_SOURCES = Object.freeze(['lone_script']);");
  assert.equal(M.entryGuessOf({ entry_source: 'registry_args' }), false, 'without registry_args in the list its crash would count');
  M = await mutant("(launch.kind === 'pypi' && (!launch.entry || entryGuess))", "(launch.kind === 'pypi' && !launch.entry)");
  assert.equal(M.failureDetail(rec, crash, null, { launch, argsUnfilled: 0, entryGuess: true }), 'start_failed');
});

test('R-LP-82: through buildItem, a crash of our entry pick (lone_script, registry_args) is start_env_limited; of the publisher\'s own console script it is start_failed', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const rec = { install: { kind: 'pypi', ok: true, steps: [{ name: 'install', exit: 0 }] }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false };
  const crash = { initialize_error: 'the server exited (exit 1, signal null)', lists: {}, transport: { exit: 1, signal: null }, timing: { total_ms: 2000 }, stderr: 'Traceback (most recent call last):\n  File "/work/venv/bin/bawbel", line 8, in <module>\nTypeError: unsupported operand\n' };
  const detailOf = (M, source) => {
    const out = mkdtempSync(join(tmpdir(), 'lp-buildItem-'));
    try {
      mkdirSync(join(out, 's001'), { recursive: true });
      writeFileSync(join(out, 's001', 'record.json'), JSON.stringify(rec));
      writeFileSync(join(out, 's001', 'probe-bare.json'), JSON.stringify(crash));
      const launch = { kind: 'pypi', package: 'bawbel-scanner', entry: 'bawbel' };
      const item = { subject: 'acme/bawbel', target_id: 's001', target: { id: 's001', launch }, resolution: { status: 'runnable', launch, choice: { type: 'pypi', entry_source: source, args_unfilled: 0, env_names: [] } } };
      const ctx = { subjectsOut: out, subjectsTelemetry: join(out, 'none.jsonl'), deadlineHit: false, retries: {}, sandboxSummary: null, state: {}, plan: { items: [] } };
      return M.buildItem(item, ctx).detail;
    } finally { rmSync(out, { recursive: true, force: true }); }
  };
  // The same crash: ours for a pick of ours, the server's for the publisher's own script.
  assert.equal(detailOf(LP, 'lone_script'), 'start_env_limited');
  assert.equal(detailOf(LP, 'registry_args'), 'start_env_limited');
  assert.equal(detailOf(LP, 'console_script'), 'start_failed');
  // Mutation: the guard at buildItem's call, entryGuess: entryGuessOf(r.choice), replaced by false (whatever follows it in the call): our pick's crash is the server's.
  const M = await mutant('entryGuess: entryGuessOf(r.choice)', 'entryGuess: false');
  assert.equal(detailOf(M, 'lone_script'), 'start_failed', 'without the guard a lone_script crash blames the server');
  assert.equal(detailOf(M, 'registry_args'), 'start_failed');
});
