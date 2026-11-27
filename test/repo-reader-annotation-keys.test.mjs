// Python reader: the wire keys of ToolAnnotations hints written in snake_case (R-RD-40). The fixtures are trimmed to
// the shape of public repositories, credited per test (repository@commit). The rule comes from the Python SDK's own
// source: under 1.x (v1.30.0 src/mcp/types.py) ToolAnnotations has camelCase fields and extra="allow", so
// read_only_hint=True stays "read_only_hint" on the wire; under 2.x (v2.0.0 mcp_types/_v2025_11_25) the fields are
// snake_case with camelCase aliases (populate_by_name, serialised by alias) and extra="ignore". fastmcp 4.x needs
// mcp>=2 (fastmcp_slim/pyproject.toml at v4.0.0 to v4.2.6), fastmcp 3.x and 2.x need mcp<2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import M from '../src/engine.js';
import { parseList } from '../src/tools.js';
import { analyseList } from '../src/unreadable.js';
import { readerNotes } from '../src/inputs/collect.js';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpc-annkeys-'));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); }
  return dir;
}
const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));
// the checks that fire on a candidate, graded the way scan-static and the CLI grade a source list
const fired = (c) => new Set(M.allFindings(analyseList(parseList(c.tools, 'source'), readerNotes(c))).map((f) => f.id));
const CAMEL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// KallistoX/mcp-unifi-applications@cec2194a8a86d9160bd2d5657476a5ff93d0f075 (pyproject.toml, src/mcp_unifi_applications/server.py)
const UNIFI_SERVER = `from fastmcp import FastMCP
from mcp.types import ToolAnnotations

mcp = FastMCP("unifi-applications")

READ_ONLY = ToolAnnotations(
    read_only_hint=True,
    destructive_hint=False,
    idempotent_hint=True,
    open_world_hint=False,
)


@mcp.tool(annotations=READ_ONLY)
def list_endpoints(method: str = "", app: str = "") -> str:
    """Browse the endpoint catalogue: one line per endpoint."""
    return ""


@mcp.tool(annotations=READ_ONLY)
def search_endpoints(query: str, method: str = "") -> str:
    """Find endpoints by name, path fragment, method or description."""
    return ""
`;
const UNIFI_PYPROJECT = `[project]
name = "mcp-unifi-applications"
keywords = ["mcp", "unifi", "ubiquiti"]
dependencies = [
    "fastmcp>=4.1",
    "rapidfuzz>=3.0",
]
`;

test('R-RD-40: fastmcp>=4.1 installs SDK 2.x, so ToolAnnotations(read_only_hint=...) is listed camelCase (KallistoX/mcp-unifi-applications shape)', async () => {
  const r = await R.fromDirectory(repo({ 'pyproject.toml': UNIFI_PYPROJECT, 'src/mcp_unifi_applications/__init__.py': '', 'src/mcp_unifi_applications/server.py': UNIFI_SERVER }));
  assert.equal(r.best.kind, 'source');
  assert.equal(r.best.sdk.pyMajor, 2);
  const t = byName(r.best.tools);
  assert.deepEqual(Object.keys(t).sort(), ['list_endpoints', 'search_endpoints']);
  assert.deepEqual(t.list_endpoints.annotations, CAMEL);
  assert.deepEqual(t.search_endpoints.annotations, CAMEL);
  assert.deepEqual(r.best.unreadable, {});
  const f = fired(r.best);
  assert.ok(!f.has('spec-annotation-key-case'), 'no key-case finding against a server whose wire keys are camelCase');
  assert.ok(!f.has('anthropic-hint'), 'the hints are read');
});

// Thecimal/quantified-self-mcp@54197267034c5c1acc7efb1b73e2f47181f97dae (pyproject.toml, requirements.txt, server.py)
test('R-RD-40: a bare mcp next to fastmcp>=4.0.3,<5.0 is SDK 2.x; inline ToolAnnotations(title=..., *_hint=...) is camelCase (Thecimal/quantified-self-mcp shape)', async () => {
  const server = `from fastmcp import FastMCP
from mcp.types import ToolAnnotations

mcp = FastMCP("quantified-self")


@mcp.tool(
    annotations=ToolAnnotations(
        title="Get metric history",
        read_only_hint=True,
        destructive_hint=False,
        idempotent_hint=True,
        open_world_hint=False,
    )
)
def get_metric_history(metric: str, start_date: str | None = None) -> str:
    """
    One metric's day-by-day values only.
    """
    return ""
`;
  const r = await R.fromDirectory(repo({
    'pyproject.toml': '[project]\nname = "quantified-self-mcp"\ndependencies = [\n    "mcp",\n    "fastmcp>=4.0.3,<5.0",\n]\n',
    'requirements.txt': 'fastmcp>=4.0.3,<5.0\n',
    'server.py': server,
  }));
  assert.equal(r.best.sdk.pyMajor, 2);
  assert.deepEqual(r.best.tools[0].annotations, Object.assign({ title: 'Get metric history' }, CAMEL));
  assert.ok(!fired(r.best).has('spec-annotation-key-case'));
});

// alexgaoth/escalate-anything@847cf77f2e021c2c92ce87be8c0fc5845508f752 (pyproject.toml mcp>=1.9, uv.lock mcp 2.3.0, src/escalate_anything/server.py)
test('R-RD-40: the uv.lock entry for mcp decides over a range in pyproject.toml, whatever the file order (alexgaoth/escalate-anything shape)', async () => {
  const server = `from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

READ = ToolAnnotations(read_only_hint=True, open_world_hint=False)


def build():
    mcp = MCPServer(name="escalate-anything", version="0.3.0")

    @mcp.tool(title="Find a company", annotations=READ)
    def find_company(query: str = "") -> dict:
        """Find a company by name."""
        return {}

    return mcp
`;
  const lock = 'version = 1\n\n[[package]]\nname = "anyio"\nversion = "4.6.0"\n\n[[package]]\nname = "mcp"\nversion = "2.3.0"\nsource = { registry = "https://pypi.org/simple" }\n';
  const files = { 'pyproject.toml': '[project]\nname = "escalate-anything"\ndependencies = [\n    "mcp>=1.9",\n]\n', 'uv.lock': lock, 'src/escalate_anything/__init__.py': '', 'src/escalate_anything/server.py': server };
  const r = await R.fromDirectory(repo(files));
  assert.equal(r.best.sdk.pyMajor, 2);
  assert.equal(r.best.sdk.pyMajorFrom, 'lock');
  assert.deepEqual(r.best.tools[0].annotations, { readOnlyHint: true, openWorldHint: false });
  // the same lock pinning 1.x keeps the keys as written: that is what SDK 1.x puts on the wire
  const r1 = await R.fromDirectory(repo(Object.assign({}, files, { 'uv.lock': lock.replace('"2.3.0"', '"1.27.0"'), 'src/escalate_anything/server.py': server.replace('mcp.server.mcpserver import MCPServer', 'mcp.server.fastmcp import FastMCP').replace('MCPServer(', 'FastMCP(') })));
  assert.equal(r1.best.sdk.pyMajor, 1);
  assert.deepEqual(r1.best.tools[0].annotations, { read_only_hint: true, open_world_hint: false });
  assert.ok(fired(r1.best).has('spec-annotation-key-case'), 'under 1.x the snake_case keys are on the wire, and the finding is right');
});

test('R-RD-40: with no knowable SDK major, snake_case hints are left out and the annotations marked not readable, with the reason; camelCase keys stay', async () => {
  // no manifest says which mcp is installed, and the source imports neither SDK-major-specific module
  const server = UNIFI_SERVER.replace('READ_ONLY = ToolAnnotations(', 'TITLED = ToolAnnotations(title="Endpoints", readOnlyHint=True)\nREAD_ONLY = ToolAnnotations(')
    .replace('@mcp.tool(annotations=READ_ONLY)\ndef search_endpoints', '@mcp.tool(annotations=TITLED)\ndef search_endpoints');
  const r = await R.fromDirectory(repo({ 'server.py': server }));
  assert.equal(r.best.sdk.pyMajor, undefined);
  assert.match(r.best.sdk.pyMajorUnknown, /no requirement on mcp or fastmcp/);
  const t = byName(r.best.tools);
  assert.equal(t.list_endpoints.annotations, undefined, 'no key the server could list is invented');
  assert.deepEqual(t.search_endpoints.annotations, { title: 'Endpoints', readOnlyHint: true }, 'camelCase kwargs are camelCase under every major');
  assert.deepEqual(r.best.unreadable.annotations, ['list_endpoints']);
  assert.ok(r.best.notes.some((n) => /snake_case ToolAnnotations hints .* left out where they are set \(1 place\).*no requirement on mcp or fastmcp/.test(n)), r.best.notes.join('\n'));
  const f = fired(r.best);
  assert.ok(!f.has('spec-annotation-key-case'));
});

test('R-RD-40: requirement specifiers: the highest major every requirement allows; keywords and classifiers are not requirements', () => {
  const sdk = (files) => R.detectSdk(new Map(Object.entries(files)));
  assert.equal(sdk({ 'pyproject.toml': '[project]\ndependencies = ["mcp>=1.9,<2"]\n' }).pyMajor, 1);
  assert.equal(sdk({ 'pyproject.toml': '[project]\ndependencies = ["mcp[cli]~=1.9"]\n' }).pyMajor, 1);
  assert.equal(sdk({ 'pyproject.toml': '[project]\ndependencies = ["mcp>=1.9"]\n' }).pyMajor, 2, 'an unbounded range installs the newest major');
  assert.equal(sdk({ 'requirements.txt': 'mcp==2.1.0 ; python_version >= "3.10"\n' }).pyMajor, 2);
  assert.equal(sdk({ 'requirements.txt': 'fastmcp>=2.10,<3  # pinned\n' }).pyMajor, 1, 'fastmcp 2.x needs SDK 1.x');
  assert.equal(sdk({ 'pyproject.toml': '[tool.poetry.dependencies]\npython = "^3.11"\nmcp = { version = "^1.9", extras = ["cli"] }\n' }).pyMajor, 1);
  assert.equal(sdk({ 'pyproject.toml': '[project]\nkeywords = ["mcp"]\nclassifiers = ["Framework :: mcp"]\n' }).pyMajor, undefined);
  assert.match(sdk({ 'pyproject.toml': '[project]\ndependencies = ["mcp<2", "fastmcp>=4"]\n' }).pyMajorUnknown, /allow no Python SDK major/);
  assert.equal(sdk({ 'server.py': 'from mcp.server.fastmcp import FastMCP\n' }).pyMajor, 1, 'mcp.server.fastmcp exists only in 1.x');
  assert.equal(sdk({ 'pyproject.toml': '[project]\ndependencies = ["mcp"]\n', 'server.py': 'from mcp.server.fastmcp import FastMCP\n' }).pyMajor, 1);
  assert.equal(sdk({ 'package.json': '{}' }).pyMajorUnknown, undefined, 'a repository with no Python says nothing about Python');
});

test('R-RD-40: under SDK 2.x a ToolAnnotations keyword that is not a field is dropped, as extra="ignore" drops it', () => {
  const src = 'from mcp.server.mcpserver import MCPServer\nfrom mcp.types import ToolAnnotations\nmcp = MCPServer("x")\n@mcp.tool(annotations=ToolAnnotations(read_only_hint=True, readonly=True))\ndef a() -> str:\n    """A."""\n    return ""\n';
  assert.deepEqual(R.extractPy(src, {})[0].tool.annotations, { readOnlyHint: true });
  assert.deepEqual(R.extractPy(src, { sdk: { pyMajor: 1 } })[0].tool.annotations, { read_only_hint: true, readonly: true });
});

// R-RD-44: the SDK major is the one of the file's own package; review of PR 58
const SNAKE_SERVER = (pkg) => `from fastmcp import FastMCP\nfrom mcp.types import ToolAnnotations\nmcp = FastMCP("${pkg}")\n\n@mcp.tool(annotations=ToolAnnotations(read_only_hint=True))\ndef ${pkg}_list() -> str:\n    """List."""\n    return ""\n`;
const lock = (v) => `version = 1\n\n[[package]]\nname = "mcp"\nversion = "${v}"\n`;

test('R-RD-44: a lock or requirement counts for the package folder that holds it: one package\'s mcp 1.x lock never decides for another\'s mcp>=2', () => {
  const files = new Map([
    ['a/pyproject.toml', '[project]\nname = "a"\ndependencies = ["mcp"]\n'], ['a/uv.lock', lock('1.2.0')], ['a/server.py', SNAKE_SERVER('a')],
    ['b/pyproject.toml', '[project]\nname = "b"\ndependencies = ["mcp>=2"]\n'], ['b/server.py', SNAKE_SERVER('b')],
  ]);
  const an = R.analyseRepo(files);
  const t = Object.fromEntries(an.found.map((x) => [x.tool.name, x.tool]));
  assert.deepEqual(t.a_list.annotations, { read_only_hint: true }, 'a runs on its locked 1.x: snake_case on the wire');
  assert.deepEqual(t.b_list.annotations, { readOnlyHint: true }, 'b runs on 2.x: camelCase, whatever a locks');
  assert.match(R.detectSdk(files).pyMajorUnknown, /declare different SDK majors/);
  // a workspace root lock counts for its members
  const ws = new Map([['uv.lock', lock('2.3.0')], ['packages/srv/pyproject.toml', '[project]\nname = "srv"\ndependencies = ["mcp>=1.9"]\n'], ['packages/srv/server.py', SNAKE_SERVER('srv')]]);
  assert.deepEqual(R.analyseRepo(ws).found[0].tool.annotations, { readOnlyHint: true });
  // poetry.lock and requirements.lock are read too
  assert.equal(R.detectSdk(new Map([['poetry.lock', lock('1.27.0')], ['pyproject.toml', '[project]\ndependencies = ["mcp>=1.9"]\n']])).pyMajor, 1);
  assert.equal(R.detectSdk(new Map([['requirements.lock', 'anyio==4.6.0\nmcp==1.26.0\n']])).pyMajor, 1);
});

test('R-RD-44: requirements under examples/ or docs/ never decide for the server; an environment marker that changes the major gives unknown; a major read from a range says so', () => {
  const files = new Map([['docs/requirements.txt', 'mcp<2\n'], ['examples/requirements.txt', 'mcp==1.9.0\n'], ['pyproject.toml', '[project]\ndependencies = ["mcp>=1.9"]\n'], ['server.py', SNAKE_SERVER('srv')]]);
  const an = R.analyseRepo(files);
  assert.deepEqual(an.found[0].tool.annotations, { readOnlyHint: true });
  assert.ok(an.notes.some((n) => /listed camelCase: SDK 2\.x inferred from mcp>=1\.9 in pyproject\.toml: no lock file/.test(n)), an.notes.join('\n'));
  // with no manifest of its own, the server is not read on an example's requirements
  const only = R.analyseRepo(new Map([['examples/requirements.txt', 'mcp==1.9.0\n'], ['server.py', SNAKE_SERVER('srv')]]));
  assert.equal(only.found[0].tool.annotations, undefined);
  const marked = new Map([['requirements.txt', 'mcp>=2 ; python_version >= "3.10"\nmcp<2 ; python_version < "3.10"\n'], ['server.py', SNAKE_SERVER('srv')]]);
  const am = R.analyseRepo(marked);
  assert.equal(am.found[0].tool.annotations, undefined, 'no key the server could list is invented');
  assert.ok(am.notes.some((n) => /depends on environment markers/.test(n)), am.notes.join('\n'));
  assert.equal(R.detectSdk(new Map([['requirements.txt', 'mcp>=2 ; python_version >= "3.10"\n']])).pyMajor, 2, 'a marker that does not change the answer is no ambiguity');
});

test('R-RD-44: a search transform keeps its reason when over-budget candidates are also counted', () => {
  const st = R.incompleteWith(null, 514, ['srv/server.py'], ['a FastMCP tool search transform (BM25SearchTransform, line 3) lists search tools, not these']);
  const both = R.incompleteWith(st, 2, ['srv/deep.py'], ['error']);
  assert.deepEqual(both, { candidates: 516, files: ['srv/server.py', 'srv/deep.py'], reasons: ['a FastMCP tool search transform (BM25SearchTransform, line 3) lists search tools, not these', 'error'] });
  assert.deepEqual(R.incompleteWith(null, 1, ['a.py'], []), { candidates: 1, files: ['a.py'] });
});

test('R-RD-44: only runtime dependencies decide the SDK major; a dependency group or extra that would install another major leaves it unknown', () => {
  const at = (pyproject, extra = {}) => R.analyseRepo(new Map([['pyproject.toml', pyproject], ['server.py', SNAKE_SERVER('srv')], ...Object.entries(extra)]));
  for (const [what, pp] of [
    ['dependency group', '[project]\nname = "x"\ndependencies = ["mcp>=1"]\n\n[dependency-groups]\ndev = ["mcp<2"]\n'],
    ['optional extra', '[project]\nname = "x"\ndependencies = ["mcp>=1"]\n\n[project.optional-dependencies]\nlegacy = ["mcp<2"]\n'],
    ['Poetry group', '[tool.poetry.dependencies]\nmcp = ">=1"\n\n[tool.poetry.group.dev.dependencies]\nmcp = "<2"\n'],
  ]) {
    const an = at(pp);
    assert.equal(an.found[0].tool.annotations, undefined, what + ': no key is guessed');
    assert.ok(an.notes.some((n) => /a dependency group or extra would install another Python SDK major/.test(n)), what + ': ' + an.notes.join('\n'));
  }
  const dev = at('[project]\nname = "x"\ndependencies = ["mcp>=1"]\n', { 'requirements-dev.txt': 'mcp<2\n' });
  assert.equal(dev.found[0].tool.annotations, undefined, 'requirements-dev.txt is a group too');
  const agree = at('[project]\nname = "x"\ndependencies = ["mcp>=2"]\n\n[dependency-groups]\ndev = ["mcp>=2.1"]\n');
  assert.deepEqual(agree.found[0].tool.annotations, { readOnlyHint: true }, 'a group that agrees changes nothing');
  assert.equal(R.analyseRepo(new Map([['pyproject.toml', '[project]\nname = "x"\n\n[dependency-groups]\ndev = ["mcp<2"]\n'], ['server.py', SNAKE_SERVER('srv')]])).found[0].tool.annotations, undefined, 'mcp only in a group: unknown');
});

test('R-RD-44: a lock the nearest folder\'s requirements do not allow (a parent project\'s, or stale) leaves the SDK major unknown', () => {
  const root = R.analyseRepo(new Map([['uv.lock', lock('1.2.0')], ['pkg/pyproject.toml', '[project]\nname = "pkg"\ndependencies = ["mcp>=2"]\n'], ['pkg/server.py', SNAKE_SERVER('pkg')]]));
  assert.equal(root.found[0].tool.annotations, undefined);
  assert.ok(root.notes.some((n) => /uv\.lock pins mcp 1\.x, which mcp>=2 in pkg\/pyproject\.toml does not allow/.test(n)), root.notes.join('\n'));
  const stale = R.analyseRepo(new Map([['uv.lock', lock('1.9.0')], ['pyproject.toml', '[project]\nname = "x"\ndependencies = ["mcp>=2"]\n'], ['server.py', SNAKE_SERVER('srv')]]));
  assert.equal(stale.found[0].tool.annotations, undefined);
  const fine = R.analyseRepo(new Map([['uv.lock', lock('2.3.0')], ['pyproject.toml', '[project]\nname = "x"\ndependencies = ["mcp>=1.9"]\n'], ['server.py', SNAKE_SERVER('srv')]]));
  assert.deepEqual(fine.found[0].tool.annotations, { readOnlyHint: true }, 'a lock the requirements allow decides');
});

test('R-RD-44: a package whose own manifest was not read (past the reader\'s limits) is not decided by an ancestor\'s lock', async () => {
  const r = await R.fromDirectory(repo({ 'uv.lock': lock('1.2.0'), 'pyproject.toml': '[project]\nname = "ws"\ndependencies = ["mcp<2"]\n', 'packages/servers/deep/pyproject.toml': '[project]\nname = "deep"\ndependencies = ["mcp>=2"]\n', 'packages/servers/deep/server.py': SNAKE_SERVER('deep') }));
  const t = r.candidates.flatMap((c) => c.tools).find((x) => x.name === 'deep_list');
  assert.ok(t, 'the tool is read');
  assert.equal(t.annotations, undefined, 'its package manifest (depth 3) is not read, so the root lock does not decide');
  assert.ok((r.best.notes || []).some((n) => /the package manifest in packages\/servers\/deep was not read/.test(n)), JSON.stringify(r.best.notes));
});

test('R-RD-44: two runtime manifests of one folder that would install different majors leave it unknown', () => {
  const an = R.analyseRepo(new Map([['pyproject.toml', '[project]\nname = "x"\ndependencies = ["mcp>=1"]\n'], ['requirements-legacy.txt', 'mcp<2\n'], ['server.py', SNAKE_SERVER('srv')]]));
  assert.equal(an.found[0].tool.annotations, undefined, 'no key is guessed');
  assert.ok(an.notes.some((n) => /manifests of one folder would install different Python SDK majors/.test(n)), an.notes.join('\n'));
  const agree = R.analyseRepo(new Map([['pyproject.toml', '[project]\nname = "x"\ndependencies = ["mcp>=1.9"]\n'], ['requirements.txt', 'mcp==2.1.0\n'], ['server.py', SNAKE_SERVER('srv')]]));
  assert.deepEqual(agree.found[0].tool.annotations, { readOnlyHint: true }, 'manifests that agree decide');
});
