// R-LP-90: an npm or PyPI install failure is the package's own only on the installer's word about that very package.
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

const rec = (kind) => ({ install: { kind, ok: false, steps: [{ name: 'install', exit: 1, timed_out: false }], egress_refused: 0 }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false });
const PY = { kind: 'pypi', package: 'Acme_MCP', version: '1.2.0', extras: ['mcp'] };
const GONE = { found: false, files: 0 };
const THERE = { found: true, files: 3 };
const fd = (M, kind, log, o = {}) => M.failureDetail(rec(kind), null, null, { stepsLog: log, launch: kind === 'pypi' ? PY : { kind: 'npm', package: '@acme/mcp' }, owned: true, pypiRelease: GONE, ...o });
// The three cases reproduced on 27 Nov, in pip's own words.
const REQUIRES_PYTHON = 'ERROR: Ignored the following versions that require a different python version: 1.2.0 Requires-Python >=3.14\nERROR: Could not find a version that satisfies the requirement acme-mcp==1.2.0 (from versions: none)\nERROR: No matching distribution found for acme-mcp==1.2.0\n';
const DEP_MISSING = 'Collecting acme-mcp[mcp]==1.2.0\n  Downloading acme_mcp-1.2.0-py3-none-any.whl\nERROR: Could not find a version that satisfies the requirement mcp-ext-gizmo>=3 (from acme-mcp[mcp]) (from versions: none)\nERROR: No matching distribution found for mcp-ext-gizmo>=3\n';
const NET_RETRY = "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.')': /simple/acme-mcp/\nERROR: Could not find a version that satisfies the requirement acme-mcp==1.2.0 (from versions: none)\nERROR: No matching distribution found for acme-mcp==1.2.0\n";
const OWN_GONE = 'ERROR: Could not find a version that satisfies the requirement acme-mcp==1.2.0 (from versions: none)\nERROR: No matching distribution found for acme-mcp==1.2.0\n';

test('R-LP-90: pip\'s "No matching distribution" is the package\'s only for its own name, an owned entry, no network trouble, and a release PyPI does not have; the three reproduced cases are ours', async () => {
  assert.equal(fd(LP, 'pypi', REQUIRES_PYTHON), 'unsupported_platform', 'a release for other Pythons only');
  assert.equal(fd(LP, 'pypi', DEP_MISSING), 'install_build_failed', 'a dependency with no distribution');
  assert.equal(fd(LP, 'pypi', NET_RETRY), 'install_build_failed', 'pip retried through the proxy');
  assert.equal(fd(LP, 'pypi', OWN_GONE), 'install_failed', 'its own release, gone from PyPI, an owned entry');
  assert.equal(fd(LP, 'pypi', OWN_GONE, { owned: false }), 'install_build_failed', 'not shown to be the subject\'s');
  assert.equal(fd(LP, 'pypi', OWN_GONE, { pypiRelease: THERE }), 'install_build_failed', 'PyPI has files for it: pip could not use them, ours');
  assert.equal(fd(LP, 'pypi', OWN_GONE, { pypiRelease: null }), 'install_build_failed', 'no facts from the planner');
  assert.equal(fd(LP, 'pypi', OWN_GONE, { pypiRelease: { found: true, files: 0 } }), 'install_failed', 'a release with no file at all');
  assert.equal(fd(LP, 'pypi', 'ERROR: No matching distribution found for acme.mcp\n'), 'install_failed', 'PEP 503 names: Acme_MCP is acme.mcp');
  // The planner records what PyPI said of the release.
  const reg = async (url) => {
    const u = new URL(url);
    const body = u.hostname === 'registry.modelcontextprotocol.io' ? { servers: [{ server: { name: 'io.github.acme/acme', version: '1.0.0', repository: { url: 'https://github.com/acme/acme', source: 'github' }, packages: [{ registryType: 'pypi', identifier: 'acme-mcp', version: '1.2.0', transport: { type: 'stdio' } }] } }] } : null;
    if (body) { const b = Buffer.from(JSON.stringify(body)); return { status: 200, ok: true, headers: { get: () => String(b.length) }, arrayBuffer: async () => b }; }
    return { status: 404, ok: false, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) };
  };
  const r = await LP.resolveSubject({ subject: 'acme/acme', repo: 'acme/acme' }, { fetch: reg });
  assert.deepEqual(r.choice.pypi_release, GONE);
});

test('R-LP-90: npm\'s E404 and ETARGET are the package\'s only for its own registry URL or name and an owned entry; a dependency\'s 404, a network error and our entry helper\'s reading are ours', async () => {
  const own404 = 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@acme%2fmcp - Not found\n';
  assert.equal(fd(LP, 'npm', own404), 'install_failed');
  assert.equal(fd(LP, 'npm', 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/left-pad-gone - Not found\n'), 'install_build_failed', 'a dependency\'s 404');
  // A dependency whose name extends the subject's is a dependency's 404, not the subject's (the URL ends at the name).
  const ev = (M, pkg, log) => M.packageInstallEvidence('npm', log, { launch: { kind: 'npm', package: pkg }, owned: true });
  const ext = [['foo-mcp', 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/foo-mcp-utils - Not found\n'], ['@acme/mcp', 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@acme%2fmcp-core - Not found\n']];
  for (const [pkg, log] of ext) assert.equal(ev(LP, pkg, log), 'install_build_failed', 'a 404 on ' + log.split('GET ')[1].split(' ')[0] + ' is not the install of ' + pkg + ' (a tool fault, not install_failed)');
  assert.equal(ev(LP, 'foo-mcp', 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/foo-mcp\n'), 'install_failed', 'the subject\'s own 404, at the end of the text');
  assert.equal(fd(LP, 'npm', 'npm error code ETARGET\nnpm error notarget No matching version found for @acme/mcp@9.9.9.\n'), 'install_failed');
  assert.equal(fd(LP, 'npm', 'npm error code ETARGET\nnpm error notarget No matching version found for zod@^9.\n'), 'install_build_failed');
  assert.equal(fd(LP, 'npm', own404, { owned: false }), 'install_build_failed');
  assert.equal(fd(LP, 'npm', 'npm error code ECONNRESET\nnpm error network aborted\n' + own404), 'install_build_failed');
  assert.equal(fd(LP, 'npm', 'npm error the package declares no bin\n'), 'entry_unresolved');
  // Mutation checks: without the name check a dependency's missing distribution is the server's; without the network
  // check a proxy retry is; without the release check a release PyPI has files for is.
  let M = await mutant('    const own = named.length > 0 && named.every((n) => n === normDist(pkg));', '    const own = named.length > 0;');
  assert.equal(fd(M, 'pypi', DEP_MISSING.replace('mcp-ext-gizmo>=3', 'mcp-ext-gizmo')), 'install_failed');
  M = await mutant("    if (!pkg || PIP_NOT_THE_PACKAGE.test(t)) return 'install_build_failed';", "    if (!pkg) return 'install_build_failed';");
  assert.equal(fd(M, 'pypi', NET_RETRY), 'install_failed');
  M = await mutant("    return own && owned && gone ? 'install_failed' : 'install_build_failed';", "    return own && owned ? 'install_failed' : 'install_build_failed';");
  assert.equal(fd(M, 'pypi', OWN_GONE, { pypiRelease: THERE }), 'install_failed');
  M = await mutant("    if (PIP_PLATFORM.test(t)) return 'unsupported_platform';\n", '');
  assert.equal(fd(M, 'pypi', REQUIRES_PYTHON), 'install_failed');
  M = await mutant("    return (e404 || etarget) && owned ? 'install_failed' : 'install_build_failed';", "    return /\\bE404\\b/.test(t) && owned ? 'install_failed' : 'install_build_failed';");
  assert.equal(fd(M, 'npm', 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/left-pad-gone - Not found\n'), 'install_failed');
  // The (?:\s|$) anchor after the registry URL: without it foo-mcp's regex matches a 404 on foo-mcp-utils.
  M = await mutant("url + '(?:\\\\s|$)'", "url");
  for (const [pkg, log] of ext) assert.equal(ev(M, pkg, log), 'install_failed', 'without the anchor a dependency 404 would be the subject\'s');
});
