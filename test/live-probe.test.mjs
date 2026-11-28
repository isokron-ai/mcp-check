// The live-probe loop worker (corpus/live-probe.mjs, .github/workflows/live-probe.yml): input checks, the install
// method resolver (registry and seed list, fetch mocked), the sandbox target lists, the item and control logic over
// saved sandbox output, and every bundle judged by tool-qa's own contract and forgery checks (test/tool-qa/). No
// network: the sandbox itself runs only on GitHub (live-probe-selftest.yml).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as LP from '../corpus/live-probe.mjs';
import { evaluateGuard } from '../corpus/loop-guard.mjs';
import { buildManifest, collectFiles, validateManifest, resultFault, SKIP_REASONS, SKIP_FAULTS } from './tool-qa/worker-kit/contract.mjs';
import { readTar, writeTar } from './tool-qa/worker-kit/tar.mjs';
import { checkBundle } from './tool-qa/ingest/forgery.mjs';
import { scanFiles } from './tool-qa/ingest/redact.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const FX = join(root, 'test', 'fixtures', 'live-probe');
const fx = (f) => readFileSync(join(FX, f), 'utf8');
const MARKER = 'liveprobe-MARKERMARKERMARKER0000';
/** The mcp-surface-corpus commit both workflows pin (SURFACE_CORPUS_REF, the conformance call and sandbox-guard). */
const SANDBOX_PIN = '3738f2c3dabe03e943a1e5ff0a2441aca831e910';
const NODE24 = 'docker.io/library/node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';
const items = (n, f = (i) => 'owner' + i + '/repo' + i) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ subject: f(i), run_key: String(i + 1).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a'), fence: i + 1 })));

// ------------------------------------------------------------------ a fake registry and OCI registry

function res(status, body, headers = {}) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = new Map(Object.entries({ 'content-length': String(buf.length), ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, arrayBuffer: async () => buf };
}
function fakeFetch(servers, { status = 200, oci = {}, realm = 'https://ghcr.io/token', npm = {}, pypi = {} } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', auth: init.headers && init.headers.authorization });
    const u = new URL(url);
    if (u.hostname === 'registry.modelcontextprotocol.io') {
      if (status !== 200) return res(status, { error: 'x' });
      const q = (u.searchParams.get('search') || '').toLowerCase();
      return res(200, { servers: servers.filter((s) => s.name.toLowerCase().includes(q) || (s.packages || []).some((p) => String(p.identifier).toLowerCase().includes(q))).map((server) => ({ server })) });
    }
    if (u.hostname === 'registry.npmjs.org') { const k = decodeURIComponent(u.pathname.slice(1)).replace(/\/[^/]+$/, ''); return k in npm ? res(200, npm[k]) : res(404, {}); }
    if (u.hostname === 'pypi.org') { const k = u.pathname.split('/')[2]; return k in pypi ? res(200, pypi[k]) : res(404, {}); }
    if (u.pathname === '/token') return res(200, { token: 'anon-token' });
    const o = oci[u.hostname];
    if (o) {
      if (!init.headers.authorization) return res(401, '', { 'www-authenticate': 'Bearer realm="' + realm + '",service="' + u.hostname + '"' });
      return o(u, init);
    }
    throw new Error('unexpected fetch ' + url);
  };
  f.calls = calls;
  return f;
}
const npmPkg = (identifier, extra = {}) => ({ registryType: 'npm', identifier, version: '1.2.3', transport: { type: 'stdio' }, ...extra });
const server = (name, repo, packages, extra = {}) => ({ name, version: '1.2.3', repository: { url: 'https://github.com/' + repo, source: 'github' }, packages, ...extra });

// ------------------------------------------------------------------ inputs

test('live-probe inputs: checked whole; at most 10 items; nothing is repeated back', () => {
  const ok = LP.parseInputs({ shardId: 'live-probe-1', attemptId: 'a1', items: items(10) });
  assert.equal(ok.items.length, 10);
  assert.equal(ok.items[3].repo, 'owner3/repo3');
  assert.throws(() => LP.parseInputs({ shardId: 'live-probe-1', attemptId: 'a1', items: items(11) }), (e) => e.code === 'bad_items');
  assert.throws(() => LP.parseInputs({ shardId: 'bad\nid', attemptId: 'a1', items: items(1) }), (e) => e.code === 'bad_shard_id');
  assert.throws(() => LP.parseInputs({ shardId: 's', attemptId: 'a1', items: '[{"subject":"a/b","run_key":"x","fence":1}]' }), (e) => e.code === 'bad_run_key');
  assert.throws(() => LP.parseInputs({ shardId: 's', attemptId: 'a1', items: JSON.stringify([{ subject: 'a/b', run_key: 'a'.repeat(64), fence: 1, extra: 1 }]) }), (e) => e.code === 'bad_item');
  assert.throws(() => LP.parseInputs({ shardId: 's', attemptId: 'a1', items: JSON.stringify([{ subject: 'a/b', run_key: 'a'.repeat(64), fence: 1 }, { subject: 'c/d', run_key: 'a'.repeat(64), fence: 2 }]) }), (e) => e.code === 'duplicate_run_key');
  const odd = LP.parseInputs({ shardId: 's', attemptId: 'a1', items: JSON.stringify([{ subject: 'npm:left-pad', run_key: 'a'.repeat(64), fence: 1 }]) });
  assert.equal(odd.items[0].repo, null, 'not owner/name: a bad_subject skip, not a failed shard');
});

// ------------------------------------------------------------------ helpers

test('live-probe helpers: repository URLs, OCI references, arguments, env, transports, package URLs', () => {
  assert.equal(LP.repoOfUrl('https://github.com/Owner/Repo.git'), 'owner/repo');
  assert.equal(LP.repoOfUrl('git+https://github.com/a/b'), 'a/b');
  assert.equal(LP.repoOfUrl('https://gitlab.com/a/b'), null);
  assert.deepEqual(LP.parseOciRef('ghcr.io/apollographql/apollo-mcp-server:v2.2.1'), { host: 'ghcr.io', path: 'apollographql/apollo-mcp-server', tag: 'v2.2.1', digest: null });
  assert.deepEqual(LP.parseOciRef('mcp/fetch'), { host: 'docker.io', path: 'mcp/fetch', tag: 'latest', digest: null });
  assert.deepEqual(LP.parseOciRef('alpine:3'), { host: 'docker.io', path: 'library/alpine', tag: '3', digest: null });
  assert.equal(LP.parseOciRef('localhost:5000/x:1'), null, 'a registry with a port, or on the runner itself, is never pulled');
  assert.equal(LP.parseOciRef('ghcr.io/a/../b:1'), null);
  assert.deepEqual(LP.packageArgs([{ type: 'positional', value: 'serve' }, { type: 'named', name: '--port', default: '8080' }, { type: 'positional', isRequired: true, valueHint: 'path' }, { type: 'positional', value: '{dir}' }]), { args: ['serve', '--port', '8080'], unfilled: 1 });
  assert.deepEqual(LP.packageEnv([{ name: 'API_KEY', isRequired: true, isSecret: true, default: 'x' }, { name: 'MODE', isRequired: true, default: 'fast' }, { name: 'PATH', isRequired: true }, { name: 'OPT' }]), { env: { API_KEY: null, MODE: 'fast' }, names: ['API_KEY', 'MODE', 'OPT'] });
  assert.deepEqual(LP.transportOf({ type: 'streamable-http', url: 'http://localhost:3001/mcp' }), { transport: 'http', http: { port: 3001, path: '/mcp' } });
  assert.deepEqual(LP.transportOf({ type: 'sse', url: 'http://localhost:3001/sse' }), { detail: 'unsupported_transport' });
  assert.deepEqual(LP.transportOf({ type: 'streamable-http', url: 'http://localhost:{port}/mcp' }), { detail: 'unsupported_transport' });
  assert.equal(LP.purlOf('npm', '@isokron/mcp-check', '1.3.1'), 'pkg:npm/%40isokron/mcp-check@1.3.1');
  assert.equal(LP.purlOf('pypi', 'MCP_Server.Time', 'latest'), 'pkg:pypi/mcp-server-time');
});

test('live-probe safeText: a subject string outside raw/ never carries an identity word, a key or an assignment', () => {
  assert.equal(LP.safeText('@isokron/mcp-check'), '@isokron/mcp-check');
  for (const s of ['attempt_id', 'my-run-key-server', 'fence', 'Fencing tool', 'run key: x', 'say "hi"', "it's"]) assert.equal(LP.safeText(s), null, s);
  assert.equal(LP.safeText('ghcr.io/acme/box:1.4'), 'ghcr.io/acme/box:1.4');
  assert.equal(LP.safeText('https://example.com/x'), 'https://example.com/x');
});

// ------------------------------------------------------------------ resolving

test('live-probe resolve: the registry entry of the repository, npm before pypi before oci, stdio first', async () => {
  const f = fakeFetch([server('io.github.acme/widget', 'acme/widget', [
    { registryType: 'pypi', identifier: 'widget-mcp', version: '2.0.0', transport: { type: 'stdio' } },
    npmPkg('@acme/widget', { transport: { type: 'streamable-http', url: 'http://localhost:4000/mcp' } }),
    npmPkg('@acme/widget-stdio', { packageArguments: [{ type: 'positional', value: 'stdio' }], environmentVariables: [{ name: 'ACME_TOKEN', isRequired: true, isSecret: true }] }),
  ], { repository: { url: 'https://github.com/acme/widget', subfolder: 'packages/server' } })]);
  const r = await LP.resolveSubject({ subject: 'acme/widget', repo: 'acme/widget' }, { fetch: f });
  assert.equal(r.status, 'runnable');
  assert.deepEqual(r.launch, { kind: 'npm', package: '@acme/widget-stdio', version: '1.2.3', install_scripts: true, args: ['stdio'], env: { ACME_TOKEN: null } });
  assert.equal(r.choice.matched_by, 'repository+namespace');
  assert.equal(r.choice.verified_by, 'namespace');
  assert.equal(r.subdir, 'packages/server');
  assert.equal(r.registry.name, 'io.github.acme/widget');
  assert.ok(f.calls.every((c) => c.url.startsWith('https://registry.modelcontextprotocol.io/v0.1/servers?search=')));
});

test('live-probe resolve: the seed list finds a moved repository; seed packages alone when the registry has none', async () => {
  const seed = new Map([['isokron-ai/kronicle-lite', [{ registry: 'npm', identifier: 'kronicle-lite' }]], ['acme/solo', [{ registry: 'pypi', identifier: 'solo-mcp' }, { registry: 'cargo', identifier: 'solo' }]]]);
  const f = fakeFetch([server('io.github.rafe-walker/kronicle-lite', 'rafe-walker/kronicle-lite', [npmPkg('kronicle-lite', { version: '0.10.2', packageArguments: [{ type: 'positional', value: 'serve' }] })])]);
  const a = await LP.resolveSubject({ subject: 'isokron-ai/kronicle-lite', repo: 'isokron-ai/kronicle-lite' }, { fetch: f, seed });
  assert.equal(a.status, 'runnable');
  assert.equal(a.choice.matched_by, 'seed');
  assert.deepEqual(a.launch, { kind: 'npm', package: 'kronicle-lite', version: '0.10.2', install_scripts: true, args: ['serve'] });
  assert.equal(a.choice.verified_by, 'seed');
  const b = await LP.resolveSubject({ subject: 'acme/solo', repo: 'acme/solo' }, { fetch: f, seed });
  assert.equal(b.status, 'runnable');
  assert.deepEqual(b.launch, { kind: 'pypi', package: 'solo-mcp', version: 'latest' });
  assert.equal(b.choice.matched_by, 'seed-only');
});

test('live-probe resolve: skips with the right codes (none, remote only, unsupported, private registry, sse, bad subject)', async () => {
  const f = fakeFetch([
    server('io.github.acme/remote', 'acme/remote', [], { remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.example/mcp' }] }),
    server('io.github.acme/rusty', 'acme/rusty', [{ registryType: 'conda', identifier: 'rusty' }]),
    server('io.github.acme/private', 'acme/private', [npmPkg('@acme/private', { registryBaseUrl: 'https://npm.acme.example' })]),
    server('io.github.acme/sse', 'acme/sse', [npmPkg('@acme/sse', { transport: { type: 'sse', url: 'http://localhost:3000/sse' } })]),
  ]);
  const r = async (s) => (await LP.resolveSubject({ subject: s, repo: s }, { fetch: f })).detail;
  assert.equal(await r('acme/nothing'), 'no_package');
  assert.equal(await r('acme/remote'), 'remote_only');
  assert.equal(await r('acme/rusty'), 'unsupported_package');
  assert.equal(await r('acme/private'), 'private_registry');
  assert.equal(await r('acme/sse'), 'unsupported_transport');
  assert.equal((await LP.resolveSubject({ subject: 'npm:x', repo: null }, { fetch: f })).detail, 'bad_subject');
  for (const d of ['no_package', 'remote_only', 'unsupported_package', 'private_registry', 'unsupported_transport', 'bad_subject']) assert.ok(SKIP_REASONS.includes(LP.DETAILS[d][0]), d);
});

test('live-probe resolve: a registry rate limit or outage is a retryable skip, never a failed shard', async () => {
  const a = await LP.resolveSubject({ subject: 'a/b', repo: 'a/b' }, { fetch: fakeFetch([], { status: 429 }) });
  assert.equal(a.detail, 'rate_limited');
  assert.deepEqual(LP.DETAILS.rate_limited.slice(0, 2), ['rate_limited', true]);
  const b = await LP.resolveSubject({ subject: 'a/b', repo: 'a/b' }, { fetch: fakeFetch([], { status: 503 }) });
  assert.equal(b.detail, 'upstream_error');
  assert.deepEqual(LP.DETAILS.upstream_error.slice(0, 2), ['upstream_unavailable', true]);
  const c = await LP.resolveSubject({ subject: 'a/b', repo: 'a/b' }, { fetch: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(c.detail, 'upstream_error');
});

/** An OCI registry stub: an index with a linux/amd64 image whose layers add up to `bytes`. */
function ociRegistry(bytes, { amd64 = true } = {}) {
  const image = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { size: 1000, digest: 'sha256:' + 'c'.repeat(64) }, layers: [{ size: bytes - 1000, digest: 'sha256:' + 'd'.repeat(64) }] });
  const imageDigest = 'sha256:' + createHash('sha256').update(image).digest('hex');
  const index = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{ digest: imageDigest, size: image.length, platform: amd64 ? { os: 'linux', architecture: 'amd64' } : { os: 'linux', architecture: 'arm64' } }] });
  const indexDigest = 'sha256:' + createHash('sha256').update(index).digest('hex');
  const handler = (u) => (u.pathname.endsWith('/gone/manifests/1') ? res(404, '') : u.pathname.endsWith('/' + encodeURIComponent(imageDigest)) ? res(200, image) : res(200, index));
  return { handler, indexDigest };
}

test('R-LP-09: an OCI image only from the allowed registries, token services included, never an IP literal', async () => {
  const ok = ociRegistry(50 * 1024 * 1024);
  const f = fakeFetch([
    server('io.github.acme/box', 'acme/box', [{ registryType: 'oci', identifier: 'ghcr.io/acme/box:1.4', transport: { type: 'stdio' }, packageArguments: [{ type: 'positional', value: 'stdio' }] }]),
    server('io.github.acme/gone', 'acme/gone', [{ registryType: 'oci', identifier: 'ghcr.io/acme/gone:1', transport: { type: 'stdio' } }, { registryType: 'pypi', identifier: 'gone-mcp', version: '1.0', transport: { type: 'stdio' } }]),
    server('io.github.acme/elsewhere', 'acme/elsewhere', [{ registryType: 'oci', identifier: 'registry.example.com/acme/x:1', transport: { type: 'stdio' } }]),
    server('io.github.acme/ip', 'acme/ip', [{ registryType: 'oci', identifier: '10.0.0.5/acme/x:1', transport: { type: 'stdio' } }]),
  ], { oci: { 'ghcr.io': ok.handler } });
  const a = await LP.resolveSubject({ subject: 'acme/box', repo: 'acme/box' }, { fetch: f });
  assert.deepEqual(a.launch, { kind: 'docker', image: 'ghcr.io/acme/box:1.4@' + ok.indexDigest, args: ['stdio'] });
  assert.equal(a.choice.oci_bytes, 50 * 1024 * 1024);
  assert.ok(f.calls.some((c) => c.url.startsWith('https://ghcr.io/token?service=ghcr.io&scope=repository%3Aacme%2Fbox%3Apull')));
  assert.equal((await LP.resolveSubject({ subject: 'acme/gone', repo: 'acme/gone' }, { fetch: f })).launch.kind, 'pypi', 'the image is gone: the next package');
  assert.equal((await LP.resolveSubject({ subject: 'acme/elsewhere', repo: 'acme/elsewhere' }, { fetch: f })).detail, 'oci_host_not_allowed');
  assert.equal((await LP.resolveSubject({ subject: 'acme/ip', repo: 'acme/ip' }, { fetch: f })).detail, 'oci_host_not_allowed');
  assert.ok(!f.calls.some((c) => /registry\.example\.com|10\.0\.0\.5/.test(c.url)), 'nothing was asked of a host off the list');
  // A token service off the list: refused before it is asked.
  const g = fakeFetch([server('io.github.acme/box', 'acme/box', [{ registryType: 'oci', identifier: 'ghcr.io/acme/box:1.4', transport: { type: 'stdio' } }])], { oci: { 'ghcr.io': ok.handler }, realm: 'https://169.254.169.254/token' });
  assert.equal((await LP.resolveSubject({ subject: 'acme/box', repo: 'acme/box' }, { fetch: g })).detail, 'oci_host_not_allowed');
  assert.ok(!g.calls.some((c) => c.url.includes('169.254')));
  assert.deepEqual(LP.DETAILS.oci_host_not_allowed, ['no_runnable_artifact', false, 'resolve', 'tool'], 'R-LP-25');
  assert.deepEqual(LP.OCI_HOSTS, ['docker.io', 'ghcr.io', 'quay.io', 'public.ecr.aws', 'mcr.microsoft.com', 'registry.gitlab.com']);
});

test('R-LP-10: an image over 2 GB, or with no linux/amd64 image, is not pulled', async () => {
  const big = ociRegistry(LP.OCI_MAX_BYTES + 1);
  const arm = ociRegistry(1024 * 1024, { amd64: false });
  const f = (h) => fakeFetch([server('io.github.acme/box', 'acme/box', [{ registryType: 'oci', identifier: 'quay.io/acme/box:2', transport: { type: 'stdio' } }])], { oci: { 'quay.io': h }, realm: 'https://quay.io/token' });
  const a = await LP.resolveSubject({ subject: 'acme/box', repo: 'acme/box' }, { fetch: f(big.handler) });
  assert.equal(a.detail, 'image_too_large');
  assert.deepEqual(LP.DETAILS.image_too_large, ['too_large', false, 'resolve', 'tool'], 'R-LP-24');
  assert.equal((await LP.resolveSubject({ subject: 'acme/box', repo: 'acme/box' }, { fetch: f(arm.handler) })).detail, 'image_registry_unreadable', 'R-LP-36: our read of the index, not the image\'s absence');
});

test('R-LP-08: a registry entry that names the repository but not from its owner is not the subject\'s, unless its package points back', async () => {
  const spoof = (pkgs, extra = {}) => server('io.github.attacker/victim', 'acme/victim', pkgs, extra);
  // The package's own metadata names another repository: refused.
  const a = await LP.resolveSubject({ subject: 'acme/victim', repo: 'acme/victim' }, { fetch: fakeFetch([spoof([npmPkg('evil-pkg')])], { npm: { 'evil-pkg': { repository: { url: 'git+https://github.com/attacker/evil.git' } } } }) });
  assert.equal(a.status, 'skipped');
  assert.equal(a.detail, 'unverified_registry_entry');
  assert.equal(a.registry, null, 'the claiming entry is not recorded as the subject\'s');
  assert.deepEqual(LP.DETAILS.unverified_registry_entry.slice(0, 2), ['no_runnable_artifact', false]);
  // A package that does not exist on npm: refused.
  assert.equal((await LP.resolveSubject({ subject: 'acme/victim', repo: 'acme/victim' }, { fetch: fakeFetch([spoof([npmPkg('nowhere')])]) })).detail, 'unverified_registry_entry');
  // R-LP-15: package metadata the publisher writes (npm repository, PyPI project_urls) no longer counts: the attacker
  // writes the package too. Only provenance the registry vouches for does (the R-LP-15 test).
  const b = await LP.resolveSubject({ subject: 'acme/victim', repo: 'acme/victim' }, { fetch: fakeFetch([spoof([npmPkg('victim-mcp')])], { npm: { 'victim-mcp': { name: 'victim-mcp', version: '1.2.3', repository: 'github:acme/victim', dist: { integrity: 'sha512-' + Buffer.alloc(64).toString('base64') } } } }) });
  assert.equal(b.detail, 'unverified_registry_entry');
  const c = await LP.resolveSubject({ subject: 'acme/victim', repo: 'acme/victim' }, { fetch: fakeFetch([spoof([{ registryType: 'pypi', identifier: 'victim-mcp', version: '1.0', transport: { type: 'stdio' } }])], { pypi: { 'victim-mcp': { info: { version: '1.0', project_urls: { Source: 'https://github.com/acme/victim/tree/main/server' } }, urls: [] } } }) });
  assert.equal(c.detail, 'unverified_registry_entry');
  // A remote-only claim is not the subject's either.
  assert.equal((await LP.resolveSubject({ subject: 'acme/victim', repo: 'acme/victim' }, { fetch: fakeFetch([spoof([], { remotes: [{ type: 'streamable-http', url: 'https://x.example/mcp' }] })]) })).detail, 'unverified_registry_entry');
  // The owner's namespace (case-insensitive) is verified by the registry itself.
  const d = await LP.resolveSubject({ subject: 'Acme/victim', repo: 'Acme/victim' }, { fetch: fakeFetch([server('io.github.acme/victim', 'acme/victim', [npmPkg('victim-mcp')])]) });
  assert.equal(d.choice.verified_by, 'namespace');
  // The result records both.
  const w = workFolder();
  LP.bundleShard({ work: w });
  const r = JSON.parse(readFileSync(join(w, 'out', '0', 'bundle', 'results', 'live-probe.json'), 'utf8'));
  assert.equal(r.install.matched_by, 'repository+namespace+seed');
  assert.equal(r.install.verified_by, 'seed');
  assert.equal(LP.repoOfMetadataUrl('git@github.com:Acme/Victim.git'), 'acme/victim');
  assert.equal(LP.repoOfMetadataUrl('https://gitlab.com/acme/victim'), null);
});

/** A fetch that answers from a map of exact URLs (JSON bodies), 404 otherwise. */
const urlFetch = (map, calls = []) => async (url) => { calls.push(String(url)); return String(url) in map ? res(200, map[String(url)]) : res(404, {}); };
const PROV = join(FX, 'provenance');
const pj = (f) => JSON.parse(readFileSync(join(PROV, f), 'utf8'));
function npmProvenanceMap({ version = pj('npm-mcp-check-1.3.1.json'), att = pj('npm-mcp-check-1.3.1-attestations.json') } = {}) {
  return { 'https://registry.npmjs.org/@isokron%2fmcp-check/1.3.1': version, 'https://registry.npmjs.org/-/npm/v1/attestations/@isokron%2fmcp-check@1.3.1': att };
}
function pypiProvenanceMap({ rel = pj('pypi-mcp-server-time-2026.11.18.json'), prov = pj('pypi-mcp-server-time-2026.11.18-wheel-provenance.json') } = {}) {
  return { 'https://pypi.org/pypi/mcp-server-time/2026.11.18/json': rel, 'https://pypi.org/integrity/mcp-server-time/2026.11.18/mcp_server_time-2026.11.18-py3-none-any.whl/provenance': prov };
}

test('R-LP-15: a repository-only registry match counts only with signed build provenance from the registry (npm, PyPI) for that repository', async () => {
  const npm = { registryType: 'npm', identifier: '@isokron/mcp-check', version: '1.3.1' };
  const pypi = { registryType: 'pypi', identifier: 'mcp-server-time', version: '2026.11.18' };
  // Real attestations, saved from the registries: they verify for their own repository and no other.
  assert.equal(await LP.packageVerifiedBy(npm, 'isokron-ai/mcp-check', { fetch: urlFetch(npmProvenanceMap()) }), 'npm_provenance');
  assert.equal(await LP.packageVerifiedBy(pypi, 'modelcontextprotocol/servers', { fetch: urlFetch(pypiProvenanceMap()) }), 'pypi_provenance');
  const why = async (pkg, subj, map) => { const out = {}; await LP.packageVerifiedBy(pkg, subj, { fetch: urlFetch(map), out }); return out.why; };
  assert.equal(await why(npm, 'acme/victim', npmProvenanceMap()), 'provenance_other_repository');
  assert.equal(await why(pypi, 'acme/victim', pypiProvenanceMap()), 'provenance_other_repository');
  // No attestation at all (the package.json may say anything): no.
  const bare = { ...pj('npm-mcp-check-1.3.1.json') }; bare.dist = { ...bare.dist }; delete bare.dist.attestations;
  assert.equal(await why(npm, 'isokron-ai/mcp-check', npmProvenanceMap({ version: bare })), 'no_provenance');
  // The tarball is not the one attested: no.
  const other = { ...pj('npm-mcp-check-1.3.1.json') }; other.dist = { ...other.dist, integrity: 'sha512-' + Buffer.alloc(64, 7).toString('base64') };
  assert.equal(await why(npm, 'isokron-ai/mcp-check', npmProvenanceMap({ version: other })), 'provenance_other_artifact');
  // The statement changed to name another repository (the signature no longer matches), or the certificate changed.
  const att = pj('npm-mcp-check-1.3.1-attestations.json');
  const slsa = att.attestations.find((a) => a.predicateType === 'https://slsa.dev/provenance/v1');
  const st = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  st.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/acme/victim';
  slsa.bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(st)).toString('base64');
  assert.equal(await why(npm, 'acme/victim', npmProvenanceMap({ att })), 'certificate_other_repository', 'the certificate still names the real repository');
  const forged = JSON.parse(JSON.stringify(att));
  st.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/isokron-ai/mcp-check';
  st.predicate.runDetails = { forged: true };
  forged.attestations.find((a) => a.predicateType === 'https://slsa.dev/provenance/v1').bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(st)).toString('base64');
  assert.equal(await why(npm, 'isokron-ai/mcp-check', npmProvenanceMap({ att: forged })), 'signature_invalid');
  // A certificate that does not chain to the pinned Fulcio authority.
  const out = {};
  const wrongCa = join(mkdtempSync(join(tmpdir(), 'lp-ca-')), 'ca.json');
  const real = JSON.parse(readFileSync(LP.SIGSTORE_CA_FILE, 'utf8'));
  writeFileSync(wrongCa, JSON.stringify({ ...real, certificate_authorities: [{ ...real.certificate_authorities[0], chain: [real.certificate_authorities[0].chain[1]] }] }));
  await LP.packageVerifiedBy(npm, 'isokron-ai/mcp-check', { fetch: urlFetch(npmProvenanceMap()), chains: LP.sigstoreChains(wrongCa), out });
  assert.equal(out.why, 'certificate_not_from_fulcio');
  // The Fulcio extensions are read from the certificate itself.
  const der = Buffer.from(pj('npm-mcp-check-1.3.1-attestations.json').attestations.find((a) => a.predicateType === 'https://slsa.dev/provenance/v1').bundle.verificationMaterial.certificate.rawBytes, 'base64');
  assert.equal(LP.fulcioExtension(der, 12), 'https://github.com/isokron-ai/mcp-check');
  assert.equal(LP.fulcioExtension(der, 8), 'https://token.actions.githubusercontent.com');
  // Through resolveSubject: a repository-only entry whose npm package has provenance for the subject.
  const reg = fakeFetch([server('io.github.someone-else/mcp-check', 'isokron-ai/mcp-check', [npmPkg('@isokron/mcp-check', { version: '1.3.1' })])]);
  const both = async (url, init) => (String(url).startsWith('https://registry.npmjs.org/') ? urlFetch(npmProvenanceMap())(url, init) : reg(url, init));
  const r = await LP.resolveSubject({ subject: 'isokron-ai/mcp-check', repo: 'isokron-ai/mcp-check' }, { fetch: both });
  assert.equal(r.status, 'runnable');
  assert.equal(r.choice.verified_by, 'npm_provenance');
  assert.equal(r.choice.matched_by, 'repository');
});

test('R-LP-16: OCI subjects run one at a time, each only with about 4x its image size free; past that, a retryable skip', async () => {
  // The plan puts OCI subjects in lists of their own, with their declared size.
  const digest = 'sha256:' + 'e'.repeat(64);
  const plan = { marker: MARKER, subject_timeout_s: 147, items: [
    { index: 0, target: { id: 's001', repo: 'a/b', ref: 'HEAD', launch: { kind: 'npm', package: 'x', version: '1.0.0' } }, resolution: { choice: {} } },
    { index: 1, target: { id: 's002', repo: 'a/c', ref: 'HEAD', launch: { kind: 'docker', image: 'ghcr.io/a/c:1@' + digest } }, resolution: { choice: { oci_bytes: 123456 } } },
  ] };
  const lists = LP.targetLists(plan, { node24Image: NODE24 });
  assert.deepEqual(lists.subjects.targets.map((t) => t.id), ['s001']);
  assert.deepEqual(lists.oci.map((o) => [o.id, o.image, o.bytes, o.list.targets[0].id]), [['s002', 'ghcr.io/a/c:1@' + digest, 123456, 's002']]);
  // The bundle reads each OCI subject from its own run; one stopped for disk is a retryable skip.
  const rk = (c) => c.repeat(64);
  const res = (ociBytes) => ({ status: 'runnable', detail: null, registry: null, choice: { type: 'oci', identifier: 'ghcr.io/a/c:1', version: '1', transport: 'stdio', runtime_hint: null, args_n: 0, args_unfilled: 0, env_names: [], oci_digest: 'e'.repeat(64), oci_bytes: ociBytes, purl: null, matched_by: 'repository+namespace', verified_by: 'namespace' }, candidates: [], launch: null, subdir: null, seed_packages: 0 });
  const its = [
    { index: 0, subject: 'acme/box', repo: 'acme/box', run_key: rk('1'), fence: 1, target_id: 's001', target: { id: 's001', launch: { kind: 'docker', image: 'ghcr.io/acme/box:1@' + digest } }, resolution: res(1000), resolve_ms: 1 },
    { index: 1, subject: 'acme/huge', repo: 'acme/huge', run_key: rk('2'), fence: 2, target_id: 's002', target: { id: 's002', launch: { kind: 'docker', image: 'ghcr.io/acme/huge:1@' + digest } }, resolution: res(2 * 1024 ** 3), resolve_ms: 1 },
    { index: 2, subject: 'acme/later', repo: 'acme/later', run_key: rk('3'), fence: 3, target_id: 's003', target: { id: 's003', launch: { kind: 'docker', image: 'ghcr.io/acme/later:1@' + digest } }, resolution: res(1000), resolve_ms: 1 },
  ];
  const w = workFolder({ items: its });
  mkdirSync(join(w, 'driver-oci', 's001', 's001'), { recursive: true });
  mkdirSync(join(w, 'driver-oci', 's001', '_shard'), { recursive: true });
  writeFileSync(join(w, 'driver-oci', 's001', 's001', 'record.json'), fx('record-ok.json'));
  writeFileSync(join(w, 'driver-oci', 's001', 's001', 'probe-bare.json'), fx('probe-known.json'));
  writeFileSync(join(w, 'driver-oci', 's001', '_shard', 'telemetry.jsonl'), fx('telemetry.jsonl'));
  writeFileSync(join(w, 'oci-runs.jsonl'), [{ id: 's001', outcome: 'ran', rc: 0, avail: 9e9, need: 4000 }, { id: 's002', outcome: 'disk_low', avail: 5e9, need: 8 * 1024 ** 3 }, { id: 's003', outcome: 'disk_low' }].map((x) => JSON.stringify(x)).join('\n') + '\n');
  const summary = LP.bundleShard({ work: w });
  assert.deepEqual(summary.map((x) => [x.status, x.detail]), [['graded', null], ['skipped', 'disk_low'], ['skipped', 'disk_low']]);
  assert.deepEqual(LP.DETAILS.disk_low.slice(0, 2), ['upstream_unavailable', true]);
  const meta = JSON.parse(readFileSync(join(w, 'out', '1', 'meta.json'), 'utf8'));
  assert.deepEqual(meta.skips, [{ stage: 'install', reason: 'upstream_unavailable', fault: 'infra', evidence: LP.RESULT_PATH, retryable: true }]);
  assert.match(readFileSync(join(w, 'out', '0', 'bundle', 'raw', 'telemetry.jsonl'), 'utf8'), /registry\.npmjs\.org/, 'its own run\'s telemetry');
  // The script: free space against four times the declared size, before each image, and the image removed after.
  const sh = readFileSync(join(root, 'corpus', 'live-probe-sandbox.sh'), 'utf8');
  assert.match(sh, /need=\$\(\( bytes \* 4 \)\)/);
  assert.match(sh, /df -B1 --output=avail "\$docker_root"/);
  assert.match(sh, /stop=disk_low/);
  assert.match(sh, /docker image rm -f "\$image"/);
  assert.ok(sh.indexOf('need=$(( bytes * 4 ))') < sh.indexOf('drive "$work/oci/$id.json"'));
});

test('R-LP-17: the install is pinned to the version whose provenance was checked, so a moving latest cannot swap it', async () => {
  // npm: the registry entry gives no version; the attested document says 1.3.1.
  const map = { ...npmProvenanceMap() };
  map['https://registry.npmjs.org/@isokron%2fmcp-check/latest'] = map['https://registry.npmjs.org/@isokron%2fmcp-check/1.3.1'];
  const reg = fakeFetch([server('io.github.someone-else/mcp-check', 'isokron-ai/mcp-check', [npmPkg('@isokron/mcp-check', { version: undefined })])]);
  const both = async (url, init) => (String(url).startsWith('https://registry.npmjs.org/') ? urlFetch(map)(url, init) : reg(url, init));
  const r = await LP.resolveSubject({ subject: 'isokron-ai/mcp-check', repo: 'isokron-ai/mcp-check' }, { fetch: both });
  assert.equal(r.choice.verified_by, 'npm_provenance');
  assert.equal(r.launch.version, '1.3.1', 'not latest');
  assert.equal(r.choice.version, '1.3.1');
  assert.equal(r.choice.purl, 'pkg:npm/%40isokron/mcp-check@1.3.1');
  // PyPI: the same, from the release document's own version.
  const pmap = pypiProvenanceMap();
  pmap['https://pypi.org/pypi/mcp-server-time/json'] = pmap['https://pypi.org/pypi/mcp-server-time/2026.11.18/json'];
  const out = {};
  assert.equal(await LP.packageVerifiedBy({ registryType: 'pypi', identifier: 'mcp-server-time' }, 'modelcontextprotocol/servers', { fetch: urlFetch(pmap), out }), 'pypi_provenance');
  assert.equal(out.version, '2026.11.18');
  // A release document for another version than the one asked for: refused.
  const odd = pypiProvenanceMap(); odd['https://pypi.org/pypi/mcp-server-time/9.9.9/json'] = odd['https://pypi.org/pypi/mcp-server-time/2026.11.18/json'];
  const o2 = {};
  assert.equal(await LP.packageVerifiedBy({ registryType: 'pypi', identifier: 'mcp-server-time', version: '9.9.9' }, 'modelcontextprotocol/servers', { fetch: urlFetch(odd), out: o2 }), null);
  assert.equal(o2.why, 'provenance_other_artifact');
});

/** DER helpers for synthetic certificates (structure only; never signed). */
const der = (tag, ...parts) => { const body = Buffer.concat(parts); const n = body.length; const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]); return Buffer.concat([Buffer.from([tag]), len, body]); };
const fulcioOid = (arc) => der(0x06, Buffer.from([0x2b, 0x06, 0x01, 0x04, 0x01, 0x83, 0xbf, 0x30, 0x01, arc]));
const ext = (oid, value, critical = false) => der(0x30, oid, ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
const utf8 = (t) => der(0x0c, Buffer.from(t));
const certWith = (exts, { trailing = Buffer.alloc(0) } = {}) => {
  const tbs = der(0x30, der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), der(0x30), der(0x30), der(0x30), der(0x30), der(0x30), der(0xa3, der(0x30, ...exts)));
  return Buffer.concat([der(0x30, tbs, der(0x30), der(0x03, Buffer.from([0]))), trailing]);
};

test('R-LP-18: Fulcio extensions are read from tbsCertificate.extensions, each exactly once', () => {
  const repo = 'https://github.com/acme/victim';
  const ok = certWith([ext(fulcioOid(12), utf8(repo)), ext(fulcioOid(8), utf8('https://token.actions.githubusercontent.com'))]);
  assert.equal(LP.fulcioExtension(ok, 12), repo);
  assert.equal(LP.fulcioExtension(ok, 8), 'https://token.actions.githubusercontent.com');
  assert.equal(LP.fulcioExtension(ok, 9), null);
  // The same extension twice: refused, whichever value comes first.
  const twice = certWith([ext(fulcioOid(12), utf8('https://github.com/attacker/x')), ext(fulcioOid(12), utf8(repo))]);
  assert.throws(() => LP.fulcioExtension(twice, 12), /appears twice/);
  // The OID's bytes inside another extension's value are not that extension (a byte search would have found them).
  const hidden = certWith([ext(der(0x06, Buffer.from([0x55, 0x1d, 0x11])), Buffer.concat([fulcioOid(12), der(0x04, utf8(repo))]))]);
  assert.equal(hidden.indexOf(Buffer.from([0x2b, 0x06, 0x01, 0x04, 0x01, 0x83, 0xbf, 0x30, 0x01, 0x0c])) > 0, true);
  assert.equal(LP.fulcioExtension(hidden, 12), null);
  // Not DER: trailing bytes, a value that is not a UTF8String filling the extension.
  assert.throws(() => LP.certExtensions(certWith([], { trailing: Buffer.from([0]) })), /not a DER certificate/);
  assert.equal(LP.fulcioExtension(certWith([ext(fulcioOid(12), Buffer.concat([utf8(repo), Buffer.from([0])]))]), 12), null);
  // The real certificates parse, with every Fulcio extension once.
  const real = Buffer.from(pj('npm-mcp-check-1.3.1-attestations.json').attestations.find((a) => a.predicateType === 'https://slsa.dev/provenance/v1').bundle.verificationMaterial.certificate.rawBytes, 'base64');
  const oids = LP.certExtensions(real).map((e) => e.oid);
  assert.equal(new Set(oids).size, oids.length);
  assert.equal(LP.fulcioExtension(real, 12), 'https://github.com/isokron-ai/mcp-check');
});

test('R-LP-19: a shared reusable workflow signs for the subject only when it is on the allowlist and is the SAN', () => {
  const gen = 'https://github.com/slsa-framework/slsa-github-generator/.github/workflows/builder_nodejs_slsa3.yml@refs/tags/v2.1.0';
  assert.equal(LP.signerKind({ san: 'URI:https://github.com/acme/victim/.github/workflows/release.yml@refs/tags/v1', buildSigner: 'https://github.com/acme/victim/.github/workflows/release.yml@refs/tags/v1', repo: 'acme/victim' }), 'repository_workflow');
  assert.equal(LP.signerKind({ san: 'URI:' + gen, buildSigner: gen, repo: 'acme/victim' }), 'trusted_reusable_workflow');
  assert.equal(LP.signerKind({ san: 'URI:' + gen.replace('@refs/tags/v2.1.0', '@refs/heads/main'), buildSigner: gen.replace('@refs/tags/v2.1.0', '@refs/heads/main'), repo: 'acme/victim' }), null, 'a branch, not a release tag');
  assert.equal(LP.signerKind({ san: 'URI:https://github.com/attacker/shared/.github/workflows/sign.yml@refs/tags/v1', buildSigner: 'https://github.com/attacker/shared/.github/workflows/sign.yml@refs/tags/v1', repo: 'acme/victim' }), null, 'not on the allowlist');
  assert.equal(LP.signerKind({ san: 'URI:https://github.com/attacker/shared/.github/workflows/sign.yml@refs/tags/v1', buildSigner: gen, repo: 'acme/victim' }), null, 'the SAN is not the allowlisted signer');
  assert.deepEqual(LP.TRUSTED_REUSABLE_SIGNERS, ['https://github.com/slsa-framework/slsa-github-generator/.github/workflows/']);
  assert.match(readFileSync(join(root, 'corpus', 'LIVE-PROBE.md'), 'utf8'), /slsa-framework\/slsa-github-generator\/\.github\/workflows\//);
});

test('R-LP-20: tool_count and tool_list_sha256 are written as fields of their own, declared in the pinned registry', () => {
  const w = workFolder();
  LP.bundleShard({ work: w });
  const recs = readFileSync(join(w, 'out', '0', 'bundle', 'observations', 'live.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const known = JSON.parse(readFileSync(LP.KNOWN_ANSWER_FILE, 'utf8')).answer;
  assert.deepEqual(recs.filter((x) => x.field === 'tool_count').map((x) => x.value), [known.tool_count]);
  assert.deepEqual(recs.filter((x) => x.field === 'tool_list_sha256').map((x) => x.value), [known.catalog_hash]);
  const reg = registryTypes();
  assert.equal(reg.get('tool_count').type, 'integer');
  assert.equal(reg.get('tool_list_sha256').type, 'hash');
});

test('R-LP-21: the sandbox at mcp-surface-corpus 73a2669 builds native modules, so kronicle-lite is expected to start in the self test', () => {
  for (const f of ['live-probe.yml', 'live-probe-selftest.yml']) assert.equal(wf(f).split(SANDBOX_PIN).length - 1, 3, f + ': the env pin, the conformance workflow and the guard');
  const shard = JSON.parse(readFileSync(join(root, 'corpus', 'fixtures', 'live-probe', 'selftest-shard.json'), 'utf8'));
  assert.deepEqual(shard.items.find((x) => x.subject === 'isokron-ai/kronicle-lite').expect, { status: 'graded', min_tools: 1, oracles: true, fuzz: true });
});

test('R-LP-22: the self test judges the bundles with the ingest tool-qa runs, whose registry declares every field the lane writes', () => {
  const y = wf('live-probe-selftest.yml');
  const ref = /\n  INGEST_REF: '([0-9a-f]{40})'\n/.exec(y);
  assert.ok(ref, 'INGEST_REF pinned to a full SHA');
  assert.match(y, new RegExp("repository: isokron-ai/tool-qa\\n          ref: \\$\\{\\{ env\\.INGEST_REF \\}\\}\\n          path: tool-qa-ingest\\n          sparse-checkout: \\|\\n            worker-kit/\\n            ingest/\\n            scripts/lib/yaml-lite\\.mjs\\n"));
  assert.match(y, /verify --ingest tool-qa-ingest tool-qa /);
  // Every field the lane can write is declared, with its type, in the registry that ingest pins (mcp-results a6fa803,
  // tool-qa #32: the oracle stage's fields too).
  const reg = registryTypes();
  for (const [f, t] of Object.entries({ ...LP.FIELDS, ...LP.TOOL_LIST_FIELDS, ...LP.ORACLE_FIELDS })) assert.equal(reg.get(f) && reg.get(f).type, t, f);
  assert.equal(createHash('sha256').update(readFileSync(join(FX, 'fields-registry.yaml'))).digest('hex'), 'b8bbfea66c4b93a46c57d4fb4a145f696ce56d996d842faa3da33fe9e4abf27d', 'the test copy is mcp-results a6fa803, as tool-qa #32 pins it');
});

test('R-LP-23: the sandbox pin includes the install-network hostile cases and the proxy positive control (mcp-surface-corpus #9, #10)', () => {
  assert.equal(SANDBOX_PIN, '3738f2c3dabe03e943a1e5ff0a2441aca831e910');
  for (const f of ['live-probe.yml', 'live-probe-selftest.yml']) {
    const y = wf(f);
    assert.equal(/\n  SURFACE_CORPUS_REF: '([0-9a-f]{40})'\n/.exec(y)[1], SANDBOX_PIN, f);
    assert.ok(y.includes('isokron-ai/mcp-surface-corpus/.github/workflows/sandbox-conformance.yml@' + SANDBOX_PIN + ' # SURFACE_CORPUS_REF'), f + ': the conformance call');
    assert.ok(y.includes('isokron-ai/mcp-surface-corpus/sandbox-guard@' + SANDBOX_PIN + ' # SURFACE_CORPUS_REF'), f + ': sandbox-guard');
    assert.equal((y.match(/mcp-surface-corpus[^\n]*@([0-9a-f]{40})/g) || []).filter((m) => !m.endsWith(SANDBOX_PIN)).length, 0, f + ': no other sandbox commit');
  }
});

test('R-LP-12: npm installs run their install scripts, in the sandbox, so native modules can be built', async () => {
  const r = await LP.resolveSubject({ subject: 'acme/widget', repo: 'acme/widget' }, { fetch: fakeFetch([server('io.github.acme/widget', 'acme/widget', [npmPkg('@acme/widget')])]) });
  assert.equal(r.launch.install_scripts, true);
  assert.equal(LP.KNOWN_ANSWER.launch.install_scripts, true, 'the known-answer control takes the same path');
});

// ------------------------------------------------------------------ plan and target lists

test('live-probe plan: targets s001.., a target the sandbox refuses is a launch_invalid skip, the budget is shared out', async () => {
  const f = fakeFetch([server('io.github.a/one', 'a/one', [npmPkg('one')]), server('io.github.a/two', 'a/two', [npmPkg('two')])]);
  const inputs = LP.parseInputs({ shardId: 's', attemptId: 'a1', items: JSON.stringify([{ subject: 'a/one', run_key: 'a'.repeat(64), fence: 1 }, { subject: 'a/two', run_key: 'b'.repeat(64), fence: 2 }, { subject: 'a/three', run_key: 'c'.repeat(64), fence: 3 }]) });
  const plan = await LP.planShard({ inputs, fetch: f, marker: MARKER, validateTarget: (t) => { if (t.launch.package === 'two') throw new Error('refused'); } });
  assert.deepEqual(plan.items.map((x) => [x.target_id, x.resolution.status, x.resolution.detail]), [['s001', 'runnable', null], [null, 'skipped', 'launch_invalid'], [null, 'skipped', 'no_package']]);
  assert.equal(plan.runnable, 1);
  assert.equal(plan.subject_timeout_s, LP.SUBJECT_TIMEOUT_MAX_S);
  // Each target's limit is its share of the budget plus the oracle stage's allowance (corpus/live-probe-driver.mjs).
  assert.equal(plan.items[0].target.timeout_s, plan.subject_timeout_s + LP.ORACLE_ALLOWANCE_S);
  assert.deepEqual(plan.items[0].target, { id: 's001', repo: 'a/one', ref: 'HEAD', registry: 'io.github.a/one', launch: { kind: 'npm', package: 'one', version: '1.2.3', install_scripts: true }, timeout_s: plan.subject_timeout_s + LP.ORACLE_ALLOWANCE_S });
  assert.equal(LP.subjectTimeout(10), 147);
  assert.ok(LP.subjectTimeout(10) * 10 <= LP.SUBJECT_BUDGET_S);
  const lists = LP.targetLists(plan, { node24Image: NODE24 });
  assert.deepEqual(lists.subjects.targets.map((t) => t.id), ['s001']);
  assert.deepEqual(lists.controls.targets.map((t) => t.id), ['s901', 's902']);
  const forgery = lists.controls.targets[1].launch;
  assert.equal(forgery.kind, 'docker');
  assert.equal(forgery.image, NODE24, 'the sandbox\'s own pinned node image');
  assert.equal(forgery.entrypoint, 'node');
  assert.equal(forgery.args[0], '-e');
  assert.ok(forgery.args[1].length <= 2000 && !/[\n\r]/.test(forgery.args[1]));
  assert.equal(forgery.args[2], MARKER);
  assert.deepEqual(lists.controls.targets[0].launch, { kind: 'npm', package: '@isokron/mcp-check', version: '1.3.1', install_scripts: true, args: ['serve'] });
  assert.throws(() => LP.targetLists(plan, { node24Image: 'node:24' }));
});

// ------------------------------------------------------------------ a whole shard from saved sandbox output

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
  // static.json as the sandbox writes it with mcp-check's reader handed over (R-LP-77): its answer under `reader`
  const stat = JSON.parse(fx('static-known.json'));
  stat.reader = { format: 'isokron-live-probe-static/1', reader_id: LP.READER_ID, repo: 'o/n', sha: 'a'.repeat(40), subdir: null, scan: { via: 'github', truncated: false, scanned: null, best_index: 0, candidates: [{ kind: 'source', fidelity: 'literal', tools: stat.static.candidates[0].tools }], hints: {} } };
  put('driver-subjects/s001/static.json', stat);
  put('driver-subjects/s001/steps.log', 'npm install ...\n');
  // kronicle-lite: installed, then exited before answering (a native module was not built).
  const rec2 = JSON.parse(fx('record-ok.json')); rec2.layers.live = false;
  put('driver-subjects/s002/record.json', rec2);
  put('driver-subjects/s002/probe-bare.json', { format: 'isokron-surface-probe/1', era: null, initialize: null, error: 'the server exited before answering', lists: {}, transport: { exit: 1 }, timing: { total_ms: 2000 } });
  for (const p of drop) { try { writeFileSync(join(w, p), ''); } catch { /* */ } }
  return w;
}

const ENV = { GITHUB_REPOSITORY: 'isokron-ai/mcp-check', GITHUB_WORKFLOW_REF: 'isokron-ai/mcp-check/.github/workflows/live-probe.yml@refs/heads/main', GITHUB_WORKFLOW_SHA: 'c'.repeat(40), GITHUB_RUN_ID: '77', GITHUB_RUN_ATTEMPT: '1' };

/** What the worker-kit and then ingest do with one item's folder: manifest, tar, and tool-qa's own checks. */
function judge(dir, item) {
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const files = collectFiles(join(dir, 'bundle'));
  const workflow = { repo: ENV.GITHUB_REPOSITORY, file: '.github/workflows/live-probe.yml', sha: ENV.GITHUB_WORKFLOW_SHA, run_id: 77, run_attempt: 1 };
  const manifest = buildManifest({ identity: { attempt_id: 'attempt-1', fence: item.fence, run_key: item.run_key }, workflow, meta, files });
  const v = validateManifest(manifest);
  const tar = writeTar([{ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, ...files]);
  const back = new Map(readTar(tar).filter((e) => e.path !== 'manifest.json').map((e) => [e.path, e.data]));
  const problems = checkBundle(manifest, back, { attempt_id: 'attempt-1', fence: item.fence, run_key: item.run_key, repo: workflow.repo, workflow_file: workflow.file, workflow_sha: workflow.sha, run_id: 77 });
  const secrets = scanFiles(new Map([...back].filter(([k]) => !k.startsWith('raw/'))));
  return { manifest, v, problems, secrets, files: back };
}

/** The pinned field registry (mcp-results at tool-qa's REGISTRY_COMMIT): id -> type. */
function registryTypes() {
  const out = new Map();
  for (const m of fx('fields-registry.yaml').matchAll(/\{id: ([a-z0-9_]+), layer: [a-z_]+, type: ([a-z]+),.*status: ([a-z]+)\}/g)) out.set(m[1], { type: m[2], status: m[3] });
  return out;
}

test('live-probe bundle: every item gets a bundle that tool-qa\'s contract and forgery checks accept', () => {
  const w = workFolder({ subjectsRc: 124 });
  const lines = [];
  const summary = LP.bundleShard({ work: w, log: (l) => lines.push(l) });
  assert.deepEqual(summary.map((s) => [s.status, s.detail]), [['graded', null], ['skipped', 'start_env_limited'], ['skipped', 'no_package'], ['skipped', 'shard_deadline']]);
  const plan = JSON.parse(readFileSync(join(w, 'plan.json'), 'utf8'));
  for (const item of plan.items) {
    const dir = join(w, 'out', String(item.index));
    const j = judge(dir, item);
    assert.ok(j.v.ok, JSON.stringify(j.v.errors));
    assert.deepEqual(j.problems, [], 'item ' + item.index + ': ' + JSON.stringify(j.problems));
    assert.deepEqual(j.secrets, []);
    assert.deepEqual(j.manifest.controls.map((c) => [c.kind, c.expected, c.observed]), [['known_good', 'match', 'match'], ['forgery', 'contained', 'contained'], ['malicious', 'blocked', 'blocked']]);
    assert.ok([...j.files.keys()].some((k) => k.startsWith('raw/') && j.files.get(k).includes(MARKER)), 'the forgery marker is in raw/');
  }
  // The skips: codes from tool-qa's list, retryable only for a passing cause.
  const meta = (i) => JSON.parse(readFileSync(join(w, 'out', String(i), 'meta.json'), 'utf8'));
  assert.deepEqual(meta(0).skips, []);
  assert.deepEqual(meta(1).skips, [{ stage: 'start', reason: 'timeout_start', fault: 'tool', evidence: LP.RESULT_PATH }]);
  assert.deepEqual(meta(2).skips, [{ stage: 'resolve', reason: 'no_runnable_artifact', fault: 'tool', evidence: LP.RESULT_PATH }]);
  assert.deepEqual(meta(3).skips, [{ stage: 'start', reason: 'upstream_unavailable', fault: 'infra', evidence: LP.RESULT_PATH, retryable: true }]);
  assert.equal(meta(0).subject.sha, '5e2668aed07efeb61beb2f3761bc3348af2075c3');
  assert.equal(meta(0).tools[1].name, 'isokron-ai/mcp-surface-corpus');
  assert.match(lines.join('\n'), /item 3: skipped \(shard_deadline, upstream_unavailable, infra, retryable\)/);
});

test('live-probe bundle: the live grade, the static comparison and the field records', () => {
  const w = workFolder();
  LP.bundleShard({ work: w });
  const b = join(w, 'out', '0', 'bundle');
  const r = JSON.parse(readFileSync(join(b, 'results', 'live-probe.json'), 'utf8'));
  const known = JSON.parse(readFileSync(LP.KNOWN_ANSWER_FILE, 'utf8')).answer;
  assert.equal(r.status, 'graded');
  assert.deepEqual(LP.answerOf(r.live), known, 'the live list graded as mcp-check -- <server> grades it');
  assert.equal(r.live.config_state, 'none');
  assert.equal(r.static_vs_live.static_tool_count, known.tool_count - 1);
  assert.equal(r.static_vs_live.names_only_live, 1);
  assert.equal(r.static_vs_live.same_catalog_hash, false);
  assert.ok(existsSync(join(b, 'raw', 'tools-list.json')) && existsSync(join(b, 'raw', 'static-compare.json')) && existsSync(join(b, 'raw', 'telemetry.jsonl')));
  // Telemetry of this subject and the run, not of another subject.
  const tel = readFileSync(join(b, 'raw', 'telemetry.jsonl'), 'utf8');
  assert.match(tel, /registry\.npmjs\.org/); assert.doesNotMatch(tel, /other\.example\.com/);
  // Field records: declared in the pinned registry, of its type, a null only with a reason.
  const reg = registryTypes();
  const recs = readFileSync(join(b, 'observations', 'live.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const o of recs) {
    assert.ok(reg.has(o.field), o.field + ' is in the registry');
    assert.equal(reg.get(o.field).type, { ...LP.FIELDS, ...LP.TOOL_LIST_FIELDS, ...LP.ORACLE_FIELDS }[o.field], o.field + ' type');
    assert.equal(o.stage, 'live');
    if (o.value === null) assert.ok(o.why, o.field);
  }
  const by = (f) => recs.filter((o) => o.field === f).map((o) => o.value);
  for (const [f, t] of Object.entries(LP.FIELDS)) assert.equal(reg.get(f) && reg.get(f).type, t, f);
  // R-LP-20: tool_count and tool_list_sha256 as fields of their own, now that tool-qa pins mcp-results f2b16de.
  assert.equal(LP.EMIT_TOOL_LIST_FIELDS, true);
  for (const [f, t] of Object.entries(LP.TOOL_LIST_FIELDS)) assert.equal(reg.get(f) && reg.get(f).type, t, f);
  assert.deepEqual(by('tool_count'), [known.tool_count]);
  assert.deepEqual(by('tool_list_sha256'), [known.catalog_hash]);
  assert.deepEqual(by('subject_id'), ['isokron-ai/mcp-check']);
  assert.deepEqual(by('registry_package_identifier'), ['@isokron/mcp-check']);
  assert.deepEqual(by('package_purl'), ['pkg:npm/%40isokron/mcp-check@1.3.1']);
  assert.deepEqual(by('protocol_era'), ['legacy']);
  assert.equal(by('server_info')[0].name, 'mcp-check');
  assert.equal(by('capabilities_flags')[0].tools, true);
  assert.deepEqual(by('config_state'), ['none']);
  assert.equal(by('catalog_per_config_state')[0].none.catalog_hash, known.catalog_hash);
  assert.deepEqual(by('sandbox_tier'), ['gvisor']);
  assert.equal(by('our_tool_versions')[0].surface_corpus, '3b43c19a3b84950732379ea5beee06a8f73512a6');
  assert.equal(by('install_phase_behaviour')[0].egress_refused, 1);
  const net = by('network_event');
  assert.deepEqual(net.map((e) => e.kind), ['dns_query', 'egress', 'dns_query', 'connection', 'host_drop']);
  assert.equal(net[2].host, null, 'a looked-up name with an identity word stays in raw/ (hash only)');
  assert.match(net[2].host_sha256, /^[0-9a-f]{64}$/);
  assert.equal(net[3].host, 'telemetry.example.com');
  const skipped = readFileSync(join(w, 'out', '2', 'bundle', 'observations', 'live.ndjson'), 'utf8');
  assert.match(skipped, /"field":"error_taxonomy_code","value":"no_package"/);
});

test('live-probe controls: a known answer that does not match, a self test that failed, or a sandbox not swept uploads nothing', () => {
  // Another server answering in the known-answer slot: a different list.
  const forged = JSON.parse(fx('probe-forgery.json'));
  const w1 = workFolder();
  writeFileSync(join(w1, 'driver-controls', 's901', 'probe-bare.json'), JSON.stringify(forged));
  assert.throws(() => LP.bundleShard({ work: w1 }), (e) => e instanceof LP.ControlFailure && /known_good=mismatch/.test(e.message));
  assert.ok(!existsSync(join(w1, 'out')), 'nothing written');
  const w2 = workFolder({ selftestRc: 1 });
  assert.throws(() => LP.bundleShard({ work: w2 }), /malicious=not_blocked/);
  const w3 = workFolder({ swept: false });
  assert.throws(() => LP.bundleShard({ work: w3 }), /not shown to be gone/);
  const w4 = workFolder();
  writeFileSync(join(w4, 'driver-controls', 's902', 'probe-bare.json'), '{}');
  assert.throws(() => LP.bundleShard({ work: w4 }), /forgery=not_run/);
});

test('live-probe forgery control: the forged texts stay in raw/; leaks() catches each way out', () => {
  const w = workFolder();
  LP.bundleShard({ work: w });
  const out = readFileSync(join(w, 'out', '0', 'bundle', 'controls', 'forgery.json'), 'utf8');
  assert.ok(!out.includes(MARKER));
  assert.equal(LP.leaks(out, MARKER), false);
  assert.match(out, /"status": "graded"/, 'the forgery server went through the same grading as a subject');
  assert.equal(LP.leaks('{"x": "' + MARKER + '"}', MARKER), true);
  assert.equal(LP.leaks('{"attempt_id": "x"}', MARKER), true);
  assert.equal(LP.leaks('{"schema_version": 1, "files": []}', MARKER), true);
  assert.equal(LP.leaks('note: run_key=abc', MARKER), true);
  // The forgery server's serverInfo and capabilities are reduced to safe values and hashes.
  const info = LP.serverInfo({ name: 'attempt_id: forged-x', version: 'fence=1' });
  assert.equal(info.name, null); assert.equal(info.version, null); assert.match(info.name_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(LP.capabilityFlags({ tools: {}, attempt_id: { x: 1 } })).includes('attempt_id'), false);
});

test('live-probe failure details: install, start, credentials, list, evidence and deadline', () => {
  const rec = (o) => ({ install: { kind: 'npm', ok: true, steps: [] }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, ...o });
  const ctx = { launch: { kind: 'npm' }, argsUnfilled: 0 };
  const exited = (exit) => ({ error: 'exited', transport: { exit, signal: null }, timing: { total_ms: 2000 } });
  assert.equal(LP.failureDetail(null, null, null, { deadlineHit: true }), 'shard_deadline');
  assert.equal(LP.failureDetail(null, null, null), 'harness_error');
  assert.equal(LP.failureDetail(rec({ excluded: 'sandbox evidence missing' })), 'sandbox_evidence_missing');
  assert.equal(LP.failureDetail(rec({ install: { kind: 'docker', ok: false, steps: [] } })), 'image_pull_failed');
  assert.equal(LP.failureDetail(rec({ install: { kind: 'npm', ok: false, steps: [{ name: 'install', exit: 1 }] }, }), null, null, { stepsLog: 'npm error code E404' }), 'install_failed');
  assert.equal(LP.failureDetail(rec({ install: { kind: 'npm', ok: false, steps: [{ name: 'install', exit: null, timed_out: true }] } })), 'install_timeout');
  assert.equal(LP.failureDetail(rec({}), { ...exited(1), stderr: 'panic: boom' }, null, ctx), 'start_failed');
  assert.equal(LP.failureDetail(rec({}), exited(1), null, ctx), 'start_env_limited', 'an early exit with no stderr is no evidence (R-LP-45)');
  assert.equal(LP.failureDetail(rec({}), { error: 'time limit (45000 ms)' }, null, ctx), 'start_timeout');
  assert.equal(LP.failureDetail(rec({}), { initialize: { capabilities: { tools: {} } }, error: null, lists: { 'tools/list': { ok: false, error: 'Method not found', error_code: -32601 } } }, null), 'list_failed');
  assert.equal(LP.failureDetail(rec({ env: { names: { registry: ['API_KEY'] }, secret_named: ['API_KEY'] } }), exited(1), exited(1), ctx), 'needs_credentials');
  // R-LP-07: an optional key named in the README is not a declared credential.
  assert.equal(LP.failureDetail(rec({ env: { names: { registry: [], readme: ['ANCHOR_KEY'], used: ['ANCHOR_KEY'] }, secret_named: ['ANCHOR_KEY'] } }), { error: null, initialize_error: 'the server exited (exit 1, signal null)', stderr: 'panic: boom', timing: { total_ms: 2000 } }, { error: null, initialize_error: 'the server exited (exit 1, signal null)', stderr: 'panic: boom', timing: { total_ms: 2000 } }, ctx), 'start_failed');
  for (const [d, [reason]] of Object.entries(LP.DETAILS)) assert.ok(SKIP_REASONS.includes(reason), d + ' -> ' + reason);
});

// ------------------------------------------------------------------ evidence rules for the skip faults (R-LP-29..38)
// A server is recorded as at fault (subject) only with evidence our own environment cannot explain; the records below
// are in the shapes the lane writes (the driver's record.json and probe, and the sandbox's telemetry.jsonl).

const lpRec = (o = {}) => ({ install: { kind: 'npm', ok: true, steps: [{ name: 'install', exit: 0 }] }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false, ...o });
const badInstall = (o = {}, step = {}) => lpRec({ install: { kind: 'npm', ok: false, steps: [{ name: 'install', exit: 1, timed_out: false, ...step }], egress_refused: 0, ...o } });
const probeExit = (exit, signal = null, ms = 3000) => ({ initialize: null, era: null, error: null, initialize_error: 'the server exited (exit ' + exit + ', signal ' + signal + ')', lists: {}, transport: { exit, signal }, ...(ms === null ? {} : { timing: { first_byte_ms: null, total_ms: ms } }) });
// A crash signature on stderr: the evidence start_failed needs (R-LP-45). An early exit with empty stderr is not.
const CRASH_ERR = 'panic: runtime error: index out of range [0] with length 0\n\ngoroutine 1 [running]:\n';
const crashExit = (exit, signal = null, ms = 3000) => ({ ...probeExit(exit, signal, ms), stderr: CRASH_ERR });
const trec = (type, o = {}) => ({ v: 1, type, run: 'abc', seq: 9, t: '2026-11-23T10:00:09.000Z', subject: 's001', ...o });
const serverDns = trec('dns_query', { source: 'netlog', role: 'server', qname: 'api.example.com', qtype: 'A', answer: 'sinkhole' });
const serverConn = trec('connection', { source: 'netlog', role: 'server', proto: 'tcp', port: 443, bytes: 0, sni: 'api.example.com' });
const traceNet = (n, role = 'server') => trec('trace_summary', { source: 'runsc', role, summary: { format: 'isokron-trace-summary/1', failed: { file: 0, process: 0, network: n, privileged: 0, other: 0 } } });
const OK = { launch: { kind: 'npm' }, argsUnfilled: 0 };
const needEnv = { names: { registry: ['API_KEY'] }, secret_named: ['API_KEY'] };

test('R-LP-29: an install our proxy refused something for is install_blocked (tool), never the server\'s install_failed', () => {
  // kronicle-lite's case: the install asked for a prebuilt binary the proxy refused; the 404 text is no excuse.
  const refused = badInstall({ egress_refused: 2, egress: [{ host: 'github.com', allowed: false }] });
  assert.equal(LP.failureDetail(refused, null, null, { stepsLog: 'npm error code E404' }), 'install_blocked');
  assert.deepEqual(LP.DETAILS.install_blocked, ['install_failed_registry', false, 'install', 'tool']);
  // Counted from the egress list when the count is not there.
  const listed = badInstall({ egress_refused: undefined, egress: [{ host: 'x.example', allowed: false }] });
  assert.equal(LP.failureDetail(listed), 'install_blocked');
});

test('R-LP-30: an install killed by a limit (137, 124, out of memory) is install_resource_limit (tool)', () => {
  for (const step of [{ exit: 137 }, { exit: 124 }]) assert.equal(LP.failureDetail(badInstall({}, step), null, null, { stepsLog: 'npm error code E404' }), 'install_resource_limit', JSON.stringify(step));
  assert.equal(LP.failureDetail(badInstall(), null, null, { stepsLog: 'FATAL ERROR: JavaScript heap out of memory' }), 'install_resource_limit');
  assert.deepEqual(LP.DETAILS.install_resource_limit, ['install_failed_registry', false, 'install', 'tool']);
});

test('R-LP-31: an install that failed with no package-level cause is install_build_failed (tool); only a package error stays the server\'s', () => {
  const log = (t) => LP.failureDetail(badInstall(), null, null, { stepsLog: t });
  for (const t of ['npm error code E404\nnpm error 404 Not Found', 'npm error code ETARGET\nnpm error notarget No matching version', 'ERROR: No matching distribution found for acme-mcp', 'npm error acme-mcp declares no bin']) assert.equal(log(t), 'install_failed', t);
  for (const t of ['gyp ERR! find Python', 'error: command \'gcc\' failed: No such file or directory', 'npm error code EBADENGINE\nnpm error engine Unsupported engine', 'Failed building wheel for pydantic-core', '']) assert.equal(log(t), 'install_build_failed', t);
  // The text may be in the step itself, as the lane writes it.
  assert.equal(LP.failureDetail(badInstall({}, { stderr: 'npm error code E404' })), 'install_failed');
  assert.deepEqual(LP.DETAILS.install_build_failed, ['install_failed_registry', false, 'install', 'tool']);
});

test('R-LP-32: a server that ran out of the time limit is start_timeout (tool) even with a required env var declared, never needs_credentials', () => {
  const r = lpRec({ env: needEnv });
  assert.equal(LP.failureDetail(r, { error: 'time limit (45000 ms)' }, { error: 'time limit (45000 ms)' }, OK), 'start_timeout');
  assert.equal(LP.failureDetail({ ...r, timed_out: true }, probeExit(1), probeExit(1), OK), 'start_timeout');
  // Killed (a signal, 137) is no exit of its own either.
  assert.equal(LP.failureDetail(r, probeExit(null, 'SIGKILL'), null, OK), 'start_env_limited');
  assert.equal(LP.failureDetail(r, probeExit(137), null, OK), 'start_env_limited');
  // The server's own non-zero exit with a declared env var is the one credentials case.
  assert.equal(LP.failureDetail(r, probeExit(1), null, OK), 'needs_credentials');
  assert.equal(LP.failureDetail(lpRec(), { error: 'time limit (45000 ms)' }, null, OK), 'start_timeout');
});

test('R-LP-33: a server that went to the network (which the run does not have) is start_needs_network, not needs_credentials or start_failed', () => {
  assert.deepEqual(LP.DETAILS.start_needs_network, ['timeout_start', false, 'start', 'tool']);
  for (const records of [[serverDns], [serverConn], [traceNet(3)]]) {
    assert.equal(LP.failureDetail(lpRec({ env: needEnv }), probeExit(1), null, { ...OK, records }), 'start_needs_network');
    // With no variable declared it is named too, not left as start_env_limited (R-LP-64).
    assert.equal(LP.failureDetail(lpRec(), crashExit(1), null, { ...OK, records }), 'start_needs_network');
  }
  // The install's lookups, a quiet trace and another target's records are no attempt of the server.
  const quiet = [trec('dns_query', { source: 'netlog', role: 'install', qname: 'registry.npmjs.org' }), trec('connection', { source: 'netlog', role: 'install' }), traceNet(0), traceNet(5, 'install')];
  assert.equal(LP.failureDetail(lpRec({ env: needEnv }), probeExit(1), null, { ...OK, records: quiet }), 'needs_credentials');
  assert.equal(LP.failureDetail(lpRec(), crashExit(1), null, { ...OK, records: quiet }), 'start_failed');
  assert.equal(LP.serverNetworkAttempt(LP.telemetryFor(join(FX, 'telemetry.jsonl'), 's001').records), false, 'the saved telemetry has no server-role lookup');
});

test('R-LP-34: start_failed is the server\'s only with its own early non-zero exit, every argument filled and a resolved launch; else start_env_limited (tool)', () => {
  assert.equal(typeof LP.START_QUICK_MS, 'number');
  assert.equal(LP.START_QUICK_MS, LP.PROBE_MS / 2);
  assert.deepEqual(LP.DETAILS.start_env_limited, ['timeout_start', false, 'start', 'tool']);
  assert.equal(LP.failureDetail(lpRec(), crashExit(1), null, OK), 'start_failed');
  const limited = (what, r, p, c) => assert.equal(LP.failureDetail(r, p, null, c), 'start_env_limited', what);
  limited('placeholder arguments left unfilled', lpRec(), crashExit(1), { ...OK, argsUnfilled: 2 });
  limited('arguments not known', lpRec(), crashExit(1), { launch: OK.launch });
  limited('killed by a signal', lpRec(), crashExit(null, 'SIGSEGV'), OK);
  limited('exit 137', lpRec(), crashExit(137), OK);
  limited('exit 0', lpRec(), crashExit(0), OK);
  limited('late (the probe ran to half its window)', lpRec(), crashExit(1, null, LP.START_QUICK_MS), OK);
  limited('no probe timing at all', lpRec(), crashExit(1, null, null), OK);
  limited('PyPI console script guessed from the package name', lpRec(), crashExit(1), { ...OK, launch: { kind: 'pypi', package: 'acme-mcp', version: 'latest' } });
  limited('no launch known', lpRec(), crashExit(1), { argsUnfilled: 0 });
  // A PyPI launch with a resolved entry is evidence again.
  assert.equal(LP.failureDetail(lpRec(), crashExit(1), null, { ...OK, launch: { kind: 'pypi', package: 'acme-mcp', entry: 'acme-server' } }), 'start_failed');
});

test('R-LP-35: list_failed is the server\'s only for a JSON-RPC error it sent or a malformed result; our limits are list_probe_limited (tool)', () => {
  assert.deepEqual(LP.DETAILS.list_probe_limited, ['timeout_start', false, 'list', 'tool']);
  // The server declared tools (R-LP-75: without that capability, "method not found" is no failure).
  const listed = (error, error_code = null) => ({ initialize: { capabilities: { tools: {} } }, era: 'legacy', error: null, lists: { 'tools/list': { ok: false, error, error_code, pages: 0 } }, transport: { exit: null, signal: null } });
  const r = lpRec({ env: needEnv });
  for (const [e, c] of [['Method not found', -32601], ['Internal error', -32603], ['the tools/list result has no tools array', null], ['nextCursor is not a string', null], ['the server repeated the same cursor', null], ['the answer has no result object', null]]) assert.equal(LP.failureDetail(r, listed(e, c), null), 'list_failed', e);
  for (const [e, c] of [['time limit', null], ['time limit (45000 ms)', null], ['paging stopped after 100 pages', null], ['the server wrote more than 25165824 bytes', null], ['HTTP request failed: ECONNRESET: x', null], ['HTTP 502: Bad Gateway', 502], ['the server exited (exit 1, signal null)', null]]) assert.equal(LP.failureDetail(r, listed(e, c), null), 'list_probe_limited', e);
  assert.equal(LP.failureDetail(r, { initialize: {}, error: null }, null), 'list_probe_limited', 'no list answer at all');
  // A declared env var does not turn a list failure into needs_credentials.
  assert.notEqual(LP.failureDetail(r, listed('Method not found', -32601), null), 'needs_credentials');
});

test('R-LP-40: the quick window is the failing probe\'s own time, not the record\'s total, which holds the install and the analysis', () => {
  // Real selftest records show 24.7 to 72.7 s of total_ms for a server that failed in about a second.
  for (const total of [24_700, 72_700, 300_000]) assert.equal(LP.failureDetail(lpRec({ timing: { total_ms: total } }), crashExit(1, null, 900), null, OK), 'start_failed', 'total ' + total);
  // A probe that ran to half its window is no early exit, whatever the total.
  assert.equal(LP.failureDetail(lpRec({ timing: { total_ms: 1000 } }), crashExit(1, null, 30_000), null, OK), 'start_env_limited');
  // The record's own probes entry, then captured_at - started_at, when the probe carries no timing.
  const bare = crashExit(1, null, null);
  assert.equal(LP.failureDetail(lpRec({ probes: { bare: { timing: { total_ms: 800 } } } }), bare, null, OK), 'start_failed');
  assert.equal(LP.failureDetail(lpRec({ probes: { bare: { timing: { total_ms: 40_000 } } } }), bare, null, OK), 'start_env_limited');
  assert.equal(LP.failureDetail(lpRec(), { ...bare, started_at: '2026-11-23T10:00:00.000Z', captured_at: '2026-11-23T10:00:01.500Z' }, null, OK), 'start_failed');
  assert.equal(LP.failureDetail(lpRec(), { ...bare, started_at: '2026-11-23T10:00:00.000Z', captured_at: '2026-11-23T10:00:40.000Z' }, null, OK), 'start_env_limited');
});

test('R-LP-39: exits 125, 126 and 127 (docker run, not executable, command not found) are not the server\'s own; needs_credentials needs the same guards as start_failed', () => {
  const r = lpRec({ env: needEnv });
  const pypiGuess = { launch: { kind: 'pypi', package: 'acme-mcp', version: 'latest' }, argsUnfilled: 0 };
  // The case: a declared env var, a guessed PyPI launch and exit 127 (command not found).
  assert.equal(LP.failureDetail(r, probeExit(127), null, pypiGuess), 'start_env_limited');
  assert.notEqual(LP.failureDetail(r, probeExit(127), null, pypiGuess), 'needs_credentials');
  for (const exit of [125, 126, 127, 137]) {
    assert.equal(LP.failureDetail(r, probeExit(exit), null, OK), 'start_env_limited', 'needs_credentials, exit ' + exit);
    assert.equal(LP.failureDetail(lpRec(), crashExit(exit), null, OK), 'start_env_limited', 'start_failed, exit ' + exit);
  }
  // Each guard of start_failed holds for needs_credentials too.
  assert.equal(LP.failureDetail(r, probeExit(1), null, pypiGuess), 'start_env_limited', 'a guessed launch');
  assert.equal(LP.failureDetail(r, probeExit(1), null, { ...OK, argsUnfilled: 1 }), 'start_env_limited', 'an unfilled argument');
  assert.equal(LP.failureDetail(r, probeExit(1), null, { launch: OK.launch }), 'start_env_limited', 'arguments not known');
  assert.equal(LP.failureDetail(r, probeExit(null, 'SIGTERM'), null, OK), 'start_env_limited', 'a signal');
  // With a network attempt it is the network code, guards or not.
  assert.equal(LP.failureDetail(r, probeExit(127), null, { ...pypiGuess, records: [serverDns] }), 'start_needs_network');
  // All guards met: the one credentials case.
  assert.equal(LP.failureDetail(r, probeExit(1), null, OK), 'needs_credentials');
  assert.equal(LP.failureDetail(r, probeExit(2), null, { launch: { kind: 'pypi', package: 'a', entry: 'a-server' }, argsUnfilled: 0 }), 'needs_credentials');
});

test('R-LP-41: a server\'s network attempt shows in its trace summary when the netlog records are lost', () => {
  const trace = (summary, role = 'server') => trec('trace_summary', { source: 'runsc', role, summary: { format: 'isokron-trace-summary/1', counts: { file: 40, process: 3, network: 0, privileged: 0, other: 0 }, failed: { file: 0, process: 0, network: 0, privileged: 0, other: 0 }, network: { sockets: [], raw_sockets: 0, connects: [], sends: [], binds: [], dns_names: [] }, ...summary } });
  const seen = (rec) => LP.failureDetail(lpRec({ env: needEnv }), probeExit(1), null, { ...OK, records: [rec] });
  // No dns_query or connection record anywhere: the trace alone.
  assert.equal(seen(trace({ network: { sockets: [], connects: [{ addr: '93.184.216.34', port: 443, n: 1, failed: 1, errno: 'ENETUNREACH' }], dns_names: [] } })), 'start_needs_network', 'a connect');
  assert.equal(seen(trace({ network: { sockets: [], connects: [], dns_names: [{ name: 'api.example.com', n: 1 }] } })), 'start_needs_network', 'a looked-up name');
  assert.equal(seen(trace({ network: { sockets: [], connects: [], sends: [{ addr: '10.0.0.9', port: 53, n: 1 }], dns_names: [] } })), 'start_needs_network', 'a send');
  assert.equal(seen(trace({ failed: { file: 0, process: 0, network: 2, privileged: 0, other: 0 } })), 'start_needs_network', 'failed network calls');
  // A quiet trace, or another role's, is no attempt.
  assert.equal(seen(trace({})), 'needs_credentials');
  assert.equal(seen(trace({ counts: { network: 9 } }, 'install')), 'needs_credentials');
  assert.equal(LP.serverNetworkAttempt([trace({ network: { connects: 3 } })]), true, 'a count works as well as a list');
});

test('R-LP-42: network syscalls alone (counts.network) are not a network attempt: the real healthy shape stays the server\'s own', () => {
  // From live-probe-selftest run 45522659823: a healthy server whose list came back, with counts.network 4 and no
  // connects, sends, names or failed network calls (local sockets inside the runtime).
  const healthy = trec('trace_summary', { source: 'runsc', role: 'server', summary: { format: 'isokron-trace-summary/1', counts: { file: 40, process: 3, network: 4, privileged: 0, other: 0 }, failed: { file: 0, process: 0, network: 0, privileged: 0, other: 0 }, network: { sockets: [], raw_sockets: 0, connects: [], sends: [], binds: [], dns_names: [] } } });
  assert.equal(LP.serverNetworkAttempt([healthy]), false);
  assert.equal(LP.failureDetail(lpRec({ env: needEnv }), probeExit(1), null, { ...OK, records: [healthy] }), 'needs_credentials');
});

test('R-LP-46: a log line or a validation message that mentions a crash word is no crash: an early exit with it stays start_env_limited', () => {
  // From the review of #40: unanchored, case-insensitive patterns blamed a healthy-but-unconfigured server for these.
  const notCrashes = [
    'WARN: ImportError for optional dependency foo', 'validation: TypeError: expected string', 'msg="panic: recovered"',
    '[PANIC: handled]', 'TypeError: expected string for --port', 'level=error msg="fatal error: bad flag"',
    'error: x\npanic is not a crash here',
  ];
  for (const stderr of notCrashes) {
    assert.doesNotMatch(stderr, LP.CRASH_TEXT, stderr);
    assert.equal(LP.failureDetail(lpRec(), { ...probeExit(1), stderr }, null, OK), 'start_env_limited', stderr);
  }
});

test('R-LP-47: a server that throws its own "missing setting" error, stack and all, needs configuration: start_needs_config, not start_failed', () => {
  const frame = '\n    at validate (/app/cfg.js:3:9)';
  for (const stderr of ['Error: API_KEY missing' + frame, 'Error: GITHUB_TOKEN is required' + frame, 'Error: Missing environment variable DATABASE_URL' + frame, 'TypeError: process.env.OPENAI_API_KEY is undefined' + frame, 'Set SLACK_BOT_TOKEN to run this server' + frame]) {
    assert.match(stderr, LP.ENV_NAME_TEXT, stderr);
    assert.equal(LP.failureDetail(lpRec(), { ...probeExit(1), stderr }, null, OK), 'start_needs_config', stderr);
  }
  // A real crash naming no setting is still the server's own.
  assert.equal(LP.failureDetail(lpRec(), { ...probeExit(1), stderr: 'TypeError: x is not a function' + frame }, null, OK), 'start_failed');
  // Lower-case words are not setting names, and a crash phrase inside a log line is no crash.
  assert.doesNotMatch('Error: response missing field', LP.ENV_NAME_TEXT);
  for (const s of ['INFO retry: Unhandled promise rejection count 0', 'log: Error: Cannot find module \'x\' (optional)', 'debug Uncaught Exception handler installed']) assert.doesNotMatch(s, LP.CRASH_TEXT, s);
});

test('a manifest 404 is the registry\'s answer for the name we built: library/ and odd tags are normalised before the request', async () => {
  const asked = [];
  const f = async (url, init = {}) => {
    const u = new URL(url); asked.push(u.href);
    if (u.pathname === '/token') return res(200, { token: 't' });
    if (!init.headers.authorization) return res(401, '', { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"' });
    return res(404, '');
  };
  const cases = [
    ['node:24', 'https://registry-1.docker.io/v2/library/node/manifests/24'],
    ['docker.io/node', 'https://registry-1.docker.io/v2/library/node/manifests/latest'],
    ['index.docker.io/acme/box:1.0-rc.1_x', 'https://registry-1.docker.io/v2/acme/box/manifests/1.0-rc.1_x'],
    ['docker.io/library/node:24-bookworm-slim', 'https://registry-1.docker.io/v2/library/node/manifests/24-bookworm-slim'],
  ];
  for (const [id, url] of cases) {
    asked.length = 0;
    const ref = LP.parseOciRef(id);
    assert.ok(ref, id);
    assert.equal(await ociCode(f, ref), 'image_unavailable', id);
    assert.equal(asked.filter((u) => u.includes('/manifests/'))[0], url, id);
  }
  assert.equal(LP.parseOciRef('ghcr.io/acme/box:bad tag'), null);
});

/** An OCI registry fetch stub for resolveOciImage: `reply(url, init)` gives the manifest answers; the token service gives a token. */
function ociFetch(reply, { challenge = 'Bearer realm="https://ghcr.io/token",service="ghcr.io"', token = { token: 'anon' } } = {}) {
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/token') return res(token === null ? 404 : 200, token === null ? '' : token);
    if (!init.headers.authorization && challenge !== false) return challenge === null ? res(401, '') : res(401, '', { 'www-authenticate': challenge });
    return reply(u, init);
  };
}
const goodImage = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { size: 1000, digest: 'sha256:' + 'c'.repeat(64) }, layers: [{ size: 5000, digest: 'sha256:' + 'd'.repeat(64) }] });
const imageRef = (o = {}) => ({ ...LP.parseOciRef('ghcr.io/acme/box:1'), ...o });
const ociCode = async (fetch, ref = imageRef()) => { try { await LP.resolveOciImage(ref, { fetch }); return 'ok'; } catch (e) { return e.detail; } };

test('R-LP-36: an image is image_unavailable (subject) only for the registry\'s own 404, 401 or 403 after a token exchange, or a digest mismatch; what we could not read is image_registry_unreadable (tool)', async () => {
  assert.deepEqual(LP.DETAILS.image_unavailable, ['install_failed_registry', false, 'resolve', 'subject']);
  assert.deepEqual(LP.DETAILS.image_registry_unreadable, ['install_failed_registry', false, 'resolve', 'tool']);
  // The registry's own answer: kept as the image's.
  for (const status of [404, 401, 403]) assert.equal(await ociCode(ociFetch(() => res(status, ''))), 'image_unavailable', 'after a good token exchange: ' + status);
  assert.equal(await ociCode(ociFetch(() => res(404, ''), { challenge: false })), 'image_unavailable', 'a 404 with no challenge is still the registry\'s answer');
  assert.equal(await ociCode(ociFetch(() => res(200, goodImage)), imageRef({ digest: 'sha256:' + '9'.repeat(64) })), 'image_unavailable', 'digest mismatch');
  // Ours: a 401 or 403 with no token ever exchanged, and everything the registry sent that we could not read.
  for (const status of [401, 403]) assert.equal(await ociCode(ociFetch(() => res(status, ''), { challenge: false })), 'image_registry_unreadable', 'no token exchanged: ' + status);
  const tool = {
    'no Bearer challenge': ociFetch(() => res(200, goodImage), { challenge: 'Basic realm="x"' }),
    'no challenge header': ociFetch(() => res(200, goodImage), { challenge: null }),
    'a bad realm': ociFetch(() => res(200, goodImage), { challenge: 'Bearer realm="not a url",service="ghcr.io"' }),
    'no token': ociFetch(() => res(200, goodImage), { token: {} }),
    'no token answer': ociFetch(() => res(200, goodImage), { token: null }),
    'bad JSON': ociFetch(() => res(200, '<html>not json')),
    'no linux/amd64 entry': ociFetch(() => res(200, { schemaVersion: 2, manifests: [{ digest: 'sha256:' + 'a'.repeat(64), platform: { os: 'linux', architecture: 'arm64' } }] })),
    'no layers': ociFetch(() => res(200, { schemaVersion: 2, config: { size: 1 }, layers: [] })),
    'bad sizes': ociFetch(() => res(200, { schemaVersion: 2, config: { size: 1 }, layers: [{ size: -5 }] })),
  };
  for (const [what, f] of Object.entries(tool)) assert.equal(await ociCode(f), 'image_registry_unreadable', what);
  assert.equal(await ociCode(ociFetch(() => res(200, goodImage))), 'ok');
});

test('R-LP-37: a run-stage image pull that failed is image_pull_failed (tool), not the image\'s absence', () => {
  // The planner already read this digest, so the image is there; the pull step records no stderr, and a rate limit on a
  // shared runner address, a timeout and the runner's disk look alike. None is evidence about the server. Tool rather
  // than infra: infra says a passing outside condition, which the record cannot show.
  assert.deepEqual(LP.DETAILS.image_pull_failed, ['install_failed_registry', false, 'install', 'tool']);
  for (const step of [{ name: 'pull', exit: 1 }, { name: 'pull', exit: null, timed_out: true }, { name: 'pull', exit: 137 }]) {
    assert.equal(LP.failureDetail(lpRec({ install: { kind: 'docker', ok: false, steps: [step] } })), 'image_pull_failed', JSON.stringify(step));
  }
  assert.equal(LP.failureDetail(lpRec({ install: { kind: 'docker', ok: false, steps: [] } })), 'image_pull_failed');
});

test('R-LP-38: no_package (tool, R-LP-43) is recorded only when no registry search page came back full; a full page (100, no paging) is registry_lookup_truncated (tool)', async () => {
  assert.deepEqual(LP.DETAILS.registry_lookup_truncated, ['no_runnable_artifact', false, 'resolve', 'tool']);
  assert.equal(LP.REGISTRY_PAGE, 100);
  const others = (n) => Array.from({ length: n }, (_, i) => server('io.github.zed/box-' + i, 'zed/box-' + i, [npmPkg('box-' + i)]));
  const resolve = (n) => LP.resolveSubject({ subject: 'acme/box', repo: 'acme/box' }, { fetch: fakeFetch(others(n)) });
  assert.equal((await resolve(99)).detail, 'no_package');
  assert.equal((await resolve(0)).detail, 'no_package');
  assert.equal((await resolve(100)).detail, 'registry_lookup_truncated');
  assert.equal((await resolve(120)).detail, 'registry_lookup_truncated');
});

test('live-probe fault evidence (telemetry, steps log, plan) reaches failureDetail through the bundle step (R-LP-29..38)', () => {
  const run = (setup) => {
    const w = workFolder();
    setup(w);
    const out = LP.bundleShard({ work: w });
    return out.map((s) => s.detail);
  };
  const addTelemetry = (w, ...recs) => writeFileSync(join(w, 'driver-subjects', '_shard', 'telemetry.jsonl'), readFileSync(join(w, 'driver-subjects', '_shard', 'telemetry.jsonl'), 'utf8') + recs.map((r) => JSON.stringify({ ...r, subject: 's002' })).join('\n') + '\n');
  assert.equal(run(() => {})[1], 'start_env_limited', 'the saved kronicle-lite capture: an early exit 1 with empty stderr, no crash signature, so no evidence against the server (R-LP-45)');
  assert.equal(run((w) => addTelemetry(w, serverDns))[1], 'start_needs_network', 'its telemetry shows a server-role lookup (R-LP-64)');
  const plan = (w, f) => { const p = JSON.parse(readFileSync(join(w, 'plan.json'), 'utf8')); f(p.items[1]); writeFileSync(join(w, 'plan.json'), JSON.stringify(p)); };
  assert.equal(run((w) => plan(w, (it) => { it.resolution.choice.args_unfilled = 1; }))[1], 'start_env_limited', 'the plan says an argument was left unfilled');
  assert.equal(run((w) => plan(w, (it) => { it.resolution.launch = { kind: 'pypi', package: 'x' }; }))[1], 'start_env_limited', 'the plan says the PyPI entry is a guess');
  const failedInstall = (log) => (w) => {
    const rec = JSON.parse(readFileSync(join(w, 'driver-subjects', 's002', 'record.json'), 'utf8'));
    rec.install = { kind: 'npm', ok: false, steps: [{ name: 'install', exit: 1, timed_out: false, ms: 5 }], egress: [] };
    writeFileSync(join(w, 'driver-subjects', 's002', 'record.json'), JSON.stringify(rec));
    writeFileSync(join(w, 'driver-subjects', 's002', 'probe-bare.json'), '');
    writeFileSync(join(w, 'driver-subjects', 's002', 'steps.log'), log);
  };
  assert.equal(run(failedInstall('npm error code E404'))[1], 'install_failed', 'steps.log names a package error');
  assert.equal(run(failedInstall('gyp ERR! stack Error: not found: make'))[1], 'install_build_failed', 'steps.log names a build error');
});

test('live-probe docs: every detail code is in the skip table with its reason and fault, and the OCI allowlist reason is the true one', () => {
  const doc = readFileSync(join(root, 'corpus', 'LIVE-PROBE.md'), 'utf8');
  for (const [d, [reason, , , fault]] of Object.entries(LP.DETAILS)) {
    const row = doc.split('\n').find((l) => l.startsWith('|') && l.includes('`' + d + '`'));
    assert.ok(row, d + ' is in the docs table');
    const cells = row.split('|').map((c) => c.trim());
    assert.equal(cells[2], '`' + reason + '`', d + ' reason');
    assert.ok(cells[3].startsWith(fault), d + ' fault ' + fault + ' in "' + cells[3] + '"');
  }
  assert.doesNotMatch(doc, /sandbox'?s? egress is deny by default, so only six OCI hosts/);
  assert.match(doc, /Docker daemon[^.]*outside the sandbox/);
});

test('live-probe raw files are capped and the cut is recorded', () => {
  const w = workFolder();
  const big = JSON.parse(fx('probe-known.json'));
  big.stderr = 'x'.repeat(LP.RAW_FILE_CAP + 10);
  writeFileSync(join(w, 'driver-subjects', 's001', 'probe-bare.json'), JSON.stringify(big));
  LP.bundleShard({ work: w });
  const r = JSON.parse(readFileSync(join(w, 'out', '0', 'bundle', 'results', 'live-probe.json'), 'utf8'));
  assert.deepEqual(r.raw_truncated.map((x) => x.path), ['raw/probe-bare.json']);
  assert.equal(readFileSync(join(w, 'out', '0', 'bundle', 'raw', 'probe-bare.json')).length, LP.RAW_FILE_CAP);
});

test('live-probe known answer: corpus/fixtures/live-probe/known-answer.json is what the code computes from the saved capture', () => {
  assert.deepEqual(JSON.parse(readFileSync(LP.KNOWN_ANSWER_FILE, 'utf8')), LP.knownAnswerFrom());
  const fixture = JSON.parse(readFileSync(join(root, 'corpus', 'fixtures', 'live-probe', 'selftest-shard.json'), 'utf8'));
  assert.equal(fixture.items[0].expect.catalog_hash, LP.knownAnswerFrom().answer.catalog_hash, 'the self test expects the same list');
  assert.equal(LP.KNOWN_ANSWER.launch.version, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version === '1.3.1' ? '1.3.1' : LP.KNOWN_ANSWER.launch.version);
});

test('live-probe forgery server: one argument for node -e, under the sandbox\'s 2000 characters', () => {
  const s = LP.forgeryScript();
  assert.ok(s.length <= 2000);
  assert.doesNotMatch(s, /\/\/ /);
});

test('R-LP-11: no upload unless the sandbox is gone: no container or volume at all, no uid 65534 or runsc process', () => {
  for (const left of [{ containers: 1 }, { volumes: 2 }, { uid_65534_processes: 1 }, { runsc_processes: 1 }, { labelled: 1 }]) {
    const w = workFolder({ left });
    assert.throws(() => LP.bundleShard({ work: w }), /not shown to be gone/, JSON.stringify(left));
    assert.ok(!existsSync(join(w, 'out')));
  }
  const w = workFolder();
  const state = JSON.parse(readFileSync(join(w, 'sandbox.json'), 'utf8')); delete state.left;
  writeFileSync(join(w, 'sandbox.json'), JSON.stringify(state));
  assert.throws(() => LP.bundleShard({ work: w }), /not shown to be gone/, 'a state file without the counts');
  const sh = readFileSync(join(root, 'corpus', 'live-probe-sandbox.sh'), 'utf8');
  for (const re of [/docker ps -aq \| wc -l/, /docker volume ls -q \| wc -l/, /pgrep -u 65534/, /pgrep -f 'runsc\|containerd-shim-runsc'/]) assert.match(sh, re);
});

test('R-LP-14: one sandbox commit everywhere: the conformance workflow, the in-job sandbox-guard and the checkout; the guard runs before any target', () => {
  for (const f of ['live-probe.yml', 'live-probe-selftest.yml']) {
    const y = wf(f);
    const ref = /\n  SURFACE_CORPUS_REF: '([0-9a-f]{40})'\n/.exec(y)[1];
    assert.equal(ref, SANDBOX_PIN, f + ': at or after mcp-surface-corpus #8');
    const code = y.replace(/^\s*#.*$/gm, '');
    assert.match(code, new RegExp('\\n  sandbox:\\n(?:    .*\\n)*?    uses: isokron-ai/mcp-surface-corpus/\\.github/workflows/sandbox-conformance\\.yml@' + ref + ' # SURFACE_CORPUS_REF\\n    with:\\n      mutations: false\\n'), f);
    assert.match(code, new RegExp('uses: isokron-ai/mcp-surface-corpus/sandbox-guard@' + ref + ' # SURFACE_CORPUS_REF\\n'), f);
    assert.match(code, /needs\.sandbox\.outputs\.verdict == 'pass'/, f + ': no target unless the conformance check passed');
    const i = code.indexOf('sandbox-guard@'); const j = code.indexOf('id: plan'); const k = code.indexOf('run: corpus/live-probe-sandbox.sh');
    assert.ok(i > 0 && i < j && j < k, f + ': the guard runs before the plan and the sandbox step');
    assert.match(code, /GUARD_VERDICT: \$\{\{ steps\.guard\.outputs\.verdict \}\}\n          GUARD_SHA: \$\{\{ steps\.guard\.outputs\.sandbox-sha \}\}\n/);
  }
  const sh = readFileSync(join(root, 'corpus', 'live-probe-sandbox.sh'), 'utf8');
  assert.match(sh, /"\$\{GUARD_VERDICT:-\}" != pass .*"\$GUARD_SHA" != "\$msc_commit"/, 'no target unless the guard passed from the same commit');
  assert.ok(sh.indexOf('GUARD_VERDICT') < sh.indexOf('drive "$work/targets-controls.json"'));
});

test('R-LP-03: the self test checks a bundle\'s workflow commit against GITHUB_WORKFLOW_SHA, as the worker kit records it', () => {
  const exp = LP.expectedIdentity({ workflow: { file: '.github/workflows/live-probe-selftest.yml' } }, { fence: 2, run_key: 'b'.repeat(64) }, {}, { ATTEMPT_ID: 'a1', GITHUB_REPOSITORY: 'isokron-ai/mcp-check', GITHUB_SHA: '1'.repeat(40), GITHUB_WORKFLOW_SHA: '2'.repeat(40), GITHUB_RUN_ID: '9' });
  assert.deepEqual(exp, { attempt_id: 'a1', fence: 2, run_key: 'b'.repeat(64), repo: 'isokron-ai/mcp-check', workflow_file: '.github/workflows/live-probe-selftest.yml', workflow_sha: '2'.repeat(40), run_id: 9 });
});

test('R-LP-13: the probe job checks LOOP_ENABLED and the lane switch again, before anything else', () => {
  const y = wf('live-probe.yml').replace(/^\s*#.*$/gm, '');
  const job = y.split(/\n  (?=[a-z-]+:\n    )/).find((j) => j.startsWith('probe:'));
  const steps = job.split('\n      - ');
  assert.match(steps[1], /^name: Kill switch, again \(LOOP_ENABLED, LANE_LIVE_PROBE_ENABLED\)\n        env:\n          LOOP_ENABLED: \$\{\{ vars\.LOOP_ENABLED \}\}\n          LANE_LIVE_PROBE_ENABLED: \$\{\{ vars\.LANE_LIVE_PROBE_ENABLED \}\}\n/);
  assert.match(steps[1], /"\$LOOP_ENABLED" != "true" \]\]; then .*exit 1; fi/);
  assert.match(steps[2], /^name: Check the inputs\n/);
});

// ------------------------------------------------------------------ kill switch

test('live-probe kill switch: LOOP_ENABLED exactly true, a pause, and LANE_LIVE_PROBE_ENABLED', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const g = (env) => evaluateGuard(env, { lane: 'live-probe', now }).reason;
  assert.equal(g({ LOOP_ENABLED: 'true' }), 'enabled');
  assert.equal(g({ LOOP_ENABLED: 'TRUE' }), 'loop_disabled');
  assert.equal(g({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-11-24' }), 'paused');
  assert.equal(g({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: 'soon' }), 'pause_unreadable');
  assert.equal(g({ LOOP_ENABLED: 'true', LANE_LIVE_PROBE_ENABLED: 'false' }), 'lane_disabled');
  assert.equal(g({ LOOP_ENABLED: 'true', LANE_SCAN_STATIC_ENABLED: 'false' }), 'enabled', 'another lane\'s switch');
});

// ------------------------------------------------------------------ workflows

const wfDir = join(root, '.github', 'workflows');
const wf = (f) => readFileSync(join(wfDir, f), 'utf8');

test('live-probe workflow: dispatch only, the pump\'s inputs, kill switch first, inputs checked whole, one pinned worker-kit step per item', () => {
  const y = wf('live-probe.yml');
  const code = y.replace(/^\s*#.*$/gm, '');
  assert.match(y, /\non:\n  workflow_dispatch:\n    inputs:\n/);
  assert.ok(!/\n  (push|schedule|pull_request|workflow_call|pull_request_target|workflow_run):/.test(y));
  assert.deepEqual([...y.matchAll(/^      ([a-z_]+):\n        description:/gm)].map((m) => m[1]), ['shard_id', 'attempt_id', 'items', 'tool_sha']);
  assert.match(y, /\nrun-name: shard \$\{\{ inputs\.shard_id \}\}\n/);
  assert.match(y, /\npermissions: \{\}\n/);
  assert.ok(!/secrets\./.test(code));
  assert.ok(!/github\.event\./.test(code));
  for (const m of code.matchAll(/run: \|?\n?((?:.*\n)*?)(?=      - |\n?$)/g)) assert.ok(!/\$\{\{/.test(m[1]), 'an expression inside a run: script');
  for (const m of code.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  const jobs = code.split(/\n  (?=[a-z-]+:\n    )/);
  const job = (n) => jobs.find((j) => j.startsWith(n + ':'));
  for (const n of ['guard', 'probe']) {
    assert.match(job(n), /\n    timeout-minutes: \d+\n/, n);
    assert.match(job(n), /\n    permissions:\n      contents: read\n(?!      )/, n);
  }
  assert.ok(Number(/timeout-minutes: (\d+)/.exec(job('probe'))[1]) < 46, 'under the pump\'s lease of 46 minutes');
  const guardSteps = job('guard').split('\n      - ');
  assert.match(guardSteps[1], /^id: enabled\n.*\n        env:\n          LOOP_ENABLED: \$\{\{ vars\.LOOP_ENABLED \}\}\n/, 'the first step is the LOOP_ENABLED check');
  assert.match(job('guard'), /LANE_LIVE_PROBE_ENABLED: \$\{\{ vars\.LANE_LIVE_PROBE_ENABLED \}\}\n        run: node corpus\/loop-guard\.mjs --lane live-probe/);
  assert.match(job('probe'), /needs: \[guard, sandbox\]\n    if: needs\.guard\.outputs\.proceed == 'true' && needs\.sandbox\.outputs\.verdict == 'pass'\n/);
  assert.match(job('sandbox'), /needs: guard\n    if: needs\.guard\.outputs\.proceed == 'true'\n/);
  const steps = job('probe').split('\n      - ');
  assert.match(steps[2], /^name: Check the inputs\n/);
  assert.equal((steps[2].match(/\[\[ ! "\$[A-Z_]+" =~ \$[a-z_]+ \]\]/g) || []).length, 3);
  const names = steps.map((s) => (/name: (.*)/.exec(s) || [])[1]);
  assert.ok(names.indexOf('Run the controls and subjects in the sandbox') < names.indexOf('Check the controls and build the bundles'));
  assert.ok(names.indexOf('Check the controls and build the bundles') < names.indexOf('Seal and upload item 0'), 'no upload before the sandbox is gone and the controls passed');
  const ref = /\n  WORKER_KIT_REF: '([0-9a-f]{40})'\n/.exec(y)[1];
  const kit = steps.filter((s) => /uses: isokron-ai\/tool-qa\/worker-kit@/.test(s));
  assert.equal(kit.length, LP.MAX_ITEMS);
  kit.forEach((s, i) => {
    assert.match(s, new RegExp('uses: isokron-ai/tool-qa/worker-kit@' + ref + '( #.*)?\\n'));
    assert.match(s, new RegExp("steps\\.bundle\\.outcome == 'success' && steps\\.plan\\.outputs\\.has_" + i + " == 'true'"));
    assert.match(s, new RegExp("item-index: '" + i + "'\\n"));
    assert.match(s, new RegExp('fence: \\$\\{\\{ steps\\.plan\\.outputs\\.fence_' + i + ' \\}\\}'));
    assert.match(s, new RegExp('run-key: \\$\\{\\{ steps\\.plan\\.outputs\\.run_key_' + i + ' \\}\\}'));
    assert.match(s, new RegExp('/live-probe/out/' + i + '/bundle\\n'));
    assert.ok(!/dry-run/.test(s));
  });
  assert.match(y, /\n  SURFACE_CORPUS_REF: '[0-9a-f]{40}'\n/);
});

test('live-probe self test workflow: runs on pull requests the same steps as the worker, with dry-run bundles judged by tool-qa', () => {
  const y = wf('live-probe-selftest.yml');
  const w = wf('live-probe.yml');
  assert.match(y, /\non:\n  pull_request:\n    paths:\n/);
  assert.match(y, /\npermissions: \{\}\n/);
  assert.ok(!/pull_request_target|secrets\./.test(y.replace(/^\s*#.*$/gm, '')));
  for (const k of ['WORKER_KIT_REF', 'SURFACE_CORPUS_REF']) assert.equal(new RegExp('\\n  ' + k + ": '([0-9a-f]{40})'\\n").exec(y)[1], new RegExp('\\n  ' + k + ": '([0-9a-f]{40})'\\n").exec(w)[1], k);
  const between = (s) => s.slice(s.indexOf('      - id: deadline'), s.indexOf('      - id: bundle'));
  const norm = (s) => between(s).replace(/inputs\.shard_id/g, 'env.SHARD_ID').replace(/inputs\.attempt_id/g, 'env.ATTEMPT_ID').replace(/inputs\.items/g, 'env.ITEMS').replace(/inputs\.tool_sha/g, 'env.TOOL_SHA').replace(/LIVE_PROBE_FUZZ: .*\n/, 'LIVE_PROBE_FUZZ: X\n').replace(/      - name: The fixture items\n        run: .*\n/, '');
  assert.equal(norm(y), norm(w), 'the self test runs exactly the worker\'s steps');
  assert.equal((y.match(/dry-run: 'true'/g) || []).length, 4);
  assert.match(y, /node corpus\/live-probe\.mjs verify --ingest tool-qa-ingest tool-qa corpus\/fixtures\/live-probe\/selftest-shard\.json/);
});

test('live-probe workflows: the sparse checkout of tool-qa holds every file the plan and verify steps read', () => {
  for (const f of ['live-probe.yml', 'live-probe-selftest.yml']) {
    const block = /sparse-checkout: \|\n((?:            .*\n)+)/.exec(wf(f));
    assert.ok(block, f);
    const entries = block[1].trim().split(/\s+/);
    for (const need of LP.TOOL_QA_FILES) assert.ok(entries.some((e) => (e.endsWith('/') ? need.startsWith(e) : need === e)), f + ' lacks ' + need);
  }
});

test('the vendored tool-qa contract is unedited and at the commit WORKER_KIT_REF pins in live-probe.yml', () => {
  const vendored = JSON.parse(readFileSync(join(root, 'test', 'tool-qa', 'VENDORED.json'), 'utf8'));
  for (const f of vendored.files) assert.equal(createHash('sha256').update(readFileSync(join(root, 'test', 'tool-qa', f.path))).digest('hex'), f.sha256, f.path);
  assert.equal(vendored.commit, /\n  WORKER_KIT_REF: '([0-9a-f]{40})'\n/.exec(wf('live-probe.yml'))[1]);
  for (const r of new Set(Object.values(LP.DETAILS).map((d) => d[0]))) assert.ok(SKIP_REASONS.includes(r), r);
});

// ------------------------------------------------------------------ explicit skip reasons and faults (gate E)

/** One bundle per detail code, each built from a skipped resolution and judged by tool-qa's contract. */
function bundleEveryDetail() {
  const rk = (n) => n.toString(16).padStart(64, '0');
  const names = Object.keys(LP.DETAILS);
  const its = names.map((d, i) => ({ index: i, subject: 'acme/s' + i, repo: 'acme/s' + i, run_key: rk(i + 1), fence: i + 1, target_id: null, resolve_ms: 1,
    resolution: { status: 'skipped', detail: d, registry: null, choice: null, candidates: [], launch: null, subdir: null, seed_packages: 0 } }));
  const w = workFolder({ items: its });
  LP.bundleShard({ work: w });
  const out = {};
  names.forEach((d, i) => {
    const dir = join(w, 'out', String(i));
    const j = judge(dir, its[i]);
    out[d] = { meta: JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')), j, result: JSON.parse(j.files.get(LP.RESULT_PATH).toString('utf8')) };
  });
  return out;
}

test('R-LP-24: an image over our size cap is too_large with fault tool, never policy_excluded', () => {
  const b = bundleEveryDetail().image_too_large;
  assert.deepEqual(b.meta.skips, [{ stage: 'resolve', reason: 'too_large', fault: 'tool', evidence: LP.RESULT_PATH }]);
  assert.ok(b.j.v.ok, JSON.stringify(b.j.v.errors));
  assert.deepEqual(resultFault(b.j.manifest.skips), { fault: 'tool', coverage: 'unassessed_tool', faults: { tool: 1 } });
  assert.equal(b.result.skip_reason, 'too_large');
  assert.equal(b.result.fault, 'tool');
});

test('R-LP-25: an OCI host off our allowlist is our gap (no_runnable_artifact, fault tool), not an exclusion', () => {
  const b = bundleEveryDetail().oci_host_not_allowed;
  assert.deepEqual(b.meta.skips, [{ stage: 'resolve', reason: 'no_runnable_artifact', fault: 'tool', evidence: LP.RESULT_PATH }]);
  assert.ok(b.j.v.ok, JSON.stringify(b.j.v.errors));
  assert.equal(resultFault(b.j.manifest.skips).coverage, 'unassessed_tool', 'counted as unassessed on our side, not excluded');
  assert.equal(b.result.fault, 'tool');
});

test('R-LP-26: a harness failure is tool_error with fault tool (retryable), not upstream_unavailable', () => {
  const all = bundleEveryDetail();
  const b = all.harness_error;
  assert.deepEqual(b.meta.skips, [{ stage: 'start', reason: 'tool_error', fault: 'tool', evidence: LP.RESULT_PATH, retryable: true }]);
  assert.ok(b.j.v.ok, JSON.stringify(b.j.v.errors));
  assert.equal(resultFault(b.j.manifest.skips).fault, 'tool');
  // An unknown detail falls back to the same record.
  assert.deepEqual(LP.DETAILS.harness_error.slice(0, 2), ['tool_error', true]);
  // The engine refusing a list is our error too.
  assert.deepEqual(all.list_rejected.meta.skips, [{ stage: 'grade', reason: 'tool_error', fault: 'tool', evidence: LP.RESULT_PATH }]);
});

test('R-LP-27: every skip names its fault explicitly, tool-qa allows that fault for its reason, and no limit of ours is policy or infra', () => {
  const all = bundleEveryDetail();
  for (const [d, [reason, , , fault]] of Object.entries(LP.DETAILS)) {
    const { meta, j, result } = all[d];
    assert.equal(meta.skips.length, 1, d);
    assert.equal(meta.skips[0].reason, reason, d);
    assert.equal(meta.skips[0].fault, fault, d + ': fault is set on the skip');
    assert.ok(SKIP_FAULTS[reason].allowed.includes(fault), d + ': ' + fault + ' is allowed for ' + reason);
    assert.ok(j.v.ok, d + ' ' + JSON.stringify(j.v.errors));
    assert.equal(result.fault, fault, d);
  }
  // Our own limits and errors: tool, and none under policy_excluded.
  for (const d of ['bad_subject', 'unsupported_package', 'unverified_registry_entry', 'oci_host_not_allowed', 'image_too_large', 'launch_invalid', 'unsupported_transport', 'install_timeout', 'list_rejected', 'harness_error', 'sandbox_evidence_missing', 'start_timeout', 'private_registry']) assert.equal(LP.DETAILS[d][3], 'tool', d);
  assert.ok(!Object.values(LP.DETAILS).some((x) => x[0] === 'policy_excluded'), 'this lane never excludes by policy');
});

test('live-probe docs exist and name the fixtures', () => {
  const doc = readFileSync(join(root, 'corpus', 'LIVE-PROBE.md'), 'utf8');
  assert.match(doc, /live-probe/);
  assert.ok(readdirSync(join(root, 'corpus', 'fixtures', 'live-probe')).includes('forgery-server.js'));
});

test('R-LP-28: a start that ran out of time and a private registry are our limits, not the server\'s (fault tool)', () => {
  // The subject's time budget also pays for the install, so a slow runner or a slow sandbox start can run it out:
  // that is no evidence the server hung. A private registry is unreachable because we reach only the default registries.
  assert.equal(LP.DETAILS.start_timeout[3], 'tool');
  assert.equal(LP.DETAILS.private_registry[3], 'tool');
});

test('R-LP-43: no_package is the tool\'s: having no registry package is no server defect (Go and Rust binaries, other npm names, own-registry images)', () => {
  assert.deepEqual(LP.DETAILS.no_package, ['no_runnable_artifact', false, 'resolve', 'tool']);
  assert.equal(LP.DETAILS.remote_only[3], 'subject', 'remote_only stays the subject\'s');
});

const CONFIG_ERRS = {
  'hyper-mcp': 'INFO hyper_mcp::plugins: Using config file at /tmp/home/.config/hyper-mcp/config.json\nError: Config file not found at: /tmp/home/.config/hyper-mcp/config.json. Please create a config file first.',
  'apollo-mcp-server': "Error: failed to read config file '/config.yaml': No such file or directory (os error 2)",
  'kubernetes-mcp-server': "Error: unable to create kubernetes target provider: no current-context is set and no contexts are defined in kubeconfig.\nConfigure a context with 'kubectl config set-context <name>' ...\nUsage:\n  kubernetes-mcp-server [flags]",
};

test('R-LP-44: an exit whose stderr asks for configuration (config file, kubeconfig, usage, required argument) is start_needs_config (tool), not start_failed', () => {
  assert.deepEqual(LP.DETAILS.start_needs_config, ['timeout_start', false, 'start', 'tool']);
  for (const [name, stderr] of Object.entries(CONFIG_ERRS)) {
    assert.match(stderr, LP.CONFIG_TEXT, name);
    assert.equal(LP.failureDetail(lpRec(), { ...probeExit(1, null, 150), stderr }, null, OK), 'start_needs_config', name);
  }
  for (const s of ['error: missing required argument --db', 'Error: the --config flag is required', 'environment variable HOME_DIR is required', 'Please set the ROOT variable', 'usage: srv [options]']) {
    assert.match(s, LP.CONFIG_TEXT, s);
  }
  // Only the server's own exit counts: a signal, 127 or a late exit with the same text are not it.
  const stderr = CONFIG_ERRS['apollo-mcp-server'];
  assert.equal(LP.failureDetail(lpRec(), { ...probeExit(127), stderr }, null, OK), 'start_env_limited');
  assert.equal(LP.failureDetail(lpRec(), { ...probeExit(null, 'SIGTERM'), stderr }, null, OK), 'start_env_limited');
  // The declared-env path is unchanged.
  assert.equal(LP.failureDetail(lpRec({ env: needEnv }), { ...probeExit(1), stderr }, null, OK), 'needs_credentials');
});

test('R-LP-45: start_failed needs a crash signature on stderr; an early exit with empty stderr is start_env_limited; config text wins over crash text', () => {
  assert.equal(LP.failureDetail(lpRec(), probeExit(1), null, OK), 'start_env_limited', 'empty stderr');
  assert.equal(LP.failureDetail(lpRec(), { ...probeExit(1), stderr: 'something went wrong' }, null, OK), 'start_env_limited', 'stderr with no signature');
  const crashes = {
    panic: "thread 'main' panicked at src/main.rs:10:5:\ncalled `Option::unwrap()` on a `None` value",
    traceback: 'Traceback (most recent call last):\n  File "server.py", line 3, in <module>\nKeyError: 1',
    uncaught: 'node:internal/process:1\n  throw err;\nUncaught Exception: boom',
    unhandled: 'Unhandled promise rejection: Error: x',
    missing_module: "Error: Cannot find module '/work/pkg/node_modules/x/dist/server.js'",
    go_panic: 'panic: runtime error: invalid memory address',
    segv: 'Segmentation fault (core dumped)',
  };
  for (const [name, stderr] of Object.entries(crashes)) {
    assert.match(stderr, LP.CRASH_TEXT, name);
    assert.equal(LP.failureDetail(lpRec(), { ...probeExit(1), stderr }, null, OK), 'start_failed', name);
  }
  // A bare dependency npm did not install is not ours to tell (R-LP-60): an optional or native one, or an undeclared one.
  assert.match("Error: Cannot find module 'zod'", LP.CRASH_TEXT);
  assert.equal(LP.failureDetail(lpRec(), { ...probeExit(1), stderr: "Error: Cannot find module 'zod'" }, null, OK), 'start_env_limited');
  const frame = '\n    at Object.<anonymous> (/app/index.js:3:1)';
  for (const s of ['ModuleNotFoundError: No module named x', 'ImportError: cannot import name y', 'SyntaxError: invalid syntax', 'ReferenceError: z is not defined' + frame, 'TypeError: x is not a function' + frame, 'fatal error: all goroutines are asleep - deadlock!\n\ngoroutine 1 [chan receive]:', 'RangeError: Maximum call stack size exceeded' + frame]) assert.match(s, LP.CRASH_TEXT, s);
  // Config text wins over crash text.
  const both = 'Traceback (most recent call last):\n  File "s.py"\nFileNotFoundError: config file not found at /etc/x.json';
  assert.match(both, LP.CRASH_TEXT);
  assert.equal(LP.failureDetail(lpRec(), { ...probeExit(1), stderr: both }, null, OK), 'start_needs_config');
  // The other guards still apply to a crash.
  assert.equal(LP.failureDetail(lpRec(), crashExit(1, null, LP.START_QUICK_MS), null, OK), 'start_env_limited');
});

test('R-PIN-07: the bundles report this repository at the commit that ran, the corpus commit used, and fuzz only when the stage ran', () => {
  const COMMIT = 'd4a373a0123456789abcdef0123456789abcdef0'.slice(0, 40);
  const toolsOf = (w, i) => JSON.parse(readFileSync(join(w, 'out', String(i), 'meta.json'), 'utf8')).tools;
  const w = workFolder();
  LP.bundleShard({ work: w, env: { MCP_CHECK_COMMIT: COMMIT } });
  for (const i of [0, 1, 2, 3]) {
    const t = toolsOf(w, i);
    assert.equal(t[0].name, '@isokron/mcp-check');
    assert.equal(t[0].version, COMMIT);
    assert.deepEqual(t.map((c) => c.name), ['@isokron/mcp-check', 'isokron-ai/mcp-surface-corpus'], 'no fuzz entry while the stage is off');
    assert.match(t[1].version, /^[0-9a-f]{40}$/);
  }
  // Outside the workflow (no commit handed in): the package version, which tool-qa counts as unproven, never as wrong.
  const w2 = workFolder();
  LP.bundleShard({ work: w2, env: {} });
  assert.equal(toolsOf(w2, 0)[0].version, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
  // The fuzz stage on: its pin is proven by the same commit.
  const w3 = workFolder();
  const plan = JSON.parse(readFileSync(join(w3, 'plan.json'), 'utf8'));
  writeFileSync(join(w3, 'plan.json'), JSON.stringify({ ...plan, fuzz: true }));
  LP.bundleShard({ work: w3, env: { MCP_CHECK_COMMIT: COMMIT } });
  assert.deepEqual(toolsOf(w3, 0).map((c) => c.name), ['@isokron/mcp-check', 'isokron-ai/mcp-surface-corpus', 'fuzz']);
  assert.equal(toolsOf(w3, 0)[2].version, COMMIT);
});

// R-LP-75. formulahendry/mcp-server-spec-driven-development@8a0532a2eb15 (npm): its initialize declares prompts only, and
// tools/list answers JSON-RPC -32601 "Method not found", which the specification lets a server without the tools
// capability answer. 6 results of 25-27 Nov recorded it as list_failed, fault subject.
const promptsOnly = (caps = { prompts: {} }, code = -32601, error = 'Method not found') => ({
  format: 'isokron-surface-probe/1', mode: 'bare', protocol_offered: '2025-11-25', era: 'legacy', error: null,
  initialize: { protocolVersion: '2025-11-25', capabilities: caps, serverInfo: { name: 'mcp-server-spec-driven-development', version: '0.3.0' } },
  lists: { 'tools/list': { ok: false, items: null, pages: 0, page_sizes: [], error, error_code: code, ms: 4 } },
  transport: { exit: null, signal: null, non_json_lines: 0, notifications: [] }, timing: { initialize_ms: 310, total_ms: 420 },
});

test('R-LP-75: a server that declared no tools capability and answered tools/list "method not found" is nothing to grade and nobody\'s fault, never list_failed', () => {
  assert.equal(LP.noToolsCapability(promptsOnly()), true);
  assert.equal(LP.noToolsCapability(promptsOnly({})), true, 'an empty capabilities object declares no tools');
  assert.equal(LP.noToolsCapability({ ...promptsOnly(), initialize: { protocolVersion: '2025-11-25' } }), false, 'no capabilities object is a malformed answer, not no tools');
  assert.equal(LP.noToolsCapability(promptsOnly({ tools: {} })), false, 'a server that declared tools must list them');
  assert.equal(LP.noToolsCapability(promptsOnly({ prompts: {} }, -32603, 'Internal error')), false, 'another error is still the server\'s');
  assert.equal(LP.noToolsCapability({ ...promptsOnly(), initialize: null, era: 'modern' }), false, 'no initialize answer: nothing declared that we read');
  const rec = JSON.parse(fx('record-ok.json'));
  assert.equal(LP.failureDetail(rec, promptsOnly(), null), 'no_tools_capability');
  assert.equal(LP.failureDetail(rec, promptsOnly({ tools: {} }), null), 'list_failed');
  assert.notEqual(LP.DETAILS.no_tools_capability[3], 'subject');
  // Through the bundle: status no_tools, no skip (fault none, coverage assessed), a bundle tool-qa accepts.
  const w = workFolder();
  writeFileSync(join(w, 'driver-subjects', 's002', 'probe-bare.json'), JSON.stringify(promptsOnly()));
  writeFileSync(join(w, 'driver-subjects', 's002', 'record.json'), fx('record-ok.json'));
  const summary = LP.bundleShard({ work: w, log: () => {} });
  assert.deepEqual(summary[1], { index: 1, status: 'no_tools', detail: null });
  const dir = join(w, 'out', '1');
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  assert.deepEqual(meta.skips, []);
  assert.deepEqual(resultFault(meta.skips), { fault: null, coverage: 'assessed', faults: {} });
  const result = JSON.parse(readFileSync(join(dir, 'bundle', LP.RESULT_PATH), 'utf8'));
  assert.deepEqual([result.status, result.detail, result.fault, result.live], ['no_tools', 'no_tools_capability', null, { tools_capability: false, tool_count: 0, config_state: 'none' }]);
  const obsLines = readFileSync(join(dir, 'bundle', 'observations', 'live.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(obsLines.find((o) => o.field === 'capabilities_flags').value.tools, false);
  assert.ok(!obsLines.some((o) => o.field === 'error_taxonomy_code'));
  const item = JSON.parse(readFileSync(join(w, 'plan.json'), 'utf8')).items[1];
  const j = judge(dir, item);
  assert.ok(j.v.ok, JSON.stringify(j.v.errors));
  assert.deepEqual(j.problems, []);
});

// R-LP-76. The 25-27 Nov retry_later rejections: getsigit/si@edd8da4f368e (11 attempts) and anderson-0/qh@cea4812df0f4 (18):
// the registry search with the 2-character repo name answers HTTP 422; SubmitRocket/wpmission-mcp-server@7d8bd3435153
// (19 attempts): ghcr's token service answers 403 DENIED for ghcr.io/support-wpmission/wpmission-mcp-server. All were
// upstream_error (infra, retryable) and came back every cycle.
test('R-LP-76: a registry 4xx is our refused query (tool, not retried), a denied pull token is image_access_denied (tool), a 2-character search is never sent, and a bug in the resolver is never an outage', async () => {
  assert.equal(LP.httpDetail(422), 'registry_query_refused');
  assert.equal(LP.httpDetail(400), 'registry_query_refused');
  // A 403 without rate-limit headers (a CDN or firewall in front of a registry), 408 and 425 stay retryable.
  for (const s of [403, 408, 425]) assert.equal(LP.httpDetail(s, () => null), 'upstream_error', String(s));
  assert.equal(LP.httpDetail(401), 'registry_query_refused');
  assert.equal(LP.httpDetail(429), 'rate_limited');
  assert.equal(LP.httpDetail(403, (k) => (k === 'x-ratelimit-remaining' ? '0' : null)), 'rate_limited');
  for (const s of [500, 502, 503]) assert.equal(LP.httpDetail(s), 'upstream_error', String(s));
  assert.deepEqual(LP.DETAILS.registry_query_refused, ['tool_error', false, 'resolve', 'tool']);
  assert.deepEqual(LP.DETAILS.image_access_denied, ['install_failed_registry', false, 'resolve', 'tool']);
  assert.deepEqual(LP.DETAILS.resolver_error, ['tool_error', false, 'resolve', 'tool']);
  for (const d of ['registry_query_refused', 'image_access_denied', 'resolver_error', 'no_tools_capability']) assert.ok(SKIP_FAULTS[LP.DETAILS[d][0]].allowed.includes(LP.DETAILS[d][3]), d);
  // A registry that refuses 2-character searches, as registry.modelcontextprotocol.io does (re-checked 27 Nov: si and qh 422, abc 200).
  const strict = (base) => { const f = async (url, init) => { const q = new URL(url).searchParams.get('search'); if (q !== null && q.length < 3) { f.refused.push(q); return res(422, { title: 'Unprocessable Entity' }); } return base(url, init); }; f.refused = []; return f; };
  const si = strict(fakeFetch([server('io.github.getsigit/si', 'getsigit/si', [npmPkg('@getsigit/si')])]));
  const r = await LP.resolveSubject({ subject: 'getsigit/si', repo: 'getsigit/si' }, { fetch: si });
  assert.deepEqual(si.refused, [], 'no query shorter than the registry minimum is sent');
  assert.equal(r.status, 'runnable', 'owner/name still finds the entry');
  // A query the registry refuses anyway is ours and final.
  const refuse = await LP.resolveSubject({ subject: 'acme/box', repo: 'acme/box' }, { fetch: fakeFetch([], { status: 422 }) });
  assert.equal(refuse.detail, 'registry_query_refused');
  assert.equal(LP.DETAILS[refuse.detail][1], false, 'not retryable');
  // ghcr's token service: 403 DENIED for the repository. Ours (private or gone look alike), not retried.
  const denied = async (url, init = {}) => { const u = new URL(url); if (u.pathname === '/token') return res(403, { errors: [{ code: 'DENIED', message: 'requested access to the resource is denied' }] }); if (!init.headers.authorization) return res(401, '', { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' }); return res(200, goodImage); };
  assert.equal(await ociCode(denied, LP.parseOciRef('ghcr.io/support-wpmission/wpmission-mcp-server:0.1.0')), 'image_access_denied');
  const wp = await LP.resolveSubject({ subject: 'SubmitRocket/wpmission-mcp-server', repo: 'SubmitRocket/wpmission-mcp-server' }, { seed: new Map([['submitrocket/wpmission-mcp-server', [{ registry: 'oci', identifier: 'ghcr.io/support-wpmission/wpmission-mcp-server:0.1.0' }]]]), fetch: async (url, init) => (new URL(url).hostname === 'registry.modelcontextprotocol.io' ? res(200, { servers: [] }) : denied(url, init)) });
  assert.equal(wp.detail, 'image_access_denied');
  // A rate limit at the token service is still a rate limit; an outage is still retryable.
  const limited = async (url, init = {}) => { const u = new URL(url); if (u.pathname === '/token') return res(429, ''); if (!init.headers.authorization) return res(401, '', { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' }); return res(200, goodImage); };
  assert.equal(await ociCode(limited), 'rate_limited');
  assert.equal((await LP.resolveSubject({ subject: 'a/b', repo: 'a/b' }, { fetch: fakeFetch([], { status: 503 }) })).detail, 'upstream_error');
  // One candidate's provenance refused (npm answers 410 for its attestations): that candidate is unverified, the next one runs.
  // Both entries match on their repository URL only, so each package's provenance is asked; the npm one comes first.
  const prov = fakeFetch([server('com.example/x', 'acme/prov', [npmPkg('@other/prov-x')]), server('com.example/y', 'acme/prov', [{ registryType: 'oci', identifier: 'ghcr.io/acme/prov:1', transport: { type: 'stdio' } }])], { oci: { 'ghcr.io': () => res(200, goodImage) } });
  const provFetch = async (url, init) => (new URL(url).hostname === 'registry.npmjs.org' ? res(410, {}) : prov(url, init));
  const pr = await LP.resolveSubject({ subject: 'acme/prov', repo: 'acme/prov' }, { fetch: provFetch });
  assert.equal(pr.status, 'runnable', 'the refused candidate does not end the subject');
  assert.equal(pr.launch.kind, 'docker');
  assert.equal(pr.choice.verified_by, 'ghcr_owner');
  // An exception of ours (no detail code) is resolver_error, with its class kept.
  const bug = await LP.resolveSubject({ subject: 'acme/box', repo: 'acme/box' }, { seed: new Map([['acme/box', [{ registry: 'npm', identifier: 5 }]]]), fetch: fakeFetch([]) });
  assert.deepEqual([bug.detail, bug.error_class], ['resolver_error', 'TypeError']);
});

test('R-LP-88: an item that names a commit (sha) pins its sandbox target to that commit instead of the branch head; anything but a full sha is refused', async () => {
  const ASKED = 'a'.repeat(40);
  const f = fakeFetch([server('io.github.a/one', 'a/one', [npmPkg('one')]), server('io.github.a/two', 'a/two', [npmPkg('two')])]);
  const inputs = LP.parseInputs({ shardId: 's', attemptId: 'a1', items: JSON.stringify([{ subject: 'a/one', run_key: 'a'.repeat(64), fence: 1, sha: ASKED }, { subject: 'a/two', run_key: 'b'.repeat(64), fence: 2 }]) });
  assert.deepEqual(inputs.items.map((x) => x.sha ?? null), [ASKED, null]);
  const plan = await LP.planShard({ inputs, fetch: f, marker: MARKER, validateTarget: (t) => { if ((t.commit === undefined) === (t.ref === undefined)) throw new Error('exactly one of commit or ref'); } });
  assert.equal(plan.items[0].target.commit, ASKED);
  assert.equal('ref' in plan.items[0].target, false);
  assert.equal(plan.items[1].target.ref, 'HEAD');
  assert.equal('commit' in plan.items[1].target, false);
  for (const bad of ['main', 'A'.repeat(40), 'a'.repeat(41), 1]) {
    assert.throws(() => LP.parseInputs({ shardId: 's', attemptId: 'a1', items: JSON.stringify([{ subject: 'a/one', run_key: 'a'.repeat(64), fence: 1, sha: bad }]) }), (e) => e.code === 'bad_sha');
  }
  assert.throws(() => LP.parseInputs({ shardId: 's', attemptId: 'a1', items: JSON.stringify([{ subject: 'a/one', run_key: 'a'.repeat(64), fence: 1, extra: 1 }]) }), (e) => e.code === 'bad_item');
});
