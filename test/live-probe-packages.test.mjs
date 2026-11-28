// The live-probe lane's package types beyond npm, PyPI and OCI images (corpus/live-probe.mjs, corpus/LIVE-PROBE.md
// "Package types"): how a subject's crate is resolved into a sandbox launch, how long it may build and where it runs in
// the shard, and whose fault a failed install is. The sandbox's side (images, hardening, the proxy's allowlist, the
// entry helpers) is tested in isokron-ai/mcp-surface-corpus (test/package-kinds.test.mjs, R-SBX-35 to R-SBX-43). Each
// protection has a mutation check: with it taken out of a copy of the module, the fixture that pins it gets through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as LP from '../corpus/live-probe.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const NODE24 = 'docker.io/library/node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';

function res(status, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) }, arrayBuffer: async () => buf };
}
/** The official registry, answering searches from a list of servers; nothing else is reachable. */
function registry(servers) {
  return async (url) => {
    const u = new URL(url);
    if (u.hostname === 'api.github.com') return res(404, {}); // R-LP-91: a repository GitHub does not know is not a Go repository
    if (u.hostname !== 'registry.modelcontextprotocol.io') throw new Error('unexpected fetch ' + url);
    const q = (u.searchParams.get('search') || '').toLowerCase();
    return res(200, { servers: servers.filter((s) => s.name.toLowerCase().includes(q) || (s.packages || []).some((p) => String(p.identifier).toLowerCase().includes(q))).map((server) => ({ server })) });
  };
}
const server = (name, repo, packages) => ({ name, version: '1.0.0', repository: { url: 'https://github.com/' + repo, source: 'github' }, packages });
const crate = (identifier, extra = {}) => ({ registryType: 'cargo', identifier, version: '0.4.1', transport: { type: 'stdio' }, ...extra });
const items = (subjects) => JSON.stringify(subjects.map((subject, i) => ({ subject, run_key: String(i + 1).repeat(64).slice(0, 64), fence: i + 1 })));

/** A copy of corpus/live-probe.mjs with one protection taken out, beside the original so its imports resolve. */
async function mutant(from, to) {
  const src = readFileSync(join(root, 'corpus', 'live-probe.mjs'), 'utf8');
  assert.ok(src.includes(from), 'the mutation text is in corpus/live-probe.mjs: ' + from.slice(0, 80));
  const file = join(root, 'corpus', '.mutant-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
  writeFileSync(file, src.replace(from, to));
  try { return await import(pathToFileURL(file).href); } finally { rmSync(file, { force: true }); }
}

// ------------------------------------------------------------------ crates

test('R-LP-54: a crate resolves to a sandbox build of exactly that crate (checked name, exact version or latest), after npm, PyPI and images; never a crate named like an option', async () => {
  const f = registry([
    server('io.github.acme/rusty', 'acme/rusty', [crate('rusty-mcp')]),
    server('io.github.acme/both', 'acme/both', [crate('both-mcp'), { registryType: 'npm', identifier: 'both-mcp', version: '1.0.0', transport: { type: 'stdio' } }]),
    server('io.github.acme/evil', 'acme/evil', [crate('--git=https://evil.example/x')]),
    server('io.github.acme/ranged', 'acme/ranged', [crate('ranged', { version: '^1.2' })]),
    server('io.github.acme/private', 'acme/private', [crate('private', { registryBaseUrl: 'https://crates.acme.example' })]),
  ]);
  const r = (s) => LP.resolveSubject({ subject: s, repo: s }, { fetch: f });
  const rusty = await r('acme/rusty');
  assert.equal(rusty.status, 'runnable');
  assert.deepEqual(rusty.launch, { kind: 'cargo', crate: 'rusty-mcp', version: '0.4.1' });
  assert.equal(rusty.choice.purl, 'pkg:cargo/rusty-mcp@0.4.1');
  assert.equal((await r('acme/both')).launch.kind, 'npm', 'an installed package before a build');
  assert.equal((await r('acme/evil')).detail, 'launch_invalid');
  assert.equal((await r('acme/ranged')).launch.version, 'latest', 'a range is not passed to cargo; the latest release is built');
  assert.equal((await r('acme/private')).detail, 'private_registry');
  // The seed list alone (no registry entry): the seed's crate, latest.
  const seedOnly = await LP.resolveSubject({ subject: 'acme/seeded', repo: 'acme/seeded' }, { fetch: registry([]), seed: new Map([['acme/seeded', [{ registry: 'cargo', identifier: 'seeded' }]]]) });
  assert.deepEqual([seedOnly.status, seedOnly.launch, seedOnly.choice.verified_by], ['runnable', { kind: 'cargo', crate: 'seeded', version: 'latest' }, 'seed']);
  // A registry entry that names the repository but is not the owner's: crates.io has no signed provenance we check, so it is not the subject's.
  const other = await LP.resolveSubject({ subject: 'acme/claimed', repo: 'acme/claimed' }, { fetch: registry([server('io.github.mallory/claimed', 'acme/claimed', [crate('x')])]) });
  assert.equal(other.detail, 'unverified_registry_entry');
});

test('R-LP-54 mutation check: without the crate name check an option-like crate name reaches the sandbox', async () => {
  const f = registry([server('io.github.acme/evil', 'acme/evil', [crate('--git=https://evil.example/x')])]);
  const M = await mutant("    if (!CRATE_NAME.test(id)) return { detail: 'launch_invalid' };\n    const v = version", '    const v = version');
  assert.equal((await M.resolveSubject({ subject: 'acme/evil', repo: 'acme/evil' }, { fetch: f })).launch.crate, '--git=https://evil.example/x');
});

test('R-LP-55: a crate builds after the other subjects, in a list of its own, with the build cap on top of its share; the others share a budget that leaves room for it', async () => {
  const servers = [server('io.github.a/one', 'a/one', [{ registryType: 'npm', identifier: 'one', version: '1.0.0', transport: { type: 'stdio' } }]), server('io.github.a/two', 'a/two', [crate('two')])];
  const inputs = LP.parseInputs({ shardId: 's', attemptId: 'a1', items: items(['a/one', 'a/two']) });
  const plan = await LP.planShard({ inputs, fetch: registry(servers) });
  const [one, two] = plan.items;
  assert.equal(plan.subject_timeout_s, LP.subjectTimeout(1, LP.BUILD_RESERVE_S));
  assert.equal(one.target.timeout_s, plan.subject_timeout_s + LP.ORACLE_ALLOWANCE_S);
  assert.equal(two.target.timeout_s, Math.min(1800, plan.subject_timeout_s + LP.ORACLE_ALLOWANCE_S + LP.BUILD_ALLOWANCE_S));
  assert.ok(two.target.timeout_s >= 15 * 60 + LP.SUBJECT_TIMEOUT_MIN_S, 'room for the whole 15-minute build and a probe');
  const lists = LP.targetLists(plan, { node24Image: NODE24 });
  assert.deepEqual(lists.subjects.targets.map((t) => t.id), ['s001']);
  assert.deepEqual(lists.builds.targets.map((t) => t.id), ['s002']);
  assert.ok(LP.subjectTimeout(9, LP.BUILD_RESERVE_S) < LP.subjectTimeout(9), 'a shard with a crate leaves time for it');
  // The sandbox script runs the builds after the subjects and before the images, and records builds_rc.
  const sh = readFileSync(join(root, 'corpus', 'live-probe-sandbox.sh'), 'utf8');
  const at = (s) => { const i = sh.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at('drive "$work/targets-subjects.json"') < at('drive "$work/targets-builds.json" "$work/driver-builds"') && at('drive "$work/targets-builds.json"') < at('drive "$work/oci/$id.json"'));
  assert.match(sh, /builds_rc: n\(v\[16\]\)/);
});

test('R-LP-55 mutation check: without the build list a crate would run among the subjects on a subject\'s time limit', async () => {
  const servers = [server('io.github.a/two', 'a/two', [crate('two')])];
  const inputs = LP.parseInputs({ shardId: 's', attemptId: 'a1', items: items(['a/two']) });
  const M = await mutant("export const isBuild = (launch) => !!(launch && launch.kind === 'cargo');", 'export const isBuild = () => false;');
  const plan = await M.planShard({ inputs, fetch: registry(servers) });
  const lists = M.targetLists(plan, { node24Image: NODE24 });
  assert.deepEqual([lists.subjects.targets.length, lists.builds.targets.length], [1, 0]);
  assert.ok(plan.items[0].target.timeout_s < 15 * 60, 'no room for the build');
});

const cargoRec = (steps, o = {}) => ({ install: { kind: 'cargo', ok: false, steps, egress_refused: 0, ...o }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false });
const LAUNCH = { kind: 'cargo', crate: 'rusty-mcp', version: 'latest' };
const fd = (rec, stepsLog, owned = true) => LP.failureDetail(rec, null, null, { stepsLog, launch: LAUNCH, argsUnfilled: 0, owned });

test('R-LP-56: a crate\'s failed install is the crate\'s only on cargo\'s own word before anything compiled, with no trouble reaching crates.io, and only when its registry entry is the subject\'s own; what our entry helper cannot find and everything else is ours', () => {
  const install = (exit = 101) => [{ name: 'install', exit, timed_out: false }];
  assert.equal(fd(cargoRec(install()), '    Updating crates.io index\nerror: could not find `rusty-mcp` in registry `crates-io` with version `*`\n'), 'install_failed');
  assert.equal(fd(cargoRec(install()), 'error: could not find `rusty_mcp` in registry `crates-io`\n'), 'install_failed', 'cargo treats - and _ alike');
  assert.equal(fd(cargoRec(install()), 'error: there is nothing to install in `rusty-mcp v0.4.1`, because it has no binaries\n`cargo install` is only for installing programs, and can\'t be used with libraries.\n'), 'package_not_runnable');
  // Another crate's name: not this crate's word.
  assert.equal(fd(cargoRec(install()), 'error: could not find `serde-evil` in registry `crates-io`\n'), 'install_build_failed');
  // After a Compiling line a build script may print anything: never the crate's absence.
  assert.equal(fd(cargoRec(install()), '   Compiling evil-build v0.1.0\nerror: could not find `rusty-mcp` in registry `crates-io`\n'), 'install_build_failed');
  // Trouble reaching crates.io: our side.
  assert.equal(fd(cargoRec(install()), 'warning: spurious network error (2 tries remaining): [7] Couldn\'t connect to server\nerror: could not find `rusty-mcp` in registry `crates-io`\n'), 'install_build_failed');
  assert.equal(fd(cargoRec(install(), { egress_refused: 1 }), 'error: could not find `rusty-mcp` in registry `crates-io`\n'), 'install_blocked');
  assert.equal(fd(cargoRec(install(137)), ''), 'install_resource_limit');
  assert.equal(fd(cargoRec([{ name: 'install', exit: null, timed_out: true }]), ''), 'install_timeout');
  assert.equal(fd(cargoRec(install()), 'error: linker `cc` not found\n'), 'install_build_failed');
  // The entry helper (mcp-surface-corpus sandbox/cargo-entry.mjs) runs after a successful install: what it cannot find is a
  // limit of its own checks (its name pattern, its regular-file test), never the crate's; several is ours too (no guess).
  const entry = (error) => [{ name: 'install', exit: 0 }, { name: 'entry', exit: 1, result: { error } }];
  for (const e of ['no_binary', 'not_installed', null]) assert.equal(fd(cargoRec(entry(e)), ''), 'entry_unresolved', String(e));
  assert.equal(fd(cargoRec(entry('several_binaries')), ''), 'entry_ambiguous');
  assert.equal(fd(cargoRec([{ name: 'install', exit: 0 }, { name: 'entry', exit: 1 }]), ''), 'entry_unresolved');
  // cargo's own word about a crate whose registry entry is not the subject's own (seed-only, seed-matched, repository-only): ours.
  assert.equal(fd(cargoRec(install()), 'error: could not find `rusty-mcp` in registry `crates-io`\n', false), 'package_error_unowned');
  assert.equal(fd(cargoRec(install()), 'error: there is nothing to install in `rusty-mcp v0.4.1`, because it has no binaries\n', false), 'package_error_unowned');
  assert.equal(LP.ownedEntry({ matched_by: 'repository+namespace+seed' }), true);
  for (const m of ['seed', 'seed-only', 'repository', 'repository+seed', null]) assert.equal(LP.ownedEntry({ matched_by: m }), false, String(m));
  assert.deepEqual(LP.DETAILS.entry_unresolved, ['install_failed_registry', false, 'install', 'tool']);
  assert.deepEqual(LP.DETAILS.package_error_unowned, ['install_failed_registry', false, 'install', 'tool']);
  // npm's and pip's package-error words in a crate's log are not evidence about the crate.
  assert.equal(fd(cargoRec(install()), '   Compiling x\nnpm ERR! code E404\nNo matching distribution found for x\n'), 'install_build_failed');
  for (const d of ['package_not_runnable', 'entry_ambiguous']) assert.ok(LP.DETAILS[d], d);
  assert.deepEqual(LP.DETAILS.package_not_runnable, ['install_failed_registry', false, 'install', 'subject']);
  assert.deepEqual(LP.DETAILS.entry_ambiguous, ['install_failed_registry', false, 'install', 'tool']);
});

test('R-LP-56 mutation check: without the Compiling guard, the network guard, the same-crate check or the ownership gate, a crate is blamed for what it did not say', async () => {
  for (const [from, to, log] of [
    ["  if (/^\\s*Compiling /m.test(t) || CARGO_NOT_THE_CRATE.test(t)) return null;", '  if (CARGO_NOT_THE_CRATE.test(t)) return null;', '   Compiling evil-build v0.1.0\nerror: could not find `rusty-mcp` in registry `crates-io`\n'],
    ["  if (/^\\s*Compiling /m.test(t) || CARGO_NOT_THE_CRATE.test(t)) return null;", "  if (/^\\s*Compiling /m.test(t)) return null;", 'warning: spurious network error (2 tries remaining)\nerror: could not find `rusty-mcp` in registry `crates-io`\n'],
    ['  if (missing && same(missing[1])) return \'install_failed\';', "  if (missing) return 'install_failed';", 'error: could not find `serde-evil` in registry `crates-io`\n'],
  ]) {
    assert.equal(fd(cargoRec([{ name: 'install', exit: 101 }]), log), 'install_build_failed');
    const M = await mutant(from, to);
    assert.equal(M.failureDetail(cargoRec([{ name: 'install', exit: 101 }]), null, null, { stepsLog: log, launch: LAUNCH, argsUnfilled: 0, owned: true }), 'install_failed', 'without the guard: ' + from.slice(0, 50));
  }
  // Without the ownership gate a seed-only crate's absence would be the subject's.
  const log = 'error: could not find `rusty-mcp` in registry `crates-io`\n';
  assert.equal(fd(cargoRec([{ name: 'install', exit: 101 }]), log, false), 'package_error_unowned');
  const M = await mutant("      return ev ? (owned ? ev : 'package_error_unowned') : 'install_build_failed';", "      return ev || 'install_build_failed';");
  assert.equal(M.failureDetail(cargoRec([{ name: 'install', exit: 101 }]), null, null, { stepsLog: log, launch: LAUNCH, argsUnfilled: 0, owned: false }), 'install_failed');
});

// ------------------------------------------------------------------ NuGet (.NET tools)

const nuget = (identifier, extra = {}) => ({ registryType: 'nuget', identifier, version: '1.2.0', runtimeHint: 'dnx', transport: { type: 'stdio' }, ...extra });

test('R-LP-57: a .NET tool package resolves to a sandbox tool install of exactly that package (checked id, exact version or latest), after npm, PyPI and images, with time for the SDK image', async () => {
  const f = registry([
    server('io.github.acme/dotty', 'acme/dotty', [nuget('Acme.Dotty.Mcp')]),
    server('io.github.acme/evil', 'acme/evil', [nuget('--add-source')]),
    server('io.github.acme/pre', 'acme/pre', [nuget('Acme.Pre', { version: '0.10.0-beta.54' })]),
    server('io.github.acme/float', 'acme/float', [nuget('Acme.Float', { version: '[1.0,2.0)' })]),
    server('io.github.acme/private', 'acme/private', [nuget('Acme.Private', { registryBaseUrl: 'https://nuget.acme.example/v3/index.json' })]),
    server('io.github.acme/official', 'acme/official', [nuget('Acme.Official', { registryBaseUrl: 'https://api.nuget.org/v3/index.json' })]),
  ]);
  const r = (s) => LP.resolveSubject({ subject: s, repo: s }, { fetch: f });
  const dotty = await r('acme/dotty');
  assert.deepEqual([dotty.status, dotty.launch, dotty.choice.purl], ['runnable', { kind: 'nuget', package: 'Acme.Dotty.Mcp', version: '1.2.0' }, 'pkg:nuget/Acme.Dotty.Mcp@1.2.0']);
  assert.equal((await r('acme/evil')).detail, 'launch_invalid');
  assert.equal((await r('acme/pre')).launch.version, '0.10.0-beta.54');
  assert.equal((await r('acme/float')).launch.version, 'latest');
  assert.equal((await r('acme/private')).detail, 'private_registry');
  assert.equal((await r('acme/official')).status, 'runnable');
  const seedOnly = await LP.resolveSubject({ subject: 'acme/seeded', repo: 'acme/seeded' }, { fetch: registry([]), seed: new Map([['acme/seeded', [{ registry: 'nuget', identifier: 'Seeded.Mcp' }]]]) });
  assert.deepEqual(seedOnly.launch, { kind: 'nuget', package: 'Seeded.Mcp', version: 'latest' });
  // Time: the subject's share plus the oracle stage's, plus PACKAGE_ALLOWANCE_S.nuget; it runs among the subjects.
  const inputs = LP.parseInputs({ shardId: 's', attemptId: 'a1', items: items(['acme/dotty']) });
  const plan = await LP.planShard({ inputs, fetch: f });
  assert.equal(plan.items[0].target.timeout_s, plan.subject_timeout_s + LP.ORACLE_ALLOWANCE_S + LP.PACKAGE_ALLOWANCE_S.nuget);
  assert.deepEqual(LP.targetLists(plan, { node24Image: NODE24 }).subjects.targets.map((t) => t.id), ['s001']);
});

test('R-LP-57 mutation check: without the package id check an option-like id reaches the sandbox', async () => {
  const f = registry([server('io.github.acme/evil', 'acme/evil', [nuget('--add-source')])]);
  const M = await mutant("    if (!NUGET_ID.test(id)) return { detail: 'launch_invalid' };\n", '');
  assert.equal((await M.resolveSubject({ subject: 'acme/evil', repo: 'acme/evil' }, { fetch: f })).launch.package, '--add-source');
});

const nugetRec = (steps, o = {}) => ({ install: { kind: 'nuget', ok: false, steps, egress_refused: 0, ...o }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false });
const NLAUNCH = { kind: 'nuget', package: 'Acme.Dotty.Mcp', version: 'latest' };
const nfd = (rec, stepsLog, owned = true) => LP.failureDetail(rec, null, null, { stepsLog, launch: NLAUNCH, argsUnfilled: 0, owned });

test('R-LP-58: a .NET tool\'s failed install is the package\'s only on the CLI\'s word about this id with no trouble reaching NuGet, and only when its registry entry is the subject\'s own; what our entry helper cannot find, other platforms, several commands and everything else are ours', () => {
  const install = (exit = 1) => [{ name: 'config', exit: 0 }, { name: 'install', exit, timed_out: false }];
  assert.equal(nfd(nugetRec(install()), '/work/nuget.config : error NU1101: Unable to find package Acme.Dotty.Mcp. No packages exist with this id in source(s): nuget.org\nTool \'acme.dotty.mcp\' failed to install.\n'), 'install_failed');
  assert.equal(nfd(nugetRec(install()), 'error NU1102: Unable to find package acme.dotty.mcp with version (= 9.9.9)\n'), 'install_failed', 'ids are case-insensitive');
  assert.equal(nfd(nugetRec(install()), 'error NU1101: Unable to find package Other.Package. No packages exist with this id\n'), 'install_build_failed', 'another package: a dependency, not this one');
  assert.equal(nfd(nugetRec(install()), 'error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json.\nerror NU1101: Unable to find package Acme.Dotty.Mcp.\n'), 'install_build_failed', 'NuGet not reached: ours');
  assert.equal(nfd(nugetRec(install()), 'Package Acme.Dotty.Mcp is not a .NET tool.\n'), 'package_not_runnable');
  assert.equal(nfd(nugetRec(install()), "Settings file 'DotnetToolSettings.xml' was not found in the package.\n"), 'package_not_runnable');
  assert.equal(nfd(nugetRec(install(), { egress_refused: 2 }), 'error NU1101: Unable to find package Acme.Dotty.Mcp.\n'), 'install_blocked');
  assert.equal(nfd(nugetRec(install(137)), ''), 'install_resource_limit');
  assert.equal(nfd(nugetRec(install()), 'npm ERR! code E404\n'), 'install_build_failed', 'npm\'s words are not NuGet\'s');
  const entry = (error) => [...install(0), { name: 'entry', exit: 1, result: { error } }];
  // After a successful install, no tool settings means our store walk (its caps, its name pattern) did not reach them: ours.
  for (const e of ['no_tool_settings', 'no_command', 'not_installed']) assert.equal(nfd(nugetRec(entry(e)), ''), 'entry_unresolved', e);
  assert.equal(nfd(nugetRec(install()), 'error NU1101: Unable to find package Acme.Dotty.Mcp.\n', false), 'package_error_unowned', 'not the subject\'s entry');
  assert.equal(nfd(nugetRec(entry('no_linux_build')), ''), 'platform_unsupported');
  assert.equal(nfd(nugetRec(entry('runtime_too_new')), ''), 'platform_unsupported', 'a tool for .NET 11 on our .NET 10');
  assert.equal(nfd(nugetRec(entry('several_commands')), ''), 'entry_ambiguous');
  assert.deepEqual(LP.DETAILS.platform_unsupported, ['no_runnable_artifact', false, 'install', 'tool']);
});

test('R-LP-58 mutation check: without the network guard or the same-id check, a package is blamed for what NuGet did not say about it', async () => {
  for (const [from, to, log] of [
    ['  if (NUGET_NOT_THE_PACKAGE.test(t)) return null;\n  const same = (n) => String(n).toLowerCase() === String(id).toLowerCase();', '  const same = (n) => String(n).toLowerCase() === String(id).toLowerCase();', 'error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json.\nerror NU1101: Unable to find package Acme.Dotty.Mcp.\n'],
    ["  if (missing && same(missing[1])) return 'install_failed';\n  const notTool", "  if (missing) return 'install_failed';\n  const notTool", 'error NU1101: Unable to find package Other.Package. No packages exist with this id\n'],
  ]) {
    const rec = nugetRec([{ name: 'install', exit: 1 }]);
    assert.equal(nfd(rec, log), 'install_build_failed');
    const M = await mutant(from, to);
    assert.equal(M.failureDetail(rec, null, null, { stepsLog: log, launch: NLAUNCH, argsUnfilled: 0, owned: true }), 'install_failed', 'without the guard: ' + from.slice(0, 50));
  }
});

test('R-LP-58: a .NET tool built for an older runtime runs rolled forward, so its crash is no evidence against it', async () => {
  const rec = (tfm, names = []) => ({ install: { kind: 'nuget', ok: true, steps: [{ name: 'install', exit: 0 }, { name: 'entry', exit: 0, result: { script: '/work/pkg/x.dll', runner: 'dotnet', ...(tfm === undefined ? {} : { tfm }) } }] }, env: { names: { registry: names }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false });
  const crash = { initialize_error: 'the server exited (exit 2, signal null)', lists: {}, transport: { exit: 2, signal: null }, timing: { total_ms: 2000 }, stderr: 'Unhandled exception. System.TypeLoadException: Could not load type\n   at Program.Main()\nSegmentation fault (core dumped)\n' };
  const quiet = { initialize_error: 'the server exited (exit 1, signal null)', lists: {}, transport: { exit: 1, signal: null }, timing: { total_ms: 2000 }, stderr: '' };
  assert.equal(LP.rolledForward(rec('net8.0').install), true);
  assert.equal(LP.rolledForward(rec('net10.0').install), false);
  assert.equal(LP.rolledForward(rec('net11.0').install), false);
  // Only a framework the sandbox's runtime is shown to be is "as shipped": the older .NET Core and .NET Standard names, a
  // platform-suffixed or unreadable framework, or none recorded, all ran on a runtime the tool may not have been built for.
  for (const tfm of ['netcoreapp3.1', 'netcoreapp2.1', 'netstandard2.0', 'net8.0-windows', 'net48', '', undefined]) assert.equal(LP.rolledForward(rec(tfm).install), true, String(tfm));
  assert.equal(LP.failureDetail(rec('net8.0'), crash, null, { launch: NLAUNCH, argsUnfilled: 0, owned: true }), 'start_env_limited');
  assert.equal(LP.failureDetail(rec('netcoreapp3.1'), crash, null, { launch: NLAUNCH, argsUnfilled: 0, owned: true }), 'start_env_limited', 'netcoreapp3.1 rolled forward too');
  // A quiet exit with a declared variable is no more the server's than a crash, rolled forward.
  assert.equal(LP.failureDetail(rec('net10.0', ['API_KEY']), quiet, null, { launch: NLAUNCH, argsUnfilled: 0, owned: true }), 'needs_credentials', 'as shipped, the declared variable');
  assert.equal(LP.failureDetail(rec('net8.0', ['API_KEY']), quiet, null, { launch: NLAUNCH, argsUnfilled: 0, owned: true }), 'start_env_limited', 'rolled forward: no evidence');
  assert.equal(LP.failureDetail(rec('net10.0'), crash, null, { launch: NLAUNCH, argsUnfilled: 0, owned: true }), 'start_failed', 'on the runtime it was built for, a crash is a crash');
  // Mutation checks: without the rule the rolled-forward crash and quiet exit are the server's; without the fallback a
  // netcoreapp3.1 tool's crash is.
  const M = await mutant('  const noEvidence = rolledForward(inst)', '  const noEvidence = false');
  assert.equal(M.failureDetail(rec('net8.0'), crash, null, { launch: NLAUNCH, argsUnfilled: 0, owned: true }), 'start_failed', 'without the rule the rolled-forward crash is the server\'s');
  assert.equal(M.failureDetail(rec('net8.0', ['API_KEY']), quiet, null, { launch: NLAUNCH, argsUnfilled: 0, owned: true }), 'needs_credentials', 'without the rule the quiet exit is the server\'s');
  const F = await mutant('  return !m || Number(m[1])', '  return !!m && Number(m[1])');
  assert.equal(F.failureDetail(rec('netcoreapp3.1'), crash, null, { launch: NLAUNCH, argsUnfilled: 0, owned: true }), 'start_failed', 'without the fallback a netcoreapp3.1 crash is the server\'s');
});

// ------------------------------------------------------------------ MCP bundles (.mcpb)

import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import * as MB from '../corpus/mcpb.mjs';
MB.RETRY.ms = 0;

/** A zip archive of { name: data } (deflated), as a bundle tool writes it. */
function zip(files) {
  const locals = []; const central = []; let off = 0;
  for (const [n, d] of Object.entries(files)) {
    const data = Buffer.isBuffer(d) ? d : Buffer.from(typeof d === 'string' ? d : JSON.stringify(d));
    const body = deflateRawSync(data); const name = Buffer.from(n); const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((0o100755 << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    central.push(ch, name); off += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const ELF64 = (machine = 0x3e) => { const b = Buffer.alloc(64); b.write('\x7fELF', 0, 'latin1'); b[4] = 2; b[5] = 1; b.writeUInt16LE(2, 16); b.writeUInt16LE(machine, 18); return b; };
const URL1 = 'https://github.com/acme/bundle/releases/download/v1.0.0/acme.mcpb';
const ASSET = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=x';
const sha = (b) => createHash('sha256').update(b).digest('hex');
/** github.com redirecting to the release-asset host, which serves the bytes; every request recorded. */
function releases(map, calls = []) {
  return async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.hostname === 'registry.modelcontextprotocol.io') return res(200, { servers: [] });
    if (u.hostname === 'github.com') { const x = map[String(url)]; if (!x) return res(404, 'Not Found'); return { status: 302, ok: false, headers: { get: (h) => (h === 'location' ? x.location ?? ASSET + '&f=' + encodeURIComponent(String(url)) : null) } }; }
    if (u.hostname === 'api.github.com') return res(404, {});
    if (u.hostname === 'release-assets.githubusercontent.com') { const k = decodeURIComponent(u.searchParams.get('f') || ''); return map[k] ? res(200, map[k].body) : res(404, ''); }
    throw new Error('unexpected fetch ' + url);
  };
}
const mcpbPkg = (identifier = URL1, extra = {}) => ({ registryType: 'mcpb', identifier, version: '1.0.0', transport: { type: 'stdio' }, ...extra });
const manifest = (server, extra = {}) => ({ manifest_version: '0.3', name: 'acme', version: '1.0.0', server, ...extra });
const nodeBundle = (m = manifest({ type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] } }), more = {}) => zip({ 'manifest.json': m, 'server/index.js': 'console.log(1)', ...more });
const launchOf = async (bundle, pkg = mcpbPkg()) => { try { return await MB.mcpbLaunch(pkg, { fetch: releases({ [URL1]: { body: bundle } }) }); } catch (e) { return { detail: e.detail, why: e.why }; } };

test('R-LP-72: a bundle is read on the planner as data from its GitHub release asset only, and launched as its manifest says: runtime, args, env and user_config filled the way a client would, the sha256 pinned for the sandbox', async () => {
  const b = nodeBundle();
  let r = await launchOf(b);
  assert.deepEqual(r.launch, { kind: 'mcpb', url: URL1, sha256: sha(b), workdir: '.', runtime: 'node', args: ['/work/pkg/server/index.js'] });
  assert.deepEqual([r.info.server_type, r.info.platform_unlisted, r.info.sha256_from], ['node', false, 'planner']);
  // The registry's fileSha256 is the one the bytes must have; then it is the pin.
  assert.equal((await launchOf(b, mcpbPkg(URL1, { fileSha256: sha(b) }))).info.sha256_from, 'registry');
  assert.equal((await launchOf(b, mcpbPkg(URL1, { fileSha256: 'f'.repeat(64) }))).detail, 'bundle_hash_mismatch');
  // user_config: a default is used (variables inside it too), an optional value with none is left out with its flag, a required one with none is configuration we do not have.
  const uc = { root: { type: 'directory', default: '${HOME}/notes' }, vault: { type: 'string' }, key: { type: 'string', sensitive: true, required: true }, many: { type: 'directory', multiple: true, default: ['/a', '/b'] } };
  let m = manifest({ type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js', '--root', '${user_config.root}', '--vault', '${user_config.vault}', '${user_config.many}'], env: { MODE: 'stdio', N: 3, OPT: '${user_config.vault}', PATH: '/evil', NODE_OPTIONS: '--require /x' } } }, { user_config: { ...uc, key: { ...uc.key, required: false } } });
  r = await launchOf(nodeBundle(m));
  assert.deepEqual(r.launch.args, ['/work/pkg/server/index.js', '--root', '/tmp/home/notes', '/a', '/b']);
  assert.deepEqual(r.launch.env, { MODE: 'stdio', N: '3' }, 'names the sandbox owns are never passed');
  m = manifest({ type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { API_KEY: '${user_config.key}' } } }, { user_config: uc });
  assert.equal((await launchOf(nodeBundle(m))).detail, 'start_needs_config', 'a required value is never guessed');
  // A linux override; python with PYTHONPATH inside the bundle; uv run as uv would; a linux/amd64 binary.
  m = manifest({ type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/mac.js'], platform_overrides: { linux: { args: ['${__dirname}/server/index.js', '--linux'] } } } });
  assert.deepEqual((await launchOf(nodeBundle(m))).launch.args, ['/work/pkg/server/index.js', '--linux']);
  m = manifest({ type: 'python', entry_point: 'server/main.py', mcp_config: { command: 'python3', args: ['${__dirname}/server/main.py'], env: { PYTHONPATH: '${__dirname}/server/lib:${__dirname}' } } });
  r = await launchOf(zip({ 'manifest.json': m, 'server/main.py': 'x' }));
  assert.deepEqual([r.launch.runtime, r.launch.args, r.launch.pythonpath], ['python', ['/work/pkg/server/main.py'], ['server/lib', '.']]);
  m = manifest({ type: 'python', entry_point: 'server/main.py', mcp_config: { command: 'python', args: ['${__dirname}/server/main.py'], env: { PYTHONPATH: '/usr/lib/evil' } } });
  assert.equal((await launchOf(zip({ 'manifest.json': m, 'server/main.py': 'x' }))).detail, 'launch_invalid', 'a PYTHONPATH outside the bundle');
  m = manifest({ type: 'uv', entry_point: 'mcp_entry.py', mcp_config: { command: 'uv', args: ['run', '--frozen', '--no-dev', '--extra', 'mcp', '--project', '${__dirname}', '${__dirname}/mcp_entry.py', 'serve'] } });
  r = await launchOf(zip({ 'manifest.json': m, 'mcp_entry.py': 'x', 'pyproject.toml': '[project]\nname="x"\n' }));
  assert.deepEqual([r.launch.runtime, r.launch.args, r.launch.extras, r.launch.console], ['uv', ['/work/pkg/mcp_entry.py', 'serve'], ['mcp'], undefined]);
  m = manifest({ type: 'uv', entry_point: 'src/x/server.py', mcp_config: { command: 'uv', args: ['run', '--directory', '${__dirname}', 'x-mcp'] } });
  assert.equal((await launchOf(zip({ 'manifest.json': m, 'pyproject.toml': '[project]\nname="x"\n' }))).launch.console, 'x-mcp');
  m = manifest({ type: 'uv', entry_point: 'server.py' });
  assert.deepEqual((await launchOf(zip({ 'manifest.json': m, 'server.py': 'x', 'pyproject.toml': '[project]\nname="x"\n' }))).launch.args, ['/work/pkg/server.py'], 'a uv bundle with no mcp_config: uv run <entry_point>');
  m = manifest({ type: 'binary', entry_point: 'server/srv', mcp_config: { command: '${__dirname}/server/srv', args: ['--stdio'] } });
  r = await launchOf(zip({ 'manifest.json': m, 'server/srv': ELF64() }));
  assert.deepEqual([r.launch.runtime, r.launch.entry, r.launch.args], ['binary', 'server/srv', ['--stdio']]);
});

test('R-LP-72: a bundle is the subject\'s fault only for its own evidence (the release page\'s 404, other bytes than its registry entry names, no archive, a path outside itself, nothing to run); our limits and platforms are ours', async () => {
  assert.equal((await MB.mcpbLaunch(mcpbPkg('https://github.com/acme/bundle/releases/download/v1/gone.mcpb'), { fetch: releases({}) }).catch((e) => e)).detail, 'bundle_unavailable');
  assert.equal((await launchOf(Buffer.from('#!/bin/sh\necho no archive\n'))).detail, 'bundle_invalid');
  assert.equal((await launchOf(zip({ 'manifest.json': manifest({ type: 'node', mcp_config: { command: 'node', args: ['x'] } }), '../../evil': 'x' }))).detail, 'bundle_invalid');
  assert.equal((await launchOf(zip({ 'server/index.js': 'x' }))).detail, 'package_not_runnable', 'no manifest');
  assert.equal((await launchOf(zip({ 'manifest.json': '{not json' }))).detail, 'package_not_runnable');
  assert.equal((await launchOf(zip({ 'manifest.json': manifest(undefined) }))).detail, 'package_not_runnable', 'no server');
  assert.equal((await launchOf(nodeBundle(manifest({ type: 'node', entry_point: 'server/gone.js', mcp_config: { command: 'node', args: ['${__dirname}/server/gone.js'] } })))).detail, 'package_not_runnable', 'the script is not in the bundle');
  // Ours: the host, our size cap, a server type or a launcher we do not start, a binary for another platform.
  assert.equal((await MB.mcpbLaunch(mcpbPkg('https://example.com/acme.mcpb'), { fetch: releases({}) }).catch((e) => e)).detail, 'bundle_host_not_allowed');
  assert.equal((await MB.mcpbLaunch(mcpbPkg(), { fetch: releases({ [URL1]: { location: 'https://evil.example/x', body: nodeBundle() } }) }).catch((e) => e)).detail, 'bundle_host_not_allowed', 'a redirect off the release-asset hosts');
  assert.equal((await MB.fetchBundle(URL1, { fetch: releases({ [URL1]: { body: Buffer.alloc(2000) } }), cap: 1000 }).catch((e) => e)).detail, 'bundle_too_large');
  assert.equal((await launchOf(nodeBundle(manifest({ type: 'deno', mcp_config: { command: 'deno', args: [] } })))).detail, 'bundle_runtime_unsupported');
  assert.equal((await launchOf(zip({ 'manifest.json': manifest({ type: 'binary', mcp_config: { command: '/bin/sh', args: ['${__dirname}/server/launch.sh'] } }), 'server/launch.sh': 'x' }))).detail, 'bundle_runtime_unsupported');
  assert.equal((await launchOf(zip({ 'manifest.json': manifest({ type: 'binary', entry_point: 'server/srv', mcp_config: { command: '${__dirname}/server/srv' } }, { compatibility: { platforms: ['darwin'] } }), 'server/srv': ELF64() }))).detail, 'platform_unsupported');
  assert.equal((await launchOf(zip({ 'manifest.json': manifest({ type: 'binary', entry_point: 'server/srv', mcp_config: { command: '${__dirname}/server/srv' } }), 'server/srv': ELF64(0xb7) }))).detail, 'platform_unsupported', 'an arm64 binary');
  assert.equal((await launchOf(zip({ 'manifest.json': manifest({ type: 'binary', entry_point: 'server/srv', mcp_config: { command: '${__dirname}/server/srv' } }), 'server/srv': Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]) }))).detail, 'platform_unsupported', 'a Mach-O binary');
  for (const [d, fault] of [['bundle_unavailable', 'subject'], ['bundle_hash_mismatch', 'subject'], ['bundle_invalid', 'subject'], ['package_not_runnable', 'subject'], ['bundle_host_not_allowed', 'tool'], ['bundle_too_large', 'tool'], ['bundle_runtime_unsupported', 'tool'], ['bundle_unreadable', 'tool'], ['platform_unsupported', 'tool'], ['start_needs_config', 'tool']]) assert.equal(LP.DETAILS[d][3], fault, d);
  // Through the lane's resolver: one subject's bundles are tried in turn (a darwin build first, then the linux one).
  const mac = zip({ 'manifest.json': manifest({ type: 'binary', entry_point: 'server/srv', mcp_config: { command: '${__dirname}/server/srv' } }, { compatibility: { platforms: ['darwin'] } }), 'server/srv': ELF64() });
  const lin = zip({ 'manifest.json': manifest({ type: 'binary', entry_point: 'server/srv', mcp_config: { command: '${__dirname}/server/srv' } }, { compatibility: { platforms: ['linux'] } }), 'server/srv': ELF64() });
  const U2 = URL1.replace('acme.mcpb', 'acme-linux.mcpb');
  const seed = new Map([['acme/bundle', [{ registry: 'mcpb', identifier: URL1 }, { registry: 'mcpb', identifier: U2 }]]]);
  const r = await LP.resolveSubject({ subject: 'acme/bundle', repo: 'acme/bundle' }, { seed, fetch: releases({ [URL1]: { body: mac }, [U2]: { body: lin } }) });
  assert.deepEqual([r.status, r.launch.url, r.choice.type, r.choice.mcpb.runtime], ['runnable', U2, 'mcpb', 'binary']);
  const none = await LP.resolveSubject({ subject: 'acme/bundle', repo: 'acme/bundle' }, { seed, fetch: releases({ [URL1]: { body: mac } }) });
  assert.equal(none.detail, 'platform_unsupported', 'our limit for one bundle comes before the other\'s 404');
});

test('R-LP-72: a path the bundle\'s runtime would resolve (an extension node adds, a folder, a name in another case, a Windows .exe) is never the bundle\'s missing file; uv with no project is a launcher', async () => {
  const nodeM = (arg) => manifest({ type: 'node', mcp_config: { command: 'node', args: ['${__dirname}/' + arg] } });
  // node adds .js and takes a folder's index.js; python runs a folder's __main__.py.
  assert.ok((await launchOf(zip({ 'manifest.json': nodeM('server/index'), 'server/index.js': 'x' }))).launch, 'node adds .js');
  assert.ok((await launchOf(zip({ 'manifest.json': nodeM('server'), 'server/index.js': 'x' }))).launch, 'node takes the folder');
  assert.ok((await launchOf(zip({ 'manifest.json': manifest({ type: 'python', mcp_config: { command: 'python', args: ['${__dirname}/app'] } }), 'app/__main__.py': 'x' }))).launch, 'python runs the folder');
  // A name in another case runs on macOS and Windows only: ours (platform_unsupported), never package_not_runnable.
  assert.equal((await launchOf(zip({ 'manifest.json': nodeM('Server/Index.js'), 'server/index.js': 'x' }))).detail, 'platform_unsupported');
  // A binary named without its .exe, or in another case: a build for another platform.
  const bin = (cmd, files) => zip({ 'manifest.json': manifest({ type: 'binary', mcp_config: { command: '${__dirname}/' + cmd } }), ...files });
  assert.equal((await launchOf(bin('server/srv', { 'server/srv.exe': 'MZ' }))).detail, 'platform_unsupported', 'srv.exe only');
  assert.equal((await launchOf(bin('server/SRV', { 'server/srv': ELF64() }))).detail, 'platform_unsupported', 'another case');
  // Still the bundle's own: a path that names nothing it holds.
  assert.equal((await launchOf(zip({ 'manifest.json': nodeM('server/gone.js'), 'server/index.js': 'x' }))).detail, 'package_not_runnable');
  assert.equal((await launchOf(bin('server/srv', { 'server/other': ELF64() }))).detail, 'package_not_runnable');
  // `uv run <command>` with no pyproject runs a command of the user's environment: a launcher, not a fault of the bundle.
  assert.equal((await launchOf(zip({ 'manifest.json': manifest({ type: 'uv', mcp_config: { command: 'uv', args: ['run', 'x-mcp'] } }) }))).detail, 'bundle_runtime_unsupported');
  // Mutation checks: without the resolution rule node's extension, and without the case rule another case, is the bundle's
  // missing file; without the uv rule a launcher is.
  const src = readFileSync(join(root, 'corpus', 'mcpb.mjs'), 'utf8');
  const mutate = async (from, to) => {
    assert.ok(src.includes(from), from.slice(0, 60));
    const file = join(root, 'corpus', '.mutant-mcpb-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
    writeFileSync(file, src.replace(from, to));
    try { return await import(pathToFileURL(file).href); } finally { rmSync(file, { force: true }); }
  };
  const go = async (M, bundle) => { try { return await M.mcpbLaunch(mcpbPkg(), { fetch: releases({ [URL1]: { body: bundle } }) }); } catch (e) { return { detail: e.detail }; } };
  let M = await mutate("set.has(r) || [...set].some((n) => n.startsWith(r + '/') || n.startsWith(r + '.'))", 'set.has(r)');
  assert.equal((await go(M, zip({ 'manifest.json': nodeM('server/index'), 'server/index.js': 'x' }))).detail, 'package_not_runnable', 'without the rule node\'s .js is a missing file');
  assert.equal((await go(M, bin('server/srv', { 'server/srv.exe': 'MZ' }))).detail, 'package_not_runnable', 'without the rule srv.exe is a missing file');
  M = await mutate("throw fail(holds(rel, lower, rel.toLowerCase()) ? 'platform_unsupported' : 'package_not_runnable', { why });", "throw fail('package_not_runnable', { why });");
  assert.equal((await go(M, zip({ 'manifest.json': nodeM('Server/Index.js'), 'server/index.js': 'x' }))).detail, 'package_not_runnable', 'without the case rule');
  M = await mutate("throw fail('bundle_runtime_unsupported', { why: 'uv_no_project' })", "throw fail('package_not_runnable', { why: 'no_pyproject' })");
  assert.equal((await go(M, zip({ 'manifest.json': manifest({ type: 'uv', mcp_config: { command: 'uv', args: ['run', 'x-mcp'] } }) }))).detail, 'package_not_runnable', 'without the uv rule');
});

test('R-LP-72: a node or python script outside the bundle (an absolute path of the author\'s machine, one that climbs out, a relative one the bundle does not hold) is never the bundle\'s crash: bundle_runtime_unsupported', async () => {
  const nodeArgs = (args) => zip({ 'manifest.json': manifest({ type: 'node', mcp_config: { command: 'node', args } }), 'server/index.js': 'x' });
  const pyArgs = (args) => zip({ 'manifest.json': manifest({ type: 'python', mcp_config: { command: 'python3', args } }), 'server/main.py': 'x' });
  for (const args of [['/Users/dev/app/server.js'], ['--no-warnings', '/opt/app/index.js'], ['${__dirname}/../outside.js'], ['../app/server.js'], ['dist/index.js'], ['-r', 'dotenv/config', '/home/me/srv.js']]) {
    const r = await launchOf(nodeArgs(args));
    assert.deepEqual([r.detail, r.why], ['bundle_runtime_unsupported', args.some((a) => a.startsWith('/') || a.includes('..')) ? 'script_outside' : 'script_relative'], JSON.stringify(args));
  }
  for (const args of [['C:\\dev\\server.py'], ['/Users/dev/main.py'], ['-u', '/srv/main.py']]) assert.equal((await launchOf(pyArgs(args))).detail, 'bundle_runtime_unsupported', JSON.stringify(args));
  // Started as before: a file of the bundle (by ${__dirname} or relative), after options; inline code or a module is not a path.
  for (const args of [['${__dirname}/server/index.js'], ['server/index.js'], ['./server/index.js'], ['--no-warnings', '-r', 'dotenv/config', '${__dirname}/server/index.js'], ['-e', 'require("x")']]) assert.ok((await launchOf(nodeArgs(args))).launch, JSON.stringify(args));
  for (const args of [['${__dirname}/server/main.py'], ['-u', 'server/main.py'], ['-m', 'server.main']]) assert.ok((await launchOf(pyArgs(args))).launch, JSON.stringify(args));
  // The bundle's own: a path inside it that names nothing it holds, found after the options too.
  assert.equal((await launchOf(nodeArgs(['--no-warnings', '${__dirname}/server/gone.js']))).detail, 'package_not_runnable');
  // Mutation check: without the outside check the absolute path is started, and its crash would be the bundle's.
  const src = readFileSync(join(root, 'corpus', 'mcpb.mjs'), 'utf8');
  const from = "  const checkPath = (p0, what, { optional = false } = {}) => {\n    const p = oneSlash(p0);\n";
  assert.ok(src.includes(from), 'the mutation text is in corpus/mcpb.mjs');
  const file = join(root, 'corpus', '.mutant-mcpb-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
  writeFileSync(file, src.replace(from, from + "    if (what === 'script') return;\n"));
  let M; try { M = await import(pathToFileURL(file).href); } finally { rmSync(file, { force: true }); }
  const got = await M.mcpbLaunch(mcpbPkg(), { fetch: releases({ [URL1]: { body: nodeArgs(['/Users/dev/app/server.js']) } }) }).catch((e) => ({ detail: e.detail }));
  assert.ok(got.launch, 'without the check the author\'s absolute path would be started');
  assert.equal(got.info.crash_not_evidence, false, '...as a node bundle whose crash counts');
});

test('R-LP-72: a file a node option loads before the script (-r, --require, --import, --loader, --experimental-loader, --env-file) is checked like the script; a package name stays allowed; value options and grouped python flags are read as the runtime reads them', async () => {
  const nodeArgs = (args) => zip({ 'manifest.json': manifest({ type: 'node', mcp_config: { command: 'node', args } }), 'server/index.js': 'x', 'server/pre.js': 'x' });
  const pyArgs = (args) => zip({ 'manifest.json': manifest({ type: 'python', mcp_config: { command: 'python3', args } }), 'server/main.py': 'x' });
  const S = '${__dirname}/server/index.js';
  // A file of the author's machine, one that climbs out, or a relative one the bundle does not hold: ours, never started.
  for (const [args, why] of [
    [['-r', '/Users/x/h.js', 'server/index.js'], 'option_outside'], [['--require=/Users/x/h.js', S], 'option_outside'],
    [['--import', 'file:///Users/x/h.mjs', S], 'option_outside'], [['--loader', '../hooks.mjs', S], 'option_outside'],
    [['--experimental-loader=./gone.mjs', S], 'option_relative'], [['--env-file', '/Users/dev/.env', 'server/index.js'], 'option_outside'],
    [['--env-file=.env', S], 'option_relative'], [['--env-file', '${__dirname}/config/app.env', S], 'option_missing'], [['--env-file', '${__dirname}/.env', S], 'option_unreadable'],
    [['${__dirname}/my server(1).js'], 'script_unreadable'],
  ]) {
    const r = await launchOf(nodeArgs(args));
    assert.deepEqual([r.detail, r.why], ['bundle_runtime_unsupported', why], JSON.stringify(args));
  }
  // Started: a package name, a file of the bundle, node: and data: specifiers; a value option's value is not the script.
  for (const args of [['-r', 'dotenv/config', S], ['--import', '@scope/pkg/register', S], ['-r', '${__dirname}/server/pre.js', S], ['--require=./server/pre.js', 'server/index.js'],
    ['--import', 'data:text/javascript,1', S], ['--disable-warning', 'ExperimentalWarning', 'server/index.js'], ['--title', 'srv', S], ['--max-old-space-size=512', S]]) assert.ok((await launchOf(nodeArgs(args))).launch, JSON.stringify(args));
  // A file in the bundle that an option names but the bundle lacks is its own, as for the script.
  assert.equal((await launchOf(nodeArgs(['-r', '${__dirname}/server/gone.js', S]))).detail, 'package_not_runnable');
  // python: an attached -W or -X value (-Wmodule) and a grouped flag (-uW ignore) do not hide the script; a long option's value is not it.
  for (const args of [['-Wmodule', '/Users/dev/main.py'], ['-uW', 'ignore', '/srv/main.py'], ['--check-hash-based-pycs', 'never', '/srv/main.py'], ['-Xutf8', '-B', '/srv/main.py']]) assert.equal((await launchOf(pyArgs(args))).detail, 'bundle_runtime_unsupported', JSON.stringify(args));
  for (const args of [['-Wignore', '${__dirname}/server/main.py'], ['-uB', 'server/main.py'], ['-um', 'server.main'], ['-c', 'import x']]) assert.ok((await launchOf(pyArgs(args))).launch, JSON.stringify(args));
  // Mutation checks.
  const src = readFileSync(join(root, 'corpus', 'mcpb.mjs'), 'utf8');
  const mutate = async (from, to) => {
    assert.ok(src.includes(from), from.slice(0, 60));
    const file = join(root, 'corpus', '.mutant-mcpb-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
    writeFileSync(file, src.replace(from, to));
    try { return await import(pathToFileURL(file).href); } finally { rmSync(file, { force: true }); }
  };
  const go = async (M, bundle) => { try { return await M.mcpbLaunch(mcpbPkg(), { fetch: releases({ [URL1]: { body: bundle } }) }); } catch (e) { return { detail: e.detail, why: e.why }; } };
  let M = await mutate('    for (const l of loads) {', '    for (const l of []) {');
  assert.ok((await go(M, nodeArgs(['--env-file', '/Users/dev/.env', 'server/index.js']))).launch, 'without the option check the author\'s .env would be loaded and the crash counted');
  assert.ok((await go(M, nodeArgs(['-r', '/Users/x/h.js', 'server/index.js']))).launch, 'without the option check -r /Users/x/h.js would be started');
  M = await mutate("      if (ch === 'c' || ch === 'm') return out(null);", "      if (/[cm]/.test(a.slice(k))) return out(null);");
  assert.ok((await go(M, pyArgs(['-Wmodule', '/Users/dev/main.py']))).launch, 'with the unanchored pattern -Wmodule hides the script');
  M = await mutate("'--title', '--input-type', '--inspect-port', '--debug-port', '--disable-warning',", "'--title', '--input-type', '--inspect-port', '--debug-port',");
  assert.equal((await go(M, nodeArgs(['--disable-warning', 'ExperimentalWarning', 'server/index.js']))).why, 'script_relative', 'without --disable-warning its value is read as the script');
  M = await mutate("    if (p.startsWith(BUNDLE_DIR + '/') && !segs.includes('..')) throw fail('bundle_runtime_unsupported', { why: `${what}_unreadable` });\n", '');
  assert.equal((await go(M, nodeArgs(['${__dirname}/my server(1).js']))).why, 'script_outside', 'without the rule a bundle path we do not read is called outside');
});

test('R-LP-72: a path with a run of slashes names the file it would without them; a module from the home folder, another scheme, or a file: URL with a host or an encoded slash is ours, never the bundle\'s missing module', async () => {
  const nodeArgs = (args) => zip({ 'manifest.json': manifest({ type: 'node', mcp_config: { command: 'node', args } }), 'server/index.js': 'x', 'lib/a.mjs': 'x' });
  const S = '${__dirname}/server/index.js';
  // A run of slashes: the file is there (script, option, binary), so it starts; a really missing one stays the bundle's.
  for (const args of [['${__dirname}/server//index.js'], ['--import', '${__dirname}/lib//a.mjs', S], ['-r', '${__dirname}//lib///a.mjs', S], ['server//index.js']]) assert.ok((await launchOf(nodeArgs(args))).launch, JSON.stringify(args));
  assert.equal((await launchOf(nodeArgs(['${__dirname}/server//gone.js']))).detail, 'package_not_runnable');
  const bin = zip({ 'manifest.json': manifest({ type: 'binary', mcp_config: { command: '${__dirname}/bin//srv' } }), 'bin/srv': ELF64() });
  assert.equal((await launchOf(bin)).launch.entry, 'bin/srv', 'a binary named with a run of slashes');
  // Ours: the home folder, a scheme a loader would fetch or resolve, a file: URL naming another host, an encoded separator.
  for (const [v, why] of [['~/h.js', 'option_outside'], ['~user/h.js', 'option_outside'], ['https://x.example/y.js', 'option_scheme'], ['http://x/y.js', 'option_scheme'], ['jsr:@std/x', 'option_scheme'],
    ['file://host/work/pkg/lib/a.mjs', 'option_outside'], ['file:///work/pkg/lib%2Fa.mjs', 'option_unreadable'], ['file:///work/pkg%5Clib/a.mjs', 'option_unreadable']]) {
    const r = await launchOf(nodeArgs(['--import', v, S]));
    assert.deepEqual([r.detail, r.why], ['bundle_runtime_unsupported', why], v);
  }
  // Still started: a file: URL of a file the bundle holds, a package name, node: and data:.
  for (const v of ['file:///work/pkg/lib/a.mjs', 'dotenv/config', '@scope/pkg', 'node:fs', 'data:text/javascript,1']) assert.ok((await launchOf(nodeArgs(['--import', v, S]))).launch, v);
  // Mutation checks: without each rule the fixture would start (and a missing-module crash count against the server),
  // or a held file would be the bundle's missing one.
  const src = readFileSync(join(root, 'corpus', 'mcpb.mjs'), 'utf8');
  const mutate = async (from, to) => {
    assert.ok(src.includes(from), from.slice(0, 60));
    const file = join(root, 'corpus', '.mutant-mcpb-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
    writeFileSync(file, src.replace(from, to));
    try { return await import(pathToFileURL(file).href); } finally { rmSync(file, { force: true }); }
  };
  const go = async (M, bundle) => { try { return await M.mcpbLaunch(mcpbPkg(), { fetch: releases({ [URL1]: { body: bundle } }) }); } catch (e) { return { detail: e.detail, why: e.why }; } };
  let M = await mutate("a.replace(/\\/{2,}/g, '/')", 'a');
  assert.equal((await go(M, nodeArgs(['--import', '${__dirname}/lib//a.mjs', S]))).detail, 'package_not_runnable', 'without the collapse a held file reads as missing');
  M = await mutate("        if (v.startsWith('~')) throw fail('bundle_runtime_unsupported', { why: 'option_outside' });\n", '');
  assert.ok((await go(M, nodeArgs(['--import', '~/h.js', S]))).launch, 'without the home rule ~/h.js would be started');
  M = await mutate("          if (u.host) throw fail('bundle_runtime_unsupported', { why: 'option_outside' });\n", '');
  assert.ok((await go(M, nodeArgs(['--import', 'file://host/work/pkg/lib/a.mjs', S]))).launch, 'without the host rule another machine\'s file would pass for the bundle\'s');
  M = await mutate("          if (/%(2f|5c)/i.test(u.pathname)) throw fail('bundle_runtime_unsupported', { why: 'option_unreadable' });\n", '');
  assert.ok((await go(M, nodeArgs(['--import', 'file:///work/pkg/lib%2Fa.mjs', S]))).launch, 'without the rule an encoded slash would be read as a separator');
  M = await mutate("        } else if (!drive && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)) throw fail('bundle_runtime_unsupported', { why: 'option_scheme' });\n", '        }\n');
  assert.ok((await go(M, nodeArgs(['--import', 'https://x.example/y.js', S]))).launch, 'without the scheme rule an https: module would be started');
});

test('R-LP-72 mutation check: without the sha256 check, the entry-name check, the redirect host check, the required-config check or the ELF check, the fixture gets through', async () => {
  const src = readFileSync(join(root, 'corpus', 'mcpb.mjs'), 'utf8');
  const mutate = async (from, to) => {
    assert.ok(src.includes(from), from.slice(0, 60));
    const file = join(root, 'corpus', '.mutant-mcpb-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
    writeFileSync(file, src.replace(from, to));
    try { return await import(pathToFileURL(file).href); } finally { rmSync(file, { force: true }); }
  };
  const go = async (M, bundle, pkg = mcpbPkg(), map = null) => { try { return await M.mcpbLaunch(pkg, { fetch: releases(map || { [URL1]: { body: bundle } }) }); } catch (e) { return { detail: e.detail }; } };
  const b = nodeBundle();
  let M = await mutate("  if (want && want !== sha256) throw fail('bundle_hash_mismatch');", '');
  assert.ok((await go(M, b, mcpbPkg(URL1, { fileSha256: 'f'.repeat(64) }))).launch, 'other bytes than the registry names');
  M = await mutate('    if (!n) {\n      // Only a name', '    if (false) {\n      // Only a name');
  assert.ok((await go(M, nodeBundle(undefined, { '../../evil': 'x' }))).launch, 'a path outside the bundle');
  M = await mutate("      u = allowedUrl(next.href);\n      if (!u) throw fail('bundle_host_not_allowed');", '      u = next;');
  assert.ok((await go(M, null, mcpbPkg(), { [URL1]: { location: 'https://release-assets.githubusercontent.com.evil.example/x', body: b } })).detail !== 'bundle_host_not_allowed', 'a redirect elsewhere is followed');
  M = await mutate("    if (r.missing === 'required') throw fail('start_needs_config', { why: 'user_config' });\n    if (r.missing) continue;", '    if (r.missing) continue;');
  const needKey = nodeBundle(manifest({ type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { API_KEY: '${user_config.key}' } } }, { user_config: { key: { type: 'string', required: true } } }));
  assert.ok((await go(M, needKey)).launch, 'a required value would be left out and the server started');
  M = await mutate("    if (!m || !isLinuxAmd64(buf, m)) throw fail('platform_unsupported', { why: 'not_linux_amd64' });", '');
  assert.ok((await go(M, zip({ 'manifest.json': manifest({ type: 'binary', entry_point: 'server/srv', mcp_config: { command: '${__dirname}/server/srv' } }), 'server/srv': ELF64(0xb7) }))).launch, 'an arm64 binary would be started');
});

const mcpbRec = (steps) => ({ install: { kind: 'mcpb', ok: false, steps, egress_refused: 0 }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false });
const MLAUNCH = { kind: 'mcpb', url: URL1, sha256: 'a'.repeat(64), runtime: 'node' };

test('R-LP-73: what goes wrong with a bundle in the sandbox is ours: the planner read and judged those very bytes', () => {
  const fd2 = (rec, log = '') => LP.failureDetail(rec, null, null, { stepsLog: log, launch: MLAUNCH, argsUnfilled: 0 });
  for (const error of ['not_found', 'sha256_mismatch', 'unsafe_path', 'zip_unreadable', 'fetch_failed', 'redirect_refused', 'no_manifest']) assert.equal(fd2(mcpbRec([{ name: 'fetch', exit: 1, result: { error } }])), 'install_build_failed', error);
  for (const error of ['too_large', 'too_many_files', 'too_big_unpacked']) assert.equal(fd2(mcpbRec([{ name: 'fetch', exit: 1, result: { error } }])), 'install_resource_limit', error);
  // A uv bundle's pip install: its dependencies' builds run, so their words are no evidence.
  assert.equal(fd2(mcpbRec([{ name: 'fetch', exit: 0 }, { name: 'venv', exit: 0 }, { name: 'requirements', exit: 0 }, { name: 'install', exit: 1 }]), 'ERROR: No matching distribution found for acme\n'), 'install_build_failed');
});

test('R-LP-74: a bundle that does not run here as shipped (no linux in its manifest, or python or uv on an environment we rebuilt) runs anyway, and its crash is never its fault', async () => {
  const m = manifest({ type: 'python', entry_point: 'server/main.py', mcp_config: { command: 'python', args: ['${__dirname}/server/main.py'] } });
  assert.equal((await launchOf(zip({ 'manifest.json': m, 'server/main.py': 'x' }))).info.crash_not_evidence, true);
  assert.equal((await launchOf(nodeBundle())).info.crash_not_evidence, false, 'a node bundle runs as shipped');
  assert.equal((await launchOf(nodeBundle(manifest({ type: 'node', entry_point: 'server/index.js', mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'] } }, { compatibility: { platforms: ['darwin'] } })))).info.crash_not_evidence, true);
  const rec = { install: { kind: 'mcpb', ok: true, steps: [{ name: 'fetch', exit: 0 }] }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false };
  const crash = { initialize: null, era: null, error: null, initialize_error: 'the server exited (exit 1, signal null)', lists: {}, transport: { exit: 1, signal: null }, timing: { total_ms: 3000 }, stderr: 'Segmentation fault (core dumped)\n' };
  assert.equal(LP.failureDetail(rec, crash, null, { launch: MLAUNCH, argsUnfilled: 0 }), 'start_failed');
  assert.equal(LP.failureDetail(rec, crash, null, { launch: MLAUNCH, argsUnfilled: 0, crashNotEvidence: true }), 'start_env_limited');
  // A quiet exit with a declared variable is no more the bundle's than a crash, when it does not run as shipped (27 Nov).
  const withKey = { ...rec, env: { names: { registry: ['API_KEY'] }, secret_named: [] } };
  const quiet = { ...crash, stderr: '' };
  assert.equal(LP.failureDetail(withKey, quiet, null, { launch: MLAUNCH, argsUnfilled: 0 }), 'needs_credentials', 'as shipped, the declared variable');
  assert.equal(LP.failureDetail(withKey, quiet, null, { launch: MLAUNCH, argsUnfilled: 0, crashNotEvidence: true }), 'start_env_limited');
  // Links the sandbox left out when it unpacked the bundle (a file the server may need): its crash is no evidence either.
  assert.equal(LP.crashNotEvidenceOf({ mcpb: { crash_not_evidence: false } }, { install: { kind: 'mcpb', steps: [{ name: 'fetch', exit: 0, result: { ok: true, links_skipped: 3 } }] } }), true);
  assert.equal(LP.crashNotEvidenceOf({ mcpb: { crash_not_evidence: false } }, { install: { kind: 'mcpb', steps: [{ name: 'fetch', exit: 0, result: { ok: true, links_skipped: 0 } }] } }), false);
});

test('R-LP-74 mutation check: without the platform guard a darwin-only bundle\'s crash would be its fault', async () => {
  const rec = { install: { kind: 'mcpb', ok: true, steps: [] }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false };
  const crash = { initialize_error: 'the server exited (exit 1, signal null)', lists: {}, transport: { exit: 1, signal: null }, timing: { total_ms: 3000 }, stderr: 'Segmentation fault (core dumped)\n' };
  const M = await mutant('  const noEvidence = rolledForward(inst) || crashNotEvidence;', '  const noEvidence = rolledForward(inst);');
  assert.equal(M.failureDetail(rec, crash, null, { launch: MLAUNCH, argsUnfilled: 0, crashNotEvidence: true }), 'start_failed');
  const withKey = { ...rec, env: { names: { registry: ['API_KEY'] }, secret_named: [] } };
  assert.equal(M.failureDetail(withKey, { ...crash, stderr: '' }, null, { launch: MLAUNCH, argsUnfilled: 0, crashNotEvidence: true }), 'needs_credentials', 'without the guard the quiet exit is the bundle\'s');
});

test('R-LP-72: a bundle\'s own failure is the subject\'s only for an entry in its namespace: a third-party entry naming the repository with a dead bundle is unverified, a seed-only one ours; a bare launcher is never the bundle\'s', async () => {
  const dead = 'https://github.com/victim/repo/releases/download/v1/gone.mcpb';
  const entry = (name, repo) => ({ name, version: '1.0.0', repository: { url: 'https://github.com/' + repo, source: 'github' }, packages: [mcpbPkg(dead)] });
  const reg = (servers) => async (url) => {
    const u = new URL(url);
    if (u.hostname === 'registry.modelcontextprotocol.io') { const q = (u.searchParams.get('search') || '').toLowerCase(); return res(200, { servers: servers.filter((s) => s.name.toLowerCase().includes(q)).map((server) => ({ server })) }); }
    if (u.hostname === 'github.com') return res(404, 'Not Found');
    if (u.hostname === 'api.github.com') return res(404, {});
    throw new Error('unexpected fetch ' + url);
  };
  const r = (servers, seed = new Map()) => LP.resolveSubject({ subject: 'victim/repo', repo: 'victim/repo' }, { fetch: reg(servers), seed });
  assert.equal((await r([entry('io.github.mallory/repo', 'victim/repo')])).detail, 'unverified_registry_entry', 'anyone\'s claim on the repository');
  assert.equal((await r([], new Map([['victim/repo', [{ registry: 'mcpb', identifier: dead }]]]))).detail, 'bundle_unowned', 'seed-only: not shown to be theirs');
  assert.equal((await r([entry('io.github.victim/repo', 'victim/repo')])).detail, 'bundle_unavailable', 'their own namespace: theirs');
  for (const d of LP.SUBJECT_RESOLVE_DETAILS) assert.equal(LP.DETAILS[d][3], 'subject', d);
  assert.deepEqual(LP.DETAILS.bundle_unowned, ['install_failed_registry', false, 'resolve', 'tool']);
  // The release page's 404 is asked once more before it counts.
  let n = 0;
  const flaky = async (url) => { const u = new URL(url); if (u.hostname === 'github.com') return n++ === 0 ? res(404, '') : { status: 302, ok: false, headers: { get: (h) => (h === 'location' ? ASSET + '&f=x' : null) } }; return res(200, nodeBundle()); };
  assert.equal((await MB.mcpbLaunch(mcpbPkg(URL1), { fetch: flaky, retryMs: 0 })).launch.runtime, 'node');
  // A launcher on the user's machine is not a file of the bundle: ours, never package_not_runnable; a shell even when shipped.
  for (const command of ['npx', 'sh', 'bash', 'bun', 'deno', 'docker', 'uvx', 'server/sh']) {
    const b = zip({ 'manifest.json': manifest({ type: 'binary', entry_point: 'server/x', mcp_config: { command, args: ['x'] } }), 'server/x': ELF64(), ...(command === 'server/sh' ? { 'server/sh': ELF64() } : {}) });
    assert.equal((await launchOf(b)).detail, 'bundle_runtime_unsupported', command);
  }
  // An entry name our rules do not take is ours; only one that leaves the bundle is its fault.
  assert.equal((await launchOf(nodeBundle(undefined, { 'a\\b.js': 'x' }))).detail, 'bundle_unreadable');
  assert.equal((await launchOf(nodeBundle(undefined, { 'a/../../b.js': 'x' }))).detail, 'bundle_invalid');
  assert.equal((await launchOf(nodeBundle(undefined, { ['a/'.repeat(70) + 'x']: 'x' }))).detail, 'bundle_unreadable', 'our depth limit');
});

test('R-LP-72 mutation check: without the ownership gate a stranger\'s dead bundle is the victim\'s fault; without the launcher check npx is package_not_runnable', async () => {
  const dead = 'https://github.com/victim/repo/releases/download/v1/gone.mcpb';
  const reg = async (url) => { const u = new URL(url); if (u.hostname === 'registry.modelcontextprotocol.io') return res(200, { servers: [{ server: { name: 'io.github.mallory/repo', version: '1', repository: { url: 'https://github.com/victim/repo' }, packages: [mcpbPkg(dead)] } }] }); return res(404, ''); };
  const M = await mutant("        if (SUBJECT_RESOLVE_DETAILS.includes(r.detail) && !(c.entry && c.entry.namespace))", '        if (false)');
  M.RETRY && (M.RETRY.ms = 0);
  assert.equal((await M.resolveSubject({ subject: 'victim/repo', repo: 'victim/repo' }, { fetch: reg })).detail, 'bundle_unavailable');
  const src = readFileSync(join(root, 'corpus', 'mcpb.mjs'), 'utf8');
  const from = "    if (LAUNCHERS.has(c.split('/').pop()) || (!c.includes('/') && !names.has(c))) throw fail('bundle_runtime_unsupported', { why: 'launcher' });\n";
  assert.ok(src.includes(from));
  const file = join(root, 'corpus', '.mutant-mcpb-' + process.pid + '-l.mjs');
  writeFileSync(file, src.replace(from, ''));
  try {
    const X = await import(pathToFileURL(file).href);
    const b = zip({ 'manifest.json': manifest({ type: 'binary', entry_point: 'server/x', mcp_config: { command: 'npx', args: ['x'] } }), 'server/x': ELF64() });
    const out = await X.mcpbLaunch(mcpbPkg(), { fetch: releases({ [URL1]: { body: b } }), retryMs: 0 }).catch((e) => e);
    assert.equal(out.detail, 'package_not_runnable', 'without the check the user\'s launcher is the bundle\'s missing binary');
  } finally { rmSync(file, { force: true }); }
});
