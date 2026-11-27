// Reader idioms and classes from the loop's no_tools_found and reader_limit fingerprints (27 Nov check-in, R-RD-42,
// R-RD-43). Fixtures are trimmed to the shape of public repositories, credited per test (repository@commit).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { usableList, incompleteText } from '../src/inputs/collect.js';
import { fixtureFetch, scanSubject } from '../corpus/scan-static.mjs';

const require = createRequire(import.meta.url);
const R = require('../src/inputs/repo-source.cjs');

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpc-fp-'));
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); }
  return dir;
}
const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));
// scan-static's own subject path over a folder served as a GitHub repository
async function scanOf(dir) {
  const inner = fixtureFetch(dir);
  const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  return scanSubject('isokron-fixture/known-answer', { fetch: async (url) => {
    const u = String(url);
    if (u === 'https://api.github.com/repos/isokron-fixture/known-answer') return json({ full_name: 'isokron-fixture/known-answer', default_branch: 'main' });
    if (u === 'https://api.github.com/repos/isokron-fixture/known-answer/branches/main') return json({ commit: { sha: 'f'.repeat(40), commit: { committer: { date: '2026-11-27T00:00:00Z' } } } });
    return inner(url);
  } });
}

// HrRodan/agent-workspace-mcp@5c4570d36c6f (src/agent_workspace_mcp/server.py L50-80, tools/filesystem.py)
test('R-RD-42: the decorator called by hand, mcp.tool(annotations=...)(module.fn), reads fn where its module defines it (HrRodan/agent-workspace-mcp shape)', async () => {
  const r = await R.fromDirectory(repo({
    'pyproject.toml': '[project]\nname = "agent-workspace-mcp"\ndependencies = ["fastmcp>=2.10,<3"]\n',
    'src/agent_workspace_mcp/__init__.py': '',
    'src/agent_workspace_mcp/tools/__init__.py': '',
    'src/agent_workspace_mcp/tools/filesystem.py': '"""Filesystem tools."""\n\n\nasync def read_file(filepath: str, offset: int = 0) -> str:\n    """Read a text file. Text only, max 1MB."""\n    return ""\n\n\nasync def list_directory(path: str = ".") -> str:\n    """List directory contents."""\n    return ""\n',
    'src/agent_workspace_mcp/server.py': 'from fastmcp import FastMCP\nfrom mcp.types import ToolAnnotations\n\nfrom agent_workspace_mcp.tools import filesystem\n\nmcp = FastMCP("agent-workspace")\n\nmcp.tool(annotations=ToolAnnotations(\n    title="Read File",\n    readOnlyHint=True,\n))(filesystem.read_file)\n\nmcp.tool(annotations=ToolAnnotations(title="List Directory", readOnlyHint=True))(filesystem.list_directory)\n',
  }));
  const t = byName(r.best.tools);
  assert.deepEqual(Object.keys(t).sort(), ['list_directory', 'read_file']);
  assert.equal(t.read_file.description, 'Read a text file. Text only, max 1MB.');
  assert.deepEqual(Object.keys(t.read_file.inputSchema.properties), ['filepath', 'offset']);
  assert.deepEqual(t.read_file.annotations, { title: 'Read File', readOnlyHint: true });
  assert.deepEqual(r.best.where.find((w) => w.name === 'read_file'), { name: 'read_file', path: 'src/agent_workspace_mcp/server.py', line: 8, fidelity: 'derived' }, 'where the registration is');
});

// DiegoTepichin/mcp-mexico@38d0921c8fd5 (src/mcp_mexico/server.py, tools/fiscal.py)
test('R-RD-42: add_tool of a function imported by name is read in its module; a bound method of a parameter is unresolved, never guessed (DiegoTepichin/mcp-mexico shape)', async () => {
  const r = await R.fromDirectory(repo({
    'pyproject.toml': '[project]\nname = "mcp-mexico"\ndependencies = ["mcp>=2"]\n',
    'src/mcp_mexico/__init__.py': '',
    'src/mcp_mexico/tools/__init__.py': '',
    'src/mcp_mexico/tools/fiscal.py': 'def get_uma(year: int | None = None) -> dict:\n    """Get the official UMA in Mexican pesos."""\n    return {}\n',
    'src/mcp_mexico/server.py': 'from mcp.server.mcpserver import MCPServer\n\nfrom mcp_mexico.tools.fiscal import get_uma\nfrom mcp_mexico.tools.banxico import BanxicoTools\n\n\ndef build_server() -> MCPServer:\n    server = MCPServer(name="mcp-mexico")\n    server.add_tool(get_uma, title="UMA")\n    _add(server, BanxicoTools())\n    return server\n\n\ndef _add(server: MCPServer, tools: BanxicoTools) -> None:\n    server.add_tool(tools.get_fix_rate, title="FIX exchange rate")\n',
  }));
  assert.deepEqual(r.best.tools.map((x) => x.name), ['get_uma']);
  assert.equal(r.best.tools[0].title, 'UMA');
  assert.equal(r.best.tools[0].description, 'Get the official UMA in Mexican pesos.');
  assert.equal(r.best.unresolvedNames, 1, 'tools.get_fix_rate: a method of a parameter');
  assert.ok(!r.best.tools.some((x) => x.name === 'get_fix_rate'));
});

// sepehr071/balad-mcp@5b70a9bc10ac (src/balad_mcp/server.py L69-70)
test('R-RD-42: a registration in a loop over a table of tuples (for fn, title in TOOLS) is unresolved, and the scan is a reader limit, not a server without tools (sepehr071/balad-mcp shape)', async () => {
  const dir = repo({
    'pyproject.toml': '[project]\nname = "balad-mcp"\ndependencies = ["mcp>=2"]\n',
    'src/balad_mcp/__init__.py': '',
    'src/balad_mcp/registry.py': 'TOOLS = []\n\n\ndef tool(title):\n    def register(fn):\n        TOOLS.append((fn, title))\n        return fn\n    return register\n',
    'src/balad_mcp/server.py': 'from mcp.server import MCPServer\n\nfrom .registry import TOOLS\n\nmcp = MCPServer("balad")\n\nfor fn, title in TOOLS:\n    mcp.add_tool(compact(fn), title=title, structured_output=False)\n',
  });
  const r = await R.fromDirectory(dir);
  assert.equal(r.best, null);
  assert.equal(r.hints.unresolvedNames, 1, 'the loop registration is counted, not dropped');
  assert.equal(usableList(r).problem, 'incomplete');
  assert.equal(r.hints.incomplete.why, 'registration_not_seen');
  assert.match(incompleteText(r), /registration not seen/);
  const s = await scanOf(dir);
  assert.equal(s.detail, 'reader_limit');
  assert.equal(s.skip_reason, 'reader_limit');
});

// dockndevai/mcp-azure-devops@3eed7569c8f0 (src/server.ts L31), theYahia/mindbox-mcp@7ebe297e8290, inity13/scenariosim-mcp@0489da646322 (server.mjs)
test('R-RD-43: an SDK server with registrations the reader does not follow, or a hand-rolled tools/list, is a reader limit (registration_not_seen); a prompts-only server is still no_tools (formulahendry/mcp-server-spec-driven-development shape)', async () => {
  const loop = repo({
    'package.json': JSON.stringify({ name: 'x', dependencies: { '@modelcontextprotocol/sdk': '1.30.0' } }),
    'src/server.ts': 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { allTools } from "./tools/index.js";\nconst server = new McpServer({ name: "azure-devops", version: "1.0.0" });\nfor (const tool of allTools) {\n  server.registerTool(tool.name, { ...tool.config }, tool.handler);\n}\n',
  });
  const s1 = await scanOf(loop);
  assert.equal(s1.detail, 'reader_limit');
  const hand = repo({ 'server.mjs': 'const TOOLS = { run_scenario: { description: "Run.", inputSchema: { type: "object" } } };\nfunction reply(id, result) { return { jsonrpc: "2.0", id, result }; }\nfunction handle(m) { if (m.method === "tools/list") return reply(m.id, { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, ...t })) }); }\n' });
  assert.equal((await scanOf(hand)).detail, 'reader_limit');
  const prompts = repo({
    'package.json': JSON.stringify({ name: 'x', dependencies: { '@modelcontextprotocol/sdk': '1.30.0' } }),
    'src/index.ts': 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nconst server = new McpServer({ name: "spec", version: "1.0.0" });\nserver.registerPrompt("plan", { description: "Plan." }, async () => ({ messages: [] }));\n',
  });
  assert.equal((await scanOf(prompts)).detail, 'no_tools');
});

// microsoft/copilot-studio-mcp@5f9cecdceeda (README and manifests only), anusornc/kala@7d9756b68161 (Clojure)
test('R-RD-43: a repository with no source file, or with its server in a language the reader does not read, is unsupported_language, not no_tools', async () => {
  const none = await scanOf(repo({ 'README.md': '# Copilot Studio MCP\n', 'manifest.json': JSON.stringify({ name: 'x' }) }));
  assert.equal(none.detail, 'unsupported_language');
  assert.equal(none.language_hint, null);
  const clj = await scanOf(repo({ 'deps.edn': '{}', 'src/kala/server.clj': '(ns kala.server)\n(defn tools [] [])\n', 'src/kala/core.clj': '(ns kala.core)\n' }));
  assert.equal(clj.detail, 'unsupported_language');
  assert.equal(clj.language_hint, 'Clojure');
  const py = await scanOf(repo({ 'main.py': 'print("hello")\n' }));
  assert.equal(py.detail, 'no_tools', 'a source file the reader reads, with no MCP code: no tools');
});

// adwarp-dev/adwarp@38f12a3a1b17 (packages/mcp/src/tools.ts:128), JerBouma/FinanceToolkit@cdaa8c6cffca (diagnostics.__doc__)
test('R-RD-43: a description built from Object.keys(C).join(...) or fn.__doc__ is read, not marked unreadable', () => {
  const ts = 'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";\nimport { z } from "zod";\nconst COMMON_FACETS = { geo: "Geography", device: "Device" };\nconst server = new McpServer({ name: "x", version: "1" });\nserver.registerTool("list_targeting_facets", { description: `Facets: ${Object.keys(COMMON_FACETS).join(", ")}.`, inputSchema: { q: z.string() } }, async () => ({ content: [] }));\nserver.registerTool("other", { description: `Use ${Object.keys(someCall()).join(", ")}.`, inputSchema: {} }, async () => ({ content: [] }));\n';
  const [a, b] = R.extractJs(ts, { sdk: { kind: 'v1' } }).map((x) => x.tool);
  assert.equal(a.description, 'Facets: geo, device.');
  assert.equal(a._unreadable, undefined);
  assert.ok(b._unreadable.includes('description'), 'a value the reader cannot read stays marked');
  const py = 'from mcp.server.fastmcp import FastMCP\nmcp = FastMCP("x")\nif True:\n    def diagnostics() -> str:\n        """Report what the server sees."""\n        return ""\n    mcp.add_tool(diagnostics, description=diagnostics.__doc__ or "")\n';
  const [d] = R.extractPy(py, {}).map((x) => x.tool);
  assert.equal(d.description, 'Report what the server sees.');
  assert.equal(d._unreadable, undefined);
});
