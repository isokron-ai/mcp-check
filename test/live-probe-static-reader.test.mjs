// live-probe's static layer (R-LP-77, R-LP-78): mcp-check's own reader, read over the archive the sandbox fetched
// (corpus/static-read.cjs), graded as scan-static grades a subject. Each fixture is served once as the GitHub repository
// scan-static reads (scanSubject, its own code path) and once as the files the sandbox's static step hands the reader;
// the two answers must be the same, to the grade and the check counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { scanSubject } from '../corpus/scan-static.mjs';
import * as LP from '../corpus/live-probe.mjs';
import { readerBundle } from '../corpus/live-probe-driver.mjs';

const require = createRequire(import.meta.url);
const SR = require('../corpus/static-read.cjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'ab'.repeat(20);
const REPO = 'fixture-owner/fixture-repo';

// a folder as the files the sandbox's static step hands the reader (sandbox/static.mjs readerLayer)
function filesOf(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), r);
      else if (e.isFile()) { const size = statSync(join(abs, e.name)).size; out.push({ path: r, size, data: size < SR.LIST_FILE_MAX ? readFileSync(join(abs, e.name)) : null }); }
    }
  };
  walk(dir, '');
  return out;
}
// the same folder as scan-static reads a subject from GitHub: the repository, its branch, then the reader's own requests
function githubFetch(dir) {
  const inner = SR.archiveFetch(filesOf(dir), { owner: REPO.split('/')[0], repo: REPO.split('/')[1], sha: SHA });
  const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  return async (url) => {
    const u = String(url);
    if (u === 'https://api.github.com/repos/' + REPO) return json({ full_name: REPO, default_branch: 'main', private: false, archived: false, fork: false });
    if (u === 'https://api.github.com/repos/' + REPO + '/branches/main') return json({ name: 'main', commit: { sha: SHA, commit: { committer: { date: '2026-11-27T00:00:00Z' } } } });
    return inner(url);
  };
}
// static.json as the sandbox writes it: our reader's answer next to the vendored engine's candidates, made up here
async function staticJson(dir, vendored = null) {
  const reader = JSON.parse(JSON.stringify(await SR.readFiles(filesOf(dir), { repo: REPO, sha: SHA })));
  return { format: 'isokron-surface-static/1', static: { candidates: vendored || [{ kind: 'source', fidelity: 'literal', tools: [{ name: 'id', inputSchema: { type: 'object' } }, { name: 'page', inputSchema: {} }] }] }, reader };
}
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpc-lp-static-'));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); }
  return dir;
}

const FIXTURES = {
  'known-answer control': join(ROOT, 'corpus', 'fixtures', 'known-answer'),
  'TypeScript, zod 4 (test/repos/ts-zod)': join(ROOT, 'test', 'repos', 'ts-zod'),
  'Python FastMCP 4 with snake_case ToolAnnotations': repo({
    'pyproject.toml': '[project]\nname = "x"\ndependencies = ["fastmcp>=4.1"]\n',
    'server.py': 'from fastmcp import FastMCP\nfrom mcp.types import ToolAnnotations\nmcp = FastMCP("x")\nRO = ToolAnnotations(read_only_hint=True, open_world_hint=False)\n\n@mcp.tool(annotations=RO)\ndef list_items(project: str) -> str:\n    """List the items of a project."""\n    return ""\n\n@mcp.tool()\ndef delete_item(item_id: str) -> str:\n    """Delete one item."""\n    return ""\n',
  }),
  // zscaler/zscaler-mcp-server shape: an MCPB manifest with names and descriptions only
  'names only (MCPB manifest)': repo({ 'manifest.json': JSON.stringify({ manifest_version: '0.2', name: 'x', server: { type: 'python', entry_point: 'server.py' }, tools: [{ name: 'zia_list_users', description: 'List users.' }, { name: 'zia_delete_user', description: 'Delete a user.' }] }) }),
  'two servers in one repository': repo({
    'a/package.json': JSON.stringify({ name: 'a', dependencies: { '@modelcontextprotocol/sdk': '1.30.0' } }),
    'a/index.ts': 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nconst s = new McpServer({ name: "a", version: "1" });\ns.registerTool("a_one", { description: "One.", inputSchema: {} }, async () => ({ content: [] }));\n',
    'b/package.json': JSON.stringify({ name: 'b', dependencies: { '@modelcontextprotocol/sdk': '1.30.0' } }),
    'b/index.ts': 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nconst s = new McpServer({ name: "b", version: "1" });\ns.registerTool("b_one", { description: "One.", inputSchema: {} }, async () => ({ content: [] }));\n',
  }),
  'nothing to read': repo({ 'README.md': '# not a server\n' }),
};

test('R-LP-77: live-probe\'s static layer and scan-static give the same answer on the same fixture (known-answer control, TypeScript, Python, names only, two servers, nothing to read)', async () => {
  const seen = { graded: 0, skipped: 0 };
  for (const [what, dir] of Object.entries(FIXTURES)) {
    const ss = await scanSubject(REPO, { fetch: githubFetch(dir) });
    const a = LP.staticAnswer(await staticJson(dir));
    if (ss.status === 'graded') {
      seen.graded++;
      assert.equal(a.skip, undefined, what + ': live-probe grades what scan-static grades');
      assert.deepEqual(a.grade.summary, ss.grade, what + ': the same grade, to every section, check count and finding');
    } else {
      seen.skipped++;
      assert.equal(a.skip, ss.detail, what + ': live-probe skips what scan-static skips, with its code');
      assert.equal(a.grade, undefined, what);
    }
  }
  assert.deepEqual(seen, { graded: 3, skipped: 3 });
});

test('R-LP-77: a names-only, several-server or incomplete read is not graded against the live list; the summary says why (zscaler/zscaler-mcp-server shape)', async () => {
  const live = LP.gradeList(JSON.stringify({ tools: [{ name: 'zia_list_users', description: 'List users.', inputSchema: { type: 'object' } }] }));
  const names = LP.compareStatic(live, await staticJson(FIXTURES['names only (MCPB manifest)']));
  assert.deepEqual(names.summary, { static_read: true, static_graded: false, static_skip: 'names_only' });
  assert.equal(names.raw, null);
  assert.equal(LP.compareStatic(live, await staticJson(FIXTURES['two servers in one repository'])).summary.static_skip, 'multiple_servers');
  const known = LP.compareStatic(live, await staticJson(FIXTURES['TypeScript, zod 4 (test/repos/ts-zod)']));
  assert.equal(known.summary.static_graded, true);
  assert.equal(known.summary.static_reader, LP.READER_ID.slice(0, 12));
});

test('R-LP-77: the vendored engine\'s candidates in static.json are never graded (dreamworkhq/mcp shape: parameter names read as tools)', async () => {
  const dir = FIXTURES['TypeScript, zod 4 (test/repos/ts-zod)'];
  const a = LP.staticAnswer(await staticJson(dir, [{ kind: 'source', fidelity: 'literal', tools: ['id', 'page', 'q', 'commentId'].map((name) => ({ name, inputSchema: { type: 'object' } })) }]));
  assert.deepEqual(a.grade.parsed.tools.map((t) => t.name), ['search_notes', 'delete_note']);
  const stat = await staticJson(dir); delete stat.reader;
  assert.deepEqual(LP.staticAnswer(stat), { skip: 'reader_missing' }, 'without our reader\'s answer there is nothing to compare, whatever the vendored engine read');
});

test('R-LP-78: a static answer from another reader than this checkout\'s is not used; an error of the reader is not a list', async () => {
  const stat = await staticJson(FIXTURES['TypeScript, zod 4 (test/repos/ts-zod)']);
  assert.equal(stat.reader.reader_id, LP.READER_ID);
  assert.deepEqual(LP.staticAnswer({ ...stat, reader: { ...stat.reader, reader_id: '0'.repeat(64) } }), { skip: 'reader_mismatch' });
  assert.deepEqual(LP.staticAnswer({ ...stat, reader: { ...stat.reader, format: 'other/1' } }), { skip: 'reader_missing' });
  assert.deepEqual(LP.staticAnswer({ ...stat, reader: { format: SR.FORMAT, reader_id: LP.READER_ID, error: 'reader_incomplete' } }), { skip: 'reader_error' });
  assert.deepEqual(LP.compareStatic(LP.gradeList(JSON.stringify({ tools: [{ name: 'a', inputSchema: { type: 'object' } }] })), { ...stat, reader: { ...stat.reader, reader_id: '0'.repeat(64) } }).summary, { static_read: false, static_graded: false, static_skip: 'reader_mismatch' });
});

test('R-LP-78: the reader bundle is the reader this checkout runs: every module repo-source.cjs requires, and the same id the lane checks', () => {
  // the modules repo-source.cjs requires, read from its own source: none may be left out of the bundle
  const src = readFileSync(join(ROOT, 'src', 'inputs', 'repo-source.cjs'), 'utf8');
  const required = new Set(Array.from(src.matchAll(/require\('\.\/([\w.-]+\.cjs)'\)/g), (m) => m[1]));
  for (const dep of [...required]) { const t = readFileSync(join(ROOT, 'src', 'inputs', dep), 'utf8'); for (const m of t.matchAll(/require\('\.\/([\w.-]+\.cjs)'\)/g)) required.add(m[1]); }
  assert.deepEqual([...required].sort(), SR.READER_FILES.filter((f) => f !== 'repo-source.cjs').sort());
  const b = readerBundle();
  assert.deepEqual(readdirSync(b.dir).sort(), SR.READER_FILES.concat([SR.SELF]).sort());
  assert.equal(b.id, LP.READER_ID);
  for (const [name, from] of SR.bundleFiles()) assert.deepEqual(readFileSync(join(b.dir, name)), readFileSync(from), name + ' is copied as it is');
  // the bundle, required from its own folder as the sandbox requires it, reads with its own copy and has the same id
  const inBundle = require(join(b.dir, SR.SELF));
  assert.equal(inBundle.readerId(), LP.READER_ID);
  assert.ok(existsSync(join(b.dir, 'repo-source.cjs')));
  // a change to any reader file changes the id
  writeFileSync(join(b.dir, 'repo-go.cjs'), readFileSync(join(b.dir, 'repo-go.cjs'), 'utf8') + '\n// changed\n');
  assert.notEqual(inBundle.readerId(), LP.READER_ID);
});

test('R-LP-77: a subfolder is read as fromGitHub reads it from GitHub: the root files, then the folder\'s own tree', async () => {
  const dir = repo({
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
    'package-lock.json': JSON.stringify({ packages: { 'node_modules/@modelcontextprotocol/sdk': { version: '1.30.0' }, 'node_modules/zod': { version: '3.25.0' } } }),
    'packages/server/package.json': JSON.stringify({ name: 'server', dependencies: { '@modelcontextprotocol/sdk': '^1.30.0', zod: '^3.25.0' } }),
    'packages/server/src/index.ts': 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { z } from "zod";\nconst s = new McpServer({ name: "x", version: "1" });\ns.registerTool("find", { description: "Find.", inputSchema: { q: z.string() } }, async () => ({ content: [] }));\n',
    'packages/other/src/index.ts': 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nconst s = new McpServer({ name: "y", version: "1" });\ns.registerTool("other", { description: "Other.", inputSchema: {} }, async () => ({ content: [] }));\n',
  });
  const r = await SR.readFiles(filesOf(dir), { repo: REPO, sha: SHA, subdir: 'packages/server' });
  assert.equal(r.subdir, 'packages/server');
  const best = r.scan.candidates[r.scan.best_index];
  assert.deepEqual(best.tools.map((t) => t.name), ['find']);
  assert.equal(best.sdk.version, '1.30.0', 'the root lock file is read, as GitHub lists the root files with the folder');
  assert.deepEqual((await SR.readFiles(filesOf(dir), { repo: REPO, sha: SHA, subdir: '../x' })).error, 'bad_input');
});

test('R-LP-78: the driver hands the sandbox driver this checkout\'s reader bundle, and removes it afterwards', async () => {
  const { main } = await import('../corpus/live-probe-driver.mjs');
  const msc = repo({
    'bin/run-shard.mjs': 'import { existsSync, readdirSync } from "node:fs";\nimport { join } from "node:path";\nexport const writableWorkOption = (w) => w;\nexport async function main(args, opts) { globalThis.__lpRun = { args, id: opts.reader && opts.reader.id, entry: opts.reader && opts.reader.entry, dir: opts.reader && opts.reader.dir, files: opts.reader ? readdirSync(opts.reader.dir).sort() : null }; return 0; }\n',
    'sandbox/probe.mjs': 'export const probeStdio = async () => ({}); export const listed = () => false;\n',
    'src/docker.mjs': 'export class Docker { constructor() {} labels() { return []; } }\n',
    'src/sandbox-run.mjs': 'export const takeTrace = async () => null;\n',
    'src/runsc.mjs': 'export const loadRunscConfig = () => ({});\n',
  });
  const out = mkdtempSync(join(tmpdir(), 'mcpc-lp-out-'));
  writeFileSync(join(out, 'targets.json'), JSON.stringify({ targets: [] }));
  const rc = await main(['--msc', msc, '--oracles', 'none', '--', '--targets', join(out, 'targets.json'), '--out', out]);
  assert.equal(rc, 0);
  const run = globalThis.__lpRun;
  assert.equal(run.id, LP.READER_ID);
  assert.equal(run.entry, SR.SELF);
  assert.deepEqual(run.files, SR.READER_FILES.concat([SR.SELF]).sort());
  assert.equal(existsSync(run.dir), false, 'the bundle folder is gone after the run');
});

// A sandbox driver as the tests above stub it, with or without mcp-surface-corpus #17's writableWork option.
function stubSandbox({ withOption }) {
  return repo({
    'bin/run-shard.mjs': (withOption ? 'export const writableWorkOption = (w) => { if (w === true || w === false) return w; throw new Error("bad"); };\n' : '')
      + 'export async function main(args, opts) { globalThis.__lpWritable = { writableWork: opts.writableWork, reader: !!opts.reader }; return 0; }\n',
    'sandbox/probe.mjs': 'export const probeStdio = async () => ({}); export const listed = () => false;\n',
    'src/docker.mjs': 'export class Docker { constructor() {} labels() { return []; } }\n',
    'src/sandbox-run.mjs': 'export const takeTrace = async () => null;\n',
    'src/runsc.mjs': 'export const loadRunscConfig = () => ({});\n',
  });
}

test('R-ORC-15: the driver runs the sandbox with writableWork true, and stops before any target on a sandbox that has no such option', async () => {
  const D = await import('../corpus/live-probe-driver.mjs');
  assert.equal(D.WRITABLE_WORK, true);
  const out = mkdtempSync(join(tmpdir(), 'mcpc-lp-ww-'));
  writeFileSync(join(out, 'targets.json'), JSON.stringify({ targets: [] }));
  const args = (msc) => ['--msc', msc, '--oracles', 'none', '--', '--targets', join(out, 'targets.json'), '--out', out];
  globalThis.__lpWritable = null;
  assert.equal(await D.main(args(stubSandbox({ withOption: true }))), 0);
  assert.deepEqual(globalThis.__lpWritable, { writableWork: true, reader: true }, 'the option goes to the sandbox driver as exactly true');
  // An older sandbox would ignore it and run every server on the read-only volume: refused, as our own (harness) error.
  globalThis.__lpWritable = null;
  await assert.rejects(D.main(args(stubSandbox({ withOption: false }))), /has no writableWork option \(mcp-surface-corpus #17\)/);
  assert.equal(globalThis.__lpWritable, null, 'the sandbox driver never started');
});
