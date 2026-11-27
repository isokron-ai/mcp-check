// --repo: what the static reader reproduces of a tool list, built on synthetic sources (no real server's text).
// Each test pins one cause found when the reader's lists were compared with the lists of the running servers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sourceLine, repoProvenance } from '../src/inputs/collect.js';

const require = createRequire(import.meta.url);
const M = require('../engine/core.js');
const R = require('../src/inputs/repo-source.cjs');

const V2 = { sdk: { kind: 'v2', version: '2.4.0', zod: 4 } };
const tools = (path, text, opts) => R.extractFromFile(path, text, opts).map((x) => x.tool);
const byName = (list) => Object.fromEntries(list.map((t) => [t.name, t]));

// ------------------------------------------------------------ spec-execution-legacy: only where the SDK adds the field
test('execution: added for SDK 1.24 to 1.x only, never invented when the version is unknown', () => {
  const code = 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nserver.registerTool("a", { description: "d", inputSchema: {} }, async () => ({}));\nserver.tool("b", async () => ({}));\n';
  for (const [v, want] of [['1.23.0', false], ['1.24.0', true], ['1.32.2', true], ['1.12.0', false], [null, false]]) {
    const got = tools('x.ts', code, { sdk: { kind: 'v1', version: v } });
    assert.equal(got.every((t) => t.execution && t.execution.taskSupport === 'forbidden'), want, 'version ' + v);
    assert.equal(got.every((t) => !t.execution), !want, 'version ' + v);
  }
  assert.ok(tools('x.ts', code).every((t) => !t.execution), 'no SDK information: no execution field');
  const v2 = 'import { McpServer } from "@modelcontextprotocol/server";\nserver.registerTool("a", { description: "d", inputSchema: {} }, async () => ({}));\n';
  assert.ok(tools('x.ts', v2, { sdk: { kind: 'v1', version: '1.32.2' } }).every((t) => !t.execution), 'the file imports SDK 2: its import wins over the manifest');
});
test('execution: the spec-execution-legacy check no longer fires on a list read from SDK 2 sources', () => {
  const code = 'import { McpServer } from "@modelcontextprotocol/server";\nimport * as z from "zod";\nserver.registerTool("a", { description: "d", inputSchema: z.object({ q: z.string() }) }, async () => ({}));\n';
  const r = M.analyse(M.parseInput(JSON.stringify({ tools: tools('x.ts', code, V2) })));
  assert.equal(M.allFindings(r).filter((f) => f.id === 'spec-execution-legacy').length, 0);
});

// ------------------------------------------------------------ input schemas, TypeScript
test('zod 4 under SDK 2: 2020-12 dialect, open objects, safe-integer bounds, optional through a constant, Schema.shape, record names', () => {
  const code = [
    'import { McpServer } from "@modelcontextprotocol/server";',
    'import * as z from "zod";',
    'const Limit = z.number().int().min(0).describe("max").optional();',
    'const Names = z.array(z.string()).min(1).optional();',
    'const Args = z.object({ q: z.string(), limit: Limit });',
    'server.registerTool("find", { description: "d", inputSchema: z.object({ names: Names, limit: Limit, n: z.number().int().positive(), meta: z.record(z.string(), z.number()), inner: z.object({ a: z.string() }) }) }, async () => ({}));',
    'server.registerTool("shaped", { description: "d", inputSchema: Args.shape }, async () => ({}));',
  ].join('\n');
  const t = byName(tools('x.ts', code, V2));
  assert.deepEqual(t.find.inputSchema, {
    type: 'object', $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      names: { type: 'array', items: { type: 'string' }, minItems: 1 },
      limit: { type: 'integer', minimum: 0, maximum: 9007199254740991, description: 'max' },
      n: { type: 'integer', exclusiveMinimum: 0, maximum: 9007199254740991 },
      meta: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: 'number' } },
      inner: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    },
    required: ['n', 'meta', 'inner'],
  });
  assert.deepEqual(t.shaped.inputSchema.required, ['q'], 'a constant keeps its .optional()');
  assert.equal(t.shaped.inputSchema.properties.limit.maximum, 9007199254740991);
  assert.equal(t.shaped.inputSchema.additionalProperties, undefined);
});
test('zod 3 under SDK 1: draft-07, closed objects, no integer bounds (unchanged)', () => {
  const code = 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { z } from "zod";\nserver.registerTool("a", { description: "d", inputSchema: { n: z.number().int(), o: z.object({ x: z.string() }) } }, async () => ({}));';
  const s = tools('x.ts', code, { sdk: { kind: 'v1', version: '1.20.0', zod: 3 } })[0].inputSchema;
  assert.equal(s.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(s.additionalProperties, false);
  assert.equal(s.properties.o.additionalProperties, false);
  assert.deepEqual(s.properties.n, { type: 'integer' });
});
test('a zod 4 repository under SDK 1: draft-07 with open objects and integer bounds', () => {
  const code = 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { z } from "zod";\nserver.registerTool("a", { description: "d", inputSchema: { n: z.number().int() } }, async () => ({}));';
  const s = tools('x.ts', code, { sdk: { kind: 'v1', version: '1.27.0', zod: 4 } })[0].inputSchema;
  assert.equal(s.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(s.additionalProperties, undefined);
  assert.deepEqual(s.properties.n, { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 });
});
test('FastMCP (TypeScript) addTool: draft-07 closed parameters; an unreadable property keeps its name', () => {
  const code = 'import { z } from "zod";\nserver.addTool({ name: "t", description: "d", parameters: z.object({ url: httpUrl(), n: z.number().int().optional() }), execute: async () => "" });';
  const s = tools('x.ts', code, { sdk: { kind: 'v2', version: '2.3.1', zod: 4 } })[0].inputSchema;
  assert.equal(s.$schema, 'http://json-schema.org/draft-07/schema#');
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(Object.keys(s.properties), ['url', 'n']);
  assert.deepEqual(s.properties.url, { 'x-mcp-check-unknown': true }); // kept by name, no schema invented (R-RD-32)
  assert.equal(s.required, undefined); // url's requiredness depends on its unread value: not guessed (R-RD-32)
  assert.equal(s.properties.n.maximum, 9007199254740991);
});
test('a raw zod shape property the reader cannot read stays in the schema by name, marked unknown, and is not listed as required', () => {
  const code = 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { z } from "zod";\nserver.registerTool("a", { description: "d", inputSchema: { a: z.string(), b: weird(), c: z.string().optional() } }, async () => ({}));';
  const s = tools('x.ts', code)[0].inputSchema;
  assert.deepEqual(Object.keys(s.properties), ['a', 'b', 'c']);
  assert.deepEqual(s.properties.b, { 'x-mcp-check-unknown': true });
  assert.deepEqual(s.required, ['a']); // b: requiredness unknown (R-RD-32)
});
test('{...SHARED}: a constant spread in the same file, and one defined in another file of the repository', () => {
  const shared = 'export const sharedParams = { namespace: { type: "string", description: "ns", default: "default" } };\nexport const ctxParam = { context: { type: "string" } };\n';
  const tool = 'import { sharedParams, ctxParam } from "./shared.js";\nconst local = { id: { type: "string" } };\nexport const getTool = { name: "get_it", description: "d", inputSchema: { type: "object", properties: { kind: { type: "string" }, ...sharedParams, ...ctxParam, ...local }, required: ["kind"] } };\n';
  const files = new Map([['src/shared.ts', shared], ['src/tool.ts', tool], ['src/index.ts', 'import { getTool } from "./tool.js";\nserver.setRequestHandler(X, () => ({ tools: [getTool] }));\n']]);
  const r = R.analyseRepo(files);
  const t = r.tools.find((x) => x.tool.name === 'get_it').tool;
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['kind', 'namespace', 'context', 'id']);
  assert.equal(t.inputSchema.properties.namespace.default, 'default');
  // within one file only (no cross-file table) the local spread still works and the unknown one is skipped
  const one = tools('src/tool.ts', tool)[0];
  assert.deepEqual(Object.keys(one.inputSchema.properties), ['kind', 'id']);
});

// ------------------------------------------------------------ input schemas, Python
const PY_SDK = [
  'from mcp.server.fastmcp import FastMCP',
  'from pydantic import Field',
  'DEFAULT_MAX = 5000',
  'mcp = FastMCP("demo")',
  '',
  '@mcp.tool()',
  'async def read_page(',
  '    url: str = Field(description="Page to read"),',
  '    max_length: int = Field(default=DEFAULT_MAX, description="Cap", gt=0, lt=1000000),',
  '    start: int = Field(default=0, ge=0),',
  '    pattern: str = Field(None, pattern="^a+$", min_length=1, max_length=9),',
  '    tags: list[str] = Field(min_length=1),',
  ') -> str:',
  '    """Read a page."""',
  '    return ""',
].join('\n');
test('Python SDK: Field(...) without a default is required; gt/ge/lt/min_length/pattern and module constants are read', () => {
  const t = tools('server.py', PY_SDK)[0];
  assert.deepEqual(t.inputSchema.required, ['url', 'tags']);
  const p = t.inputSchema.properties;
  assert.deepEqual([p.max_length.default, p.max_length.exclusiveMinimum, p.max_length.exclusiveMaximum], [5000, 0, 1000000]);
  assert.equal(p.start.minimum, 0);
  assert.deepEqual([p.pattern.default, p.pattern.pattern, p.pattern.minLength, p.pattern.maxLength], [null, '^a+$', 1, 9]);
  assert.equal(p.tags.minItems, 1);
  assert.equal(p.url.title, 'Url');
});
const PY_FAST = [
  'from typing import Dict, Optional',
  'from fastmcp import FastMCP',
  '',
  'def register(mcp: FastMCP):',
  '    @mcp.tool()',
  '    def list_things(cluster: Optional[str] = None, count: int = 5) -> str:',
  '        """',
  '        List all things.',
  '',
  '        Args:',
  '            cluster: Optional cluster name.',
  '              Falls back to the default.',
  '            count: How many.',
  '        """',
  '        return ""',
  '',
  '    @mcp.tool()',
  '    def get_thing(name: str) -> Dict:',
  '        """Get one."""',
  '        return {}',
].join('\n');
test('standalone fastmcp: no titles, closed argument model, docstring Args become descriptions, wrapped result, _meta tags', () => {
  const [a, b] = tools('tools.py', PY_FAST);
  assert.equal(a.description, 'List all things.');
  assert.deepEqual(a.inputSchema, {
    properties: {
      cluster: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null, description: 'Optional cluster name.\n  Falls back to the default.' },
      count: { type: 'integer', default: 5, description: 'How many.' },
    },
    type: 'object', additionalProperties: false,
  });
  assert.deepEqual(a.outputSchema, { properties: { result: { type: 'string' } }, required: ['result'], type: 'object', 'x-fastmcp-wrap-result': true });
  assert.deepEqual(a._meta, { fastmcp: { tags: [] } });
  assert.deepEqual(b.outputSchema, { additionalProperties: true, type: 'object' });
  assert.deepEqual(b.inputSchema.required, ['name']);
});
test('Python files of the SDK keep titles (the standalone fastmcp rules apply to fastmcp imports only)', () => {
  const t = tools('server.py', PY_SDK)[0];
  assert.equal(t.inputSchema.title, 'read_pageArguments');
  assert.equal(t._meta, undefined);
});

// ------------------------------------------------------------ SDK detection
test('detectSdk: manifests and lock files give the SDK kind, version and zod major; a lock file beats a range', () => {
  const pkg = JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '^1.20.0', zod: '^3.25.0' } });
  const lock = JSON.stringify({ packages: { 'node_modules/@modelcontextprotocol/sdk': { version: '1.26.0' }, 'node_modules/zod': { version: '4.1.0' } } });
  assert.deepEqual(R.detectSdk(new Map([['package.json', pkg]])), { kind: 'v1', version: '1.20.0', zod: 3, zodVersion: '3.25.0', py: null });
  assert.deepEqual(R.detectSdk(new Map([['package.json', pkg], ['package-lock.json', lock]])), { kind: 'v1', version: '1.26.0', zod: 4, zodVersion: '4.1.0', py: null });
  assert.equal(R.detectSdk(new Map([['package.json', JSON.stringify({ dependencies: { '@modelcontextprotocol/server': '^2.1.0', zod: '^4.0.0' } })]])).kind, 'v2');
  assert.equal(R.detectSdk(new Map([['pyproject.toml', 'dependencies = [\n  "fastmcp>=3.0",\n]']])).py, 'fastmcp');
  assert.equal(R.detectSdk(new Map([['pyproject.toml', 'dependencies = [\n  "mcp[cli]>=1.2",\n]']])).py, 'sdk');
});
test('analyseRepo reads the SDK from the manifests and applies it to every file', () => {
  const files = new Map([
    ['package.json', JSON.stringify({ dependencies: { '@modelcontextprotocol/sdk': '1.30.1', zod: '3.25.0' } })],
    ['src/a.ts', 'server.registerTool("a", { description: "d", inputSchema: { q: z.string() } }, async () => ({}));\nimport { z } from "zod";'],
  ]);
  const t = R.analyseRepo(files).tools[0].tool;
  assert.deepEqual(t.execution, { taskSupport: 'forbidden' });
  assert.equal(t.inputSchema.additionalProperties, false);
});

// ------------------------------------------------------------ tools the running server would not list
const reasons = (r, name) => (r.found.find((x) => x.tool.name === name) || { marks: [] }).marks.map((m) => m.reason);
test('a literal registry that says enabled: false removes those tools; the rest stay, others are marked as conditional', () => {
  const files = new Map([
    ['src/registry.ts', 'export const REGISTRY = {\n  on_tool: { name: "On", enabled: true, group: "x" },\n  off_tool: { name: "Off", description: "d", enabled: false, group: "x" },\n  hidden_tool: { hidden: true },\n};\n'],
    ['src/tools.ts', 'export function registerOn(server) { server.registerTool("on_tool", { description: "a", inputSchema: {} }, h); }\nexport function registerOff(server) { server.registerTool("off_tool", { description: "b", inputSchema: {} }, h); }\nexport function registerHidden(server) { server.registerTool("hidden_tool", { description: "b", inputSchema: {} }, h); }\n'],
    ['src/server.ts', 'import { registerOn, registerOff, registerHidden } from "./tools.js";\nif (can("on_tool")) { registerOn(server); }\nif (can("off_tool")) { registerOff(server); }\nif (can("hidden_tool")) { registerHidden(server); }\n'],
  ]);
  const r = R.analyseRepo(files);
  assert.deepEqual(r.tools.map((x) => x.tool.name), ['on_tool']);
  assert.deepEqual(r.excluded.map((x) => x.tool.name).sort(), ['hidden_tool', 'off_tool']);
  assert.deepEqual(reasons(r, 'on_tool'), ['conditional-caller']);
  assert.ok(reasons(r, 'off_tool').includes('disabled-by-default'));
});
test('a tool that declares conditions (flags that turn it on) is left out', () => {
  const code = 'defineTool({ name: "plain", description: "d", annotations: { readOnlyHint: true }, schema: {} });\ndefineTool({ name: "gated", description: "d", annotations: { readOnlyHint: true, conditions: ["someFlag"] }, schema: {} });\n';
  const r = R.analyseRepo(new Map([['src/tools.ts', code]]));
  assert.deepEqual(r.tools.map((x) => x.tool.name), ['plain']);
  assert.deepEqual(reasons(r, 'gated'), ['declares-conditions']);
});
test('server modules that register the same names are alternatives: the larger one is kept, the names only the other has are left out', () => {
  const a = 'mcp = FastMCP("x")\n@mcp.tool()\nasync def read_doc(url: str) -> str:\n    """r"""\n@mcp.tool()\nasync def search_doc(q: str) -> str:\n    """s"""\n@mcp.tool()\nasync def recommend(u: str) -> str:\n    """r"""\n';
  const b = 'mcp = FastMCP("y")\n@mcp.tool()\nasync def read_doc(url: str) -> str:\n    """r"""\n@mcp.tool()\nasync def list_services() -> str:\n    """l"""\n';
  const r = R.analyseRepo(new Map([['pkg/server_main.py', a], ['pkg/server_alt.py', b]]));
  assert.deepEqual(r.tools.map((x) => x.tool.name).sort(), ['read_doc', 'recommend', 'search_doc']);
  assert.deepEqual(reasons(r, 'list_services'), ['alternate-server']);
  // two modules with no name in common are two servers, not alternatives
  const c = 'mcp = FastMCP("z")\n@mcp.tool()\nasync def other(u: str) -> str:\n    """o"""\n';
  assert.equal(R.analyseRepo(new Map([['pkg/server_main.py', a], ['pkg/more.py', c]])).excluded.length, 0);
});
test('a { name, description, inputSchema } constant nothing refers to is left out; one that is used stays', () => {
  const files = new Map([
    ['src/config/a.ts', 'export const usedSchema = { name: "used", description: "d", inputSchema: { type: "object", properties: {} } } as const;\nexport const deadSchema = { name: "dead", description: "d", inputSchema: { type: "object", properties: {} } } as const;\n'],
    ['src/index.ts', 'import { usedSchema } from "./config/a.js";\nconst tools = [usedSchema];\n'],
  ]);
  const r = R.analyseRepo(files);
  assert.deepEqual(r.tools.map((x) => x.tool.name), ['used']);
  assert.deepEqual(reasons(r, 'dead'), ['unreferenced-declaration']);
});
test('registrations inside an if or else of their own function are marked, not removed; deprecated tools are marked', () => {
  const code = 'function setup(server, cfg) {\n  server.registerTool("always", { description: "d", inputSchema: {} }, h);\n  if (cfg.sandboxed) {\n    server.registerTool("boxed", { description: "d", inputSchema: {} }, h);\n  } else {\n    server.registerTool("open", { title: "Open (deprecated)", description: "d", inputSchema: {} }, h);\n  }\n}\n';
  const r = R.analyseRepo(new Map([['src/s.ts', code]]));
  assert.equal(r.tools.length, 3);
  assert.deepEqual(reasons(r, 'always'), []);
  assert.deepEqual(reasons(r, 'boxed'), ['conditional-branch']);
  assert.deepEqual(reasons(r, 'open'), ['conditional-branch', 'deprecated']);
  assert.equal(r.found.find((x) => x.tool.name === 'boxed').marks[0].detail, 'cfg.sandboxed');
  // Python: an if around a decorated function
  const py = 'if os.environ.get("X"):\n    @mcp.tool()\n    def maybe(a: str) -> str:\n        """m"""\n';
  assert.deepEqual(reasons(R.analyseRepo(new Map([['s.py', py]])), 'maybe'), ['conditional-branch']);
});
test('a function called both inside and outside an if is not marked; exclusions never empty the list', () => {
  const files = new Map([
    ['src/t.ts', 'export function reg(server) { server.registerTool("t1", { description: "d", inputSchema: {} }, h); }\n'],
    ['src/s.ts', 'import { reg } from "./t.js";\nreg(a);\nif (x) { reg(b); }\n'],
  ]);
  assert.deepEqual(reasons(R.analyseRepo(files), 't1'), []);
  const all = new Map([['src/r.ts', 'const T = { only: { enabled: false } };\nserver.registerTool("only", { description: "d", inputSchema: {} }, h);\n']]);
  const r = R.analyseRepo(all);
  assert.deepEqual(r.tools.map((x) => x.tool.name), ['only']);
  assert.equal(r.excluded.length, 0);
});

// ------------------------------------------------------------ the source line says what was left out
function fakeGithub(files) {
  const sha = 'a'.repeat(40);
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
  return async (url) => {
    const u = String(url);
    if (/api\.github\.com\/repos\/o\/r$/.test(u)) return ok({ default_branch: 'main' });
    if (/\/git\/trees\//.test(u)) return ok({ sha, truncated: false, tree: Object.keys(files).map((path) => ({ type: 'blob', path, size: files[path].length })) });
    const m = new RegExp('raw\\.githubusercontent\\.com/o/r/' + sha + '/(.+)$').exec(u);
    if (m && files[m[1]] !== undefined) return ok(files[m[1]]);
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
}
test('fromGitHub reads manifests and sources, reports the tools left out and the conditional ones', async () => {
  const files = {
    'package.json': JSON.stringify({ dependencies: { '@modelcontextprotocol/server': '2.4.0' } }),
    'src/reg.ts': 'export const T = { gone: { enabled: false } };\n',
    'src/a.ts': 'import * as z from "zod";\nexport function reg(server) { server.registerTool("kept", { description: "d", inputSchema: z.object({ n: z.number().int() }) }, h); server.registerTool("gone", { description: "d", inputSchema: z.object({}) }, h); }\n',
    'src/main.ts': 'import { reg } from "./a.js";\nif (cfg.on) { reg(server); }\n',
  };
  const got = await R.fromGitHub('github.com/o/r', { fetch: fakeGithub(files) });
  const c = got.best;
  assert.deepEqual(c.tools.map((t) => t.name), ['kept']);
  assert.equal(c.tools[0].inputSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(c.excluded[0].name, 'gone');
  assert.match(c.excluded[0].reasons[0], /^disabled-by-default/);
});
test('the Source line of a report names the tools left out', () => {
  const line = sourceLine({ kind: 'repo', repo: 'o/r', sha: 'a'.repeat(40), via: 'github', provenance: 'derived: x; 2 tools left out (disabled-by-default)' });
  assert.match(line, /2 tools left out \(disabled-by-default\)/);
});
test('repoProvenance: counts what was left out by reason and what is kept under a condition', () => {
  const c = { fidelity: 'derived', kind: 'source', excluded: [{ name: 'a', reasons: ['disabled-by-default (enabled: false in x.ts)'] }, { name: 'b', reasons: ['declares-conditions (flag)'] }, { name: 'c', reasons: ['disabled-by-default (enabled: false in x.ts)'] }], marked: [{ name: 'd', reasons: ['conditional-caller'], excluded: false }, { name: 'a', reasons: ['conditional-branch'], excluded: true }, { name: 'e', reasons: ['deprecated'], excluded: false }] };
  const r = repoProvenance(c);
  assert.match(r.provenance, /^derived: .*; 3 tools left out \(disabled-by-default, declares-conditions\); 1 kept but registered under a condition$/);
  assert.equal(repoProvenance({ fidelity: 'literal', kind: 'source' }).provenance, 'literal: tool definitions written as literals in the source');
});
