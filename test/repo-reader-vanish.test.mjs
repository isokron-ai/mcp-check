// A property the reader cannot read (R-RD-38): it keeps its name with the unknown mark as its schema, nothing is
// invented for it, its requiredness is not guessed where it depends on the value, and the tool's input schema is
// listed as read in part with the property's path and the reason. Synthetic fixtures, one per way the value can be
// out of reach: a call of something unknown, a schema factory the reader cannot read, a mix with readable zod, an
// unreadable spread, a JSON Schema literal (JavaScript and Python) and a nested property.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { analyseList } from '../src/unreadable.js';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');
const M = require('../engine/core.js');

const read = (files) => R.analyseRepo(new Map(Object.entries(files)));
const pub = (an) => R.publicTools(an.tools.map((x) => x.tool));
const tool = (p, n) => { const x = p.tools.find((y) => y.name === n); assert.ok(x, 'no tool ' + n); return x; };
const UNKNOWN = { 'x-mcp-check-unknown': true };
const ZOD3 = '{"dependencies": {"@modelcontextprotocol/sdk": "1.29.0", "zod": "3.25.76"}}';
const SDK = '{"dependencies": {"@modelcontextprotocol/sdk": "1.29.0"}}';
const ts = (schema, extra = '') => [
  "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
  "import { z } from 'zod';",
  "import { unknownFn, commonArgs } from 'somewhere';",
  "import { makeSchema } from './lib/schemas';",
  extra,
  "const server = new McpServer({ name: 'x', version: '1.0.0' });",
  "server.registerTool('t', { description: 'Reads one thing.', inputSchema: " + schema + " }, async () => ({ content: [] }));",
].join('\n');

test('R-RD-38: a raw shape property whose value is an unknown call keeps its name, is not required, and is marked', () => {
  const p = pub(read({ 'package.json': ZOD3, 'src/s.ts': ts("{ a: unknownFn('x') }") }));
  const s = tool(p, 't').inputSchema;
  assert.deepEqual(Object.keys(s.properties), ['a']);
  assert.deepEqual(s.properties.a, UNKNOWN, 'no schema is invented for it');
  assert.equal(s.required, undefined, 'requiredness of a raw shape property depends on its value: not guessed');
  assert.deepEqual(p.unreadable.inputSchema, ['t']);
  assert.deepEqual(p.unreadable.inputSchemaPaths.t, [{ path: 'properties.a', reason: 'a value the reader cannot read', expr: 'unknownFn("x")', required: 'unknown' }]);
});

test('R-RD-38: a schema factory the reader cannot read ({ a: makeSchema() }) keeps the name and is marked', () => {
  const p = pub(read({ 'package.json': ZOD3, 'src/s.ts': ts('{ a: makeSchema() }') }));
  assert.deepEqual(tool(p, 't').inputSchema.properties, { a: UNKNOWN });
  assert.deepEqual(p.unreadable.inputSchemaPaths.t.map((h) => [h.path, h.required]), [['properties.a', 'unknown']]);
});

test('R-RD-38: a mix { a: z.string(), b: unknownFn() } keeps a as read and b by name, in source order; only a is required', () => {
  for (const schema of ['{ a: z.string(), b: unknownFn(), c: z.number().optional() }', 'z.object({ a: z.string(), b: unknownFn(), c: z.number().optional() })']) {
    const p = pub(read({ 'package.json': ZOD3, 'src/s.ts': ts(schema) }));
    const s = tool(p, 't').inputSchema;
    assert.deepEqual(Object.keys(s.properties), ['a', 'b', 'c'], schema);
    assert.deepEqual(s.properties.a, { type: 'string' });
    assert.deepEqual(s.properties.b, UNKNOWN);
    assert.deepEqual(s.required, ['a'], schema + ': b is not listed as required, a still is');
    assert.deepEqual(p.unreadable.inputSchemaPaths.t.map((h) => [h.path, h.required]), [['properties.b', 'unknown']]);
  }
});

test('R-RD-38: an unreadable spread in a shape is listed at the properties path; what it reads stays as before', () => {
  const p = pub(read({ 'package.json': ZOD3, 'src/s.ts': ts('{ a: z.string(), ...commonArgs() }') }));
  const s = tool(p, 't').inputSchema;
  assert.deepEqual(s.properties, { a: { type: 'string' } });
  assert.deepEqual(s.required, ['a']);
  assert.deepEqual(p.unreadable.inputSchemaPaths.t, [{ path: 'properties', reason: 'a spread the reader cannot read: names and schemas not known', expr: '...commonArgs()', required: 'unknown' }]);
});

test('R-RD-38: a JSON Schema literal keeps the property and its own required list as written (JavaScript)', () => {
  const p = pub(read({ 'package.json': SDK, 'src/s.js': [
    "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
    "import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';",
    "import { unknownFn } from 'somewhere';",
    "const server = new Server({ name: 'x', version: '1' }, { capabilities: { tools: {} } });",
    'server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [',
    "  { name: 't', description: 'Reads one thing.', inputSchema: { type: 'object', properties: { a: unknownFn('x'), b: { type: 'string' }, c: { type: 'object', properties: { d: unknownFn() } } }, required: ['a', 'b'] } },",
    "  { name: 'u', description: 'Reads one thing.', inputSchema: { type: 'object', properties: { a: { type: 'string' }, ...unknownFn() }, required: ['a'] } },",
    '] }));',
  ].join('\n') }));
  const s = tool(p, 't').inputSchema;
  assert.deepEqual(Object.keys(s.properties), ['a', 'b', 'c']);
  assert.deepEqual(s.properties.a, UNKNOWN);
  assert.deepEqual(s.properties.c.properties.d, UNKNOWN, 'a nested property is kept the same way');
  assert.deepEqual(s.required, ['a', 'b'], 'a literal required list is what the server lists');
  assert.deepEqual(p.unreadable.inputSchemaPaths.t.map((h) => [h.path, h.required]), [['properties.a', true], ['properties.c.properties.d', false]]);
  assert.deepEqual(tool(p, 'u').inputSchema.properties, { a: { type: 'string' } });
  assert.deepEqual(p.unreadable.inputSchemaPaths.u.map((h) => h.path), ['properties']);
});

test('R-RD-38: a JSON Schema literal in a Python low-level server keeps the property the same way', () => {
  const p = pub(read({ 'pyproject.toml': '[project]\nname = "x"\ndependencies = ["mcp>=1.2"]\n', 'server.py': [
    'from mcp.server import Server',
    'import mcp.types as types',
    'from somewhere import unknown_fn',
    'server = Server("x")',
    '@server.list_tools()',
    'async def list_tools():',
    '    return [types.Tool(name="t", description="Reads one thing.", inputSchema={"type": "object", "properties": {"a": unknown_fn("x"), "b": {"type": "string"}}, "required": ["a", "b"]})]',
  ].join('\n') }));
  const s = tool(p, 't').inputSchema;
  assert.deepEqual(Object.keys(s.properties), ['a', 'b']);
  assert.deepEqual(s.properties.a, UNKNOWN);
  assert.deepEqual(s.required, ['a', 'b']);
  assert.deepEqual(p.unreadable.inputSchemaPaths.t, [{ path: 'properties.a', reason: 'a value the reader cannot read', expr: 'unknown_fn("x")', required: true }]);
});

test('R-RD-38: a fully readable schema is unchanged and carries no mark', () => {
  const p = pub(read({ 'package.json': ZOD3, 'src/s.ts': ts('{ a: z.string(), b: z.number().optional() }') }));
  assert.deepEqual(tool(p, 't').inputSchema, { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'], additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#' });
  assert.deepEqual(p.unreadable, {});
});

test('R-RD-38: a schema read in part has its schema checks skipped, not graded as if the unread property were empty', () => {
  const p = pub(read({ 'package.json': ZOD3, 'src/s.ts': ts('{ a: z.string(), b: unknownFn() }') }));
  const parsed = { tools: p.tools };
  const r = analyseList(parsed, { unreadable: p.unreadable, unresolved: [] });
  assert.equal(r.skipped_checks.input_schemas, 1);
  const schemaIds = r.tools[0].findings.map((f) => f.id).filter((id) => /^(schema-|spec-input-schema-|spec-schema-)/.test(id));
  assert.deepEqual(schemaIds, []);
  // without the reader's note, the engine would grade the unknown property (e.g. its missing type and description)
  const raw = M.analyse(parsed).tools[0].findings.map((f) => f.id).filter((id) => /^(schema-|spec-input-schema-|spec-schema-)/.test(id));
  assert.ok(raw.length > 0, 'the skip is what removes them: ' + raw.join(', '));
});

test('R-RD-39: compiled CommonJS zod (const zod_1 = require("zod"); zod_1.z.string()) is read as zod', () => {
  const p = pub(read({ 'package.json': '{"dependencies": {"@modelcontextprotocol/sdk": "1.29.0", "zod": "3.25.76"}}', 'src/index.js': [
    '"use strict";',
    'const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");',
    'const zod_1 = require("zod");',
    'const server = new mcp_js_1.McpServer({ name: "x", version: "1.0.0" });',
    'server.registerTool("t", { description: "Reads one thing.", inputSchema: { a: zod_1.z.string().describe("A"), b: zod_1.z.number().optional() } }, async () => ({ content: [] }));',
  ].join('\n') }));
  const s = tool(p, 't').inputSchema;
  assert.deepEqual(s.properties, { a: { type: 'string', description: 'A' }, b: { type: 'number' } });
  assert.deepEqual(s.required, ['a']);
  assert.deepEqual(p.unreadable, {});
});
