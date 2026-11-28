// R-LP-83: a command line with subcommands that printed its usage gets one retry with the MCP subcommand it lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as LP from '../corpus/live-probe.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));

/** corpus/<file> with `from` replaced by `to`, imported fresh (a mutation check). */
async function mutant(from, to, file = 'live-probe.mjs') {
  const src = readFileSync(join(root, 'corpus', file), 'utf8');
  assert.ok(src.includes(from), 'the mutation text is in corpus/' + file + ': ' + from.slice(0, 80));
  const out = join(root, 'corpus', '.mutant-' + process.pid + '-' + Math.random().toString(16).slice(2) + '.mjs');
  writeFileSync(out, src.replace(from, to));
  try { return await import(pathToFileURL(out).href); } finally { rmSync(out, { force: true }); }
}

const okRec = { install: { kind: 'pypi', ok: true, steps: [{ name: 'install', exit: 0 }] }, env: { names: { registry: [] }, secret_named: [] }, timing: { total_ms: 30000 }, timed_out: false };
const exited = (stderr, exit = 2, o = {}) => ({ format: 'isokron-surface-probe/1', era: null, initialize: null, initialize_error: `the server exited (exit ${exit}, signal null)`, lists: {}, transport: { exit, signal: null }, stderr, timing: { total_ms: 900 }, ...o });
const item = (launch) => ({ index: 0, subject: 'acme/convergeqa', repo: 'acme/convergeqa', target_id: 's001', target: { id: 's001', repo: 'acme/convergeqa', ref: 'HEAD', launch }, resolution: { status: 'runnable', choice: { type: launch.kind, pydeps: null } } });
const PY = { kind: 'pypi', package: 'convergeqa-mcp', version: '1.0.0', entry: 'convergeqa-mcp' };
// Banners as the lane recorded them (26 Nov), and the shapes of the other parsers.
const ARGPARSE = 'usage: convergeqa-mcp [-h] {reviews,compare,mcp} ...\nconvergeqa-mcp: error: the following arguments are required: command\n';
const PLAIN = "Error: A subcommand must be specified (e.g. 'fast-mcp stdio <target>')\n";
const CLICK = 'Usage: delego [OPTIONS] COMMAND [ARGS]...\n\nOptions:\n  --help  Show this message and exit.\n\nCommands:\n  init   Set up the vault\n  serve  Run the MCP server\n';
const TYPER_BARE = "Usage: vox-pop [OPTIONS] COMMAND [ARGS]...\nTry 'vox-pop --help' for help.\n\nError: Missing command.\n";
const NO_MCP = 'usage: convergeqa-mcp <reviews|compare>\n';

test('R-LP-83: the MCP subcommand a usage banner lists (mcp, stdio, serve, server, run, start), and never one it does not list', () => {
  assert.equal(LP.serveSubcommand(ARGPARSE), 'mcp');
  assert.equal(LP.serveSubcommand(PLAIN), 'stdio');
  assert.equal(LP.serveSubcommand(CLICK), 'serve');
  assert.equal(LP.serveSubcommand(TYPER_BARE), null, 'Typer without its command list: nothing listed, nothing guessed');
  assert.equal(LP.serveSubcommand(NO_MCP), null);
  assert.equal(LP.serveSubcommand('Traceback (most recent call last):\n  ... serve ...\n'), null, 'no usage banner');
  assert.equal(LP.serveSubcommand('usage: x {stdio,serve,mcp}\n'), 'mcp', 'in our order');
});

test('R-LP-83: a PyPI or npm command line that printed its usage and exited gets one retry with that subcommand first; a signal, a list, a subcommand already given or another kind does not', () => {
  assert.deepEqual(LP.retryFor(item(PY), { rec: okRec, bare: exited(ARGPARSE) }), { reason: 'cli_subcommand', change: { args_prefix: ['mcp'] } });
  assert.deepEqual(LP.retryFor(item({ kind: 'npm', package: 'fast-mcp' }), { rec: okRec, bare: exited(PLAIN, 1) }), { reason: 'cli_subcommand', change: { args_prefix: ['stdio'] } });
  assert.deepEqual(LP.retryLaunch({ ...PY, args: ['--verbose'] }, { args_prefix: ['mcp'] }).args, ['mcp', '--verbose']);
  assert.equal(LP.retryFor(item(PY), { rec: okRec, bare: exited(ARGPARSE, null, { transport: { exit: null, signal: 'SIGTERM' } }) }), null, 'killed, not its own exit');
  assert.equal(LP.retryFor(item(PY), { rec: okRec, bare: exited(ARGPARSE, 137) }), null);
  assert.equal(LP.retryFor(item({ ...PY, args: ['serve'] }), { rec: okRec, bare: exited(ARGPARSE) }), null, 'a subcommand already given');
  assert.equal(LP.retryFor(item({ kind: 'docker', image: 'ghcr.io/acme/x:1@sha256:' + 'a'.repeat(64) }), { rec: okRec, bare: exited(ARGPARSE) }), null);
  assert.equal(LP.retryFor(item(PY), { rec: okRec, bare: exited(NO_MCP) }), null);
  assert.equal(LP.retryFor(item(PY), { rec: { ...okRec, install: { kind: 'pypi', ok: false, steps: [] } }, bare: exited(ARGPARSE) }), null);
  // The bundle step trusts only a retry.json entry with one of our subcommands.
  const w = join(root, 'corpus', '.retry-' + process.pid + '.json');
  writeFileSync(w, JSON.stringify({ format: LP.RETRY_FORMAT, retries: [{ id: 's001', reason: 'cli_subcommand', change: { args_prefix: ['mcp'] } }, { id: 's002', reason: 'cli_subcommand', change: { args_prefix: ['--evil'] } }, { id: 's003', reason: 'cli_subcommand', change: { args_prefix: ['mcp', 'x'] } }] }));
  try { assert.deepEqual(LP.retriesOf(w), { s001: { reason: 'cli_subcommand', change: { args_prefix: ['mcp'] } } }); } finally { rmSync(w, { force: true }); }
});

test('R-LP-83 mutation check: without the rule the usage banner is the end; without the listed-only rule a subcommand would be guessed', async () => {
  let M = await mutant('  return driftRetry(item, l, { rec, bare, envp }) || cliRetry(l, { rec, bare, envp });', '  return driftRetry(item, l, { rec, bare, envp });');
  assert.equal(M.retryFor(item(PY), { rec: okRec, bare: exited(ARGPARSE) }), null);
  M = await mutant("  return SERVE_SUBCOMMANDS.find((w) => listedWords.has(w)) || null;", "  return SERVE_SUBCOMMANDS.find((w) => listedWords.has(w)) || 'mcp';");
  assert.equal(M.serveSubcommand(NO_MCP), 'mcp', 'a guess the banner never offered');
  M = await mutant('  if (!USAGE_TEXT.test(t)) return null;\n', '');
  assert.equal(M.serveSubcommand('Error: could not open config {serve,mcp}\n'), 'mcp', 'without the banner check any {a,b} text would do');
  assert.equal(LP.serveSubcommand('Error: could not open config {serve,mcp}\n'), null);
});
