// The kind of construct behind each part the source reader could not read (R-RD-45): src/inputs/unreadable-kind.cjs,
// carried per part by the reader (candidate.unreadableKinds, candidate.unresolvedKinds) and given by scan-static as
// registration_provenance.unreadable_kinds, in fixed words and counts only. Every fixture here is our own code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { kindCounts, provenanceOf } from '../corpus/scan-static.mjs';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');
const UK = require('../src/inputs/unreadable-kind.cjs');

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpc-ukind-'));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); }
  return dir;
}
const kindsOf = async (files) => {
  const r = await R.fromDirectory(repo(files));
  return provenanceOf(r.best, { truncated: false }, r.best.tools.length).unreadable_kinds;
};

const TS_HEAD = `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
`;
const tsTool = (description, extra = '') => ({
  'package.json': '{ "name": "f", "type": "module", "dependencies": { "@modelcontextprotocol/sdk": "^1", "zod": "^3" } }\n',
  'src/index.ts': `${TS_HEAD}${extra}
const server = new McpServer({ name: "f", version: "0.0.1" });
server.registerTool("echo", {
  description: ${description},
  inputSchema: { text: z.string() },
}, async ({ text }) => ({ content: [{ type: "text", text }] }));
`,
});

test('R-RD-45: the classifier gives one closed word for an expression\'s shape, never its text', () => {
  const tok = (src) => {
    // the reader's own JS tokens, read through a one-tool fixture would be heavier: a minimal token list here
    const out = [];
    for (const m of src.matchAll(/`[^`]*\$\{[^`]*`|"[^"]*"|\.\.\.|\?\?|\|\||&&|=>|[A-Za-z_]\w*|\d+|\S/g)) {
      const v = m[0];
      if (v.startsWith('`')) out.push({ type: 'tpl', value: v });
      else if (v.startsWith('"')) out.push({ type: 'str', value: v.slice(1, -1) });
      else if (/^\d/.test(v)) out.push({ type: 'num', value: Number(v) });
      else if (/^[A-Za-z_]/.test(v)) out.push({ type: 'id', value: v });
      else out.push({ type: 'p', value: v });
    }
    return out;
  };
  const k = (src, imports = new Set()) => UK.valueKind(tok(src), 0, undefined, { imports });
  assert.equal(k('describe("echo")'), 'call');
  assert.equal(k('await load()'), 'call');
  assert.equal(k('TEXTS.echo'), 'member');
  assert.equal(k('TEXTS["echo"]'), 'member');
  assert.equal(k('ECHO', new Set(['ECHO'])), 'imported');
  assert.equal(k('ECHO'), 'identifier');
  assert.equal(k('`Echo ${x}`'), 'template_expr');
  assert.equal(k('"Echo " + x'), 'concat');
  assert.equal(k('x ? "a" : "b"'), 'conditional');
  assert.equal(k('x || "a"'), 'conditional');
  assert.equal(k('...base'), 'spread');
  assert.equal(k('() => "a"'), 'function');
  assert.equal(k('{ a: x }'), 'nested');
  assert.equal(k(''), 'other');
  for (const w of ['call', 'member', 'imported', 'identifier', 'template_expr', 'concat', 'conditional', 'spread', 'function', 'nested', 'other', 'too_deep']) assert.ok(UK.UNREADABLE_KINDS.includes(w));
  assert.deepEqual(UK.importedNames(tok('import { A, B as C } from "x"; import D from "y"; import * as E from "z";')), new Set(['A', 'C', 'D', 'E']));
});

test('R-RD-45: scan-static gives the kind of each unreadable TypeScript description, in our words and counts only', async () => {
  assert.deepEqual((await kindsOf(tsTool('describe("echo")', 'function describe(n: string) { return n.toUpperCase(); }\n'))).descriptions, { call: 1 });
  assert.deepEqual((await kindsOf(tsTool('TEXTS.echo', 'const TEXTS = JSON.parse(process.env.TEXTS ?? "{}");\n'))).descriptions, { member: 1 });
  assert.deepEqual((await kindsOf(tsTool('ECHO_DESCRIPTION', 'import { ECHO_DESCRIPTION } from "texts-package";\n'))).descriptions, { imported: 1 });
  assert.deepEqual((await kindsOf(tsTool('`Echo ${process.env.WHAT}`'))).descriptions, { template_expr: 1 });
  assert.deepEqual((await kindsOf(tsTool('process.env.LONG ? "Echo the text back." : "Echo."'))).descriptions, { conditional: 1 });
  const k = await kindsOf(tsTool('describe("echo")', 'function describe(n: string) { return n.toUpperCase(); }\n'));
  assert.deepEqual(Object.keys(k).sort(), ['annotations', 'descriptions', 'input_schemas', 'names']);
  assert.deepEqual([k.input_schemas, k.annotations, k.names], [{}, {}, {}]);
});

test('R-RD-45: a readable tool has no kinds; kindCounts keeps only our words with whole positive counts', async () => {
  const k = await kindsOf(tsTool('"Echo the text back."'));
  assert.deepEqual(k, { input_schemas: {}, descriptions: {}, annotations: {}, names: {} });
  assert.deepEqual(kindCounts({ call: 2, member: 0, 'evil name': 3, other: 1.5, imported: 1 }), { call: 2, imported: 1 });
  assert.deepEqual(kindCounts(null), {});
  assert.deepEqual(kindCounts(['call']), {});
});

test('R-RD-45: scan-static gives the kind of an unreadable Python description and of unreadable annotations', async () => {
  const py = (deco, head = '') => ({
    'pyproject.toml': '[project]\nname = "f"\nversion = "0.0.1"\ndependencies = ["mcp"]\n',
    'server.py': `from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
${head}
mcp = FastMCP("f")


@mcp.tool(${deco})
def echo(text: str) -> str:
    return text
`,
  });
  assert.deepEqual((await kindsOf(py('description=os.environ["ECHO_DESCRIPTION"]', 'import os\n'))).descriptions, { member: 1 });
  assert.deepEqual((await kindsOf(py('description=ECHO_DESCRIPTION', 'from texts_package import ECHO_DESCRIPTION\n'))).descriptions, { imported: 1 });
  assert.deepEqual((await kindsOf(py('annotations=ToolAnnotations(readOnlyHint=os.environ.get("RO") == "1")', 'import os\n'))).annotations, { call: 1 });
});
