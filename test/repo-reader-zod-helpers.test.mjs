// Zod helpers in TypeScript servers (R-RD-25 onwards): .regex(), bounds from constants, schema factory functions and
// the other zod constructs three real servers needed. Each fixture is trimmed from the server it names, at the commit
// named, with the handlers and unrelated tools removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');

const read = (files) => R.analyseRepo(new Map(Object.entries(files)));
const tool = (an, n) => { const x = an.tools.find((y) => y.tool.name === n); assert.ok(x, 'no tool ' + n + ' in ' + an.tools.map((y) => y.tool.name).join(', ')); return x.tool; };
const ZOD3 = '{"dependencies": {"@modelcontextprotocol/sdk": "1.29.0", "zod": "3.25.76"}}';
const ZOD4 = '{"dependencies": {"@modelcontextprotocol/sdk": "1.32.2", "zod": "4.6.7"}}';
const SAFE = 9007199254740991;

// ---------------------------------------------------------------- R-RD-25: .regex() -> pattern
// Trimmed from isokron-ai/mcp-check d4a373a5f785db4631c18aad97df658836bbc2d1 src/server.js (explain_check) and
// barzoj/somtoday-mcp 51b0d5f334d6971a9c800fdf14dde84508fdb8ef src/server.ts (school_info, download_attachment).
test('R-RD-25: .regex(/…/) is written as the JSON Schema pattern (in a chain, in a union branch, with a message or flags); two regexes leave it out', () => {
  const an = read({ 'package.json': ZOD4, 'src/server.ts': [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import { z } from 'zod';",
    "const server = new McpServer({ name: 'somtoday', version: '1.0.0' });",
    "server.registerTool('explain_check', {",
    "  description: 'Returns the documentation for one check by its id.',",
    "  inputSchema: { check_id: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/).describe('Check id from a check_tools_list finding.') },",
    "}, async () => ({ content: [] }));",
    "server.registerTool('school_info', {",
    "  description: 'School contact data per child.',",
    "  inputSchema: {",
    "    paginaId: z.union([z.number().int().min(-2), z.string().regex(/^(-[12]|\\d+)$/)]).transform(String).optional().describe('Information page id.'),",
    "    bestanddataId: z.string().regex(/^[A-Za-z0-9._~-]{1,200}$/, 'bad id').optional(),",
    "    folded: z.string().regex(/^[a-z]+$/i),",
    "    twice: z.string().regex(/^a/).regex(/b$/),",
    "    thrice: z.string().regex(/^a/).regex(/b/).regex(/c$/),",
    "  },",
    "}, async () => ({ content: [] }));",
  ].join('\n') });
  assert.deepEqual(tool(an, 'explain_check').inputSchema.properties.check_id, { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z0-9-]+$', description: 'Check id from a check_tools_list finding.' });
  const p = tool(an, 'school_info').inputSchema.properties;
  assert.deepEqual(p.paginaId, { anyOf: [{ type: 'integer', minimum: -2, maximum: SAFE }, { type: 'string', pattern: '^(-[12]|\\d+)$' }], description: 'Information page id.' });
  assert.deepEqual(p.bestanddataId, { type: 'string', pattern: '^[A-Za-z0-9._~-]{1,200}$' });
  assert.deepEqual(p.folded, { type: 'string', pattern: '^[a-z]+$' }, 'flags are not carried into the pattern');
  assert.deepEqual(p.twice, { type: 'string' }, 'two patterns go to allOf in the SDK; the reader leaves them out rather than guess');
  assert.deepEqual(p.thrice, { type: 'string' });
});

// ---------------------------------------------------------------- R-RD-26: bounds and numbers from constants
// Trimmed from isokron-ai/mcp-check d4a373a5f785db4631c18aad97df658836bbc2d1 src/server.js, src/tools.js and
// src/limits.js (check_tools_list), with two section names masked. The `unknown` bound is added: a value only known
// at run time.
test('R-RD-26: .min/.max/.length take a literal constant, .length of a constant array and arithmetic of literals; a bound that cannot be read is left out', () => {
  const an = read({ 'package.json': ZOD4,
    'src/tools.js': [
      "export const SECTIONS = ['spec', 'dir-a', 'dir-b', 'security', 'quality', 'surface'];",
      'export const MAX_FINDINGS = 500;',
      'export const DEFAULT_LIMIT = 100;',
    ].join('\n'),
    'src/limits.js': 'export const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB of JSON per list\nexport const MAX_TOOLS = 2000;\n',
    'src/server.js': [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "import * as z from 'zod/v4';",
      "import { SECTIONS, DEFAULT_LIMIT, MAX_FINDINGS } from './tools.js';",
      "import { MAX_BYTES, MAX_TOOLS } from './limits.js';",
      "const server = new McpServer({ name: 'mcp-check', version: '1.0.0' });",
      "server.registerTool('check_tools_list', {",
      "  description: 'Grades a tools/list answer. Limit ' + MAX_BYTES / 1048576 + ' MiB of JSON and ' + MAX_TOOLS + ' tools.',",
      '  inputSchema: z.strictObject({',
      "    sections: z.array(z.enum(SECTIONS)).min(1).max(SECTIONS.length).optional().describe('Sections to report.'),",
      "    limit: z.number().int().min(1).max(MAX_FINDINGS).default(DEFAULT_LIMIT).describe('Most findings to return.'),",
      '    pair: z.array(z.string()).length(SECTIONS.length - 4),',
      '    bytes: z.string().max(MAX_BYTES - 1),',
      '    unknown: z.string().max(Number(process.env.MAX_LEN)),',
      '  }),',
      '}, async () => ({ content: [] }));',
    ].join('\n') });
  const t = tool(an, 'check_tools_list');
  assert.equal(t.description, 'Grades a tools/list answer. Limit 2 MiB of JSON and 2000 tools.');
  const p = t.inputSchema.properties;
  assert.deepEqual(p.sections, { type: 'array', items: { type: 'string', enum: ['spec', 'dir-a', 'dir-b', 'security', 'quality', 'surface'] }, minItems: 1, maxItems: 6, description: 'Sections to report.' });
  assert.deepEqual(p.limit, { type: 'integer', minimum: 1, maximum: 500, default: 100, description: 'Most findings to return.' });
  assert.deepEqual(p.pair, { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 });
  assert.deepEqual(p.bytes, { type: 'string', maxLength: 2097151 });
  assert.deepEqual(p.unknown, { type: 'string' }, 'a bound known only at run time is left out, not guessed');
});

// A constant array with an element the reader could not read has no known length.
// Trimmed from the same file; the spread element is added.
test('R-RD-26: .length of a constant array with a spread or an unreadable element is not a bound', () => {
  const an = read({ 'package.json': ZOD4, 'src/server.js': [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import * as z from 'zod/v4';",
    "import { EXTRA } from 'somewhere-else';",
    "const SECTIONS = ['spec', 'quality', ...EXTRA];",
    "const server = new McpServer({ name: 'mcp-check', version: '1.0.0' });",
    "server.registerTool('check_tools_list', { description: 'Grades a list.', inputSchema: { sections: z.array(z.string()).max(SECTIONS.length) } }, async () => ({ content: [] }));",
  ].join('\n') });
  assert.deepEqual(tool(an, 'check_tools_list').inputSchema.properties.sections, { type: 'array', items: { type: 'string' } });
});

// A number read from a `let` or `var` can be assigned again before the schema is built, so it is not a bound, an
// operand or text. Synthetic, in the shape of the check_tools_list fixture above.
test('R-RD-26: a number from a let or var is not a bound, an operand or text; only a const is', () => {
  const an = read({ 'package.json': ZOD3, 'src/server.ts': [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import { z } from 'zod';",
    'let MAX_LEN = 5;',
    'MAX_LEN = 10;',
    'var LIMIT = 50;',
    'function grow() { LIMIT = 90; }',
    'const FIXED = 7;',
    "const server = new McpServer({ name: 'x', version: '1.0.0' });",
    "server.registerTool('t', { description: 'Up to ' + LIMIT + ' items, ' + FIXED + ' fixed.', inputSchema: {",
    '  a: z.string().max(MAX_LEN),',
    '  b: z.array(z.string()).max(LIMIT * 2),',
    '  c: z.string().max(FIXED),',
    '  d: z.string().describe(`Limit ${LIMIT}.`),',
    '} }, async () => ({ content: [] }));',
  ].join('\n') });
  const t = tool(an, 't');
  assert.equal(t.description, 'Up to … items, 7 fixed.', 'a let/var number is not written into text');
  const p = t.inputSchema.properties;
  assert.deepEqual(p.a, { type: 'string' }, 'let MAX_LEN = 5; MAX_LEN = 10 is not a maxLength of 5');
  assert.deepEqual(p.b, { type: 'array', items: { type: 'string' } }, 'a var in arithmetic is not an operand');
  assert.deepEqual(p.c, { type: 'string', maxLength: 7 }, 'a const still is');
  assert.equal(p.d.description, 'Limit ….');
});

// ---------------------------------------------------------------- R-RD-27: schema factory functions
// Trimmed from CruGlobal/flightdeck-mcp-server 3a4f362dbf0b4723cd67cccb40704adf4d1c2259 src/tools.ts (id, pagination,
// get_project, update_work_item). The `description` constant and the get_me registration using it are added.
test('R-RD-27: a schema factory of the file (id("Project id"), id("…").optional()) is read with its argument as the parameter', () => {
  const an = read({ 'package.json': ZOD3, 'src/tools.ts': [
    'import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    'import { z } from "zod";',
    '// Flightdeck resource ids are integers, and the API returns them as numbers.',
    'const id = (description: string) => z.union([z.string(), z.number()]).describe(description);',
    'const description = "Return the user behind the configured token.";',
    'const pagination = {',
    '  page: z.number().int().positive().optional().describe("1-based page number (default 1)"),',
    '};',
    'const workItemFields = {',
    '  title: z.string().optional().describe("Work item title"),',
    '  state_id: id("State id — must belong to the item\'s project").optional(),',
    '};',
    'export function registerTools(server: McpServer, client: unknown): void {',
    '  server.registerTool(',
    '    "get_project",',
    '    { title: "Get a project", description: "Retrieve a single project by its id.", inputSchema: { project_id: id("Project id") } },',
    '    async (args) => ({ content: [] }),',
    '  );',
    '  server.registerTool(',
    '    "update_work_item",',
    '    { title: "Update a work item", description: "Update a work item by id.", inputSchema: { work_item_id: id("Work item id"), ...workItemFields, ...pagination } },',
    '    async (args) => ({ content: [] }),',
    '  );',
    '  server.registerTool("get_me", { title: "Get current identity", description, inputSchema: {} }, async () => ({ content: [] }));',
    '}',
  ].join('\n') });
  assert.equal(tool(an, 'get_me').description, 'Return the user behind the configured token.', 'a parameter is bound only while its call is read');
  const gp = tool(an, 'get_project').inputSchema;
  assert.deepEqual(Object.keys(gp.properties), ['project_id']);
  assert.equal(gp.properties.project_id.description, 'Project id');
  assert.deepEqual(gp.required, ['project_id']);
  const up = tool(an, 'update_work_item').inputSchema;
  assert.deepEqual(Object.keys(up.properties), ['work_item_id', 'title', 'state_id', 'page']);
  assert.equal(up.properties.state_id.description, "State id — must belong to the item's project");
  assert.deepEqual(up.required, ['work_item_id'], 'id("…").optional() is optional');
});

// Trimmed from barzoj/somtoday-mcp 51b0d5f334d6971a9c800fdf14dde84508fdb8ef src/server.ts (ymd, rangeArgs, numericId,
// leerlingArg, schedule). The positional registration of homework is added.
test('R-RD-27: factories calling factories, a factory returning a shape spread in (...rangeArgs("…")), and a template of a parameter', () => {
  const an = read({ 'package.json': ZOD4, 'src/server.ts': [
    'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    'import { z } from "zod";',
    'const ymd = () => z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/, "YYYY-MM-DD");',
    'const rangeArgs = (defaultText: string) => ({',
    '  date: ymd().optional().describe("One Amsterdam calendar date."),',
    '  from: ymd().optional().describe(`First date of the range. ${defaultText}`),',
    '  to: ymd().optional().describe("Last date of the range (inclusive)."),',
    '});',
    '// A factory, so every field gets its own schema (no shared `$ref` in the JSON schema).',
    'const numericId = () =>',
    '  z',
    '    .union([z.number().int().nonnegative(), z.string().regex(/^\\d+$/)])',
    '    .transform(String);',
    'const leerlingArg = () =>',
    '  numericId()',
    '    .optional()',
    '    .describe(',
    '      "Numeric leerling id. Required when more than one child is linked.",',
    '    );',
    'export function createServer(): McpServer {',
    '  const server = new McpServer({ name: "somtoday", version: "1.0.0" });',
    '  server.registerTool(',
    '    "schedule",',
    '    { title: "Schedule", description: "Lessons per day.", inputSchema: { ...rangeArgs("Defaults to today."), leerlingId: leerlingArg() } },',
    '    async () => ({ content: [] }),',
    '  );',
    '  server.tool("homework", "Homework per day.", { ...rangeArgs("Defaults to tomorrow."), leerlingId: leerlingArg() }, async () => ({ content: [] }));',
    '  return server;',
    '}',
  ].join('\n') });
  const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
  const s = tool(an, 'schedule').inputSchema;
  assert.deepEqual(s.properties, {
    date: Object.assign({}, DATE, { description: 'One Amsterdam calendar date.' }),
    from: Object.assign({}, DATE, { description: 'First date of the range. Defaults to today.' }),
    to: Object.assign({}, DATE, { description: 'Last date of the range (inclusive).' }),
    leerlingId: { anyOf: [{ type: 'integer', minimum: 0, maximum: SAFE }, { type: 'string', pattern: '^\\d+$' }], description: 'Numeric leerling id. Required when more than one child is linked.' },
  });
  assert.equal(s.required, undefined, 'every field is optional');
  const h = tool(an, 'homework').inputSchema;
  assert.deepEqual(Object.keys(h.properties), ['date', 'from', 'to', 'leerlingId'], 'the positional form (name, description, shape) reads the spread too');
  assert.equal(h.properties.from.description, 'First date of the range. Defaults to tomorrow.');
  assert.deepEqual(an.unreadable || [], []);
});

// Trimmed from isokron-ai/mcp-check d4a373a5f785db4631c18aad97df658836bbc2d1 src/server.js (toolsListArg,
// compare_tools_lists). The factory is moved to its own module here to read it through a direct import; the
// re-exporting module, the factory with a statement before its return, the constant named like the parameter and
// the unknown argument are added.
test('R-RD-27: a factory imported directly is read; a re-exported one, one with statements and an unknown argument are not guessed', () => {
  const an = read({ 'package.json': ZOD4,
    'src/limits.js': 'export const MAX_BYTES = 2 * 1024 * 1024;\nexport const MAX_TOOLS = 2000;\n',
    'src/args.js': [
      "import * as z from 'zod/v4';",
      "import { MAX_BYTES, MAX_TOOLS } from './limits.js';",
      "const what = 'A module constant of the same name';",
      "export const toolsListArg = (what) => z.union([z.string(), z.array(z.unknown())])",
      "  .describe(what + ': the answer to tools/list. Limit ' + MAX_BYTES / 1048576 + ' MiB of JSON and ' + MAX_TOOLS + ' tools.');",
      "export function busy(what) { const d = what + '!'; return z.string().describe(d); }",
    ].join('\n'),
    'src/reexport.js': "export { toolsListArg as relisted } from './args.js';\n",
    'src/server.js': [
      "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
      "import * as z from 'zod/v4';",
      "import { toolsListArg, busy } from './args.js';",
      "import { relisted } from './reexport.js';",
      "const server = new McpServer({ name: 'mcp-check', version: '1.0.0' });",
      "server.registerTool('compare_tools_lists', {",
      "  description: 'Compares two tools/list answers.',",
      '  inputSchema: z.strictObject({',
      "    before: toolsListArg('The earlier tool list'),",
      "    after: toolsListArg(process.env.LABEL),",
      "    third: relisted('A third list'),",
      "    fourth: busy('x'),",
      '  }),',
      '}, async () => ({ content: [] }));',
    ].join('\n') });
  const p = tool(an, 'compare_tools_lists').inputSchema.properties;
  assert.deepEqual(p.before, { anyOf: [{ type: 'string' }, { type: 'array', items: {} }], description: 'The earlier tool list: the answer to tools/list. Limit 2 MiB of JSON and 2000 tools.' });
  assert.deepEqual(p.after, { anyOf: [{ type: 'string' }, { type: 'array', items: {} }] }, 'a description built from an argument the reader cannot read is left out');
  assert.deepEqual(p.third, { 'x-mcp-check-unknown': true }, 'a factory reached through a re-export is not followed: kept by name, marked unknown (R-RD-38)');
  assert.deepEqual(p.fourth, { 'x-mcp-check-unknown': true }, 'a factory body with statements before its return is not read: kept by name, marked unknown (R-RD-38)');
});

// Synthetic: the shape of R-RD-15's timing test, with a zod factory.
test('R-RD-27: many factory calls next to many constants are read in linear time', () => {
  const consts = Array.from({ length: 4000 }, (_, i) => 'const c' + i + ' = ' + i + ';').join('\n');
  const regs = Array.from({ length: 3000 }, (_, i) => "server.registerTool('t" + i + "', { description: 'D.', inputSchema: { a: id('A " + i + "'), b: id('B').optional() } }, async () => ({ content: [] }));").join('\n');
  const t0 = performance.now();
  const an = read({ 'package.json': ZOD3, 'src/index.ts': "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\nimport { z } from 'zod';\nconst server = new McpServer({ name: 'x', version: '1.0.0' });\nconst id = (description: string) => z.string().describe(description);\n" + consts + '\n' + regs });
  const ms = performance.now() - t0;
  assert.equal(an.tools.length, 3000);
  assert.equal(tool(an, 't2999').inputSchema.properties.a.description, 'A 2999');
  assert.ok(ms < 3000, 'took ' + Math.round(ms) + ' ms');
});

// ---------------------------------------------------------------- R-RD-28: unions and .nullable() per zod major
// Trimmed from CruGlobal/flightdeck-mcp-server 3a4f362dbf0b4723cd67cccb40704adf4d1c2259 src/tools.ts (workItemFields,
// zod 3.25.76 under SDK 1.29.0). estimate_point's .int() and the slug field are added. Expected values are what that
// SDK lists for these expressions.
test('R-RD-28: zod 3 writes a union of bare primitives as a type array, and .nullable() of anything else as anyOf with null', () => {
  const an = read({ 'package.json': ZOD3, 'src/tools.ts': [
    'import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    'import { z } from "zod";',
    'const id = (description: string) => z.union([z.string(), z.number()]).describe(description);',
    'export function registerTools(server: McpServer): void {',
    '  server.registerTool("update_work_item", { title: "Update a work item", description: "Update a work item by id.", inputSchema: {',
    '    work_item_id: id("Work item id"),',
    '    cycle_id: z',
    '      .union([z.string(), z.number()])',
    '      .nullable()',
    '      .optional()',
    '      .describe("Cycle id (same project), or null to remove the item from its cycle"),',
    '    assignee_ids: z',
    '      .array(z.union([z.string(), z.number()]))',
    '      .optional()',
    '      .describe("User ids to assign; must be members of the workspace"),',
    '    start_date: z.string().nullable().optional().describe("ISO 8601 date (YYYY-MM-DD), or null to clear"),',
    '    estimate_point: z.number().int().nullable().optional(),',
    '    slug: z.string().min(1).describe("Short name").nullable(),',
    '  } }, async () => ({ content: [] }));',
    '}',
  ].join('\n') });
  const p = tool(an, 'update_work_item').inputSchema.properties;
  assert.deepEqual(p.work_item_id, { type: ['string', 'number'], description: 'Work item id' });
  assert.deepEqual(p.cycle_id, { anyOf: [{ type: ['string', 'number'] }, { type: 'null' }], description: 'Cycle id (same project), or null to remove the item from its cycle' });
  assert.deepEqual(p.assignee_ids, { type: 'array', items: { type: ['string', 'number'] }, description: 'User ids to assign; must be members of the workspace' });
  assert.deepEqual(p.start_date, { type: ['string', 'null'], description: 'ISO 8601 date (YYYY-MM-DD), or null to clear' });
  assert.deepEqual(p.estimate_point, { anyOf: [{ type: 'integer' }, { type: 'null' }] }, 'z.number().int() has a check, so it is not a bare type');
  assert.deepEqual(p.slug, { anyOf: [{ type: 'string', minLength: 1, description: 'Short name' }, { type: 'null' }], description: 'Short name' });
});

// zod-to-json-schema takes the type-array path only when every option is a bare ZodString/ZodNumber/ZodBoolean/ZodNull
// with no checks: an option zod wraps (ZodOptional, ZodEffects, ZodDefault, ZodBranded, ZodReadonly, ZodCatch,
// ZodPipeline) or one with a check the JSON Schema does not show (.trim()) makes the union anyOf, and .nullable() of a
// wrapped schema is anyOf with null. Expected values are what zod-to-json-schema 3.25.2 writes for these expressions
// with the SDK's options (strictUnions, pipeStrategy 'input'); an .optional() option, which it writes as
// anyOf [{not: {}}, schema], is not built by the reader (the union is marked inexact) and is not a type array.
// Synthetic negative controls for the R-RD-28 fixture above.
test('R-RD-28: zod 3 writes a union with a wrapped or checked option as anyOf, never a type array', () => {
  const an = read({ 'package.json': ZOD3, 'src/server.ts': [
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "import { z } from 'zod';",
    'const Opt = z.string().optional();',
    'const wrapped = () => z.string().refine((x) => x.length > 0);',
    "const server = new McpServer({ name: 'x', version: '1.0.0' });",
    "server.registerTool('t', { description: 'd', inputSchema: {",
    '  opt: z.union([z.string().optional(), z.number()]),',
    '  nullish: z.union([z.string().nullish(), z.number()]),',
    '  refine: z.union([z.string().refine((x) => !!x), z.number()]),',
    '  superRefine: z.union([z.string().superRefine(() => {}), z.number()]),',
    '  transform: z.union([z.string().transform(Number), z.number()]),',
    "  dflt: z.union([z.string().default('x'), z.number()]),",
    '  brand: z.union([z.string().brand(), z.number()]),',
    '  readonly: z.union([z.string().readonly(), z.number()]),',
    "  caught: z.union([z.string().catch('x'), z.number()]),",
    '  piped: z.union([z.string().pipe(z.string()), z.number()]),',
    '  trimmed: z.union([z.string().trim(), z.number()]),',
    '  viaConst: z.union([Opt, z.boolean()]),',
    "  viaConstDescribed: z.union([Opt.describe('o'), z.boolean()]),",
    '  viaFactory: z.union([wrapped(), z.number()]),',
    '  refineNullable: z.string().refine((x) => !!x).nullable(),',
    '  optNullable: z.string().optional().nullable(),',
    "  described: z.union([z.string().describe('s'), z.number()]),",
    '  bare: z.union([z.string(), z.number()]),',
    '} }, async () => ({ content: [] }));',
  ].join('\n') });
  const p = tool(an, 't').inputSchema.properties;
  const SN = { anyOf: [{ type: 'string' }, { type: 'number' }] };
  for (const k of ['opt', 'nullish', 'refine', 'superRefine', 'transform', 'brand', 'readonly', 'caught', 'piped', 'trimmed', 'viaFactory']) assert.deepEqual(p[k], SN, k);
  assert.deepEqual(p.dflt, { anyOf: [{ type: 'string', default: 'x' }, { type: 'number' }] });
  assert.deepEqual(p.viaConst, { anyOf: [{ type: 'string' }, { type: 'boolean' }] }, 'a constant keeps its wrapper');
  assert.deepEqual(p.viaConstDescribed, { anyOf: [{ type: 'string', description: 'o' }, { type: 'boolean' }] });
  assert.deepEqual(p.refineNullable, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  assert.deepEqual(p.optNullable, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  assert.deepEqual(p.described, { type: ['string', 'number'] }, 'a description alone keeps the option bare');
  assert.deepEqual(p.bare, { type: ['string', 'number'] });
});

// Trimmed from barzoj/somtoday-mcp 51b0d5f334d6971a9c800fdf14dde84508fdb8ef src/server.ts (textOrNumber, numericId,
// study_material; zod 4.6.7 under SDK 1.32.2). The nullable fields and the zod 4.3.6 run of the same source are added;
// expected values are what SDK 1.32.2 lists with each zod version.
test('R-RD-28: zod 4 writes .nullable() as anyOf with null, and from zod 4.5.0 compacts an anyOf of bare types to a type array', () => {
  const src = (zod) => ({ 'package.json': '{"dependencies": {"@modelcontextprotocol/sdk": "1.32.2", "zod": "' + zod + '"}}', 'src/server.ts': [
    'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    'import { z } from "zod";',
    '/** Free-text or numeric reference (subject name/abbreviation/uuid, page slug). */',
    'const textOrNumber = () => z.union([z.string(), z.number()]).transform(String);',
    'const numericId = () => z.union([z.number().int().nonnegative(), z.string().regex(/^\\d+$/)]).transform(String);',
    'const server = new McpServer({ name: "somtoday", version: "1.0.0" });',
    'server.registerTool("study_material", { title: "Study material", description: "Study material per subject.", inputSchema: {',
    '  vak: textOrNumber().describe("Subject name, abbreviation or uuid."),',
    '  leerlingId: numericId().optional(),',
    '  note: z.string().nullable(),',
    '  count: z.number().int().nullable(),',
    '  either: z.union([z.string(), z.number()]).nullable().optional().describe("d"),',
    '} }, async () => ({ content: [] }));',
  ].join('\n') });
  const LEERLING = { anyOf: [{ type: 'integer', minimum: 0, maximum: SAFE }, { type: 'string', pattern: '^\\d+$' }] };
  const COUNT = { anyOf: [{ type: 'integer', minimum: -SAFE, maximum: SAFE }, { type: 'null' }] };
  const p46 = tool(read(src('4.6.7')), 'study_material').inputSchema.properties;
  assert.deepEqual(p46, {
    vak: { type: ['string', 'number'], description: 'Subject name, abbreviation or uuid.' },
    leerlingId: LEERLING, note: { type: ['string', 'null'] }, count: COUNT,
    either: { type: ['string', 'number', 'null'], description: 'd' },
  });
  const p43 = tool(read(src('4.3.6')), 'study_material').inputSchema.properties;
  assert.deepEqual(p43, {
    vak: { anyOf: [{ type: 'string' }, { type: 'number' }], description: 'Subject name, abbreviation or uuid.' },
    leerlingId: LEERLING, note: { anyOf: [{ type: 'string' }, { type: 'null' }] }, count: COUNT,
    either: { anyOf: [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, { type: 'null' }], description: 'd' },
  });
});

// ---------------------------------------------------------------- R-RD-29: an empty raw shape under SDK 1.23+
// Trimmed from CruGlobal/flightdeck-mcp-server 3a4f362dbf0b4723cd67cccb40704adf4d1c2259 src/tools.ts (get_me,
// get_project; zod 3.25.76 under SDK 1.29.0). The z.object({}) tool and the run without a known SDK version are added.
test('R-RD-29: an empty raw shape is listed without additionalProperties from SDK 1.23 on; other shapes and z.object({}) stay closed under zod 3', () => {
  const src = (pkg) => ({ 'package.json': pkg, 'src/tools.ts': [
    'import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    'import { z } from "zod";',
    'export function registerTools(server: McpServer): void {',
    '  server.registerTool(',
    '    "get_me",',
    '    {',
    '      title: "Get current identity",',
    '      description:',
    '        "Return the user, workspace and token behind the configured Flightdeck API token. Useful as a connectivity/health check.",',
    '      inputSchema: {},',
    '    },',
    '    async () => ({ content: [] }),',
    '  );',
    '  server.registerTool("get_project", { title: "Get a project", description: "Retrieve a single project by its id.", inputSchema: { project_id: z.string() } }, async () => ({ content: [] }));',
    '  server.registerTool("ping", { description: "Ping.", inputSchema: z.object({}) }, async () => ({ content: [] }));',
    '}',
  ].join('\n') });
  const D7 = 'http://json-schema.org/draft-07/schema#';
  const an = read(src(ZOD3));
  assert.deepEqual(tool(an, 'get_me').inputSchema, { type: 'object', properties: {}, $schema: D7 });
  assert.deepEqual(tool(an, 'get_project').inputSchema, { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'], additionalProperties: false, $schema: D7 });
  assert.deepEqual(tool(an, 'ping').inputSchema, { type: 'object', properties: {}, additionalProperties: false, $schema: D7 });
  const unknown = read(src('{"dependencies": {"zod": "3.25.76"}}'));
  assert.equal(tool(unknown, 'get_me').inputSchema.additionalProperties, false, 'without a known SDK version the reading is unchanged');
});

// ---------------------------------------------------------------- R-RD-30: a constant shape filtered by key
// Trimmed from CruGlobal/flightdeck-mcp-server 3a4f362dbf0b4723cd67cccb40704adf4d1c2259 src/tools.ts (workItemFields,
// create_work_item). The tools other than create_work_item, and the constant arrays they use, are added.
test('R-RD-30: ...Object.fromEntries(Object.entries(FIELDS).filter(([key]) => key !== "title")) spreads the constant shape without the rejected keys', () => {
  const an = read({ 'package.json': ZOD3, 'src/tools.ts': [
    'import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
    'import { z } from "zod";',
    'const id = (description: string) => z.union([z.string(), z.number()]).describe(description);',
    'const workItemFields = {',
    '  title: z.string().optional().describe("Work item title"),',
    '  description: z.string().optional().describe("Plain-text description (empty string clears it)"),',
    '  state_id: id("State id — must belong to the item\'s project").optional(),',
    '  draft: z.boolean().optional().describe("Whether the item is a draft"),',
    '};',
    'const DATES = ["start_date", "target_date"];',
    'const BROKEN = { title: z.string(), ...somethingElse };',
    'export function registerTools(server: McpServer): void {',
    '  server.registerTool(',
    '    "create_work_item",',
    '    {',
    '      title: "Create a work item",',
    '      description: "Create a work item in a project.",',
    '      inputSchema: {',
    '        project_id: id("Project id to create the item in"),',
    '        title: z.string().describe("Work item title (required)"),',
    '        ...Object.fromEntries(',
    '          Object.entries(workItemFields).filter(([key]) => key !== "title"),',
    '        ),',
    '      },',
    '    },',
    '    async () => ({ content: [] }),',
    '  );',
    '  server.registerTool("only_flags", { description: "Flags.", inputSchema: { ...Object.fromEntries(Object.entries(workItemFields).filter(([k, v]) => !DATES.includes(k) && (k === "draft" || "title" === k))) } }, async () => ({ content: [] }));',
    '  server.registerTool("by_prefix", { description: "Prefix.", inputSchema: { n: z.string(), ...Object.fromEntries(Object.entries(workItemFields).filter(([k]) => k.startsWith("d"))) } }, async () => ({ content: [] }));',
    '  server.registerTool("by_ternary", { description: "Ternary.", inputSchema: { n: z.string(), ...Object.fromEntries(Object.entries(workItemFields).filter(([k]) => k === "draft" ? true : k === "title")) } }, async () => ({ content: [] }));',
    '  server.registerTool("from_broken", { description: "Broken.", inputSchema: { n: z.string(), ...Object.fromEntries(Object.entries(BROKEN).filter(([k]) => k !== "x")) } }, async () => ({ content: [] }));',
    '}',
  ].join('\n') });
  const c = tool(an, 'create_work_item').inputSchema;
  assert.deepEqual(Object.keys(c.properties), ['project_id', 'title', 'description', 'state_id', 'draft']);
  assert.deepEqual(c.required, ['project_id', 'title'], 'the filtered fields keep their optional flags; the tool\'s own title stays');
  assert.equal(c.properties.title.description, 'Work item title (required)');
  assert.equal(c.properties.state_id.description, "State id — must belong to the item's project");
  assert.deepEqual(Object.keys(tool(an, 'only_flags').inputSchema.properties), ['title', 'draft']);
  assert.deepEqual(Object.keys(tool(an, 'by_prefix').inputSchema.properties), ['n'], 'a test other than key comparisons is not read');
  assert.deepEqual(Object.keys(tool(an, 'by_ternary').inputSchema.properties), ['n'], 'a test read only in part is not read');
  assert.deepEqual(Object.keys(tool(an, 'from_broken').inputSchema.properties), ['n'], 'a constant with a part the reader could not read is not filtered');
});

// ---------------------------------------------------------------- R-RD-31: text of a factory call that is not used
// Trimmed from black-swan-causal-labs/study-design-diagram-studio 16b760c (lib/study/webmcp.ts), a server with its own
// JSON Schema helpers, found by the sample run of this series. The flightdeck-shaped tool at the end is added.
test('R-RD-31: a factory call whose value is not used leaves no unread text behind; a used one keeps the text of what it could not read', () => {
  const an = read({ 'package.json': ZOD3, 'lib/study/webmcp.ts': [
    "import { z } from 'zod';",
    "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
    "type Tool={name:string;description:string;inputSchema:Record<string,unknown>;execute:(input:unknown)=>Promise<unknown>};",
    "const str={type:'string'};const num={type:['integer','null'],minimum:-36500,maximum:36500};",
    "const elementProperties={id:str,label:{type:'string',maxLength:100},start:num,end:num,endpointLabel:{type:'string',maxLength:80}};",
    "const object=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});",
    "export function createTools(read:()=>unknown):Tool[]{",
    "const tool=(name:string,description:string,inputSchema:Record<string,unknown>,run:(input:unknown)=>unknown):Tool=>({name,description,inputSchema,execute:async input=>({content:[{type:'text',text:JSON.stringify(run(input))}]})});",
    'return [',
    "tool('update_design_element','Update only supplied fields on one timeline element.',object({id:str,expected_revision:{type:'integer'},patch:object(Object.fromEntries(Object.entries(elementProperties).filter(([k])=>k!=='id')))},['id','expected_revision','patch']),input=>read()),",
    '];}',
    "const server = new McpServer({ name: 'x', version: '1.0.0' });",
    'const id = (description: string) => z.union([z.string(), z.number()]).describe(description);',
    "server.registerTool('get_project', { description: 'Get a project.', inputSchema: { project_id: id(PREFIX + 'Project id') } }, async () => ({ content: [] }));",
  ].join('\n') });
  assert.equal(tool(an, 'update_design_element')._lost, undefined, 'the helper call was not read as a value, so its text is not reported as unread');
  const gp = tool(an, 'get_project');
  assert.ok(JSON.stringify(gp._lost || []).includes('Project id'), 'text of an argument a used call could not read is kept for the scans');
  assert.deepEqual(gp.inputSchema.properties.project_id, { type: ['string', 'number'] });
});
