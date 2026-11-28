#!/usr/bin/env node
// The check of .github/workflows/live-probe-go-proof.yml (R-LP-91): after the sandbox ran the fixture shard, each Go
// subject must have been planned as `go install <package>@<full commit>`, built inside the sandbox (its install record
// ok), reached no host but the module proxy and the checksum database, and ended with an outcome whose fault side is
// ours (never the server's). What each subject ended with is printed.
//
//   node corpus/go-proof-check.mjs <live-probe work dir> <tool-qa-result dir>
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ALLOWED_HOSTS = Object.freeze(['proxy.golang.org', 'sum.golang.org', 'storage.googleapis.com']);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** One subject's verdict from the plan item, the driver record of its build, and its bundle's result. */
export function judge(item, rec, result) {
  const problems = []; const l = item.target && item.target.launch;
  if (!l || l.kind !== 'go') problems.push('not planned as a go install');
  else {
    if (!/^[0-9a-f]{40}$/.test(String(l.version))) problems.push('the version is not a full commit');
    if (item.target.commit !== l.version) problems.push('the target is not pinned to the commit it builds');
    if (/@latest\b/.test(JSON.stringify(l))) problems.push('latest');
  }
  const inst = rec && rec.install;
  if (!inst) problems.push('no install record: it did not build in the sandbox');
  else {
    if (inst.kind !== 'go') problems.push('the sandbox did not run a go install');
    if (inst.ok !== true) problems.push('the build did not succeed');
    const hosts = [...new Set((Array.isArray(inst.egress) ? inst.egress : []).map((e) => e && e.host).filter(Boolean))].sort();
    for (const h of hosts) if (!ALLOWED_HOSTS.includes(h)) problems.push('egress to ' + h);
    if ((inst.egress_refused || 0) > 0) problems.push(inst.egress_refused + ' egress attempt(s) refused by the proxy');
  }
  if (!result) problems.push('no bundle result');
  else if (result.status === 'skipped' && result.fault === 'subject') problems.push('a skip blamed on the server: ' + result.detail);
  return problems;
}

export function main(argv, out = (s) => process.stdout.write(s + '\n')) {
  const [work, tarDir] = argv;
  if (!work || !tarDir) { out('usage: node corpus/go-proof-check.mjs <work> <tool-qa-result dir>'); return 2; }
  const plan = readJson(join(work, 'plan.json'));
  if (!plan) { out('no plan.json'); return 1; }
  const results = new Map();
  for (const f of existsSync(tarDir) ? readdirSync(tarDir).filter((x) => x.endsWith('.tar')) : []) {
    try { const r = JSON.parse(execFileSync('tar', ['-xOf', join(tarDir, f), 'results/live-probe.json'], { maxBuffer: 16 * 1024 * 1024 }).toString('utf8')); results.set(r.subject, r); } catch { /* not a bundle of this shard */ }
  }
  let bad = 0;
  for (const item of plan.items) {
    const dir = join(work, 'driver-builds', item.target_id || 'none');
    const rec = readJson(join(dir, 'record.json'));
    const result = results.get(item.subject) || null;
    const problems = judge(item, rec, result);
    const inst = rec && rec.install;
    const probe = readJson(join(dir, 'probe-env.json')) || readJson(join(dir, 'probe-bare.json'));
    out(JSON.stringify({
      subject: item.subject, resolved: item.resolution && item.resolution.status, launch: item.target && item.target.launch,
      steps: inst && Array.isArray(inst.steps) ? inst.steps.map((s) => ({ name: s.name, exit: s.exit, ms: s.ms ?? s.duration_ms ?? null })) : null,
      egress_hosts: inst && Array.isArray(inst.egress) ? [...new Set(inst.egress.map((e) => e && e.host).filter(Boolean))].sort() : null,
      egress_refused: inst ? inst.egress_refused ?? null : null,
      probe: probe ? { exit: probe.exit ?? null, listed: !!(probe.lists && probe.lists['tools/list'] && probe.lists['tools/list'].ok), stderr_head: String(probe.stderr || '').slice(0, 300) } : null,
      status: result && result.status, detail: result && result.detail, skip_reason: result && result.skip_reason, fault: result && result.fault,
      problems,
    }));
    bad += problems.length;
  }
  out(bad ? bad + ' problem(s)' : 'every Go subject was planned at its commit, built in the sandbox with egress to the module proxy and checksum database only, and ended with an outcome that is not the server\'s fault');
  return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('go-proof-check.mjs')) process.exitCode = main(process.argv.slice(2));
