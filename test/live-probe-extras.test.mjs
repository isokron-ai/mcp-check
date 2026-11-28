// R-LP-84: a PyPI launch installs the extra that holds the server (EMIT_PYPI_EXTRAS on).
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

function res(status, body) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) }, arrayBuffer: async () => buf };
}
/** The registry with one namespace-owned PyPI entry, and PyPI's JSON for its release (no wheel: deps from the metadata). */
const world = (extras) => async (url) => {
  const u = new URL(url);
  if (u.hostname === 'registry.modelcontextprotocol.io') return res(200, { servers: [{ server: { name: 'io.github.acme/arcaeon', version: '1.0.0', repository: { url: 'https://github.com/acme/arcaeon', source: 'github' }, packages: [{ registryType: 'pypi', identifier: 'arcaeon', version: '0.3.1', transport: { type: 'stdio' } }] } }] });
  if (u.hostname === 'pypi.org') return res(200, { info: { name: 'arcaeon', version: '0.3.1', requires_dist: ['httpx>=0.27', ...extras.map((x) => (x === 'dev' ? 'pytest; extra == "dev"' : `mcp>=1.2; extra == "${x}"`))], provides_extra: extras }, urls: [] });
  throw new Error('unexpected fetch ' + url);
};
const item = { subject: 'acme/arcaeon', repo: 'acme/arcaeon' };

test('R-LP-84: a PyPI launch installs the extra that holds the server (pkg[mcp]) now the pinned sandbox takes launch.extras; only an extra named mcp, server or cli', async () => {
  assert.equal(LP.EMIT_PYPI_EXTRAS, true);
  // The pinned sandbox takes the field (mcp-surface-corpus R-SBX-49 is after 4c16b58).
  const y = readFileSync(join(root, '.github', 'workflows', 'live-probe.yml'), 'utf8');
  assert.notEqual(/\n  SURFACE_CORPUS_REF: '([0-9a-f]{40})'\n/.exec(y)[1], '4c16b586e8e5886acb098285b6ec405fd4db4ac7');
  let r = await LP.resolveSubject(item, { fetch: world(['mcp', 'dev']) });
  assert.deepEqual([r.status, r.launch.kind, r.launch.package, r.launch.extras, r.choice.extras], ['runnable', 'pypi', 'arcaeon', ['mcp'], ['mcp']]);
  r = await LP.resolveSubject(item, { fetch: world(['dev', 'all']) });
  assert.equal(r.launch.extras, undefined, 'no extra named for the server: none installed');
  // Mutation check: with the switch off the mcp extra is left out and the server starts without its SDK.
  const M = await mutant('export const EMIT_PYPI_EXTRAS = true;', 'export const EMIT_PYPI_EXTRAS = false;');
  assert.equal((await M.resolveSubject(item, { fetch: world(['mcp', 'dev']) })).launch.extras, undefined);
});
