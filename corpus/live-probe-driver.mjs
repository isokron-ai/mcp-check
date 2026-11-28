#!/usr/bin/env node
/**
 * The sandbox driver of the live-probe lane, with the oracle stage (corpus/LIVE-PROBE.md, "Oracles"):
 *
 *   node corpus/live-probe-driver.mjs --msc <mcp-surface-corpus checkout> --oracles <clients.json | none> -- <run-shard args>
 *
 * Runs mcp-surface-corpus's own driver (bin/run-shard.mjs, at the checkout the sandbox guard ran from) unchanged,
 * with one addition through its probe option: after the driver's stdio probe of a target (the subjects s001...,
 * the controls s901 and s902), corpus/oracles/run.mjs runs the oracle stage on that same `docker run` command, and
 * writes <out>/<target>/oracles.json. Per target it runs at most once in full (the SDK clients and the conformance
 * suite), on the first probe that got a tool list, and at most once with the clients only (oracles-unlisted.json), on
 * the first probe that got none. It never
 * throws into the driver, and its time is bounded: at most ORACLE_BUDGET_MS, and never past the target's own time
 * limit minus RESERVE_MS (kept for the driver's second probe and its analysis).
 *
 * Streamable HTTP targets are probed inside the sandbox by a helper container, not through this option: the oracle
 * stage does not run for them (oracles.json is then absent, and the bundle says so).
 *
 * With `--fuzz on` (default off; the plan decides, corpus/FUZZ.md) the fuzz stage runs after that, once per target,
 * after the first probe that got a tool list: read-only protocol sessions (corpus/fuzz/), written to <out>/<target>/fuzz.json.
 */
import { readFileSync, existsSync, mkdirSync, rmSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runOracles, writeOracles } from './oracles/run.mjs';
import { runFuzz, FUZZ_BUDGET_MS } from './fuzz/run.mjs';

export const ORACLE_BUDGET_MS = 150_000;
export const RESERVE_MS = 75_000;
export const MIN_BUDGET_MS = 20_000;
export const FUZZ_MIN_BUDGET_MS = 20_000;
/**
 * The sandbox driver's writableWork option (mcp-surface-corpus #17, R-ORC-15): each package kind's server (npm, PyPI, Go,
 * crates, NuGet, MCP bundles) gets a writable layer of its own per probe, an overlay over its read-only work volume at
 * /work and a /data tmpfs, removed after the probe. A server that writes into its own install or to /data then starts
 * instead of failing as start_env_limited. The work volume itself is never written, and a layer the sandbox cannot make
 * is recorded and the probe runs read-only, as before: that is our failure, never the server's. The sandbox's driver
 * refuses the option unless Docker's volumes are on the guard's capped filesystem, and this driver refuses a sandbox
 * that has no such option: either fails the shard as a harness error, never a subject.
 */
export const WRITABLE_WORK = true;
const TARGET_RE = /^s[0-9]{3}$/;
/** The driver's server container name: surface-<run>-<target>-s<n> (mcp-surface-corpus src/docker.mjs name()). */
const SERVER_NAME_RE = /^surface-[0-9a-f]{12}-(s[0-9]{3})-s[0-9]+$/;

export function parse(argv) {
  const o = { msc: null, oracles: 'none', fuzz: 'off', rest: [] };
  const i = argv.indexOf('--');
  const head = i < 0 ? argv : argv.slice(0, i);
  o.rest = i < 0 ? [] : argv.slice(i + 1);
  for (let k = 0; k < head.length; k += 2) {
    if (head[k] === '--msc') o.msc = head[k + 1];
    else if (head[k] === '--oracles') o.oracles = head[k + 1];
    else if (head[k] === '--fuzz') { if (!['on', 'off'].includes(head[k + 1])) throw new Error('--fuzz is on or off'); o.fuzz = head[k + 1]; }
    else throw new Error(`unknown option ${head[k]}`);
  }
  if (!o.msc || !o.oracles || !o.rest.length) throw new Error('usage: live-probe-driver.mjs --msc DIR --oracles FILE|none [--fuzz on|off] -- <run-shard args>');
  return o;
}

/** The target id of a probe command, from its container name, or null (the baseline, a helper). */
export function targetOf(command) {
  const i = Array.isArray(command) ? command.indexOf('--name') : -1;
  const m = i >= 0 ? SERVER_NAME_RE.exec(String(command[i + 1])) : null;
  return m ? m[1] : null;
}

/** Whether a probe got an answer from the server: an initialize result, or a 2026-07-28 server's refusal of it. */
export function answered(p) {
  return !!p && typeof p === 'object' && ((!!p.initialize && typeof p.initialize === 'object') || p.era === 'modern');
}

/** The value of one run-shard option. */
const optionOf = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

/**
 * The probe option: the driver's own probe, then the oracle stage, at most once in full and once with the clients
 * only per target. `starts` holds when each target started (the driver asks for its labels first thing), `limits`
 * each target's time limit in seconds.
 */
export function oracleProbe({ probe, listed, out, install, pins, starts, limits, run = runOracles, write = writeOracles, remove = removeQuietly, takeTrace, now = () => Date.now(), log = () => {} }) {
  const full = new Set(); const unlisted = new Set();
  return async (command, opts) => {
    const p = await probe(command, opts);
    const id = targetOf(command);
    if (!install || !id || full.has(id)) return p;
    const got = listed(p);
    if (!got && unlisted.has(id)) return p;
    const file = join(out, id, got ? 'oracles.json' : 'oracles-unlisted.json');
    // R-ORC-12: with no list, the clients run only on a server that answered (an initialize result, or the 2026-07-28
    // refusal of it): one that never started fails initialize for every client too, at about a minute an item. The skip
    // is recorded, and a later probe of the target (the env one) that gets an answer still runs them.
    if (!got && !answered(p)) {
      try { mkdirSync(join(out, id), { recursive: true }); write(file, { format: 'isokron-live-probe-oracles/1', mode: 'skipped', why: 'not_started', probe_listed: false }); } catch (e) { log(`${id}: oracle stage error: ${String(e && e.message).slice(0, 300)}`); }
      return p;
    }
    (got ? full : unlisted).add(id);
    try {
      const start = starts.get(id) ?? now();
      const limit = (limits.get(id) ?? 0) * 1000;
      const budget = Math.min(ORACLE_BUDGET_MS, start + limit - RESERVE_MS - now());
      mkdirSync(join(out, id), { recursive: true });
      if (budget < MIN_BUDGET_MS) { write(file, { format: 'isokron-live-probe-oracles/1', mode: 'skipped', why: 'time_budget', budget_ms: Math.max(0, Math.floor(budget)), probe_listed: got }); return p; }
      await remove(command, opts);
      const work = join(out, '_shard', 'oracle-work', id);
      // With no list from our probe, the clients only (each with a shorter limit): they show whether another client
      // gets a list where our probe did not.
      const rec = await run({ command, dockerEnv: opts && opts.env, install, pins: got ? pins : { ...pins, client_timeout_ms: Math.min(pins.client_timeout_ms, 15_000) }, budgetMs: budget, mode: got ? 'full' : 'clients_only', work, takeTrace });
      rec.probe_listed = got;
      write(file, rec);
      rmSync(work, { recursive: true, force: true });
    } catch (e) {
      log(`${id}: oracle stage error: ${String(e && e.message).slice(0, 300)}`);
      try { write(file, { format: 'isokron-live-probe-oracles/1', mode: 'error', error: String(e && e.message).slice(0, 300), probe_listed: got }); } catch { /* nothing more to do */ }
    }
    return p;
  };
}

/**
 * The fuzz stage's probe option: the inner probe (the driver's own, with the oracle stage), then, only when `enabled`,
 * the fuzz stage once per target, after the first probe that got a tool list. Same time rule as the oracle stage: it
 * never runs past the target's limit less RESERVE_MS, and a stage error never reaches the driver.
 */
export function fuzzProbe({ probe, listed, out, enabled, starts, limits, run = runFuzz, write = writeOracles, remove = removeQuietly, takeTrace, now = () => Date.now(), log = () => {} }) {
  const done = new Set();
  return async (command, opts) => {
    const p = await probe(command, opts);
    const id = targetOf(command);
    if (!enabled || !id || done.has(id) || !listed(p)) return p;
    done.add(id);
    const file = join(out, id, 'fuzz.json');
    try {
      const start = starts.get(id) ?? now();
      const limit = (limits.get(id) ?? 0) * 1000;
      const budget = Math.min(FUZZ_BUDGET_MS, start + limit - RESERVE_MS - now());
      mkdirSync(join(out, id), { recursive: true });
      if (budget < FUZZ_MIN_BUDGET_MS) { write(file, { format: 'isokron-live-probe-fuzz/1', mode: 'skipped', why: 'time_budget', budget_ms: Math.max(0, Math.floor(budget)) }); return p; }
      await remove(command, opts);
      write(file, await run({ command, dockerEnv: opts && opts.env, budgetMs: budget, takeTrace }));
    } catch (e) {
      log(`${id}: fuzz stage error: ${String(e && e.message).slice(0, 300)}`);
      try { write(file, { format: 'isokron-live-probe-fuzz/1', mode: 'error', error: String(e && e.message).slice(0, 300) }); } catch { /* nothing more to do */ }
    }
    return p;
  };
}

/** The probe's container is gone before the first oracle session takes its address. */
export async function removeQuietly(command, opts) {
  const i = command.indexOf('--name');
  if (i < 0) return;
  const { spawnSync } = await import('node:child_process');
  spawnSync('docker', ['rm', '-f', '-v', command[i + 1]], { env: (opts && opts.env) || process.env, stdio: 'ignore', timeout: 30_000 });
}

/**
 * mcp-check's own source reader for the sandbox's static step (corpus/static-read.cjs, R-LP-77): its files copied into
 * a fresh folder, which the sandbox driver puts in its read-only tools volume. Returns { dir, id }.
 */
export function readerBundle(base = tmpdir()) {
  const SR = createRequire(import.meta.url)('./static-read.cjs');
  const dir = mkdtempSync(join(base, 'isokron-reader-'));
  for (const [name, from] of SR.bundleFiles()) copyFileSync(from, join(dir, name));
  return { dir, id: SR.readerId(), entry: SR.SELF };
}

/** Each target's time limit in seconds, as the sandbox driver reads its list (its own default is 600 s). */
export function limitsOf(list) {
  const limits = new Map();
  const dflt = list && list.defaults && Number.isFinite(list.defaults.timeout_s) ? list.defaults.timeout_s : 600;
  for (const t of (list && list.targets) || []) if (TARGET_RE.test(t.id)) limits.set(t.id, Number.isFinite(t.timeout_s) ? t.timeout_s : dflt);
  return limits;
}

export async function main(argv = process.argv.slice(2)) {
  const o = parse(argv);
  const msc = resolve(o.msc);
  const load = (p) => import(pathToFileURL(join(msc, p)).href);
  const [{ main: runShard, writableWorkOption }, { probeStdio, listed }, { Docker }, { takeTrace }, { loadRunscConfig }] = await Promise.all([
    load('bin/run-shard.mjs'), load('sandbox/probe.mjs'), load('src/docker.mjs'), load('src/sandbox-run.mjs'), load('src/runsc.mjs'),
  ]);
  // An older sandbox ignores an option it does not know: the servers would run on the read-only volume while the lane
  // says they had a layer. Stop before any target instead (R-ORC-15).
  if (WRITABLE_WORK && typeof writableWorkOption !== 'function') throw new Error('the sandbox at SURFACE_CORPUS_REF has no writableWork option (mcp-surface-corpus #17): not running on a read-only volume unannounced');
  const out = resolve(optionOf(o.rest, '--out'));
  const targetsFile = optionOf(o.rest, '--targets');
  let limits = new Map();
  try { limits = limitsOf(JSON.parse(readFileSync(targetsFile, 'utf8'))); } catch { /* the driver itself refuses a bad list */ }
  let install = null;
  if (o.oracles !== 'none' && existsSync(o.oracles)) { try { install = JSON.parse(readFileSync(o.oracles, 'utf8')); } catch { install = null; } }
  const pins = JSON.parse(readFileSync(new URL('./oracles/pins.json', import.meta.url), 'utf8'));
  const starts = new Map();
  class TimedDocker extends Docker {
    labels(target = null) {
      if (target && !starts.has(target)) starts.set(target, Date.now());
      return super.labels(target);
    }
  }
  const cfg = loadRunscConfig();
  mkdirSync(join(out, '_shard'), { recursive: true });
  const trace = (cid) => takeTrace(cfg, cid, { waitMs: 3000 });
  const withOracles = oracleProbe({ probe: probeStdio, listed, out, install, pins, starts, limits, takeTrace: trace });
  const probe = o.fuzz === 'on' ? fuzzProbe({ probe: withOracles, listed, out, enabled: true, starts, limits, takeTrace: trace }) : withOracles;
  const reader = readerBundle();
  try { return await runShard(o.rest, { makeDocker: (x) => new TimedDocker(x), probe, runscConfig: cfg, reader, writableWork: WRITABLE_WORK }); } finally { rmSync(reader.dir, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((rc) => process.exit(rc), (e) => { process.stderr.write(`${e && e.stack}\n`); process.stdout.write('run finished, exit 125\n'); process.exit(1); });
}
