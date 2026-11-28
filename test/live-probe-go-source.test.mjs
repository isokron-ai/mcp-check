// The live-probe lane's Go-from-source path (corpus/go-entry.mjs, corpus/live-probe.mjs, R-LP-91..95): a Go repository
// with no registry package is built in the sandbox with `go install <package path>@<full commit>` (mcp-surface-corpus
// launchPlan, kind go, R-SBX-62). Here: which package is chosen, how the commit is pinned, what is ours and what is
// nobody's fault, what the token may reach, and the proof's own check. The sandbox's side (image, flags, hosts) is tested
// in isokron-ai/mcp-surface-corpus (test/package-kinds.test.mjs). Each protection has a mutation check: with it taken
// out of a copy of the module, the fixture that pins it gets through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as LP from '../corpus/live-probe.mjs';
import * as GO from '../corpus/go-entry.mjs';
import * as PROOF from '../corpus/go-proof-check.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const MARKER = 'liveprobe-' + 'a'.repeat(32);
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const SHA = 'ab'.repeat(20);

/** A copy of a corpus file with one protection taken out, beside the original so its imports resolve. */
async function mutant(from, to, file = 'go-entry.mjs') {
  const src = readFileSync(join(root, 'corpus', file), 'utf8');
  assert.ok(src.includes(from), 'the mutation text is in corpus/' + file + ': ' + from.slice(0, 80));
  const out = join(root, 'corpus', '.mutant-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
  writeFileSync(out, src.replace(from, to));
  try { return await import(pathToFileURL(out).href); } finally { rmSync(out, { force: true }); }
}

function res(status, body, headers = {}) {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : headers[k.toLowerCase()] ?? null) }, arrayBuffer: async () => buf };
}

/**
 * A fetch with an empty MCP registry and a GitHub repository made of `files` ({ path: text }), served as GitHub's
 * trees and blobs API serves it. The repository's tree (and commit) id is `top`. Every call is kept in `calls`.
 */
function world(files, { top = SHA, rate = false, status = null, redirectTo = null } = {}) {
  const trees = new Map(); const blobs = new Map(); const calls = [];
  const build = (prefix) => {
    const names = new Map();
    for (const p of Object.keys(files)) {
      if (!p.startsWith(prefix)) continue;
      const [first, ...more] = p.slice(prefix.length).split('/');
      names.set(first, more.length ? 'tree' : 'blob');
    }
    return [...names].map(([name, type]) => {
      const path = prefix + name;
      if (type === 'blob') { const id = sha1('blob:' + path + files[path]); blobs.set(id, files[path]); return { path: name, type, sha: id, size: Buffer.byteLength(files[path]) }; }
      const id = sha1('tree:' + path); trees.set(id, build(path + '/')); return { path: name, type, sha: id };
    });
  };
  trees.set(top, build(''));
  const f = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: String(url), host: u.hostname, auth: init.headers && init.headers.authorization, redirect: init.redirect });
    if (u.hostname === 'registry.modelcontextprotocol.io') return res(200, { servers: [] });
    if (u.hostname !== 'api.github.com') throw new Error('unexpected fetch ' + url);
    if (rate) return res(403, { message: 'rate limit' }, { 'x-ratelimit-remaining': '0' });
    if (status) return res(status, {});
    if (redirectTo && !u.pathname.startsWith('/repositories/')) return res(301, '', { location: redirectTo });
    const m = /^\/(?:repos\/[^/]+\/[^/]+|repositories\/\d+)\/(commits\/HEAD|git\/trees\/([0-9a-f]{40})|git\/blobs\/([0-9a-f]{40}))$/.exec(u.pathname);
    if (!m) return res(404, {});
    if (m[1] === 'commits/HEAD') return res(200, { sha: top });
    if (m[2]) return trees.has(m[2]) ? res(200, { sha: m[2], tree: trees.get(m[2]), truncated: false }) : res(404, {});
    return blobs.has(m[3]) ? res(200, { sha: m[3], encoding: 'base64', content: Buffer.from(blobs.get(m[3])).toString('base64'), size: blobs.get(m[3]).length }) : res(404, {});
  };
  f.calls = calls;
  return f;
}

const GOMOD = (m = 'github.com/acme/widget') => 'module ' + m + '\n\ngo 1.23\n\nrequire github.com/mark3labs/mcp-go v0.32.0\n';
const MAIN = 'package main\n\nfunc main() {}\n';
const LIB = 'package widget\n';
const resolve = (files, item = {}, o = {}) => { const w = world(files, o); return LP.resolveSubject({ subject: 'acme/widget', repo: 'acme/widget', ...item }, { fetch: w, ghToken: o.token ?? null }).then((r) => Object.assign(r, { calls: w.calls })); };

test('R-LP-91: the picker takes the module root when it is a main package, else the one main package under cmd/, else the one named for the repository or the registry name; several and none named is entry_ambiguous, none at all is no_main_package', async () => {
  const P = GO.pickMain;
  assert.deepEqual(P({ root: { main: true }, cmds: [{ name: 'a', main: true }, { name: 'b', main: true }], names: [] }), { dir: '' }, 'the module root first, whatever lies under cmd/');
  assert.deepEqual(P({ root: { main: false }, cmds: [{ name: 'tool', main: true }, { name: 'gen', main: false }], names: ['widget'] }), { dir: 'cmd/tool' }, 'the one main package, though its name is not the repository\'s');
  assert.deepEqual(P({ root: { main: false }, cmds: [{ name: 'widget', main: true }, { name: 'other', main: true }], names: ['widget'] }), { dir: 'cmd/widget' }, 'named for the repository');
  assert.deepEqual(P({ root: { main: false }, cmds: [{ name: 'Server', main: true }, { name: 'other', main: true }], names: ['io.github.acme/server'.split('/').pop()] }), { dir: 'cmd/Server' }, 'named for the registry name, case aside');
  const amb = P({ root: { main: false }, cmds: [{ name: 'a', main: true }, { name: 'b', main: true }], names: ['widget'] });
  assert.equal(amb.detail, 'entry_ambiguous');
  assert.deepEqual(amb.candidates, ['a', 'b']);
  assert.equal(P({ root: { main: false }, cmds: [{ name: 'widget', main: true }, { name: 'widget', main: true }], names: ['widget'] }).detail, 'entry_ambiguous', 'two named alike are still a guess');
  assert.equal(P({ root: { main: false }, cmds: [{ name: 'a', main: false }], names: ['a'] }).detail, 'no_main_package');
  assert.equal(P({ root: { main: false }, cmds: [], names: [] }).detail, 'no_main_package');
  // The mutation checks: each rule taken out lets its fixture through.
  const m1 = await mutant("if (root && root.main === true) return { dir: '' };", '');
  assert.notDeepEqual(m1.pickMain({ root: { main: true }, cmds: [{ name: 'a', main: true }, { name: 'b', main: true }], names: [] }), { dir: '' });
  const m2 = await mutant("if (mains.length === 1) return { dir: 'cmd/' + mains[0].name };", '');
  assert.equal(m2.pickMain({ root: { main: false }, cmds: [{ name: 'tool', main: true }], names: ['widget'] }).detail, 'entry_ambiguous');
  const m3 = await mutant("if (named.length === 1) return { dir: 'cmd/' + named[0].name };", '');
  assert.equal(m3.pickMain({ root: { main: false }, cmds: [{ name: 'widget', main: true }, { name: 'other', main: true }], names: ['widget'] }).detail, 'entry_ambiguous');
  const m4 = await mutant("if (!mains.length) return { detail: 'no_main_package' };", '');
  assert.notEqual(m4.pickMain({ root: { main: false }, cmds: [], names: [] }).detail, 'no_main_package');
  const m5 = await mutant("const named = mains.filter((c) => want.has(norm(c.name)));", 'const named = mains.slice(0, 1);');
  assert.deepEqual(m5.pickMain({ root: { main: false }, cmds: [{ name: 'a', main: true }, { name: 'b', main: true }], names: ['widget'] }), { dir: 'cmd/a' }, 'a guess without the name rule');
});

test('R-LP-91: go.mod and package clauses are read as data: the module line, replace and exclude (block or line, not a name that begins with them), comments, build-ignored generators and test files', () => {
  assert.equal(GO.parseGoMod('// c\nmodule github.com/a/b // x\n\ngo 1.23\n').module, 'github.com/a/b');
  assert.equal(GO.parseGoMod('module "github.com/a/b"\n').module, 'github.com/a/b');
  assert.equal(GO.parseGoMod('/* module x.y/z */\nmodule github.com/a/b\n').module, 'github.com/a/b');
  assert.deepEqual([GO.parseGoMod(GOMOD()).replace, GO.parseGoMod(GOMOD()).exclude], [false, false]);
  assert.equal(GO.parseGoMod(GOMOD() + 'replace github.com/x/y => ../y\n').replace, true);
  assert.equal(GO.parseGoMod(GOMOD() + 'replace (\n\tgithub.com/x/y => ../y\n)\n').replace, true);
  assert.equal(GO.parseGoMod(GOMOD() + 'exclude github.com/x/y v1.0.0\n').exclude, true);
  assert.equal(GO.parseGoMod(GOMOD() + '// replace github.com/x/y => ../y\n').replace, false, 'a comment is no directive');
  assert.equal(GO.parseGoMod(GOMOD() + 'require (\n\treplacement.example/x v1.0.0\n)\n').replace, false, 'a module whose name begins with replace');
  assert.equal(GO.parseGoMod('go 1.23\n').module, null);
  assert.deepEqual(GO.packageHead('// Command x does y.\npackage main\n'), { name: 'main', ignored: false });
  assert.deepEqual(GO.packageHead('/* licence */\n\n// doc\npackage widget_test\n'), { name: 'widget_test', ignored: false });
  assert.deepEqual(GO.packageHead('//go:build ignore\n\npackage main\n'), { name: 'main', ignored: true });
  assert.deepEqual(GO.packageHead('// +build ignore\n\npackage main\n'), { name: 'main', ignored: true });
  assert.equal(GO.packageHead('//go:build linux\n\npackage main\n').ignored, false, 'another constraint is not a generator');
  assert.equal(GO.packageHead('import "x"\n'), null);
  assert.equal(GO.packageHead('/* open'), null);
  const names = GO.goFilesOf([{ type: 'blob', path: 'a_test.go', sha: SHA }, { type: 'blob', path: 'z.go', sha: SHA }, { type: 'blob', path: 'main.go', sha: SHA }, { type: 'tree', path: 'x.go', sha: SHA }, { type: 'blob', path: 'README.md', sha: SHA }, { type: 'blob', path: 'b.go', sha: 'zz' }]).map((e) => e.path);
  assert.deepEqual(names, ['main.go', 'z.go'], 'main.go first, no tests, no folders, no bad ids');
});

test('R-LP-92: a repository with no registry package and a main package at its module root is built at its commit: go install <module>@<full commit>, never latest, the target pinned to that commit', async () => {
  const r = await resolve({ 'go.mod': GOMOD(), 'main.go': MAIN, 'widget/w.go': LIB });
  assert.equal(r.status, 'runnable');
  assert.deepEqual(r.launch, { kind: 'go', module: 'github.com/acme/widget', version: SHA });
  assert.equal(r.commit, SHA, 'the commit read is the commit built');
  assert.equal(r.choice.type, 'go');
  assert.equal(r.choice.purl, 'pkg:golang/github.com/acme/widget@' + SHA);
  assert.equal(r.choice.matched_by, 'repository');
  assert.equal(r.choice.verified_by, 'source_commit');
  assert.ok(!JSON.stringify(r.launch).includes('latest'));
  assert.ok(LP.isBuild(r.launch), 'it builds in the sandbox, after the other subjects, with the build allowance');
  // A commit the dispatch names is the commit built; GitHub is not asked for the head.
  const named = 'cd'.repeat(20);
  const r2 = await resolve({ 'go.mod': GOMOD(), 'main.go': MAIN }, { sha: named }, { top: named });
  assert.equal(r2.launch.version, named);
  assert.ok(!r2.calls.some((c) => c.url.endsWith('/commits/HEAD')));
  // The shard plan pins the sandbox target to that commit (not HEAD), and the build runs after the other subjects.
  const inputs = LP.parseInputs({ shardId: 's', attemptId: 'a1', items: JSON.stringify([{ subject: 'acme/widget', run_key: 'a'.repeat(64), fence: 1 }]) });
  const w = world({ 'go.mod': GOMOD(), 'main.go': MAIN });
  const plan = await LP.planShard({ inputs, fetch: w, marker: MARKER, ghToken: null });
  assert.equal(plan.items[0].target.commit, SHA);
  assert.ok(!('ref' in plan.items[0].target));
  assert.equal(plan.items[0].target.launch.version, SHA);
  const lists = LP.targetLists(plan, { node24Image: 'docker.io/library/node:24-bookworm-slim@sha256:' + 'c'.repeat(64) });
  assert.deepEqual(lists.builds.targets.map((t) => t.id), ['s001']);
  assert.deepEqual(lists.subjects.targets.map((t) => t.id), []);
  assert.ok(plan.items[0].target.timeout_s >= LP.BUILD_ALLOWANCE_S);
  // The mutation check: a target that follows HEAD builds what it did not read.
  const M = await mutant("...(it.sha ? { commit: it.sha } : r.commit ? { commit: r.commit } : { ref: 'HEAD' })", "...(it.sha ? { commit: it.sha } : { ref: 'HEAD' })", 'live-probe.mjs');
  const plan2 = await M.planShard({ inputs, fetch: world({ 'go.mod': GOMOD(), 'main.go': MAIN }), marker: MARKER, ghToken: null });
  assert.equal(plan2.items[0].target.ref, 'HEAD');
});

test('R-LP-92: with no main package at the root, one main package under cmd/ is built; several are told apart by the name of the repository or its server.json, else entry_ambiguous (ours); only a main package counts', async () => {
  const one = await resolve({ 'go.mod': GOMOD(), 'widget.go': LIB, 'cmd/tool/main.go': MAIN, 'cmd/gen/gen.go': '//go:build ignore\n\npackage main\n', 'cmd/doc/doc.go': 'package doc\n' });
  assert.equal(one.launch.module, 'github.com/acme/widget/cmd/tool');
  assert.equal(one.choice.go.dir, 'cmd/tool');
  const named = await resolve({ 'go.mod': GOMOD(), 'cmd/widget/main.go': MAIN, 'cmd/other/main.go': MAIN });
  assert.equal(named.launch.module, 'github.com/acme/widget/cmd/widget', 'named for the repository');
  const bySj = await resolve({ 'go.mod': GOMOD(), 'cmd/srv/main.go': MAIN, 'cmd/other/main.go': MAIN, 'server.json': JSON.stringify({ name: 'io.github.acme/srv', packages: [] }) });
  assert.equal(bySj.launch.module, 'github.com/acme/widget/cmd/srv', 'named in the repository\'s own server.json');
  const amb = await resolve({ 'go.mod': GOMOD(), 'cmd/a/main.go': MAIN, 'cmd/b/main.go': MAIN });
  assert.deepEqual([amb.status, amb.detail], ['skipped', 'entry_ambiguous']);
  assert.deepEqual(LP.DETAILS.entry_ambiguous.slice(-1), ['tool']);
  const lib = await resolve({ 'go.mod': GOMOD(), 'widget.go': LIB, 'internal/x/x.go': LIB });
  assert.deepEqual([lib.status, lib.detail], ['skipped', 'no_main_package']);
  assert.deepEqual(LP.DETAILS.no_main_package, ['no_runnable_artifact', false, 'resolve', 'tool']);
  const gen = await resolve({ 'go.mod': GOMOD(), 'gen.go': '//go:build ignore\n\npackage main\n', 'widget.go': LIB });
  assert.equal(gen.detail, 'no_main_package', 'a build-ignored generator is not the server');
  const many = {}; for (let i = 0; i < GO.MAX_CMD_DIRS + 1; i++) many['cmd/c' + i + '/main.go'] = MAIN;
  assert.equal((await resolve({ 'go.mod': GOMOD(), ...many })).detail, 'entry_ambiguous', 'more commands than we read are a guess');
});

test('R-LP-92: what is not ours to build is said so and never blamed on the server: no go.mod stays no_package, a replace or exclude directive is go_install_refused, a bad module path launch_invalid, a tree too big to list go_source_unreadable', async () => {
  assert.equal((await resolve({ 'README.md': 'x' })).detail, 'no_package', 'not a Go repository');
  const rep = await resolve({ 'go.mod': GOMOD() + 'replace github.com/x/y => ../y\n', 'main.go': MAIN });
  assert.deepEqual([rep.status, rep.detail], ['skipped', 'go_install_refused']);
  assert.equal((await resolve({ 'go.mod': GOMOD() + 'exclude github.com/x/y v1.0.0\n', 'main.go': MAIN })).detail, 'go_install_refused');
  assert.equal((await resolve({ 'go.mod': GOMOD('widget'), 'main.go': MAIN })).detail, 'launch_invalid', 'a module path the sandbox would refuse');
  for (const d of ['no_main_package', 'go_install_refused', 'go_source_unreadable']) assert.deepEqual(LP.DETAILS[d], ['no_runnable_artifact', false, 'resolve', 'tool'], d);
  const w = world({ 'go.mod': GOMOD(), 'main.go': MAIN });
  const big = async (url, init) => { const x = await w(url, init); if (/git\/trees\//.test(String(url))) { const b = JSON.parse(Buffer.from(await x.arrayBuffer()).toString('utf8')); return res(200, { ...b, truncated: true }); } return x; };
  assert.equal((await LP.resolveSubject({ subject: 'acme/widget', repo: 'acme/widget' }, { fetch: big, ghToken: null })).detail, 'go_source_unreadable');
  // The mutation check: without the directive check the build is planned and fails in the sandbox with go's own refusal.
  const M = await mutant('if (mod.replace || mod.exclude) return', 'if (false) return');
  const x = await M.goSource({ repo: 'acme/widget', fetch: world({ 'go.mod': GOMOD() + 'replace github.com/x/y => ../y\n', 'main.go': MAIN }), token: null, httpDetail: LP.httpDetail });
  assert.ok(x.launch, 'without the check it is planned');
});

test('R-LP-92: the registry-format server.json a repository ships gives the arguments and environment names, never a value we invent; one that asks for a transport we do not run is unsupported_transport', async () => {
  const sj = { name: 'io.github.acme/widget', packages: [{ registryType: 'oci', identifier: 'x', transport: { type: 'stdio' }, packageArguments: [{ type: 'positional', value: '/data' }, { type: 'named', name: '--mode', value: 'ro' }], environmentVariables: [{ name: 'WIDGET_DIR', default: '/data' }] }] };
  const r = await resolve({ 'go.mod': GOMOD(), 'main.go': MAIN, 'server.json': JSON.stringify(sj) });
  assert.deepEqual(r.launch.args, ['/data', '--mode', 'ro']);
  assert.deepEqual(r.launch.env, { WIDGET_DIR: '/data' });
  const bare = await resolve({ 'go.mod': GOMOD(), 'main.go': MAIN });
  assert.equal(bare.launch.args, undefined, 'no declaration: no argument, none invented');
  assert.equal(bare.choice.args_n, 0);
  const sse = await resolve({ 'go.mod': GOMOD(), 'main.go': MAIN, 'server.json': JSON.stringify({ name: 'x', packages: [{ transport: { type: 'sse', url: 'http://localhost:3000/sse' } }] }) });
  assert.equal(sse.detail, 'unsupported_transport');
  const bad = await resolve({ 'go.mod': GOMOD(), 'main.go': MAIN, 'server.json': '{not json' });
  assert.equal(bad.status, 'runnable', 'an unreadable server.json is no reason to stop');
});

test('R-LP-93: GitHub is the only host asked, and the token goes to api.github.com only: a redirect elsewhere is refused, one inside api.github.com is followed; a rate limit or outage is a retryable skip, never a verdict', async () => {
  const files = { 'go.mod': GOMOD(), 'main.go': MAIN };
  const r = await resolve(files, {}, { token: 'tok123' });
  assert.ok(r.calls.filter((c) => c.host === 'api.github.com').length >= 4, 'head, tree, go.mod, main.go');
  for (const c of r.calls) {
    if (c.host === 'api.github.com') assert.equal(c.auth, 'Bearer tok123');
    else assert.equal(c.auth, undefined, c.host + ' gets no token');
    if (c.host === 'api.github.com') assert.equal(c.redirect, 'manual');
  }
  assert.ok(r.calls.every((c) => ['registry.modelcontextprotocol.io', 'api.github.com'].includes(c.host)), 'no host but the registry and GitHub\'s API');
  const away = await resolve(files, {}, { token: 'tok123', redirectTo: 'https://evil.example/steal' });
  assert.equal(away.detail, 'upstream_error', 'a redirect to another host is refused');
  assert.ok(away.calls.every((c) => c.host !== 'evil.example'));
  const home = await resolve(files, {}, { token: 'tok123', redirectTo: 'https://api.github.com/repositories/42/git/trees/' + SHA });
  assert.ok(home.calls.some((c) => c.url.includes('/repositories/42/')), 'a renamed repository\'s redirect inside api.github.com is followed');
  const limited = await resolve(files, {}, { rate: true });
  assert.deepEqual([limited.status, limited.detail, LP.DETAILS[limited.detail][1]], ['skipped', 'rate_limited', true]);
  const down = await resolve(files, {}, { status: 503 });
  assert.deepEqual([down.detail, LP.DETAILS[down.detail][1]], ['upstream_error', true]);
  const gone = await resolve(files, {}, { status: 404 });
  assert.equal(gone.detail, 'no_package', 'a repository GitHub does not know is not a Go repository');
  // The mutation check: without the host rule the token follows a redirect to any host.
  const M = await mutant("u.hostname !== 'api.github.com' ||", '', 'go-entry.mjs');
  const w = world(files, { redirectTo: 'https://evil.example/steal' });
  let evil = 0;
  await M.goSource({ repo: 'acme/widget', fetch: async (u, i) => { if (new URL(u).hostname === 'evil.example') { evil++; return res(200, { sha: SHA }); } return w(u, i); }, token: 'tok123', httpDetail: LP.httpDetail });
  assert.ok(evil > 0, 'without the rule the redirect to evil.example is followed, with the token');
});

test('R-LP-94: a Go build that fails is ours, whatever it printed: the install is never the package\'s own failure, a refused host is install_blocked, our limits are ours, and a start is judged as any other (evidence or ours)', () => {
  const rec = (steps, extra = {}) => ({ install: { kind: 'go', ok: false, steps, egress_refused: 0, ...extra }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 1000 } });
  const launch = { kind: 'go', module: 'github.com/acme/widget', version: SHA };
  const fd = (r, log = '') => LP.failureDetail(r, null, null, { stepsLog: log, launch, owned: true });
  const bad = [{ name: 'prep', exit: 0 }, { name: 'install', exit: 1 }];
  assert.equal(fd(rec(bad), 'go: github.com/acme/widget@' + SHA + ': reading https://proxy.golang.org/github.com/acme/widget/@v/' + SHA + '.info: 404 Not Found\n'), 'install_build_failed', 'even the proxy\'s "404 Not Found" for the module is ours, not the subject\'s');
  assert.equal(fd(rec(bad), '# github.com/acme/widget\n./main.go:3:1: undefined: x\n'), 'install_build_failed', 'a compile error is ours (our toolchain, our flags)');
  assert.equal(fd(rec(bad), 'go: go.mod requires go >= 1.29 (running go 1.26; GOTOOLCHAIN=local)\n'), 'install_build_failed');
  assert.equal(fd(rec(bad, { egress_refused: 2 })), 'install_blocked', 'a host our proxy refused');
  assert.equal(fd(rec([{ name: 'install', exit: 137 }])), 'install_resource_limit');
  assert.equal(fd(rec([{ name: 'install', exit: 124, timed_out: true }])), 'install_timeout');
  for (const d of ['install_build_failed', 'install_blocked', 'install_resource_limit', 'install_timeout']) assert.equal(LP.DETAILS[d][3], 'tool', d);
});

test('R-LP-95: the proof check fails a Go subject that was not planned at its commit, did not build in the sandbox, reached a host but the module proxy and checksum database, had an attempt refused, or was blamed on the server; and passes one that did none of it', async () => {
  const item = { subject: 'acme/widget', target_id: 's001', target: { commit: SHA, launch: { kind: 'go', module: 'github.com/acme/widget', version: SHA } } };
  const ok = { install: { kind: 'go', ok: true, steps: [{ name: 'install', exit: 0 }], egress: [{ host: 'proxy.golang.org', allowed: true }, { host: 'sum.golang.org', allowed: true }], egress_refused: 0 } };
  const result = { status: 'skipped', detail: 'start_needs_config', fault: 'tool' };
  assert.deepEqual(PROOF.judge(item, ok, result), []);
  assert.deepEqual(PROOF.ALLOWED_HOSTS, ['proxy.golang.org', 'sum.golang.org'], 'storage.googleapis.com only when a proof shows a build needs it');
  const withHost = (h) => ({ install: { ...ok.install, egress: [...ok.install.egress, { host: h, allowed: true }] } });
  assert.match(PROOF.judge(item, withHost('storage.googleapis.com'), result).join(), /egress to storage\.googleapis\.com/);
  assert.match(PROOF.judge(item, withHost('github.com'), result).join(), /egress to github\.com/);
  assert.match(PROOF.judge(item, { install: { ...ok.install, egress_refused: 1 } }, result).join(), /refused/);
  assert.match(PROOF.judge(item, { install: { ...ok.install, ok: false } }, result).join(), /did not succeed/);
  assert.match(PROOF.judge(item, null, result).join(), /no install record/);
  assert.match(PROOF.judge({ ...item, target: { ...item.target, launch: { kind: 'npm' } } }, ok, result).join(), /not planned as a go install/);
  assert.match(PROOF.judge({ ...item, target: { commit: 'main', launch: { ...item.target.launch, version: 'main' } } }, ok, result).join(), /not a full commit/);
  assert.match(PROOF.judge({ ...item, target: { commit: 'c'.repeat(40), launch: item.target.launch } }, ok, result).join(), /not pinned/);
  assert.match(PROOF.judge(item, ok, { status: 'skipped', detail: 'start_failed', fault: 'subject' }).join(), /blamed on the server/);
  assert.match(PROOF.judge(item, ok, null).join(), /no bundle result/);
  // The mutation check: with the allowlist widened to the storage host the same record passes.
  const M = await mutant("export const ALLOWED_HOSTS = Object.freeze(['proxy.golang.org', 'sum.golang.org']);", "export const ALLOWED_HOSTS = Object.freeze(['proxy.golang.org', 'sum.golang.org', 'storage.googleapis.com']);", 'go-proof-check.mjs');
  assert.deepEqual(M.judge(item, withHost('storage.googleapis.com'), result), []);
});

test('R-LP-95: the proof workflow runs on a pull request, in the sandbox, with no secret and no oracle or fuzz stage, one pinned commit of the sandbox everywhere, and its fixture names both Go repositories', () => {
  const y = readFileSync(join(root, '.github', 'workflows', 'live-probe-go-proof.yml'), 'utf8');
  const code = y.replace(/^\s*#.*$/gm, '');
  assert.match(y, /\n  pull_request:\n    paths:\n/);
  assert.ok(!/pull_request_target|secrets\./.test(code));
  assert.match(y, /\npermissions: \{\}\n/);
  for (const m of code.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  const ref = /\n  SURFACE_CORPUS_REF: '([0-9a-f]{40})'\n/.exec(y)[1];
  assert.equal((code.match(/mcp-surface-corpus[^\n]*@([0-9a-f]{40})/g) || []).filter((m) => !m.endsWith(ref)).length, 0, 'one sandbox commit');
  assert.ok(!/oracles|FUZZ/.test(code));
  assert.match(code, /node corpus\/go-proof-check\.mjs/);
  assert.match(code, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  const fx = JSON.parse(readFileSync(join(root, 'corpus', 'fixtures', 'live-probe', 'go-proof-shard.json'), 'utf8'));
  assert.deepEqual(fx.items.map((i) => i.subject), ['mark3labs/mcp-filesystem-server', 'isaacphi/mcp-language-server']);
  for (const f of ['live-probe.yml', 'live-probe-selftest.yml']) assert.match(readFileSync(join(root, '.github', 'workflows', f), 'utf8'), /\n          GH_TOKEN: \$\{\{ github\.token \}\}\n        run: node corpus\/live-probe\.mjs plan /, f + ': the plan step gets the read-only token');
});

test('R-LP-95: every Go detail code is in the lane\'s documentation with its reason and fault', () => {
  const doc = readFileSync(join(root, 'corpus', 'LIVE-PROBE.md'), 'utf8');
  for (const d of ['no_main_package', 'go_install_refused', 'go_source_unreadable']) {
    const row = doc.split('\n').find((l) => l.startsWith('|') && l.includes('`' + d + '`'));
    assert.ok(row, d + ' is in the table');
    const cells = row.split('|').map((c) => c.trim());
    assert.equal(cells[2], '`no_runnable_artifact`');
    assert.ok(cells[3].startsWith('tool'));
  }
  assert.match(doc, /\*\*Go from source\*\*/);
});
