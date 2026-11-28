import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const wf = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.yml')).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

test('workflows: every third-party action pinned by full SHA; read-only default token; no pull_request_target', () => {
  assert.deepEqual(Object.keys(wf).sort(), ['ast-grep-validate.yml', 'bench-mutants.yml', 'ci.yml', 'corpus.yml', 'fuzz-calls.yml', 'live-probe-selftest.yml', 'live-probe.yml', 'mutation-probe.yml', 'reader-qa.yml', 'release.yml', 'scan-static.yml']);
  for (const [f, y] of Object.entries(wf)) {
    for (const m of y.replace(/^\s*#.*$/gm, '').matchAll(/uses:\s*(\S+)/g)) if (m[1] !== './') assert.match(m[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, f + ': ' + m[1]);
    // The loop workers grant nothing at the top; each of their jobs asks for contents: read.
    if (f === 'scan-static.yml' || f === 'ast-grep-validate.yml' || f === 'fuzz-calls.yml' || f === 'mutation-probe.yml' || /^live-probe/.test(f)) assert.match(y, /\npermissions: \{\}\n/, f + ': top-level permissions are {}');
    else assert.match(y, /\npermissions:\n  contents: read\n/, f + ': top-level permissions are contents: read');
    assert.ok(!/pull_request_target|workflow_run/.test(y.replace(/^#.*$/gm, '')), f);
    for (const m of y.matchAll(/persist-credentials:\s*(\S+)/g)) assert.equal(m[1], 'false', f);
  }
});

test('release: tag-triggered, npm publish only from the npm environment with OIDC and provenance; registry in its own job', () => {
  const y = wf['release.yml'];
  assert.match(y, /on:\n  push:\n    tags: \["v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"\]/);
  assert.match(y, /npm install -g npm@11\.21\.3 /, 'npm pinned exactly');
  assert.match(y, /git merge-base --is-ancestor "\$SHA" origin\/main/, 'the tagged commit must be on main');
  assert.match(y, /fetch-depth: 0/);
  const jobs = y.split(/\n  (?=[a-z-]+:\n    )/);
  const job = (n) => jobs.find((j) => j.startsWith(n + ':'));
  assert.match(job('publish'), /environment:\n      name: npm/);
  assert.match(job('publish'), /id-token: write/);
  assert.match(job('publish'), /npm publish --provenance --access public/);
  assert.ok(!/npm (ci|install)(?! -g npm@)/.test(job('publish')), 'nothing but npm itself is installed in the publish job');
  assert.match(job('publish'), /--ignore-scripts/);
  assert.match(job('publish'), /package-manager-cache: false/);
  assert.ok(!/environment:/.test(job('registry')), 'the registry job runs without the npm environment');
  assert.match(job('registry'), /mcp-publisher login github-oidc/);
  assert.match(job('registry'), /sha256sum -c/);
  assert.ok(!/id-token/.test(job('check')), 'the test job gets no OIDC token');
  assert.ok(!/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./.test(y), 'no stored npm token');
});

test('corpus: manual dispatch only, guarded to this repository and main, one secret in one step, hook required before decrypt', () => {
  const y = wf['corpus.yml'];
  assert.match(y, /\non:\n  workflow_dispatch:/);
  assert.ok(!/\n  (push|schedule|pull_request):/.test(y));
  assert.equal((y.match(/if: github\.repository == 'isokron-ai\/mcp-check' && github\.ref == 'refs\/heads\/main'/g) || []).length, 2);
  assert.equal((y.match(/secrets\./g) || []).length, 1);
  assert.match(y, /CORPUS_TARGETS_KEY: \$\{\{ secrets\.CORPUS_TARGETS_KEY \}\}\n        run: corpus\/decrypt-targets\.sh/);
  assert.ok(y.indexOf('--surface-only') < y.indexOf('Decrypt the target list'), 'the hook check comes before the decrypt step');
  assert.match(y, /environment: corpus/);
  assert.ok(!/tools\/call/.test(readFileSync(fileURLToPath(new URL('../corpus/run-surface-shard.sh', import.meta.url)), 'utf8')));
});

test('ci: the zero-config job runs the Action with no inputs, after a plain checkout, and is required by ci-ok', () => {
  const y = wf['ci.yml'];
  const job = y.slice(y.indexOf('\n  zero-config:\n'), y.indexOf('\n  ci-ok:'));
  assert.match(job, /- name: The zero-config workflow\n        id: zero\n        uses: \.\/\n      - name:/, 'uses: ./ with no with: block');
  assert.ok(!/setup-node|npm (ci|install)/.test(job), 'no setup-node or install, as in the documented workflow');
  assert.match(job, /\[ "\$SOURCE" = repo-static \]/);
  assert.match(y, /needs: \[test, action, zero-config, bench, mutants\]/);
  assert.match(y, /\[ "\$n" -eq 5 \]/);
});

test('R-BENCH-11: the bench gate and the mutant pass are required by ci-ok, and their steps are pinned', () => {
  const y = wf['ci.yml'];
  const bench = y.slice(y.indexOf('\n  bench:\n'), y.indexOf('\n  mutants:\n'));
  assert.match(bench, /run: node bench\/run\.mjs --json bench-score\.json --md bench-score\.md\n/);
  assert.match(bench, /run: node bench\/gate\.mjs --score bench-score\.json\n/);
  assert.ok(!/continue-on-error/.test(bench), 'no step of the bench job can be softened');
  assert.match(bench, /- name: The gate against bench\/baseline\.json\n {8}run: node bench\/gate\.mjs --score bench-score\.json\n/, 'the gate step is one plain command');
  const mut = y.slice(y.indexOf('\n  mutants:\n'), y.indexOf('\n  zero-config:\n'));
  assert.match(mut, /run: node bench\/mutate\.mjs --jobs 4 --json mutants\.json --md mutants\.md\n/);
  assert.match(mut, /grep -qE '\^\(src\/\|engine\/\|bench\/\)' changed\.txt/);
  assert.ok(!/continue-on-error/.test(mut));
  assert.ok(!/\$\{\{/.test(mut.split('run: |').slice(1).join('').replace(/\n {8}[A-Z_]+: \$\{\{[^}]*\}\}/g, '')), 'no expressions inside run scripts');
  assert.match(y.slice(y.indexOf('\n  ci-ok:\n')), /needs: \[test, action, zero-config, bench, mutants\]/);
  const w = wf['bench-mutants.yml'];
  assert.match(w, /schedule:/); assert.ok(!/pull_request/.test(w), 'pull requests run the pass in ci.yml');
  // the benchmark's synthetic package.json files are kept away from Dependabot
  assert.match(readFileSync(fileURLToPath(new URL('../.github/dependabot.yml', import.meta.url)), 'utf8'), /exclude-paths:\n\s+- "bench\/\*\*"/);
});

test('scan-static: dispatch only, the pump\'s three inputs, kill switch first, inputs checked whole, one pinned worker-kit step per item', () => {
  const y = wf['scan-static.yml'];
  const code = y.replace(/^\s*#.*$/gm, '');
  assert.match(y, /\non:\n  workflow_dispatch:\n    inputs:\n/);
  assert.ok(!/\n  (push|schedule|pull_request|workflow_call):/.test(y));
  assert.deepEqual([...y.matchAll(/^      ([a-z_]+):\n        description:/gm)].map((m) => m[1]), ['shard_id', 'attempt_id', 'items', 'tool_sha'], 'exactly the inputs tool-qa\'s pump sends (tool_sha only when it enforces a pin)');
  assert.match(y, /\nrun-name: shard \$\{\{ inputs\.shard_id \}\}\n/);
  assert.match(y, /\nconcurrency:\n  group: scan-static-/);
  assert.ok(!/secrets\./.test(code), 'no secrets');
  assert.ok(!/github\.event\./.test(code));
  // No input is expanded inside a run: script; they reach steps through env.
  for (const m of code.matchAll(/run: \|?\n?((?:.*\n)*?)(?=      - |\n?$)/g)) assert.ok(!/\$\{\{\s*inputs\./.test(m[1]), 'an input expanded in a run: script');
  const jobs = code.split(/\n  (?=[a-z-]+:\n    )/);
  const job = (n) => jobs.find((j) => j.startsWith(n + ':'));
  for (const n of ['guard', 'scan']) {
    assert.match(job(n), /\n    timeout-minutes: \d+\n/, n);
    assert.match(job(n), /\n    permissions:\n      contents: read\n(?!      )/, n);
  }
  assert.match(job('guard'), /if: github\.repository == 'isokron-ai\/mcp-check' && github\.ref == 'refs\/heads\/main'/);
  const guardSteps = job('guard').split('\n      - ');
  assert.match(guardSteps[1], /^id: enabled\n.*\n        env:\n          LOOP_ENABLED: \$\{\{ vars\.LOOP_ENABLED \}\}\n        run: \|\n          if \[\[ "\$LOOP_ENABLED" == "true" \]\]; then echo "on=true"/, 'the first step is the LOOP_ENABLED check');
  for (const s of guardSteps.slice(2)) assert.match(s, /if: steps\.enabled\.outputs\.on == 'true'/, 'later guard steps run only when the loop is on');
  assert.match(job('guard'), /LOOP_ENABLED: \$\{\{ vars\.LOOP_ENABLED \}\}\n(?:.*\n)*?        run: node corpus\/loop-guard\.mjs --lane scan-static/);
  assert.match(job('scan'), /needs: guard\n    if: needs\.guard\.outputs\.proceed == 'true'/);
  const steps = job('scan').split('\n      - ');
  assert.match(steps[1], /^name: Kill switch, again /, 'R-SS-06: the switches are checked again first');
  assert.match(steps[2], /^name: Check the inputs\n/, 'the inputs are checked before anything is checked out or read');
  assert.equal((steps[2].match(/\[\[ ! "\$[A-Z_]+" =~ \$[a-z_]+ \]\]/g) || []).length, 3, 'all three inputs, as whole strings');
  // The worker-kit: one step per item index 0..24, all at the same commit as WORKER_KIT_REF.
  const ref = /\n  WORKER_KIT_REF: '([0-9a-f]{40})'\n/.exec(y)[1];
  const kit = steps.filter((s) => /uses: isokron-ai\/tool-qa\/worker-kit@/.test(s));
  assert.equal(kit.length, 25);
  kit.forEach((s, i) => {
    assert.match(s, new RegExp('uses: isokron-ai/tool-qa/worker-kit@' + ref + '( #.*)?\\n'), 'item ' + i + ' names WORKER_KIT_REF');
    assert.match(s, new RegExp("steps\\.scan\\.outputs\\.has_" + i + " == 'true'"));
    // R-SS-02: gated on the controls, not on the scan step's success.
    assert.match(s, /if: \$\{\{ !cancelled\(\) && steps\.scan\.outputs\.controls_ok == 'true' && steps\.scan\.outputs\.controls_failed != 'true' && /);
    assert.ok(!/steps\.scan\.outcome/.test(s), 'item ' + i + ' does not need the scan step to succeed');
    assert.match(s, new RegExp("item-index: '" + i + "'\\n"));
    assert.match(s, new RegExp('fence: \\$\\{\\{ steps\\.scan\\.outputs\\.fence_' + i + ' \\}\\}'));
    assert.match(s, new RegExp('run-key: \\$\\{\\{ steps\\.scan\\.outputs\\.run_key_' + i + ' \\}\\}'));
    assert.match(s, new RegExp('/scan-static/' + i + '/bundle\\n'));
    assert.match(s, new RegExp('\\n {10}meta-file: \\$\\{\\{ runner\\.temp \\}\\}/scan-static/' + i + '/meta\\.json\\n'), 'R-SS-05: item ' + i + ' seals its own meta file');
  });
  const scanStep = steps.find((s) => s.startsWith('id: scan\n'));
  assert.match(scanStep, /\n        timeout-minutes: (\d+)\n/, 'R-SS-02: the scan step has its own limit');
  const stepLimit = Number(/\n        timeout-minutes: (\d+)\n/.exec(scanStep)[1]);
  const jobLimit = Number(/\n    timeout-minutes: (\d+)\n/.exec(job('scan'))[1]);
  assert.ok(stepLimit >= 34 && stepLimit <= jobLimit - 6, 'past the 32-minute budget and a last subject, and room left for the uploads');
});

test('R-SS-06: the scan job checks LOOP_ENABLED and the lane switch again, before anything else', () => {
  const y = wf['scan-static.yml'];
  const scan = y.split(/\n  (?=[a-z-]+:\n    )/).find((j) => j.startsWith('scan:'));
  const step = scan.split('\n      - ')[1];
  assert.match(step, /LOOP_ENABLED: \$\{\{ vars\.LOOP_ENABLED \}\}/);
  assert.match(step, /LANE_SCAN_STATIC_ENABLED: \$\{\{ vars\.LANE_SCAN_STATIC_ENABLED \}\}/);
  const script = /run: \|\n((?: {10}.*\n?)+)/.exec(step)[1].replace(/^ {10}/gm, '');
  const run = (env) => spawnSync('bash', ['-e', '-c', script], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.equal(run({ LOOP_ENABLED: 'true' }).status, 0, 'lane unset means on');
  assert.equal(run({ LOOP_ENABLED: 'true', LANE_SCAN_STATIC_ENABLED: 'true' }).status, 0);
  const off = run({ LOOP_ENABLED: 'false' });
  assert.equal(off.status, 1);
  assert.match(off.stdout, /LOOP_ENABLED was switched off/);
  assert.equal(run({}).status, 1);
  const lane = run({ LOOP_ENABLED: 'true', LANE_SCAN_STATIC_ENABLED: 'false' });
  assert.equal(lane.status, 1);
  assert.match(lane.stdout, /lane was switched off/);
});

test('R-SS-05: each of the 25 worker-kit steps seals the bundle and the meta file of its own item', () => {
  const steps = wf['scan-static.yml'].split('\n      - ').filter((s) => /uses: isokron-ai\/tool-qa\/worker-kit@/.test(s));
  assert.equal(steps.length, 25);
  steps.forEach((s, i) => {
    assert.match(s, new RegExp("item-index: '" + i + "'\\n"));
    assert.match(s, new RegExp('\\n {10}bundle-dir: \\$\\{\\{ runner\\.temp \\}\\}/scan-static/' + i + '/bundle\\n'));
    assert.match(s, new RegExp('\\n {10}meta-file: \\$\\{\\{ runner\\.temp \\}\\}/scan-static/' + i + '/meta\\.json\\n'));
  });
});

test('R-AG-09: scan-static installs ast-grep and turns the oracle on only when LANE_SCAN_STATIC_AST_GREP is exactly "true"; it is off by default', () => {
  const y = wf['scan-static.yml'];
  const code = y.replace(/^\s*#.*$/gm, '');
  const steps = code.split('\n      - ');
  const install = steps.find((s) => /^name: Install ast-grep/.test(s));
  assert.ok(install, 'an install step');
  assert.match(install, /\n        if: \$\{\{ vars\.LANE_SCAN_STATIC_AST_GREP == 'true' \}\}\n/);
  assert.match(install, /\n        working-directory: corpus\/ast-grep\n/);
  assert.match(install, /\n        run: npm ci --ignore-scripts --no-audit --no-fund\n/, 'from the lockfile, with no install scripts');
  const scanStep = steps.find((s) => s.startsWith('id: scan\n'));
  assert.match(scanStep, /\n          SCAN_STATIC_AST_GREP: \$\{\{ vars\.LANE_SCAN_STATIC_AST_GREP == 'true' && '1' \|\| '' \}\}\n/);
  assert.ok(steps.indexOf(install) < steps.indexOf(scanStep), 'installed before the scan');
  assert.ok(!/LANE_SCAN_STATIC_AST_GREP/.test(code.replace(/vars\.LANE_SCAN_STATIC_AST_GREP == 'true'/g, '')), 'the variable is read only as == "true"');
  assert.match(readFileSync(fileURLToPath(new URL('../corpus/scan-static.mjs', import.meta.url)), 'utf8'), /astGrep: env\.SCAN_STATIC_AST_GREP === '1'/);
});

test('R-AG-09: ast-grep-validate: dispatch only from main, public data only, no secret, the inputs checked whole and read through env', () => {
  const y = wf['ast-grep-validate.yml'];
  const code = y.replace(/^\s*#.*$/gm, '');
  assert.match(y, /\non:\n  workflow_dispatch:\n    inputs:\n/);
  assert.ok(!/\n  (push|schedule|pull_request|workflow_call):/.test(y));
  assert.deepEqual([...y.matchAll(/^      ([a-z_]+):\n        description:/gm)].map((m) => m[1]), ['targets', 'label']);
  assert.match(code, /if: github\.repository == 'isokron-ai\/mcp-check' && github\.ref == 'refs\/heads\/main'/);
  assert.ok(!/secrets\./.test(code) && !/github\.token|GITHUB_TOKEN/.test(code), 'no secret and no token');
  for (const m of code.matchAll(/run: \|?\n?((?:.*\n)*?)(?=      - |\n?$)/g)) assert.ok(!/\$\{\{\s*inputs\./.test(m[1]), 'an input expanded in a run: script');
  assert.match(code, /\n    permissions:\n      contents: read\n/);
  assert.match(code, /run: npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(code, /TARGETS: \$\{\{ inputs\.targets \}\}\n        run: node corpus\/ast-grep\/harness\.mjs run - /);
});
