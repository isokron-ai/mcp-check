// Why a live-probe start failed (corpus/live-probe.mjs failureDetail), R-LP-59..65: a server is blamed (start_failed,
// fault subject) only for a crash in its own code. The stderr below is real, trimmed, from the 26 Nov 2026 review of
// every recorded start failure (each credits the package and version it came from); in that review 37 of the 38
// PyPI start_failed results were our environment, an extra we did not install, or a dependency that changed after
// the release.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as LP from '../corpus/live-probe.mjs';
import { readFileSync } from 'node:fs';
import { pypiDeps, requirementOf } from '../corpus/pypi-entry.mjs';

const rec = (o = {}) => ({ install: { kind: 'pypi', ok: true, steps: [{ name: 'install', exit: 0 }] }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 60000 }, timed_out: false, ...o });
const exit1 = (stderr, ms = 1500) => ({ initialize: null, era: null, error: null, initialize_error: 'the server exited (exit 1, signal null)', lists: {}, transport: { exit: 1, signal: null }, timing: { first_byte_ms: null, total_ms: ms }, stderr });
const py = (pkg, version, entry, pydeps = null) => ({ launch: { kind: 'pypi', package: pkg, version, entry }, argsUnfilled: 0, pydeps });
const detail = (stderr, ctx, r = rec()) => LP.failureDetail(r, exit1(stderr), null, ctx);
const tb = (...lines) => ['Traceback (most recent call last):', '  File "/work/venv/bin/x", line 5, in <module>', ...lines].join('\n');

// --- fixtures (trimmed stderr; package@version they came from)

// blockchain-ai-mcp@1.0.12 (CSOAI-ORG): declares mcp>=1.0.0, no upper bound; the venv resolved mcp 2.x.
const FASTMCP_2X = tb('    from server import main', '    from mcp.server.fastmcp import FastMCP', '    raise ModuleNotFoundError(_MESSAGE, name=__name__)',
  "ModuleNotFoundError: No module named 'mcp.server.fastmcp'. This is mcp 2.x, where FastMCP was renamed to MCPServer (from mcp.server.mcpserver import MCPServer) and other APIs changed");
const BLOCKCHAIN = { top: ['server', 'blockchain-ai-mcp'], base: ['mcp', 'httpx'], uncapped: ['mcp', 'httpx'], extra_only: [], extras: [] };
// A name a dependency no longer has, in a dependency the release caps (or of which we know nothing): not ours to tell.
const IMPORT_GONE = tb('    from server import main', '    from httpx import AsyncHTTPTransportPool', "ImportError: cannot import name 'AsyncHTTPTransportPool' from 'httpx'");
// mcp-weather-server@0.6.1: McpError became MCPError in mcp 2.x.
const MCPERROR = tb('    from mcp import McpError', "ImportError: cannot import name 'McpError' from 'mcp' (/work/venv/lib/python3.13/site-packages/mcp/__init__.py). Did you mean: 'MCPError'?");
const WEATHER = { top: ['mcp-weather-server'], base: ['mcp', 'httpx'], uncapped: ['mcp'], extra_only: [], extras: [] };
// better-jupyter-mcp-server@1.1.0: a sibling dependency dropped a name.
const KERNEL = tb('    from jupyter_kernel_client import KernelClient', "ImportError: cannot import name 'KernelClient' from 'jupyter_kernel_client' (/work/venv/lib/python3.13/site-packages/jupyter_kernel_client/__init__.py)");
const JUPYTER = { top: ['better-jupyter-mcp-server'], base: ['mcp', 'jupyter-kernel-client'], uncapped: ['mcp', 'jupyter-kernel-client'], extra_only: [], extras: [] };
// deadsimple-email (teamspend-cli@0.2.6 and dns-aid@0.28.1 alike): mcp (or typer) comes only with an extra.
const NO_MCP = tb('    from deadsimple.mcp import main', '    from mcp.types import ToolAnnotations', "ModuleNotFoundError: No module named 'mcp'");
const DEADSIMPLE = { top: ['deadsimple'], base: ['httpx'], uncapped: ['httpx'], extra_only: ['mcp'], extras: ['mcp'] };
const NO_TYPER = tb('    from dns_aid.cli.main import app', '    import typer', "ModuleNotFoundError: No module named 'typer'");
const DNSAID = { top: ['dns-aid'], base: ['dnspython'], uncapped: ['dnspython'], extra_only: ['typer', 'mcp'], extras: ['cli', 'mcp'] };
// arcaeon (and lium.io, grc-lake, pardesline alike): the server names the extra itself.
const EXTRA_HINT = 'arcaeon needs the MCP Python SDK: pip install \'arcaeon[mcp]\'';
// midos-mcp@2026.2.23.1 and codex-control-plane-mcp@0.2.1: the server writes into its own site-packages, which our run mounts read-only.
const RO_FS = tb('    L1_MEMORY.mkdir(parents=True, exist_ok=True)', '    os.mkdir(self, mode)', "OSError: [Errno 30] Read-only file system: '/work/venv/lib/python3.13/site-packages/knowledge'");
// plantcv-mcp@1.20.0: OpenCV needs libGL, which python:3.13-slim lacks.
const LIBGL = tb('    native_module = importlib.import_module("cv2")', 'ImportError: libGL.so.1: cannot open shared object file: No such file or directory');
// mcpbridge-wrapper@0.1.6: wraps Xcode's bridge, macOS only.
const XCRUN = tb('    raise child_exception_type(errno_num, err_msg, err_filename)', "FileNotFoundError: [Errno 2] No such file or directory: 'xcrun'");
// mcp-snowflake-server-nsp@0.14.5: a configuration request, raised with a traceback.
const SNOWFLAKE = tb('    raise ValueError(msg)', 'ValueError: Missing required connection parameter \'database\'. Provide via "--database" argument, "SNOWFLAKE_DATABASE" env var, or TOML file.');
// stratevo@6.0.3: the wheel lacks a subpackage its own entry imports. The one real crash of the 38.
const STRATEVO = tb('    from stratevo.cli.main import main', '    from stratevo.cli.commands.backtest import (cmd_backtest, cmd_compare)', "ModuleNotFoundError: No module named 'stratevo.cli.commands'");
const STRATEVO_DEPS = { top: ['stratevo'], base: ['numpy', 'pandas'], uncapped: ['numpy', 'pandas'], extra_only: [], extras: [] };
// ghcr.io/wyre-technology/sentinelone-mcp:v1.0.6 (and four more OCI images): our --workdir /tmp hid the image's WORKDIR.
const WORKDIR_NODE = "node:internal/modules/cjs/loader:1252\n  throw err;\n  ^\n\nError: Cannot find module '/tmp/dist/index.js'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1249:15)\n  code: 'MODULE_NOT_FOUND',\n  requireStack: []\n}\n\nNode.js v22.11.0";
// ghcr.io/akira231097/artha-council-mcp:1.4.0: SQLite cannot create its database file under the read-only root.
const SQLITE = tb('    conn = sqlite3.connect(self.db_path)', 'sqlite3.OperationalError: unable to open database file');
// mcp-registry-mcp (npm): registers the same tool twice. A real crash: stays the server's.
const DUP_TOOL = 'file:///work/pkg/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:713\n            throw new Error(`Tool ${name} is already registered`);\n                  ^\n\nError: Tool health_check is already registered\n    at McpServer._createRegisteredTool (file:///work/pkg/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:713:19)\n\nNode.js v24.22.3';

// Shapes the second review of #49 raised (real-shaped; the server code is a stand-in).
const GH_ISSUES = { top: ['gh-issues-mcp'], base: ['mcp', 'httpx'], uncapped: ['mcp', 'httpx'], extra_only: [], extras: [] };
const ACME = { top: ['acme-crm-mcp'], base: ['mcp', 'pydantic-settings', 'legacy-tz'], uncapped: ['mcp', 'pydantic-settings', 'legacy-tz'], extra_only: [], extras: [] };
const SP = '/work/venv/lib/python3.13/site-packages';
const ENV_KEYERROR = tb(`  File "${SP}/gh_issues_mcp/server.py", line 12, in <module>`, "    TOKEN = os.environ['GITHUB_TOKEN']", `  File "<frozen os>", line 716, in __getitem__`, "KeyError: 'GITHUB_TOKEN'");
const PYDANTIC = tb(`  File "${SP}/acme_crm_mcp/config.py", line 30, in load`, '    return Settings()', `  File "${SP}/pydantic_settings/main.py", line 188, in __init__`, 'pydantic_core._pydantic_core.ValidationError: 1 validation error for Settings\napi_key\n  Field required [type=missing, input_value={}, input_type=dict]');
const DEP_SYNTAX = tb(`  File "${SP}/acme_crm_mcp/server.py", line 3, in <module>`, '    import legacy_tz', `  File "${SP}/legacy_tz/__init__.py", line 41`, '    print "tz"', '    ^^^^^^^^^^', 'SyntaxError: Missing parentheses in call to \'print\'. Did you mean print(...)?');
const DEP_UNION = tb(`  File "${SP}/acme_crm_mcp/server.py", line 3, in <module>`, '    import legacy_tz', `  File "${SP}/legacy_tz/types.py", line 7, in <module>`, '    Zone = str | None', "TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'");
const ABS_FILE = tb(`  File "${SP}/acme_crm_mcp/index.py", line 9, in load`, "    with open('/data/index.json') as f:", "FileNotFoundError: [Errno 2] No such file or directory: '/data/index.json'");
const NO_SPACE = tb(`  File "${SP}/acme_crm_mcp/cache.py", line 20, in warm`, '    f.write(blob)', 'OSError: [Errno 28] No space left on device');

// The cases the rules must never blame, with the detail each gets. Every one was start_failed (subject) before.
const NOT_THE_SERVER = [
  ['FASTMCP_2X', FASTMCP_2X, py('blockchain-ai-mcp', '1.0.12', 'blockchain_ai_mcp', BLOCKCHAIN), 'start_dependency_drift', 'drift'],
  ['MCPERROR', MCPERROR, py('mcp-weather-server', '0.6.1', 'mcp_weather_server', WEATHER), 'start_dependency_drift', 'drift'],
  ['KERNEL', KERNEL, py('better-jupyter-mcp-server', '1.1.0', 'better-jupyter-mcp-server', JUPYTER), 'start_dependency_drift', 'drift'],
  ['NO_MCP', NO_MCP, py('deadsimple-email', 'latest', 'deadsimple-mcp', DEADSIMPLE), 'start_needs_extra', 'extra'],
  ['NO_TYPER', NO_TYPER, py('dns-aid', '0.28.1', 'dns-aid', DNSAID), 'start_needs_extra', 'extra'],
  ['EXTRA_HINT', tb('    raise SystemExit(msg)', 'RuntimeError: ' + EXTRA_HINT), py('arcaeon', '0.1.0', 'arcaeon'), 'start_needs_extra', 'extra'],
  ['RO_FS', RO_FS, py('midos-mcp', '2026.2.23.1', 'midos-mcp'), 'start_env_limited', 'env'],
  ['LIBGL', LIBGL, py('plantcv-mcp', '1.20.0', 'plantcv-mcp'), 'start_env_limited', 'env'],
  ['SQLITE', SQLITE, { launch: { kind: 'docker', image: 'ghcr.io/akira231097/artha-council-mcp:1.4.0' }, argsUnfilled: 0 }, 'start_env_limited', 'env'],
  ['WORKDIR_NODE', WORKDIR_NODE, { launch: { kind: 'docker', image: 'ghcr.io/wyre-technology/sentinelone-mcp:v1.0.6' }, argsUnfilled: 0 }, 'start_env_limited', 'env'],
  ['EXCEL', 'Error: ExcelMcp is Windows only\n    at main (/work/pkg/dist/index.js:4:9)', { launch: { kind: 'npm', package: 'excel-mcp' }, argsUnfilled: 0 }, 'unsupported_platform', 'platform'],
  ['XCRUN', XCRUN, py('mcpbridge-wrapper', '0.1.6', 'mcpbridge-wrapper'), 'unsupported_platform', 'platform'],
  ['SNOWFLAKE', SNOWFLAKE, py('mcp-snowflake-server-nsp', '0.14.5', 'mcp_snowflake_server'), 'start_needs_config', 'config'],
];

test('R-LP-59: of the 26 Nov PyPI start_failed results, only the crash in the server\'s own code is blamed on it', () => {
  for (const [name, stderr, ctx, want] of NOT_THE_SERVER) {
    assert.match(stderr, LP.CRASH_TEXT, name + ': the old rule saw a crash here');
    const d = detail(stderr, ctx);
    assert.equal(d, want, name);
    assert.equal(LP.DETAILS[d][3], 'tool', name + ': fault tool, never subject');
  }
  // stratevo: its own wheel lacks the subpackage its entry imports. Still the server's.
  assert.equal(detail(STRATEVO, py('stratevo', '6.0.3', 'stratevo', STRATEVO_DEPS)), 'missing_own_module', 'its packaging, named (R-LP-68)');
  assert.equal(detail(STRATEVO, py('stratevo', '6.0.3', 'stratevo')), 'start_failed', 'without the wheel facts, a module named like the package is its own');
  assert.equal(detail(DUP_TOOL, { launch: { kind: 'npm', package: 'mcp-registry-mcp' }, argsUnfilled: 0 }), 'start_failed', 'a real crash in its own code');
  // A declared variable does not turn a crash of its own into needs_credentials, nor a quiet exit into a crash.
  const declared = rec({ env: { names: { registry: ['STRATEVO_KEY'] }, secret_named: ['STRATEVO_KEY'] } });
  assert.equal(detail(STRATEVO, py('stratevo', '6.0.3', 'stratevo', STRATEVO_DEPS), declared), 'missing_own_module');
  assert.equal(detail('', py('stratevo', '6.0.3', 'stratevo', STRATEVO_DEPS), declared), 'needs_credentials');
  assert.equal(detail(tb('    raise RuntimeError(msg)', 'RuntimeError: STRATEVO_KEY is not set'), py('stratevo', '6.0.3', 'stratevo', STRATEVO_DEPS), declared), 'needs_credentials');
  // The other guards still hold for a crash of its own.
  assert.equal(LP.failureDetail(rec(), exit1(STRATEVO, LP.START_QUICK_MS), null, py('stratevo', '6.0.3', 'stratevo')), 'start_env_limited', 'a late exit');
});

test('R-LP-60: a read-only root, a refused write, a missing shared library or executable, or our /tmp workdir is start_env_limited (tool)', () => {
  for (const s of [RO_FS, LIBGL, SQLITE, WORKDIR_NODE, "python: can't open file '/tmp/server.py': [Errno 2] No such file or directory",
    "Error: EACCES: permission denied, mkdir '/data/logs'", "PermissionError: [Errno 13] Permission denied: '/config'", "Error: EROFS: read-only file system, open '/app/cache.json'",
    'node: error while loading shared libraries: libatomic.so.1: cannot open shared object file',
    // nano-pdf-mcp's image (an arm64 image on our amd64 runner) and neo4j-mcp-canary's bundled binary: a binary for another CPU.
    '[FATAL tini (2)] exec python failed: Exec format error', "OSError: [Errno 8] Exec format error: '/work/venv/lib/python3.13/site-packages/neo4j_mcp_canary/neo4j-mcp-canary.exe'"]) {
    assert.match(s, LP.ENV_TEXT, s);
  }
  for (const s of ['Error: spawn git ENOENT\n    at ChildProcess._handle.onexit (node:internal/child_process:285:19)', "FileNotFoundError: [Errno 2] No such file or directory: 'uvx'", '/bin/sh: 1: java: not found', 'exec: "docker": executable file not found in $PATH']) {
    assert.equal(detail(s, py('x-mcp', '1.0.0', 'x-mcp')), 'start_env_limited', s);
  }
  // Go and glibc print these in lower case; GitPython without git; a native addon that was never built.
  for (const s of ['panic: open /app/data.db: read-only file system\n\ngoroutine 1 [running]:', 'panic: mkdir /home/app: permission denied\n\ngoroutine 1 [running]:',
    tb('ImportError: Bad git executable.'), 'Error: Could not locate the bindings file. Tried:\n    at bindings (/work/pkg/node_modules/bindings/bindings.js:126:9)']) {
    assert.equal(detail(s, py('x-mcp', '1.0.0', 'x-mcp')), 'start_env_limited', s);
  }
  // CommonJS: a bare dependency that is not installed is not ours to tell; the package's own file is its own.
  const npmCtx = { launch: { kind: 'npm', package: 'x-mcp' }, argsUnfilled: 0 };
  assert.equal(detail("Error: Cannot find module 'sharp'\nRequire stack:\n- /work/pkg/node_modules/x-mcp/dist/index.js", npmCtx), 'start_env_limited');
  assert.equal(detail("Error: Cannot find module '/work/pkg/node_modules/x-mcp/dist/tools.js'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1249:15)", npmCtx), 'start_failed');
  // A declared env var does not turn our environment into the server's needs_credentials.
  assert.equal(detail(RO_FS, py('midos-mcp', '2026.2.23.1', 'midos-mcp'), rec({ env: { names: { registry: ['API_KEY'] }, secret_named: ['API_KEY'] } })), 'start_env_limited');
  // A file path or a data file is not an executable.
  assert.doesNotMatch("FileNotFoundError: [Errno 2] No such file or directory: 'config.json'", LP.ENV_TEXT);
});

test('R-LP-61: a module only an extra brings, or a server naming the extra to install, is start_needs_extra (tool)', () => {
  assert.deepEqual(LP.DETAILS.start_needs_extra, ['timeout_start', false, 'start', 'tool']);
  assert.equal(detail(NO_MCP, py('deadsimple-email', 'latest', 'deadsimple-mcp', DEADSIMPLE)), 'start_needs_extra');
  assert.equal(detail(NO_TYPER, py('dns-aid', '0.28.1', 'dns-aid', DNSAID)), 'start_needs_extra');
  // A missing module we cannot place (no wheel facts, or not declared at all: a stdlib module the slim image lacks, a
  // name that differs from its distribution) is not the server's either.
  assert.equal(detail(NO_MCP, py('deadsimple-email', 'latest', 'deadsimple-mcp')), 'start_env_limited');
  assert.equal(detail(tb("ModuleNotFoundError: No module named 'distutils'"), py('x', '1', 'x', { ...DEADSIMPLE, extra_only: [] })), 'start_env_limited');
  // The release's facts, as the planner records them from PyPI's JSON and the wheel.
  const deps = pypiDeps({ requires_dist: ['httpx>=0.27', 'mcp>=1.2; extra == "mcp"', 'typer[all]>=0.9 ; extra == \'cli\'', 'pydantic>=2,<3', 'anyio~=4.0', 'rich (>=13)'], provides_extra: ['mcp', 'cli'] }, ['deadsimple/__init__.py', 'deadsimple/mcp.py', 'deadsimple-1.0.dist-info/METADATA', 'helper.py']);
  assert.deepEqual(deps, { top: ['deadsimple', 'helper'], base: ['httpx', 'pydantic', 'anyio', 'rich'], uncapped: ['httpx', 'rich'], extra_only: ['mcp', 'typer'], extras: ['mcp', 'cli'] });
  assert.deepEqual(requirementOf('Foo_Bar[x] ==1.*; python_version < "3.12"'), { name: 'foo-bar', extra: null, capped: true });
  assert.equal(pypiDeps(null, null).top, null, 'no wheel read: own modules unknown');
  // A namespace folder (no __init__.py) is shared with other distributions: google.auth is not the server's module.
  const ns = pypiDeps({ requires_dist: ['google-auth>=2'] }, ['google/cloud_x/__init__.py', 'x_mcp/__init__.py']);
  assert.deepEqual(ns.top, ['x-mcp']);
  assert.equal(detail(tb("ModuleNotFoundError: No module named 'google.auth'"), py('x-mcp', '1', 'x-mcp', ns)), 'start_env_limited');
  // Without the wheel, only a module named exactly like the package is its own: mcp-server-docker's `docker` is a library.
  assert.equal(detail(tb("ModuleNotFoundError: No module named 'docker'"), py('mcp-server-docker', '1', 'mcp-server-docker')), 'start_env_limited');
  // PEP 508 corners: a direct reference is one exact artifact; a reversed extra marker; junk entries.
  assert.equal(requirementOf('foo @ https://example.com/foo-1.0.whl').capped, true);
  assert.equal(requirementOf('foo>=1; "mcp" == extra').extra, 'mcp');
  assert.deepEqual(pypiDeps({ requires_dist: [null, 7, 'a>=1'] }).base, ['a']);
});

test('R-LP-62: a dependency that changed after the release is start_dependency_drift, and a macOS- or Windows-only server is unsupported_platform (both tool)', () => {
  assert.deepEqual(LP.DETAILS.start_dependency_drift, ['timeout_start', false, 'start', 'tool']);
  assert.deepEqual(LP.DETAILS.unsupported_platform, ['timeout_start', false, 'start', 'tool']);
  assert.equal(detail(FASTMCP_2X, py('blockchain-ai-mcp', '1.0.12', 'blockchain_ai_mcp', BLOCKCHAIN)), 'start_dependency_drift');
  assert.equal(detail(MCPERROR, py('mcp-weather-server', '0.6.1', 'mcp_weather_server', WEATHER)), 'start_dependency_drift');
  // Drift needs the dependency declared with no upper bound; a capped one, or no facts at all, is not ours to tell:
  // start_env_limited, still never the server's. The SDK's own "This is mcp 2.x" is drift whatever the facts (R-LP-81).
  assert.equal(detail(IMPORT_GONE, py('blockchain-ai-mcp', '1.0.12', 'blockchain_ai_mcp', { ...BLOCKCHAIN, uncapped: ['mcp'] })), 'start_env_limited');
  assert.equal(detail(IMPORT_GONE, py('blockchain-ai-mcp', '1.0.12', 'blockchain_ai_mcp')), 'start_env_limited');
  assert.equal(detail(FASTMCP_2X, py('blockchain-ai-mcp', '1.0.12', 'blockchain_ai_mcp', { ...BLOCKCHAIN, uncapped: ['httpx'] })), 'start_dependency_drift');
  assert.equal(detail(FASTMCP_2X, py('blockchain-ai-mcp', '1.0.12', 'blockchain_ai_mcp')), 'start_dependency_drift');
  // Node: an export a dependency no longer has.
  const esm = "file:///work/pkg/dist/index.js:1\nimport { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n         ^^^^^^^^^\nSyntaxError: The requested module '@modelcontextprotocol/sdk/server/mcp.js' does not provide an export named 'McpServer'\n    at ModuleJob._instantiate (node:internal/modules/esm/module_job:180:21)";
  assert.equal(detail(esm, { launch: { kind: 'npm', package: 'x-mcp' }, argsUnfilled: 0 }), 'start_dependency_drift');
  assert.equal(detail("SyntaxError: The requested module './tools.js' does not provide an export named 'x'\n    at ModuleJob._instantiate (node:internal/modules/esm/module_job:180:21)", { launch: { kind: 'npm', package: 'x-mcp' }, argsUnfilled: 0 }), 'start_failed', 'its own module');
  assert.equal(detail("SyntaxError: The requested module 'file:///work/pkg/dist/x.js' does not provide an export named 'a'\n    at ModuleJob._instantiate (node:internal/modules/esm/module_job:180:21)", { launch: { kind: 'npm', package: 'x-mcp' }, argsUnfilled: 0 }), 'start_failed', 'a file: URL is its own module');
  // Platform: the server says so, or needs an executable only macOS or Windows has.
  assert.equal(detail('Error: ExcelMcp is Windows only\n    at main (/work/pkg/dist/index.js:4:9)', { launch: { kind: 'npm', package: 'excel-mcp' }, argsUnfilled: 0 }), 'unsupported_platform');
  assert.equal(detail(XCRUN, py('mcpbridge-wrapper', '0.1.6', 'mcpbridge-wrapper')), 'unsupported_platform');
  for (const s of ['This server only runs on macOS', 'RuntimeError: requires Windows', 'Error: not supported on Linux', 'macOS-only: uses AppleScript']) assert.match(s, LP.PLATFORM_TEXT, s);
  for (const s of ['Running on Windows, macOS and Linux', 'windows path detected']) assert.doesNotMatch(s, LP.PLATFORM_TEXT, s);
});

test('R-LP-63: configuration requests the first patterns missed are start_needs_config (tool), traceback or not', () => {
  const msgs = ['Missing required setting(s): OITC_APIKEY', 'Configuration error: AXE_API_KEY, AXE_URL', '{"error":{"code":"configuration_path_required"}}', 'Pass --project <path>', 'Error: Factory is not configured', 'No Telegram credentials configured', 'Run the pipeline first', 'Invalid configuration', SNOWFLAKE,
    // mcp-hydrolix: a configuration request raised with a traceback, with a variable declared.
    tb('    raise ValueError(', 'ValueError: User/password authentication is only partially configured: set both HYDROLIX_USER and HYDROLIX_PASSWORD')];
  for (const s of msgs) {
    assert.match(s, LP.CONFIG_TEXT, s);
    assert.equal(detail(s, { launch: { kind: 'npm', package: 'x' }, argsUnfilled: 0 }), 'start_needs_config', s);
  }
  for (const s of ['missing field in response', 'run the server', 'Configured 3 tools']) assert.doesNotMatch(s, LP.CONFIG_TEXT, s);
});

test('R-LP-64: a server that went to the network is start_needs_network whether or not a variable is declared, from telemetry or its own stderr', () => {
  const dns = { v: 1, type: 'dns_query', subject: 's001', source: 'netlog', role: 'server', qname: 'api.example.com', qtype: 'A', answer: 'sinkhole' };
  // Was start_env_limited with no variable declared (code at 1177): the cause is known, so it is named.
  assert.equal(LP.failureDetail(rec(), exit1('panic: x\n\ngoroutine 1 [running]:'), null, { launch: { kind: 'npm' }, argsUnfilled: 0, records: [dns] }), 'start_needs_network');
  for (const s of [tb('httpx.ConnectError: [Errno -3] Temporary failure in name resolution'), 'Error: getaddrinfo ENOTFOUND api.github.com\n    at GetAddrInfoReqWrap.onlookup (node:dns:120:26)', tb('requests.exceptions.ConnectionError: HTTPSConnectionPool(host=\'x\', port=443): Failed to establish a new connection')]) {
    assert.match(s, LP.NETWORK_TEXT, s);
    assert.equal(detail(s, py('x-mcp', '1', 'x-mcp')), 'start_needs_network', s);
  }
  for (const s of ['panic: dial tcp: lookup api.x.com on 127.0.0.11:53: no such host\n\ngoroutine 1 [running]:', 'panic: dial tcp 127.0.0.1:5432: connect: connection refused\n\ngoroutine 1 [running]:',
    tb('socket.gaierror: [Errno -3] Temporary failure in name resolution'), 'TypeError: fetch failed\n    at node:internal/deps/undici/undici:13510:13']) {
    assert.equal(detail(s, py('x-mcp', '1', 'x-mcp')), 'start_needs_network', s);
  }
  // With a declared variable too: the network is the cause, never needs_credentials.
  const declared = rec({ env: { names: { registry: ['API_KEY'] }, secret_named: ['API_KEY'] } });
  assert.equal(detail('Error: getaddrinfo ENOTFOUND api.github.com\n    at GetAddrInfoReqWrap.onlookup (node:dns:120:26)', py('x-mcp', '1', 'x-mcp'), declared), 'start_needs_network');
  assert.equal(LP.DETAILS.start_needs_network[3], 'tool');
});

test('R-LP-65: mutation check: with a start rule switched off its fixture gets another detail, and with all of them off every fixture is blamed on the server again', () => {
  const cases = [...NOT_THE_SERVER,
    ['NETWORK', tb('httpx.ConnectError: [Errno -3] Temporary failure in name resolution'), py('x-mcp', '1', 'x-mcp'), 'start_needs_network', 'network'],
    ['IMPORT_NO_FACTS', IMPORT_GONE, py('blockchain-ai-mcp', '1.0.12', 'blockchain_ai_mcp'), 'start_env_limited', 'import'],
    ['MCP2_TEXT_NO_FACTS', FASTMCP_2X, py('blockchain-ai-mcp', '1.0.12', 'blockchain_ai_mcp'), 'start_dependency_drift', 'drift'],
    ['ENV_KEYERROR', ENV_KEYERROR, py('gh-issues-mcp', '0.4.0', 'gh-issues-mcp', GH_ISSUES), 'start_needs_config', 'config'],
    ['PYDANTIC', PYDANTIC, py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', ACME), 'start_needs_config', 'config'],
    ['DEP_SYNTAX', DEP_SYNTAX, py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', ACME), 'start_env_limited', 'frame'],
    ['DEP_UNION', DEP_UNION, py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', ACME), 'start_env_limited', 'frame'],
    ['ABS_FILE', ABS_FILE, py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', ACME), 'start_env_limited', 'env'],
    ['NO_SPACE', NO_SPACE, py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', ACME), 'start_env_limited', 'env']];
  const rules = new Set();
  try {
    for (const [name, stderr, ctx, want, rule] of cases) {
      rules.add(rule);
      LP.setStartMutation(null);
      assert.equal(detail(stderr, ctx), want, name + ' with every rule on');
      LP.setStartMutation(rule);
      assert.notEqual(detail(stderr, ctx), want, name + ': switching ' + rule + ' off changed nothing, so its test does not depend on it');
      LP.setStartMutation('all');
      assert.equal(detail(stderr, ctx), 'start_failed', name + ': without the start rules the server is blamed, which is what they prevent');
    }
  } finally { LP.setStartMutation(null); }
  assert.deepEqual([...rules].sort(), ['config', 'drift', 'env', 'extra', 'frame', 'import', 'network', 'platform']);
});

test('R-LP-68: the server\'s own packaging defects stay the server\'s: a module of its own package its wheel lacks, a module its own code imports that it neither ships nor declares', () => {
  assert.deepEqual(LP.DETAILS.missing_own_module, ['timeout_start', false, 'start', 'subject']);
  assert.deepEqual(LP.DETAILS.undeclared_dependency, ['timeout_start', false, 'start', 'subject']);
  const own = { top: ['acme-crm-mcp'], base: ['mcp'], uncapped: ['mcp'], extra_only: [], extras: [] };
  const ctx = py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', own);
  // Its own code imports httpx, which requires_dist never names and which is not installed.
  const httpx = tb(`  File "${SP}/acme_crm_mcp/server.py", line 4, in <module>`, '    import httpx', "ModuleNotFoundError: No module named 'httpx'");
  assert.equal(detail(httpx, ctx), 'undeclared_dependency');
  // A sibling module the wheel left out (`from utils import x`, utils not shipped, not declared).
  const utils = tb(`  File "${SP}/acme_crm_mcp/server.py", line 2, in <module>`, '    from utils import helpers', "ModuleNotFoundError: No module named 'utils'");
  assert.equal(detail(utils, ctx), 'undeclared_dependency');
  // From its console script too.
  assert.equal(detail(tb('  File "/work/venv/bin/acme-crm-mcp", line 5, in <module>', '    import httpx', "ModuleNotFoundError: No module named 'httpx'"), ctx), 'undeclared_dependency');
  // A submodule of its own package the wheel lacks.
  assert.equal(detail(tb(`  File "${SP}/acme_crm_mcp/server.py", line 2, in <module>`, "ModuleNotFoundError: No module named 'acme_crm_mcp.tools'"), ctx), 'missing_own_module');
  // Not the server's: declared in base (a failed install), only an extra's, Python's own or the venv's, imported from
  // inside a dependency, or no facts read.
  assert.equal(detail(httpx, py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', { ...own, base: ['mcp', 'httpx'] })), 'start_env_limited');
  assert.equal(detail(httpx, py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', { ...own, extra_only: ['httpx'], extras: ['http'] })), 'start_needs_extra');
  for (const m of ['distutils', 'imp', 'tkinter', 'pkg_resources', 'setuptools']) assert.equal(detail(tb(`  File "${SP}/acme_crm_mcp/server.py", line 2, in <module>`, `ModuleNotFoundError: No module named '${m}'`), ctx), 'start_env_limited', m);
  assert.equal(detail(tb(`  File "${SP}/mcp/server/lowlevel.py", line 2, in <module>`, "ModuleNotFoundError: No module named 'anyio'"), ctx), 'start_env_limited', 'a dependency\'s own import');
  assert.equal(detail(httpx, py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp')), 'start_env_limited', 'no facts');
  // FinanceToolkit 2.3.5: its mcp_server imports anyio, which its [mcp] extra brings through mcp; we did not install the
  // extra, so it is the extra's, not an undeclared dependency. With the extra installed, it would be.
  const ft = { top: ['financetoolkit'], base: ['numpy', 'pandas', 'requests'], uncapped: ['numpy', 'pandas', 'requests'], extra_only: ['mcp', 'fastmcp'], extras: ['econometrics', 'mcp'] };
  const anyio = tb(`  File "${SP}/financetoolkit/mcp_server/mcp_controller.py", line 15, in <module>`, '    import anyio', "ModuleNotFoundError: No module named 'anyio'");
  assert.equal(detail(anyio, py('financetoolkit', '2.3.5', 'financetoolkit-mcp', ft)), 'start_needs_extra');
  assert.equal(detail(anyio, { ...py('financetoolkit', '2.3.5', 'financetoolkit-mcp', ft), launch: { kind: 'pypi', package: 'financetoolkit', version: '2.3.5', entry: 'financetoolkit-mcp', extras: ['mcp'] } }), 'undeclared_dependency');
  // A stdlib AttributeError (our Python version) stays ours.
  assert.equal(detail(tb(`  File "${SP}/acme_crm_mcp/server.py", line 2, in <module>`, "AttributeError: module 'asyncio' has no attribute 'coroutine'"), ctx), 'start_env_limited');
  // A late exit is still no evidence.
  assert.equal(LP.failureDetail(rec(), exit1(httpx, LP.START_QUICK_MS), null, ctx), 'undeclared_dependency', 'packaging is evidence whatever the timing');
});

test('R-LP-69: an unset variable read, pydantic settings, a missing absolute path, a full disk, our stop, or a crash inside a dependency is never the server\'s', () => {
  const ctx = py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', ACME);
  assert.equal(detail(ENV_KEYERROR, py('gh-issues-mcp', '0.4.0', 'gh-issues-mcp', GH_ISSUES)), 'start_needs_config');
  assert.equal(detail(PYDANTIC, ctx), 'start_needs_config');
  for (const s of [ABS_FILE, NO_SPACE, "Error: ENOENT: no such file or directory, open '/config/settings.json'\n    at Object.openSync (node:fs:573:18)", 'Error: ENOSPC: no space left on device, write', tb(`  File "${SP}/acme_crm_mcp/server.py", line 40, in run`, '    time.sleep(1)', 'KeyboardInterrupt')]) {
    assert.equal(detail(s, ctx), 'start_env_limited', s.slice(-60));
  }
  assert.equal(detail(DEP_SYNTAX, ctx), 'start_env_limited');
  assert.equal(detail(DEP_UNION, ctx), 'start_env_limited');
  // A crash whose last frame is the server's own code is still its own; so is one in Python's own library it called.
  const ownCrash = tb(`  File "${SP}/acme_crm_mcp/server.py", line 7, in <module>`, '    TOOLS["x"]', "KeyError: 'x'");
  assert.equal(detail(ownCrash, ctx), 'start_failed');
  assert.equal(detail(tb(`  File "${SP}/acme_crm_mcp/server.py", line 7, in <module>`, '  File "/usr/local/lib/python3.13/json/decoder.py", line 355, in raw_decode', 'json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)'), ctx), 'start_failed');
  // Lower-case or dict-style keys are no variable.
  assert.doesNotMatch("KeyError: 'name'", /KeyError: '[A-Z]/);
  assert.deepEqual(LP.lastFrame('no frames here'), null);
  assert.equal(LP.frameInDependency(DEP_UNION, { pydeps: null, pkg: null }), false, 'no own modules known: not ours to say');
});

test('R-LP-71: a declared dependency whose import name differs from its distribution\'s is not undeclared when missing; an unknown mapping is ours', () => {
  const own = (dist) => ({ top: ['acme-crm-mcp'], base: ['mcp', dist], uncapped: ['mcp', dist], extra_only: [], extras: [] });
  const missing = (mod) => tb(`  File "${SP}/acme_crm_mcp/server.py", line 4, in <module>`, `    import ${mod}`, `ModuleNotFoundError: No module named '${mod}'`);
  // Declared, not installed (a failed install): ours, whatever the import name.
  const pairs = [['jose', 'python-jose'], ['Crypto', 'pycryptodome'], ['serial', 'pyserial'], ['cv2', 'opencv-python-headless'], ['OpenSSL', 'pyopenssl'], ['markdown_it', 'markdown-it-py']];
  for (const [mod, dist] of pairs) {
    assert.ok(LP.DIST_IMPORTS[dist].includes(mod.toLowerCase().replace(/_/g, '-')), dist + ' lists ' + mod);
    assert.equal(detail(missing(mod), py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', own(dist))), 'start_env_limited', mod + ' from ' + dist);
  }
  // A declared distribution whose import names we do not know may be the one: ours, never the server's.
  assert.equal(LP.DIST_IMPORTS['some-vendor-sdk'], undefined);
  assert.equal(detail(missing('vendorsdk_core'), py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', own('some-vendor-sdk'))), 'start_env_limited');
  // An extra's distribution counts as declared too.
  assert.equal(detail(missing('jose'), py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', { top: ['acme-crm-mcp'], base: ['mcp'], uncapped: ['mcp'], extra_only: ['python-jose'], extras: ['auth'] })), 'start_needs_extra');
  // Every declared distribution known and none providing it: undeclared, the server's.
  assert.equal(detail(missing('jose'), py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', own('httpx'))), 'undeclared_dependency');
  // Mutation check: with the mapping off, each pair is blamed again.
  try {
    LP.setStartMutation('importmap');
    for (const [mod, dist] of pairs.filter(([m]) => !['cv2'].includes(m))) assert.equal(detail(missing(mod), py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', own(dist))), 'undeclared_dependency', 'mapping off: ' + mod);
    assert.equal(detail(missing('vendorsdk_core'), py('acme-crm-mcp', '1.2.0', 'acme-crm-mcp', own('some-vendor-sdk'))), 'undeclared_dependency', 'mapping off: the unknown one');
  } finally { LP.setStartMutation(null); }
});

test('R-LP-66: a PyPI launch installs the extra that holds the server (mcp, server, cli), once the pinned sandbox takes it', () => {
  assert.deepEqual(LP.serverExtras({ extras: ['dev', 'cli', 'mcp', 'test'] }), ['mcp', 'cli']);
  assert.deepEqual(LP.serverExtras({ extras: ['server'] }), ['server']);
  assert.deepEqual(LP.serverExtras({ extras: ['all', 'dev'] }), [], 'only an extra named for the server');
  assert.deepEqual(LP.serverExtras(null), []);
  // An older sandbox refuses launch.extras, so the switch stays off until SURFACE_CORPUS_REF moves past
  // mcp-surface-corpus 4c16b58 (R-SBX-49 is after it).
  const y = readFileSync(new URL('../.github/workflows/live-probe.yml', import.meta.url), 'utf8');
  const pin = /\n  SURFACE_CORPUS_REF: '([0-9a-f]{40})'\n/.exec(y)[1];
  assert.equal(LP.EMIT_PYPI_EXTRAS, pin !== '4c16b586e8e5886acb098285b6ec405fd4db4ac7', 'on exactly when the pinned sandbox takes launch.extras');
});

test('R-LP-67: an HTTP-mode server\'s own exit comes from the sandbox\'s container record, only with its output read back', () => {
  const http = (o = {}) => ({ format: 'isokron-surface-probe/1', mode: 'http', error: null, initialize: null, lists: {}, transport: {}, stderr: '', stderr_bytes: 0, timing: { total_ms: 3500 }, ...o });
  const box = (exit, o = {}) => ({ v: 1, type: 'container', subject: 's001', role: 'server', runtime: 'runsc', exit, signal: null, timed_out: false, oom_killed: false, ms: 3400, ...o });
  // The real shape (an HTTP-mode image that exited 2 in 3.5 s), now with its stderr read back.
  const err = 'Traceback (most recent call last):\n  File "/app/server.py", line 9, in <module>\n    main()\nKeyError: \'port\'';
  assert.deepEqual(LP.exitOf(http({ stderr: err, stderr_bytes: err.length }), [box(2), box(2)]), { exit: 2, signal: null });
  const ctx = { launch: { kind: 'docker', image: 'ghcr.io/acme/srv:1' }, argsUnfilled: 0 };
  assert.equal(LP.failureDetail(rec(), http({ stderr: err, stderr_bytes: err.length }), null, { ...ctx, records: [box(2)] }), 'start_failed');
  assert.equal(LP.failureDetail(rec(), http({ stderr: 'Error: Missing required setting(s): OITC_APIKEY', stderr_bytes: 46 }), null, { ...ctx, records: [box(1)] }), 'start_needs_config');
  // No output read back (the sandbox before R-SBX-47), a killed, timed-out or still-running container, or records that disagree: not its own exit.
  assert.deepEqual(LP.exitOf(http(), [box(1)]), { exit: null, signal: null });
  for (const recs of [[box(null)], [box(1, { timed_out: true })], [box(137, { oom_killed: true })], [box(1), box(2)], [box(1, { signal: 'SIGKILL' })], []]) {
    assert.deepEqual(LP.exitOf(http({ stderr: err, stderr_bytes: 10 }), recs), { exit: null, signal: null }, JSON.stringify(recs));
  }
  assert.equal(LP.failureDetail(rec(), http({ stderr: err, stderr_bytes: err.length }), null, { ...ctx, records: [box(null)] }), 'start_env_limited');
  // stdio keeps its transport's exit.
  assert.deepEqual(LP.exitOf({ transport: { exit: 3, signal: null } }, [box(1)]), { exit: 3, signal: null });
});

test('R-LP-70: an exit of 128+n is signal n (our stop 143, our interrupt 130, a segfault 139), never the server\'s own exit; an image the sandbox would not run as is stays ours', () => {
  const http = (o = {}) => ({ format: 'isokron-surface-probe/1', mode: 'http', error: null, initialize: null, lists: {}, transport: {}, timing: { total_ms: 3500 }, ...o });
  const box = (exit) => ({ v: 1, type: 'container', subject: 's001', role: 'server', runtime: 'runsc', exit, signal: null, timed_out: false, oom_killed: false, ms: 3400 });
  const ki = tb('  File "/app/server.py", line 40, in main', '    time.sleep(1)', 'KeyboardInterrupt');
  const crash = tb('  File "/app/server.py", line 9, in <module>', "KeyError: 'port'");
  const ctx = { launch: { kind: 'docker', image: 'ghcr.io/acme/srv:1' }, argsUnfilled: 0 };
  for (const [code, sig] of [[143, 'SIGTERM'], [130, 'SIGINT'], [139, 'SIGSEGV'], [137, 'SIGKILL'], [134, 'SIGABRT']]) {
    assert.deepEqual(LP.exitOf(http({ stderr: crash, stderr_bytes: crash.length }), [box(code)]), { exit: null, signal: sig }, String(code));
    assert.equal(LP.failureDetail(rec(), http({ stderr: crash, stderr_bytes: crash.length }), null, { ...ctx, records: [box(code)] }), 'start_env_limited', String(code));
    // The same over stdio, where docker run reports it.
    assert.equal(LP.failureDetail(rec(), { ...exit1(crash), transport: { exit: code, signal: null } }, null, ctx), 'start_env_limited', 'stdio ' + code);
  }
  assert.equal(LP.failureDetail(rec(), http({ stderr: ki, stderr_bytes: ki.length }), null, { ...ctx, records: [box(130)] }), 'start_env_limited', 'KeyboardInterrupt with 130');
  assert.equal(LP.failureDetail(rec(), http({ stderr: crash, stderr_bytes: crash.length }), null, { ...ctx, records: [box(1)] }), 'start_failed', 'its own exit 1 still counts');
  assert.deepEqual(LP.exitOf({ transport: { exit: 128, signal: null } }), { exit: 128, signal: null }, '128 itself is an exit code');
  // An image only for another platform, and a WORKDIR the sandbox refused: ours.
  const docker = (oci) => rec({ install: { kind: 'docker', ok: false, steps: [{ name: 'pull', exit: 0 }], oci } });
  assert.equal(LP.failureDetail(docker({ platform: 'linux/arm64', platform_unsupported: true }), null, null, ctx), 'unsupported_platform');
  assert.equal(LP.failureDetail(docker({ platform: null }), null, null, ctx), 'image_pull_failed');
  const refused = rec({ install: { kind: 'docker', ok: true, steps: [{ name: 'pull', exit: 0 }], oci: { workdir: null, workdir_refused: '/proc/self/fd/7', volumes: [] } } });
  assert.equal(LP.failureDetail(refused, { ...exit1(crash), transport: { exit: 1, signal: null } }, null, ctx), 'start_env_limited');
});
