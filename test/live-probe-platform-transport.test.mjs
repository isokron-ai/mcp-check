// R-LP-86: a package for another platform (npm notsup) and a transport we cannot run, each named for what it is.
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

const npmRec = (log) => ({ install: { kind: 'npm', ok: false, steps: [{ name: 'install', exit: 1, timed_out: false }], egress_refused: 0 }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false, _log: log });
const fd = (M, log) => M.failureDetail(npmRec(log), null, null, { stepsLog: log, launch: { kind: 'npm', package: 'x' }, argsUnfilled: 0, owned: true });
const LOGS = {
  // npm 10/11's words (anipottsbuilds/imessage-mcp, @mgcrea/mcp-apple-calendar, trsdn/mcp-server-uiautomation).
  ebad: 'npm error code EBADPLATFORM\nnpm error notsup Unsupported platform for imessage-mcp@1.4.0: wanted {"os":"darwin"} (current: {"os":"linux"})\n',
  valid: 'npm ERR! notsup Valid os:      darwin\nnpm ERR! notsup Actual os:     linux\n',
  cpu: 'npm error notsup Unsupported platform for uiautomation@2.0.1: wanted {"os":"win32","cpu":"x64,arm64"}\n',
};

test('R-LP-86: an npm package for another OS, CPU or libc is unsupported_platform (tool), never the package\'s install_failed', async () => {
  for (const [k, log] of Object.entries(LOGS)) assert.equal(fd(LP, log), 'unsupported_platform', k);
  assert.deepEqual(LP.DETAILS.unsupported_platform.slice(-1), ['tool']);
  // Still the package's own word where npm says it: a name that is not there.
  assert.equal(fd(LP, 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x - Not found\n'), 'install_failed', 'its own registry URL (R-LP-90)');
  assert.equal(fd(LP, 'npm error gyp ERR! build error\n'), 'install_build_failed');
  // Mutation check: without the rule npm's platform refusal is an install failure with no cause.
  const M = await mutant("    if (inst.kind === 'npm' && NPM_PLATFORM.test(text)) return 'unsupported_platform';\n", '');
  assert.equal(fd(M, LOGS.ebad), 'install_build_failed');
});

test('R-LP-86: a transport we cannot run says why (sse, no URL, a variable nothing declares, not loopback, no port); a URL whose variables the package declares is run', async () => {
  const T = (t, vars) => LP.transportOf(t, vars);
  assert.deepEqual(T({ type: 'sse', url: 'http://localhost:3001/sse' }), { detail: 'unsupported_transport', why: 'sse' });
  assert.deepEqual(T({ type: 'websocket' }), { detail: 'unsupported_transport', why: 'other' });
  assert.deepEqual(T({ type: 'streamable-http' }), { detail: 'unsupported_transport', why: 'no_url' });
  assert.deepEqual(T({ type: 'streamable-http', url: 'http://localhost:{port}/mcp' }), { detail: 'unsupported_transport', why: 'url_variable' });
  assert.deepEqual(T({ type: 'streamable-http', url: 'https://api.example.com/mcp' }), { detail: 'unsupported_transport', why: 'not_local' });
  assert.deepEqual(T({ type: 'streamable-http', url: 'http://localhost/mcp' }), { detail: 'unsupported_transport', why: 'no_port' });
  assert.deepEqual(T({ type: 'streamable-http', url: 'http://localhost:80/mcp' }), { detail: 'unsupported_transport', why: 'port_range' });
  assert.deepEqual(T({ type: 'streamable-http', url: 'http://localhost:3001/mcp' }), { transport: 'http', http: { port: 3001, path: '/mcp' } });
  // Derivable: the URL names a variable the package declares (an env default, a named argument's default or value).
  const pkg = (extra) => ({ registryType: 'npm', identifier: 'toolbox-mcp', version: '1.18.0', transport: { type: 'streamable-http', url: 'http://localhost:{port}/{path}' }, ...extra });
  const vars = LP.transportVars(pkg({ environmentVariables: [{ name: 'port', default: '5000' }, { name: 'TOKEN', isSecret: true, default: 'x' }], packageArguments: [{ type: 'named', name: '--path', default: 'mcp' }] }));
  assert.deepEqual(vars, { port: '5000', path: 'mcp' });
  assert.deepEqual(T(pkg().transport, vars), { transport: 'http', http: { port: 5000, path: '/mcp' } });
  assert.deepEqual(T(pkg().transport, { port: '50 00', path: 'mcp' }), { detail: 'unsupported_transport', why: 'url_variable' }, 'a value we would not put in a URL');
  // The URL's variables are the values the server gets: an env name's default (packageEnv passes no `value`).
  assert.deepEqual(LP.transportVars(pkg({ environmentVariables: [{ name: 'port', value: '7000', default: '5000' }] })), { port: '5000' });
  assert.deepEqual(LP.transportVars(pkg({ environmentVariables: [{ name: 'port', value: '7000' }] })), {}, 'a value packageEnv would not pass is no variable');
  const r = await LP.launchFor(pkg({ environmentVariables: [{ name: 'port', default: '5000' }], packageArguments: [{ type: 'named', name: '--path', default: 'mcp' }] }));
  assert.deepEqual([r.launch.transport, r.launch.http], ['http', { port: 5000, path: '/mcp' }]);
  // The resolver records each refusal and its reason (raw/resolution.json, transport_refused).
  const reg = async (url) => {
    const u = new URL(url);
    if (u.hostname !== 'registry.modelcontextprotocol.io') throw new Error('unexpected fetch ' + url);
    const body = JSON.stringify({ servers: [{ server: { name: 'io.github.acme/mem', version: '1.0.0', repository: { url: 'https://github.com/acme/mem', source: 'github' }, packages: [{ registryType: 'npm', identifier: 'mem-mcp', version: '1.0.0', transport: { type: 'sse', url: 'http://localhost:3001/sse' } }] } }] });
    return { status: 200, ok: true, headers: { get: () => String(body.length) }, arrayBuffer: async () => Buffer.from(body) };
  };
  const s = await LP.resolveSubject({ subject: 'acme/mem', repo: 'acme/mem' }, { fetch: reg });
  assert.deepEqual([s.detail, s.transport_refused], ['unsupported_transport', [{ identifier: 'mem-mcp', type: 'sse', why: 'sse' }]]);
  // Mutation check: without the variables a declared port leaves the server unrun.
  const M = await mutant('  const tr = transportOf(pkg.transport, transportVars(pkg));', '  const tr = transportOf(pkg.transport);');
  assert.equal((await M.launchFor(pkg({ environmentVariables: [{ name: 'port', default: '5000' }], packageArguments: [{ type: 'named', name: '--path', default: 'mcp' }] }))).detail, 'unsupported_transport');
});
