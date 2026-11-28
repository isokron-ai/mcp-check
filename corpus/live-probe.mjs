#!/usr/bin/env node
// Loop worker of isokron-ai/tool-qa's live-probe lane (.github/workflows/live-probe.yml). For each dispatched subject (a
// public GitHub repository, owner/name) it works out how to install the server from its published package, then the
// sandbox of isokron-ai/mcp-surface-corpus installs and starts it, speaks MCP to it (initialize, tools/list,
// prompts/list, resources/list, resources/templates/list; no tool is ever called) and stops it. This script grades the
// live tool list with this repository's engine, the way `mcp-check -- <server>` grades a captured list, compares it
// with the list read from source when the sandbox read one, and writes one result bundle per item for tool-qa's
// worker kit. corpus/LIVE-PROBE.md describes the lane.
//
//   node corpus/live-probe.mjs plan <work> --msc <dir> [--seed <seed-v1.json>]
//        environment: SHARD_ID, ATTEMPT_ID, ITEMS. Checks the inputs whole, resolves each subject's install method
//        from the seed list and the official MCP Registry, writes <work>/plan.json and the sandbox's two target lists
//        (<work>/targets-controls.json, <work>/targets-subjects.json), and the step outputs has_<i>, fence_<i>,
//        run_key_<i> and subject_timeout_s.
//   node corpus/live-probe.mjs bundle <work>
//        after corpus/live-probe-sandbox.sh: checks the three controls, then writes <work>/out/<i>/bundle/ and
//        <work>/out/<i>/meta.json for every item.
//   node corpus/live-probe.mjs verify <tool-qa dir> <tar>...
//        the pull request self test: judges dry-run bundles with tool-qa's own manifest, forgery, field and secret
//        checks, and checks the fixture shard's expected outcomes.
//   node corpus/live-probe.mjs known-answer [<capture.json>]
//        prints corpus/fixtures/live-probe/known-answer.json as this code computes it from the saved capture.
//
// Exit codes: 0 done (whatever the subjects did); 1 malformed dispatch inputs (nothing is read); 2 usage; 3 a control
// did not give its expected outcome, or another harness error (nothing may be uploaded).
//
// Subject text (tool names, descriptions, schemas, server info, package names, host names a server looked up, install
// logs) goes under raw/ only. results/, controls/, observations/ and logs/ hold our own codes, counts, hashes and
// grades, and a subject's own strings only where a strict pattern shows they cannot carry an attempt identity.
import { X509Certificate, createHash, createVerify, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import M from '../src/engine.js';
import { InputError } from '../src/limits.js';
import { parseList } from '../src/tools.js';
import { analyseList } from '../src/unreadable.js';
import { usableList } from '../src/inputs/collect.js';
import { createRequire } from 'node:module';
import { gradeCandidate } from './scan-static.mjs';
import { VERSION } from '../src/version.js';
import { ranCommit } from './tool-commit.mjs';
import { baselineProblems, judgeOracles } from './oracles/judge.mjs';
import { pypiEntry } from './pypi-entry.mjs';
import { mcpbLaunch } from './mcpb.mjs';
import { goSource } from './go-entry.mjs';

export const LANE = 'live-probe';
export const FORMAT = 'isokron-mcp-check-live-probe/1';
export const CONTROL_FORMAT = 'isokron-mcp-check-live-probe-control/1';
export const PLAN_FORMAT = 'isokron-mcp-check-live-probe-plan/1';
export const STAGE = 'live';
export const RESULT_PATH = 'results/live-probe.json';
/** The pump's shard_size for live-probe (tool-qa pump/workflows.json); the workflow has one upload step per item. */
export const MAX_ITEMS = 10;
export const MAX_ITEMS_CHARS = 60000;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const SUBJECT_ID_RE = /^[^\s]{1,512}$/;
export const RUN_KEY_RE = /^[0-9a-f]{64}$/;
export const MARKER_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';
export const TARGETS_FORMAT = 'isokron-surface-targets/1';
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'live-probe');
export const KNOWN_ANSWER_FILE = join(FIXTURES, 'known-answer.json');
/** Our server's tools/list, captured as it answers (its docs links included): a test fixture, outside the link-tag scan. */
export const KNOWN_ANSWER_CAPTURE = join(here, '..', 'test', 'fixtures', 'live-probe', 'known-answer-tools.json');
export const FORGERY_SERVER = join(FIXTURES, 'forgery-server.js');
/** The oracle stage's pins (corpus/oracles/pins.json) and the expected oracle results of our own servers. */
export const ORACLE_PINS_FILE = join(here, 'oracles', 'pins.json');
export const ORACLE_BASELINE_FILE = join(FIXTURES, 'oracle-baseline.json');
/** Each target's time limit grows by this much for the oracle stage (corpus/live-probe-driver.mjs ORACLE_BUDGET_MS). */
export const ORACLE_ALLOWANCE_S = 150;
/** The fuzz stage's allowance per stdio target, only while the stage is on (corpus/FUZZ.md). */
export const FUZZ_ALLOWANCE_S = 60;
/** The self test's ceiling for one target's fuzz stage: the stage's own budget (corpus/fuzz/run.mjs FUZZ_BUDGET_MS). */
export const FUZZ_STAGE_MAX_MS = 60_000;

/**
 * The known-answer control: our own published server, @isokron/mcp-check 1.3.1, installed from npm and started in the
 * sandbox exactly as a subject is. Its live tool list is the one saved in test/fixtures/live-probe/known-answer-tools.json.
 */
export const KNOWN_ANSWER = Object.freeze({
  id: 's901', repo: 'isokron-ai/mcp-check', commit: '5e2668aed07efeb61beb2f3761bc3348af2075c3', registry: 'io.github.isokron-ai/mcp-check',
  launch: Object.freeze({ kind: 'npm', package: '@isokron/mcp-check', version: '1.3.1', install_scripts: true, args: Object.freeze(['serve']) }),
  timeout_s: 300,
});
/** The forgery control: corpus/fixtures/live-probe/forgery-server.js in the sandbox's own digest-pinned node image. */
export const FORGERY = Object.freeze({ id: 's902', repo: 'isokron-ai/mcp-check', commit: KNOWN_ANSWER.commit, timeout_s: 150 });
/** Item i runs as sandbox target s001, s002, ... (the sandbox's ids are never public beyond this). */
export const targetId = (i) => 's' + String(i + 1).padStart(3, '0');

/** Subjects: the sandbox's whole budget for them, and each one's limit within it. */
export const SUBJECT_BUDGET_S = 26 * 60;
/**
 * R-LP-55: a subject built in the sandbox (a crate) runs after the others, in a list of its own
 * (targets-builds.json), with this much more time than a subject: the sandbox's 15-minute build cap and its Rust
 * image's first pull. When a shard has one, the other subjects share this much less of SUBJECT_BUDGET_S, so the builds
 * still have time before the deadline.
 */
export const BUILD_ALLOWANCE_S = 17 * 60;
export const BUILD_RESERVE_S = 12 * 60;
/** R-LP-57: more time for a kind whose install image is large and pulled at its first subject (the .NET SDK image). */
export const PACKAGE_ALLOWANCE_S = Object.freeze({ nuget: 180, mcpb: 120 });
/** The launch kinds that build in the sandbox. */
export const isBuild = (launch) => !!(launch && (launch.kind === 'cargo' || launch.kind === 'go'));
export const SUBJECT_TIMEOUT_MIN_S = 90;
export const SUBJECT_TIMEOUT_MAX_S = 300;
export const PROBE_MS = 45_000;
/** A start that failed on its own account fails well inside the probe window; a later exit may be our limits (R-LP-34, R-LP-40). */
export const START_QUICK_MS = PROBE_MS / 2;
/** One raw file at most (tool-qa's limit is 8 MiB a file, 64 MiB a bundle). */
export const RAW_FILE_CAP = 6 * 1024 * 1024;
export const RAW_TOTAL_CAP = 40 * 1024 * 1024;
const REGISTRY_CAP = 4 * 1024 * 1024;

/**
 * Why an item has no live grade: our detail code, the tool-qa skip reason (worker-kit/contract.mjs SKIP_REASONS) it is
 * recorded with, whether it is retryable, the stage, and the fault side (SKIP_FAULTS: tool, subject, infra or policy).
 * results/ keeps the detail. R-LP-24..27: our own limits and errors have reasons of their own and fault "tool", never
 * policy_excluded (which reads as a deliberate exclusion, not a coverage gap) and never upstream_unavailable (which
 * reads as somebody else's outage). Only what the subject itself did (a failing install, a server that
 * will not start, one that needs credentials) is the subject's, and only a rate limit or an outage is infra.
 */
export const DETAILS = Object.freeze({
  bad_subject: ['no_runnable_artifact', false, 'resolve', 'tool'], // not a GitHub owner/name: this lane reads GitHub only
  no_package: ['no_runnable_artifact', false, 'resolve', 'tool'], // no registry package is no defect: Go and Rust binaries, other npm names and own-registry images exist (R-LP-43)
  unsupported_package: ['no_runnable_artifact', false, 'resolve', 'tool'], // a package type we cannot run
  private_registry: ['no_runnable_artifact', false, 'resolve', 'tool'],
  unverified_registry_entry: ['no_runnable_artifact', false, 'resolve', 'tool'], // our provenance checks stop short of it
  // Our allowlist of OCI hosts (it guards the planner's own fetches and what the runner's Docker daemon pulls, outside the
  // sandbox; it is not the sandbox's egress rule). A deliberate safety choice, but it is a limit of
  // ours, not a statement about the server: recorded as a gap of ours (tool), so it counts as unassessed and is not
  // hidden as an exclusion. no_runnable_artifact is the one reason that fits: there is no artifact we can run.
  oci_host_not_allowed: ['no_runnable_artifact', false, 'resolve', 'tool'],
  image_too_large: ['too_large', false, 'resolve', 'tool'], // over our 2 GB image cap
  launch_invalid: ['no_runnable_artifact', false, 'resolve', 'tool'], // the entry's package id failed our own name check
  remote_only: ['remote_only', false, 'resolve', 'subject'],
  unsupported_transport: ['unsupported_transport', false, 'resolve', 'tool'],
  // R-LP-29..38: a server is recorded as at fault (subject) only with evidence our own environment cannot explain.
  registry_lookup_truncated: ['no_runnable_artifact', false, 'resolve', 'tool'], // a registry search page came back full: the entry may not have been fetched
  image_unavailable: ['install_failed_registry', false, 'resolve', 'subject'], // the registry's own 404, 401 or 403 after a good token exchange, or a digest mismatch
  image_registry_unreadable: ['install_failed_registry', false, 'resolve', 'tool'], // we could not read the registry's answer (no challenge, bad realm, no token, bad JSON, no linux/amd64, no layers, bad sizes)
  image_pull_failed: ['install_failed_registry', false, 'install', 'tool'], // the run-stage pull failed on a digest the planner already read
  install_failed: ['install_failed_registry', false, 'install', 'subject'], // a package-level error (E404, ETARGET, no matching distribution, no bin), no proxy denial
  install_blocked: ['install_failed_registry', false, 'install', 'tool'], // our egress proxy refused something the install asked for
  install_resource_limit: ['install_failed_registry', false, 'install', 'tool'], // killed (137, 124, out of memory) inside our limits
  install_build_failed: ['install_failed_registry', false, 'install', 'tool'], // a native build, a missing compiler or library, an engine mismatch, or an install failure with no package-level cause
  install_timeout: ['install_failed_registry', false, 'install', 'tool'], // our install time limit
  // R-LP-56: the package declares nothing we could start, in the package manager's own words (cargo: "there is nothing to
  // install ... because it has no binaries"), never from text the package printed, and only for a package whose registry
  // entry is the subject's own (namespace); otherwise package_error_unowned.
  package_not_runnable: ['install_failed_registry', false, 'install', 'subject'],
  // R-LP-56: a package-level error (not in the registry, nothing to install) for a package whose registry entry is not
  // shown to be the subject's (a seed-only or seed-matched package, a repository-only match): we cannot say it is theirs.
  package_error_unowned: ['install_failed_registry', false, 'install', 'tool'],
  // R-LP-54: several binaries (or commands) and none named for the package: we would have to guess, so it is ours.
  entry_ambiguous: ['install_failed_registry', false, 'install', 'tool'],
  // R-LP-91: a Go repository with no registry package is built at its commit (corpus/go-entry.mjs). A repository with no
  // `package main` at its root or under cmd/ is a library: there is nothing to start (ours to report, nobody's defect). A
  // go.mod with a replace or exclude directive is one `go install <package>@<commit>` refuses; a tree GitHub would not
  // list whole, or a file we could not read, is our limit. None of them is the server's.
  no_main_package: ['no_runnable_artifact', false, 'resolve', 'tool'],
  go_install_refused: ['no_runnable_artifact', false, 'resolve', 'tool'],
  go_source_unreadable: ['no_runnable_artifact', false, 'resolve', 'tool'],
  // R-LP-57: the package has a build for other platforms only (a .NET tool for Windows runtimes): our platform, not a defect.
  platform_unsupported: ['no_runnable_artifact', false, 'install', 'tool'],
  // R-LP-72..74: MCP bundles (corpus/mcpb.mjs). Ours: a host we do not fetch from, a runtime or launcher we do not start
  // (a shell script, a uv project in a subfolder, a server type the spec does not name), an archive or manifest we do not
  // read (zip64, over 1 MiB), our size cap. The bundle's own: the release page's 404, bytes that are not the ones its
  // registry entry names (fileSha256), a file that is no zip archive or names a path outside itself, and (as
  // package_not_runnable) a manifest that names nothing to run or a file the bundle does not hold.
  bundle_host_not_allowed: ['no_runnable_artifact', false, 'resolve', 'tool'],
  bundle_runtime_unsupported: ['no_runnable_artifact', false, 'resolve', 'tool'],
  bundle_unreadable: ['install_failed_registry', false, 'resolve', 'tool'],
  bundle_too_large: ['too_large', false, 'resolve', 'tool'],
  bundle_unavailable: ['install_failed_registry', false, 'resolve', 'subject'],
  bundle_hash_mismatch: ['install_failed_registry', false, 'resolve', 'subject'],
  bundle_invalid: ['install_failed_registry', false, 'resolve', 'subject'],
  // R-LP-72: a failure that would be the bundle's own (above, or package_not_runnable), for a bundle whose registry entry
  // is not shown to be the subject's (a seed-only or seed-matched package): ours to report, never the subject's.
  bundle_unowned: ['install_failed_registry', false, 'resolve', 'tool'],
  // R-LP-89: the release host answered a 4xx that does not change (not 403, 408, 425, 429): ours, never retried.
  bundle_fetch_refused: ['tool_error', false, 'resolve', 'tool'],
  // R-LP-56: the install succeeded but our entry helper found nothing it may start (its name pattern, its regular-file or
  // record checks): ours, never the package's.
  entry_unresolved: ['install_failed_registry', false, 'install', 'tool'],
  needs_credentials: ['start_requires_credentials', false, 'start', 'subject'], // a declared required env var, and the server exited non-zero by itself with no network attempt
  start_needs_network: ['timeout_start', false, 'start', 'tool'], // the server tried the network, which the run does not have
  start_failed: ['timeout_start', false, 'start', 'subject'], // a crash signature on stderr (R-LP-45), and exited with its own non-zero code, early, with every argument filled
  start_needs_config: ['timeout_start', false, 'start', 'tool'], // the server exited with its own code and asked for configuration we did not give it (R-LP-44)
  start_env_limited: ['timeout_start', false, 'start', 'tool'], // a start failure our environment could have caused
  start_needs_extra: ['timeout_start', false, 'start', 'tool'], // a module only an extra of the package brings, which we did not install (R-LP-61)
  start_dependency_drift: ['timeout_start', false, 'start', 'tool'], // a dependency the release declares with no upper bound lacks what it imports: it changed after the release (R-LP-62)
  missing_own_module: ['timeout_start', false, 'start', 'subject'], // its wheel lacks a module of its own package (R-LP-68)
  undeclared_dependency: ['timeout_start', false, 'start', 'subject'], // its own code imports a module the release neither ships nor declares, not installed (R-LP-68)
  unsupported_platform: ['timeout_start', false, 'start', 'tool'], // the server runs on macOS or Windows only; our sandbox is Linux (R-LP-62)
  start_timeout: ['timeout_start', false, 'start', 'tool'],
  list_failed: ['timeout_start', false, 'list', 'subject'], // a JSON-RPC error the server sent, or a malformed result
  list_probe_limited: ['timeout_start', false, 'list', 'tool'], // our time limit, page cap or read cap, or an HTTP transport failure
  list_rejected: ['tool_error', false, 'grade', 'tool'], // our engine refused the list it was given
  rate_limited: ['rate_limited', true, 'resolve', 'infra'],
  upstream_error: ['upstream_unavailable', true, 'resolve', 'infra'], // 5xx, 408, a network failure or a cut read: tried again
  // R-LP-76: a registry's 4xx (other than 404, 408, 429 and a rate limit) is its answer to our request and comes back the
  // same on every retry: ours, not retried (a 2-character search is a 422).
  registry_query_refused: ['tool_error', false, 'resolve', 'tool'],
  // R-LP-76: the token service refused a pull token for the image (ghcr's 403 DENIED: a private or missing package). We
  // cannot tell private from gone, and the request is ours: not the subject's, not retried.
  image_access_denied: ['install_failed_registry', false, 'resolve', 'tool'],
  resolver_error: ['tool_error', false, 'resolve', 'tool'], // R-LP-76: an exception of ours in the resolver, never an outage
  // R-LP-75: a fallback only (buildItem records such a server as no_tools, with no skip): the server declared no tools
  // capability and answered tools/list "method not found", as the specification lets it. Never the subject's.
  no_tools_capability: ['no_tools_found', false, 'list', 'tool'],
  harness_error: ['tool_error', true, 'start', 'tool'], // our driver or bundle step failed; tried again, then accepted as a gap
  shard_deadline: ['upstream_unavailable', true, 'start', 'infra'],
  sandbox_evidence_missing: ['trace_unavailable', true, 'start', 'tool'],
  disk_low: ['upstream_unavailable', true, 'install', 'infra'], // the runner's disk
});

/** The fields this lane writes, with their types in mcp-results fields/registry.yaml (at tool-qa's pinned commit). */
export const FIELDS = Object.freeze({
  subject_id: 'string', registry_name: 'string', registry_version: 'string', registry_package_register_type: 'string',
  registry_package_identifier: 'string', registry_package_version: 'string', registry_package_transport: 'string',
  registry_package_runtime_hint: 'string', package_purl: 'string', oci_digest: 'hash', transports_offered: 'array',
  protocol_era: 'enum', protocol_negotiated: 'string', client_version: 'string', server_info: 'object',
  capabilities_flags: 'object', capabilities_jcs_sha256: 'hash', instructions_len_chars: 'integer', instructions_sha256: 'hash',
  startup_ms: 'integer', latency_cold_ms: 'number', startup_without_config: 'enum', config_state: 'enum',
  catalog_per_config_state: 'object', stdout_noise_lines: 'integer', stderr_counts: 'object', list_changed_notifications: 'integer',
  pagination_behaviour: 'object', step_telemetry: 'object', sandbox_tier: 'enum', runner_env: 'object', our_tool_versions: 'object',
  observation_coverage: 'object', install_phase_behaviour: 'object', network_event: 'object', error_taxonomy_code: 'enum',
  static_vs_live_agreement: 'object', commit_sha: 'string', commit_date: 'timestamp',
});
/**
 * PyPI launches name the extras that hold the server (`pkg[mcp]`, R-LP-66): on since SURFACE_CORPUS_REF pins a sandbox
 * whose target format takes `launch.extras` (mcp-surface-corpus R-SBX-49, in 4504c0b; an older one refuses the field).
 * R-LP-84: about 10 servers keep the MCP SDK in their `mcp` extra.
 */
export const EMIT_PYPI_EXTRAS = true;
/** Extras a release declares that hold an MCP server or its command line: installed with it, in this order. */
export const SERVER_EXTRAS = Object.freeze(['mcp', 'server', 'cli']);
export function serverExtras(deps) {
  const have = deps && Array.isArray(deps.extras) ? deps.extras : [];
  return SERVER_EXTRAS.filter((x) => have.includes(x));
}
/**
 * The oracle stage's fields (mcp-results registry, layer protocol and tool_telemetry): written only while
 * EMIT_ORACLE_FIELDS is on, which needs tool-qa's ingest to pin a registry that has them (INGEST_REF in the workflows).
 */
export const EMIT_ORACLE_FIELDS = true;
export const ORACLE_FIELDS = Object.freeze({
  oracle_stage: 'object', sdk_client_results: 'array', conformance_suite: 'object', conformance_summary: 'object',
  conformance_checks: 'array', oracle_disagreements: 'array',
});
/**
 * tool_count and tool_list_sha256 (mcp-results f2b16de) are written as fields of their own: tool-qa's ingest pins that
 * registry (tool-qa #14). Off, both values would travel only inside catalog_per_config_state.
 */
export const EMIT_TOOL_LIST_FIELDS = true;
export const TOOL_LIST_FIELDS = Object.freeze({ tool_count: 'integer', tool_list_sha256: 'hash' });
/**
 * R-LP-87: tool_names_sha256 (mcp-results R-RES-15, planned): written only while EMIT_TOOL_NAMES_FIELD is on, which
 * needs tool-qa's ingest to pin a registry that declares it (INGEST_REF; else the observation is an undeclared_field).
 */
export const EMIT_TOOL_NAMES_FIELD = false;
/**
 * R-LP-81: launch_retry (mcp-results, planned): the change a retry made to the plan's launch when its run is the item's
 * (mcp<2, a subcommand). Written only while EMIT_LAUNCH_RETRY_FIELD is on, once tool-qa's pinned registry declares it.
 */
export const EMIT_LAUNCH_RETRY_FIELD = false;
export const LAUNCH_RETRY_FIELDS = Object.freeze({ launch_retry: 'object' });
export const TOOL_NAMES_FIELDS = Object.freeze({ tool_names_sha256: 'hash' });
/**
 * The fuzz stage's fields (corpus/FUZZ.md): written only while EMIT_FUZZ_FIELDS is on, which needs the mcp-results
 * registry to hold them and tool-qa's ingest to pin that registry. list_determinism is already a planned field there
 * (boolean); fuzz_stage, invariant_results and unicode_identifier_findings are proposed.
 */
export const EMIT_FUZZ_FIELDS = false;
export const FUZZ_FIELDS = Object.freeze({ fuzz_stage: 'object', invariant_results: 'array', unicode_identifier_findings: 'array', list_determinism: 'boolean' });
const ENUM_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

/** What a run is configured with; its digest (with the sandbox commit) is the meta file's settings_manifest_digest. */
export const SETTINGS = Object.freeze({
  lane: LANE, format: FORMAT, subject_ref: 'default branch head (static layer); the registry package version (live)',
  install: 'npm, pypi or oci package from the official MCP Registry entry, else from the seed list; stdio or streamable HTTP',
  sandbox: 'isokron-ai/mcp-surface-corpus bin/run-shard.mjs, lane ci (gVisor, deny-by-default egress, DNS logger)',
  probe: 'initialize, tools/list, prompts/list, resources/list, resources/templates/list; no tool called; with no env, then dummy env',
  oracles: 'corpus/oracles/pins.json: official SDK clients (TypeScript 1.x and 2.x, Python, Go) list tools; the official conformance suite runs the read-only server scenarios of each frozen requirement set through the stdio bridge; no tool called',
  grading: 'parseList + analyseList of the live tools/list result, as mcp-check -- <server>',
  probe_ms: PROBE_MS, subject_budget_s: SUBJECT_BUDGET_S,
});

export class InputProblem extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export class ControlFailure extends Error {}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const json = (v) => JSON.stringify(v, null, 2) + '\n';
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const int = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);

export function isDateTime(s) {
  const m = typeof s === 'string' ? DATE_TIME_RE.exec(s) : null;
  if (!m) return false;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || se > 60) return false;
  return !Number.isNaN(Date.parse(s));
}

/** Canonical JSON (keys sorted), for hashes of subject objects. */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

// ------------------------------------------------------------------ subject text

/** The words ingest reads as an attempt identity (tool-qa ingest/forgery.mjs IDENTITY_ALIASES and TEXT_CLAIM_RE). */
export const IDENTITY_WORD_RE = /(attempt[\s_-]?id|run[\s_-]?key|fenc(?:e|ing))/i;
const PRINTABLE = /^[\x20-\x7e]{1,200}$/;

/**
 * A subject's string, kept outside raw/ only when it matches `re`, holds no identity word (ingest reads a claim only
 * next to one) and no quote, so it can never read as a claim about an attempt; else null (raw/ keeps the original).
 */
export function safeText(s, re = PRINTABLE) {
  return typeof s === 'string' && re.test(s) && !IDENTITY_WORD_RE.test(s) && !/["'\\`]/.test(s) ? s : null;
}
const SAFE_NAME = /^[A-Za-z0-9@][A-Za-z0-9@._/+ -]{0,199}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_HOST = /^[a-z0-9_][a-z0-9_.-]{0,252}$/;

// ------------------------------------------------------------------ inputs

/**
 * The dispatch inputs, checked whole. Throws InputProblem; its message never repeats the input. A subject the manifest
 * can name but that is not a GitHub owner/name gets repo null: its item reports a bad_subject skip.
 */
export function parseInputs({ shardId, attemptId, items }) {
  if (typeof shardId !== 'string' || !ID_RE.test(shardId)) throw new InputProblem('bad_shard_id', 'shard_id must be 1 to 128 letters, digits, ".", "_" or "-", starting with a letter or digit');
  if (typeof attemptId !== 'string' || !ID_RE.test(attemptId)) throw new InputProblem('bad_attempt_id', 'attempt_id must be 1 to 128 letters, digits, ".", "_" or "-", starting with a letter or digit');
  if (typeof items !== 'string' || items.length === 0 || items.length > MAX_ITEMS_CHARS) throw new InputProblem('bad_items', 'items must be 1 to ' + MAX_ITEMS_CHARS + ' characters of JSON');
  let list;
  try { list = JSON.parse(items); } catch { throw new InputProblem('bad_items', 'items is not JSON'); }
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ITEMS) throw new InputProblem('bad_items', 'items must be a JSON list of 1 to ' + MAX_ITEMS + ' entries');
  const seen = new Set();
  return {
    shardId, attemptId,
    items: list.map((x, i) => {
      if (!isObj(x)) throw new InputProblem('bad_item', 'items[' + i + '] is not an object');
      if (Object.keys(x).some((k) => !['subject', 'run_key', 'fence', 'sha'].includes(k))) throw new InputProblem('bad_item', 'items[' + i + '] has keys other than subject, run_key, fence and sha');
      if (typeof x.subject !== 'string' || !SUBJECT_ID_RE.test(x.subject) || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(x.subject)) throw new InputProblem('bad_subject', 'items[' + i + '].subject must be 1 to 512 characters with no space or control character');
      if (typeof x.run_key !== 'string' || !RUN_KEY_RE.test(x.run_key)) throw new InputProblem('bad_run_key', 'items[' + i + '].run_key must be 64 lower-case hex digits');
      if (!Number.isSafeInteger(x.fence) || x.fence < 1) throw new InputProblem('bad_fence', 'items[' + i + '].fence must be a positive whole number');
      // The commit to read (tool-qa R-SHA-01): the target is pinned to it instead of the branch head.
      if (x.sha !== undefined && (typeof x.sha !== 'string' || !/^[0-9a-f]{40}$/.test(x.sha))) throw new InputProblem('bad_sha', 'items[' + i + '].sha must be 40 lower-case hex digits');
      if (seen.has(x.run_key)) throw new InputProblem('duplicate_run_key', 'items[' + i + '] repeats the run_key of an earlier item');
      seen.add(x.run_key);
      const repo = SUBJECT_RE.test(x.subject) && !/\/\.\.?$/.test(x.subject) ? x.subject : null;
      return { index: i, subject: x.subject, repo, run_key: x.run_key, fence: x.fence, ...(x.sha ? { sha: x.sha } : {}) };
    }),
  };
}

// ------------------------------------------------------------------ resolving the install method

const fail = (detail, extra = {}) => Object.assign(new Error(detail), { detail }, extra);

/** The seed list (tool-qa history/seed-v1.json): lower-cased owner/name -> its packages [{registry, identifier}]. */
export function loadSeed(file) {
  const map = new Map();
  if (!file || !existsSync(file)) return map;
  let d;
  try { d = JSON.parse(readFileSync(file, 'utf8')); } catch { return map; }
  for (const s of Array.isArray(d && d.subjects) ? d.subjects : []) {
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.packages)) continue;
    map.set(s.id.toLowerCase(), s.packages.filter((p) => p && typeof p.registry === 'string' && typeof p.identifier === 'string').slice(0, 20));
  }
  return map;
}

/**
 * A fetch's failure as a detail code: rate_limited (429, or 403 with a rate limit); registry_query_refused for any other
 * 4xx but 403, 408 and 425 (the registry's answer to our request, the same on a retry: R-LP-76); else upstream_error
 * (5xx, 408, 425, and a 403 with no rate-limit headers, which a CDN or firewall in front of a registry may send for a
 * while: still tried again; the token service's own 403 is image_access_denied, below).
 */
export function httpDetail(status, header = () => null) {
  if (status === 429 || (status === 403 && (header('x-ratelimit-remaining') === '0' || header('retry-after') != null))) return 'rate_limited';
  if (Number.isInteger(status) && status >= 400 && status < 500 && ![403, 408, 425].includes(status)) return 'registry_query_refused';
  return 'upstream_error';
}

async function readCapped(res, cap) {
  const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
  if (len > cap) throw fail('upstream_error');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > cap) throw fail('upstream_error');
  return buf;
}

/** GET JSON from a fixed host. 404 gives null; any other failure throws a detail code. */
export async function getJson(fetchImpl, url, { headers = {}, timeoutMs = 20_000, cap = REGISTRY_CAP } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'isokron-mcp-check-live-probe', ...headers }, redirect: 'follow', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw fail('upstream_error'); }
  if (res.status === 404) return null;
  if (!res.ok) throw fail(httpDetail(res.status, (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null)), { status: res.status });
  try { return JSON.parse((await readCapped(res, cap)).toString('utf8')); } catch (e) { throw e && e.detail ? e : fail('upstream_error'); }
}

/** owner/name of a GitHub repository URL, lower case, or null. */
export function repoOfUrl(url) {
  const m = typeof url === 'string' ? /^(?:git\+)?(?:https?|git|ssh):\/\/(?:git@)?(?:www\.)?github\.com[/:]([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?(?:[#?].*)?$/i.exec(url.trim()) : null;
  return m ? (m[1] + '/' + m[2]).toLowerCase() : null;
}

/**
 * owner/name of a GitHub URL in package metadata, lower case, or null: a full URL (any path after the repository, as
 * in project_urls), git@github.com:owner/name, or npm's shorthand github:owner/name or owner/name.
 */
export function repoOfMetadataUrl(url) {
  if (typeof url !== 'string' || url.length > 500) return null;
  const u = url.trim();
  let m = /^(?:git\+)?(?:https?|git|ssh):\/\/(?:git@)?(?:www\.)?github\.com[/:]([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:[/#?].*)?$/i.exec(u)
    || /^git@github\.com:([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/i.exec(u)
    || /^(?:github:)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/.exec(u);
  return m ? (m[1] + '/' + m[2]).toLowerCase() : null;
}

// Installed packages first, then an image, then a package we build: a crate's build can take BUILD_CAP_S.
const TYPE_RANK = { npm: 0, pypi: 1, oci: 2, mcpb: 3, nuget: 4, cargo: 5 };
const TRANSPORT_RANK = { stdio: 0, 'streamable-http': 1 };
const DEFAULT_BASE = { npm: ['https://registry.npmjs.org', 'https://registry.npmjs.org/'], pypi: ['https://pypi.org', 'https://pypi.org/', 'https://pypi.org/simple', 'https://pypi.org/simple/'], cargo: ['https://crates.io', 'https://crates.io/', 'https://index.crates.io', 'https://index.crates.io/'], nuget: ['https://api.nuget.org/v3/index.json', 'https://api.nuget.org', 'https://api.nuget.org/', 'https://www.nuget.org', 'https://www.nuget.org/'] };
/** A NuGet package id and an exact NuGet version, as the sandbox checks them (mcp-surface-corpus src/targets.mjs). */
const NUGET_ID = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_])?$/;
const NUGET_VERSION = /^[0-9]+\.[0-9]+(?:\.[0-9]+){0,2}(?:-[0-9A-Za-z.-]{1,60})?(?:\+[0-9A-Za-z.-]{1,60})?$/;
/** A crate name as crates.io takes it, and the sandbox's own check (mcp-surface-corpus src/targets.mjs CRATE). */
const CRATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CRATE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{1,60})?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]{0,80}\/)?[a-z0-9][a-z0-9._~-]{0,120}$/;
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,120}[A-Za-z0-9])?$/;
const SEMVER = /^[0-9]+(?:\.[0-9A-Za-z-]+){0,3}(?:[-+.][0-9A-Za-z.+-]{1,60})?$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_ENV = /^(PATH|HOME|TMPDIR|LD_[A-Z_]+|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|PYTHON(PATH|HOME|STARTUP)|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_(FILE|DIR)|DOCKER_.*|GITHUB_.*|ACTIONS_.*|RUNNER_.*|SURFACE_.*|CORPUS_.*)$/i;
const ARG_RE = /^[^\u0000\n\r]{1,2000}$/;
const SUBDIR = /^(?![/.])(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+/-]{1,200}$/;
const REGISTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,120}\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** The OCI registries an image may come from, and the token services they send us to. No IP literal, no other host. */
export const OCI_HOSTS = Object.freeze(['docker.io', 'ghcr.io', 'quay.io', 'public.ecr.aws', 'mcr.microsoft.com', 'registry.gitlab.com']);
export const OCI_TOKEN_HOSTS = Object.freeze(['auth.docker.io', 'ghcr.io', 'quay.io', 'public.ecr.aws', 'mcr.microsoft.com', 'gitlab.com', 'registry.gitlab.com']);
/** An image whose layers (and config) add up to more than this is not pulled. */
export const OCI_MAX_BYTES = 2 * 1024 ** 3;

/** An OCI reference split into host, path, tag and digest; null when it is not one we can pull by digest. */
export function parseOciRef(id) {
  if (typeof id !== 'string' || id.length > 300 || /\s/.test(id)) return null;
  let rest = id; let digest = null;
  const at = rest.indexOf('@');
  if (at >= 0) { digest = rest.slice(at + 1); rest = rest.slice(0, at); if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return null; }
  let tag = null;
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) { tag = rest.slice(colon + 1); rest = rest.slice(0, colon); }
  const parts = rest.split('/');
  let host = 'docker.io';
  if (parts.length > 1 && (/[.:]/.test(parts[0]) || parts[0] === 'localhost')) host = parts.shift().toLowerCase();
  if (host === 'index.docker.io' || host === 'registry-1.docker.io') host = 'docker.io';
  let path = parts.join('/');
  if (host === 'docker.io' && !path.includes('/')) path = 'library/' + path;
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(host) || host === 'localhost') return null;
  if (!/^[a-z0-9][a-z0-9._/-]{0,199}$/.test(path) || /(^|\/)\.\.?(\/|$)|\/\/|\/$/.test(path)) return null;
  if (tag !== null && !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,119}$/.test(tag)) return null;
  return { host, path, tag: tag || 'latest', digest };
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const MANIFEST_CAP = 4 * 1024 * 1024;

/**
 * The digest an OCI reference points to and the size of its linux/amd64 image, from the registry's v2 API (anonymous:
 * the registry's own token service when it asks for one). Data only: no layer is fetched here. Only OCI_HOSTS, and token
 * services on OCI_TOKEN_HOSTS. Throws a detail code: oci_host_not_allowed, image_unavailable (the registry's own 404, a 401 or
 * 403 after a good token exchange, or a digest mismatch: the image's), image_registry_unreadable (anything else we could
 * not read: no Bearer challenge, a bad realm, no token, bad JSON, no linux/amd64 entry, no layers, bad sizes: ours), image_too_large,
 * rate_limited or upstream_error.
 */
export async function resolveOciImage(ref, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 20_000, maxBytes = OCI_MAX_BYTES } = {}) {
  if (!OCI_HOSTS.includes(ref.host)) throw fail('oci_host_not_allowed');
  const api = ref.host === 'docker.io' ? 'registry-1.docker.io' : ref.host;
  const urlFor = (reference) => 'https://' + api + '/v2/' + ref.path + '/manifests/' + encodeURIComponent(reference);
  const header = (res, k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
  let auth = null;
  const ask = async (url) => {
    try {
      return await fetchImpl(url, { method: 'GET', headers: { accept: MANIFEST_ACCEPT, 'user-agent': 'isokron-mcp-check-live-probe', ...(auth ? { authorization: auth } : {}) }, redirect: 'follow', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
    } catch { throw fail('upstream_error'); }
  };
  const manifest = async (reference) => {
    let res = await ask(urlFor(reference));
    if (res.status === 401 && !auth) {
      const m = /^Bearer\s+(.*)$/i.exec(String(header(res, 'www-authenticate') || ''));
      if (!m) throw fail('image_registry_unreadable');
      const params = {};
      for (const p of m[1].matchAll(/([a-z]+)="([^"]{0,500})"/gi)) params[p[1].toLowerCase()] = p[2];
      let realm;
      try { realm = new URL(params.realm); } catch { throw fail('image_registry_unreadable'); }
      if (realm.protocol !== 'https:' || realm.port !== '' || !OCI_TOKEN_HOSTS.includes(realm.hostname)) throw fail('oci_host_not_allowed');
      if (params.service) realm.searchParams.set('service', params.service);
      realm.searchParams.set('scope', 'repository:' + ref.path + ':pull');
      let tok;
      try { tok = await getJson(fetchImpl, realm.href, { timeoutMs, cap: 64 * 1024 }); } catch (e) {
        // R-LP-76: the token service's own 401 or 403 (ghcr's DENIED for a private or missing package) is its answer
        // about the image, the same on every retry; private and gone look alike, so it is ours (tool), never infra.
        if (e && (e.status === 401 || e.status === 403) && e.detail !== 'rate_limited') throw fail('image_access_denied', { status: e.status });
        throw e;
      }
      const token = tok && (typeof tok.token === 'string' ? tok.token : typeof tok.access_token === 'string' ? tok.access_token : null);
      if (!token || token.length > 16384) throw fail('image_registry_unreadable');
      auth = 'Bearer ' + token;
      res = await ask(urlFor(reference));
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      if (res.status === 403 && httpDetail(403, (k) => header(res, k)) === 'rate_limited') throw fail('rate_limited');
      // The registry's own refusal is the image's only when nothing of ours can explain it: a 404 is its answer for the
      // name, and a 401 or 403 counts only after a good token exchange (R-LP-36). Without one, it may be our request.
      throw fail(res.status === 404 || auth ? 'image_unavailable' : 'image_registry_unreadable', { status: res.status });
    }
    if (!res.ok) throw fail(httpDetail(res.status, (k) => header(res, k)), { status: res.status });
    const buf = await readCapped(res, MANIFEST_CAP);
    let doc;
    try { doc = JSON.parse(buf.toString('utf8')); } catch { throw fail('image_registry_unreadable'); }
    const digest = 'sha256:' + sha256(buf);
    return { doc, digest };
  };
  const top = await manifest(ref.digest || ref.tag);
  if (ref.digest && top.digest !== ref.digest) throw fail('image_unavailable');
  let image = top.doc;
  if (isObj(image) && Array.isArray(image.manifests)) {
    const pick = image.manifests.find((e) => isObj(e) && isObj(e.platform) && e.platform.os === 'linux' && e.platform.architecture === 'amd64' && typeof e.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(e.digest));
    if (!pick) throw fail('image_registry_unreadable');
    const sub = await manifest(pick.digest);
    if (sub.digest !== pick.digest) throw fail('image_unavailable');
    image = sub.doc;
  }
  if (!isObj(image) || !Array.isArray(image.layers) || !image.layers.length) throw fail('image_registry_unreadable');
  const sizes = [image.config && image.config.size, ...image.layers.map((l) => l && l.size)];
  if (!sizes.every((n) => Number.isSafeInteger(n) && n >= 0)) throw fail('image_registry_unreadable');
  const bytes = sizes.reduce((a, b) => a + b, 0);
  if (bytes > maxBytes) throw fail('image_too_large', { bytes });
  return { digest: top.digest, bytes };
}

// ------------------------------------------------------------------ provenance

export const SIGSTORE_CA_FILE = join(FIXTURES, 'sigstore-fulcio.json');
let sigstoreCas = null;
/** The pinned Fulcio certificate chains (intermediate first, root last), as X509Certificate lists. */
export function sigstoreChains(file = SIGSTORE_CA_FILE) {
  if (file === SIGSTORE_CA_FILE && sigstoreCas) return sigstoreCas;
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const chains = d.certificate_authorities.map((ca) => ca.chain.map((b) => new X509Certificate(Buffer.from(b, 'base64'))));
  if (file === SIGSTORE_CA_FILE) sigstoreCas = chains;
  return chains;
}

/** One DER element at `i` of `buf`: { tag, start, end, next } (content from start to end), or null. */
function derAt(buf, i, limit = buf.length) {
  if (i + 2 > limit) return null;
  const tag = buf[i];
  if ((tag & 0x1f) === 0x1f) return null; // multi-byte tags do not occur in X.509
  let len = buf[i + 1]; let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3 || i + 2 + n > limit) return null;
    len = 0;
    for (let k = 0; k < n; k++) len = len * 256 + buf[i + 2 + k];
    if (len < 0x80 || (n > 1 && buf[i + 2] === 0)) return null; // DER: shortest length form
    hdr += n;
  }
  const start = i + hdr; const end = start + len;
  return end <= limit ? { tag, start, end, next: end } : null;
}
/** The elements of a constructed DER value, in order; null when they do not exactly fill it. */
function derChildren(buf, el) {
  const out = [];
  for (let i = el.start; i < el.end;) { const c = derAt(buf, i, el.end); if (!c) return null; out.push(c); i = c.next; }
  return out;
}
/** A DER OBJECT IDENTIFIER's content as dotted text. */
function oidText(b) {
  if (!b.length) return null;
  const parts = [Math.min(2, Math.floor(b[0] / 40)), b[0] - 40 * Math.min(2, Math.floor(b[0] / 40))];
  let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0; } else if (v > 2 ** 40) return null; }
  return b[b.length - 1] & 0x80 ? null : parts.join('.');
}

/**
 * The extensions of an X.509 certificate, parsed from tbsCertificate.extensions: [{ oid, critical, value }], or
 * throws when the certificate is not well-formed DER or names an extension twice (RFC 5280 forbids it).
 */
export function certExtensions(der) {
  const cert = derAt(der, 0);
  if (!cert || cert.tag !== 0x30 || cert.end !== der.length) throw new Error('not a DER certificate');
  const top = derChildren(der, cert);
  if (!top || top.length !== 3 || top[0].tag !== 0x30) throw new Error('not a DER certificate');
  const tbs = derChildren(der, top[0]);
  if (!tbs) throw new Error('the tbsCertificate is not well-formed');
  const ext = tbs.find((e) => e.tag === 0xa3);
  if (!ext) return [];
  const wrapped = derChildren(der, ext);
  if (!wrapped || wrapped.length !== 1 || wrapped[0].tag !== 0x30) throw new Error('the extensions are not well-formed');
  const out = []; const seen = new Set();
  for (const e of derChildren(der, wrapped[0]) || (() => { throw new Error('the extensions are not well-formed'); })()) {
    const f = e.tag === 0x30 ? derChildren(der, e) : null;
    if (!f || f.length < 2 || f.length > 3 || f[0].tag !== 0x06) throw new Error('an extension is not well-formed');
    const oid = oidText(der.subarray(f[0].start, f[0].end));
    if (!oid) throw new Error('an extension OID is not well-formed');
    if (seen.has(oid)) throw new Error('the extension ' + oid + ' appears twice');
    seen.add(oid);
    let critical = false; let val = f[1];
    if (f.length === 3) { if (f[1].tag !== 0x01 || f[1].end - f[1].start !== 1) throw new Error('an extension is not well-formed'); critical = der[f[1].start] === 0xff; val = f[2]; }
    if (val.tag !== 0x04) throw new Error('an extension value is not an OCTET STRING');
    out.push({ oid, critical, value: der.subarray(val.start, val.end) });
  }
  return out;
}

/**
 * The value of one Fulcio certificate extension (OID 1.3.6.1.4.1.57264.1.<arc>) as text, or null when the certificate
 * does not have it: a DER UTF8String filling the value (arcs 8 and later) or raw text (arcs 1 to 7). Throws when the
 * certificate is malformed or has an extension twice (certExtensions).
 */
export function fulcioExtension(der, arc) {
  const hits = certExtensions(der).filter((e) => e.oid === '1.3.6.1.4.1.57264.1.' + arc);
  if (!hits.length) return null;
  const v = hits[0].value;
  if (arc < 8) return v.toString('utf8');
  const s = derAt(v, 0);
  if (!s || s.tag !== 0x0c || s.start === s.end || s.end !== v.length) return null;
  return v.subarray(s.start, s.end).toString('utf8');
}

/**
 * Reusable workflows trusted to sign for the repository that calls them (the Build Signer URI, Fulcio extension 9,
 * starts with one of these and names a release tag). With one of them the certificate's SAN names the reusable
 * workflow, not the subject; the Source Repository URI (extension 12) still names the subject. corpus/LIVE-PROBE.md.
 */
export const TRUSTED_REUSABLE_SIGNERS = Object.freeze([
  'https://github.com/slsa-framework/slsa-github-generator/.github/workflows/',
]);
/**
 * Who signed, given the certificate's SAN and Build Signer URI (extension 9), once its Source Repository URI is the
 * subject: 'repository_workflow' (a workflow of the subject itself), 'trusted_reusable_workflow' (an allowlisted
 * reusable workflow, which signs as itself), or null.
 */
export function signerKind({ san, buildSigner, repo }) {
  const want = 'https://github.com/' + repo.toLowerCase() + '/';
  if (String(san).toLowerCase().startsWith('uri:' + want)) return 'repository_workflow';
  if (trustedSigner(buildSigner) && san === 'URI:' + buildSigner) return 'trusted_reusable_workflow';
  return null;
}
const trustedSigner = (uri) => typeof uri === 'string' && TRUSTED_REUSABLE_SIGNERS.some((p) => uri.startsWith(p) && /^[A-Za-z0-9_.-]+\.ya?ml@refs\/tags\/v[0-9][0-9A-Za-z.-]*$/.test(uri.slice(p.length)));

/**
 * Checks one Sigstore-signed DSSE statement: the leaf certificate chains to the pinned Fulcio authority, it was issued
 * to a GitHub Actions workflow of `repo` (the OIDC issuer and Source Repository URI extensions, and the SAN), and the
 * envelope's signature over the statement verifies with it. Returns null when all hold, else the first reason.
 * Not checked here: the transparency log (Rekor) entry and that the signing time fell inside the certificate's
 * ten-minute validity; the registry checked those when it accepted the attestation, and serves it.
 */
export function sigstoreProblem({ certDer, payloadType, body, signature, repo, chains = sigstoreChains(), info = {} }) {
  let leaf;
  try { leaf = new X509Certificate(certDer); certExtensions(certDer); } catch { return 'certificate_unreadable'; }
  const chain = chains.find((c) => c.length && leaf.checkIssued(c[0]) && leaf.verify(c[0].publicKey) && c.every((x, k) => (k + 1 < c.length ? x.checkIssued(c[k + 1]) && x.verify(c[k + 1].publicKey) : x.verify(x.publicKey))));
  if (!chain) return 'certificate_not_from_fulcio';
  const issuer = fulcioExtension(certDer, 8) || fulcioExtension(certDer, 1);
  if (issuer !== 'https://token.actions.githubusercontent.com') return 'not_github_actions';
  const want = 'https://github.com/' + repo.toLowerCase();
  const source = fulcioExtension(certDer, 12);
  if (!source || source.toLowerCase() !== want) return 'certificate_other_repository';
  const signer = signerKind({ san: String(leaf.subjectAltName || ''), buildSigner: fulcioExtension(certDer, 9), repo });
  if (!signer) return 'certificate_other_repository';
  info.signer = signer;
  const pae = Buffer.concat([Buffer.from('DSSEv1 ' + Buffer.byteLength(payloadType) + ' ' + payloadType + ' ' + body.length + ' '), body]);
  try { if (!createVerify('sha256').update(pae).verify(leaf.publicKey, signature)) return 'signature_invalid'; } catch { return 'signature_invalid'; }
  return null;
}

/**
 * npm: the build provenance the registry serves for this version (dist.attestations, SLSA v1 in a Sigstore bundle).
 * Its statement must name this package and version with the tarball's own sha512 (dist.integrity), its signed
 * workflow repository must be the subject, and sigstoreProblem must pass for the subject. package.json fields
 * (repository, homepage, bugs) are the publisher's own words and count for nothing. Returns null or a reason.
 */
export async function npmProvenanceProblem(id, version, subject, { fetch: fetchImpl = globalThis.fetch, chains, info = {} } = {}) {
  const v = await getJson(fetchImpl, 'https://registry.npmjs.org/' + id.replace('/', '%2f') + '/' + (version && version !== 'latest' ? encodeURIComponent(version) : 'latest'));
  if (!isObj(v) || !isObj(v.dist)) return 'package_missing';
  const m = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(String(v.dist.integrity || ''));
  if (!m) return 'no_integrity';
  const tarSha512 = Buffer.from(m[1], 'base64').toString('hex');
  const url = isObj(v.dist.attestations) && typeof v.dist.attestations.url === 'string' ? v.dist.attestations.url : null;
  if (!url || !url.startsWith('https://registry.npmjs.org/-/npm/v1/attestations/')) return 'no_provenance';
  const att = await getJson(fetchImpl, url);
  const prov = (isObj(att) && Array.isArray(att.attestations) ? att.attestations : []).find((x) => isObj(x) && x.predicateType === 'https://slsa.dev/provenance/v1' && isObj(x.bundle));
  if (!prov) return 'no_provenance';
  const env = prov.bundle.dsseEnvelope; const vm = prov.bundle.verificationMaterial;
  const certB64 = isObj(vm) && isObj(vm.certificate) ? vm.certificate.rawBytes : isObj(vm) && isObj(vm.x509CertificateChain) && Array.isArray(vm.x509CertificateChain.certificates) && isObj(vm.x509CertificateChain.certificates[0]) ? vm.x509CertificateChain.certificates[0].rawBytes : null;
  if (!isObj(env) || typeof env.payload !== 'string' || env.payloadType !== 'application/vnd.in-toto+json' || !Array.isArray(env.signatures) || !env.signatures[0] || typeof certB64 !== 'string') return 'provenance_unreadable';
  const body = Buffer.from(env.payload, 'base64');
  let st; try { st = JSON.parse(body.toString('utf8')); } catch { return 'provenance_unreadable'; }
  const purl = 'pkg:npm/' + String(v.name || id).replace(/^@/, '%40') + '@' + String(v.version);
  if (!(Array.isArray(st.subject) && st.subject.some((x) => isObj(x) && x.name === purl && isObj(x.digest) && x.digest.sha512 === tarSha512))) return 'provenance_other_artifact';
  const wf = st.predicate && st.predicate.buildDefinition && st.predicate.buildDefinition.externalParameters && st.predicate.buildDefinition.externalParameters.workflow;
  if (!isObj(wf) || String(wf.repository || '').toLowerCase() !== 'https://github.com/' + subject.toLowerCase()) return 'provenance_other_repository';
  const p = sigstoreProblem({ certDer: Buffer.from(certB64, 'base64'), payloadType: env.payloadType, body, signature: Buffer.from(env.signatures[0].sig, 'base64'), repo: subject, info, ...(chains ? { chains } : {}) });
  // The version that was checked: the install is pinned to it, so a moving "latest" cannot swap the package.
  if (!p) { if (typeof v.version !== 'string' || !SEMVER.test(v.version)) return 'provenance_other_artifact'; info.version = v.version; }
  return p;
}

/**
 * PyPI: a PEP 740 attestation from PyPI's integrity API for a file of this release, published by a GitHub Trusted
 * Publisher whose repository is the subject. The statement must name the file with its sha256 as PyPI lists it, and
 * sigstoreProblem must pass for the subject. project_urls and the home page count for nothing. Returns null or a reason.
 */
export async function pypiProvenanceProblem(id, version, subject, { fetch: fetchImpl = globalThis.fetch, chains, info = {} } = {}) {
  const rel = await getJson(fetchImpl, 'https://pypi.org/pypi/' + encodeURIComponent(id) + '/' + (version && version !== 'latest' ? encodeURIComponent(version) + '/' : '') + 'json');
  if (!isObj(rel) || !isObj(rel.info) || !Array.isArray(rel.urls)) return 'package_missing';
  const ver = String(rel.info.version || '');
  if (!SEMVER.test(ver) || (version && version !== 'latest' && ver !== version)) return 'provenance_other_artifact';
  const files = rel.urls.filter((u) => isObj(u) && typeof u.filename === 'string' && /^[A-Za-z0-9._+-]{1,200}$/.test(u.filename) && isObj(u.digests) && /^[0-9a-f]{64}$/.test(String(u.digests.sha256))).sort((x, y) => (x.packagetype === 'bdist_wheel' ? 0 : 1) - (y.packagetype === 'bdist_wheel' ? 0 : 1)).slice(0, 3);
  if (!files.length) return 'package_missing';
  let why = 'no_provenance';
  for (const f of files) {
    const d = await getJson(fetchImpl, 'https://pypi.org/integrity/' + encodeURIComponent(id) + '/' + encodeURIComponent(ver) + '/' + encodeURIComponent(f.filename) + '/provenance');
    for (const b of isObj(d) && Array.isArray(d.attestation_bundles) ? d.attestation_bundles : []) {
      const pub = isObj(b) && isObj(b.publisher) ? b.publisher : null;
      if (!pub || pub.kind !== 'GitHub' || String(pub.repository || '').toLowerCase() !== subject.toLowerCase()) { why = 'provenance_other_repository'; continue; }
      for (const a of Array.isArray(b.attestations) ? b.attestations : []) {
        if (!isObj(a) || !isObj(a.envelope) || !isObj(a.verification_material) || typeof a.envelope.statement !== 'string' || typeof a.envelope.signature !== 'string' || typeof a.verification_material.certificate !== 'string') { why = 'provenance_unreadable'; continue; }
        const body = Buffer.from(a.envelope.statement, 'base64');
        let st; try { st = JSON.parse(body.toString('utf8')); } catch { why = 'provenance_unreadable'; continue; }
        if (!(Array.isArray(st.subject) && st.subject.some((x) => isObj(x) && x.name === f.filename && isObj(x.digest) && x.digest.sha256 === f.digests.sha256))) { why = 'provenance_other_artifact'; continue; }
        const p = sigstoreProblem({ certDer: Buffer.from(a.verification_material.certificate, 'base64'), payloadType: 'application/vnd.in-toto+json', body, signature: Buffer.from(a.envelope.signature, 'base64'), repo: subject, info, ...(chains ? { chains } : {}) });
        if (!p) { info.version = ver; return null; }
        why = p;
      }
    }
  }
  return why;
}

/**
 * How a package that came with a repository-only registry match is tied to the subject: 'npm_provenance',
 * 'pypi_provenance' or 'ghcr_owner', or null with the reason in `out.why`. Only what a registry vouches for counts:
 * signed build provenance it serves, or the owner of the ghcr.io namespace. A missing package or attestation is no; a
 * registry that fails throws upstream_error or rate_limited.
 */
export async function packageVerifiedBy(pkg, subject, { fetch: fetchImpl = globalThis.fetch, chains, out = {} } = {}) {
  const type = String(pkg.registryType || pkg.registry || '').toLowerCase();
  const id = typeof pkg.identifier === 'string' ? pkg.identifier.trim() : '';
  const version = typeof pkg.version === 'string' && SEMVER.test(pkg.version) ? pkg.version : null;
  if (type === 'npm' && NPM_NAME.test(id)) { out.why = await npmProvenanceProblem(id, version, subject, { fetch: fetchImpl, chains, info: out }); return out.why ? null : 'npm_provenance'; }
  if (type === 'pypi' && PYPI_NAME.test(id)) { out.why = await pypiProvenanceProblem(id, version, subject, { fetch: fetchImpl, chains, info: out }); return out.why ? null : 'pypi_provenance'; }
  if (type === 'oci') {
    const ref = parseOciRef(id);
    if (ref && ref.host === 'ghcr.io' && ref.path.split('/')[0] === subject.toLowerCase().split('/')[0]) return 'ghcr_owner';
    out.why = 'image_other_owner'; return null;
  }
  out.why = 'unsupported_package'; return null;
}

/** A value that stands for one the user fills in: `{name}` (also with `-` or `.`), `$NAME`, `${NAME}`, `<your-key>`. */
export const PLACEHOLDER = /\{[A-Za-z0-9_.-]{1,80}\}|\$\{?[A-Za-z_][A-Za-z0-9_]{0,80}\}?|<[^<>\n]{1,80}>/;

/** Arguments from a registry package's packageArguments: values and defaults only, never a value we would invent. */
export function packageArgs(list) {
  const args = []; let unfilled = 0;
  for (const a of Array.isArray(list) ? list.slice(0, 40) : []) {
    if (!isObj(a)) continue;
    const v = typeof a.value === 'string' ? a.value : typeof a.default === 'string' ? a.default : null;
    const usable = v !== null && ARG_RE.test(v) && !/\{[A-Za-z0-9_]+\}/.test(v);
    if (a.type === 'named') {
      if (typeof a.name !== 'string' || !/^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]{0,80}(=)?$/.test(a.name)) { if (a.isRequired) unfilled++; continue; }
      if (usable) { if (a.name.endsWith('=')) args.push(a.name + v); else args.push(a.name, v); } else if (a.isRequired) unfilled++;
    } else if (usable) args.push(v);
    else if (a.isRequired) unfilled++;
  }
  return { args: args.slice(0, 40), unfilled };
}

/**
 * Env a registry package declares: a required name gets its declared default, else a dummy value in the sandbox (null);
 * an optional name gets its declared default and nothing else (R-LP-80: an image whose own default is HTTP declares
 * `MCP_TRANSPORT` optional with default `stdio`, which a client applies). Never a value we invent: no default, a
 * secret's default, or a placeholder (`{name}`, `{data-dir}`, `$HOME`, `${HOME}`, `<your-key>`) leaves an optional name
 * out (PLACEHOLDER).
 */
export function packageEnv(list) {
  const env = {}; const names = [];
  for (const e of Array.isArray(list) ? list.slice(0, 100) : []) {
    if (!isObj(e) || typeof e.name !== 'string' || !ENV_NAME.test(e.name) || RESERVED_ENV.test(e.name)) continue;
    names.push(e.name);
    const d = typeof e.default === 'string' && e.default.length <= 500 && !/[\u0000\n\r]/.test(e.default) && !e.isSecret ? e.default : null;
    if (!e.isRequired && (d === null || PLACEHOLDER.test(d))) continue;
    if (Object.keys(env).length < 60) env[e.name] = d;
  }
  return { env, names: names.slice(0, 100) };
}

/**
 * The transport block for the sandbox target list, or { detail: 'unsupported_transport', why } (R-LP-86). A streamable
 * HTTP URL may name the package's own variables (`http://localhost:{port}/mcp`): each is filled from `vars`, the
 * declared defaults and values of its env names and arguments, never a value we invent. why: sse (the legacy transport,
 * which the sandbox's probe does not speak), other (another type), no_url, url_variable (a variable nothing declares),
 * not_local (a host that is not the server's own loopback), no_port or port_range (none, or one under 1024).
 */
export function transportOf(t, vars = {}) {
  const type = isObj(t) && typeof t.type === 'string' ? t.type : 'stdio';
  if (type === 'stdio') return { transport: 'stdio' };
  if (type === 'sse') return { detail: 'unsupported_transport', why: 'sse' };
  if (type !== 'streamable-http') return { detail: 'unsupported_transport', why: 'other' };
  const raw = typeof t.url === 'string' ? t.url.slice(0, 300) : '';
  if (!raw) return { detail: 'unsupported_transport', why: 'no_url' };
  let unknown = false;
  const url = raw.replace(/\{([A-Za-z_][A-Za-z0-9_-]{0,80})\}/g, (all, n) => {
    const v = Object.prototype.hasOwnProperty.call(vars, n) ? vars[n] : null;
    if (typeof v === 'string' && /^[A-Za-z0-9._~-]{1,100}$/.test(v)) return v;
    unknown = true; return all;
  });
  if (unknown) return { detail: 'unsupported_transport', why: 'url_variable' };
  const m = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\])(?::([0-9]{2,5}))?(\/[A-Za-z0-9._~/-]{0,200})?$/.exec(url);
  if (!m) return { detail: 'unsupported_transport', why: 'not_local' };
  const port = m[1] ? Number(m[1]) : null;
  if (!port) return { detail: 'unsupported_transport', why: 'no_port' };
  if (port < 1024 || port > 65535) return { detail: 'unsupported_transport', why: 'port_range' };
  return { transport: 'http', http: { port, path: m[2] || '/mcp' } };
}

/**
 * The variables a transport URL may name: a package's declared env names, each with the default packageEnv passes to
 * the server, and its named arguments (`--port` is `port`) with the value or default packageArgs passes; nothing else.
 */
export function transportVars(pkg) {
  const vars = {};
  const put = (n, v) => { if (typeof n === 'string' && typeof v === 'string' && !Object.prototype.hasOwnProperty.call(vars, n)) vars[n] = v; };
  // An env name's declared default, as packageEnv passes it to the server (never a value it would not pass).
  for (const e of Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables.slice(0, 100) : []) if (isObj(e) && !e.isSecret) put(e.name, e.default);
  for (const a of Array.isArray(pkg.packageArguments) ? pkg.packageArguments.slice(0, 40) : []) {
    if (!isObj(a)) continue;
    const v = typeof a.value === 'string' ? a.value : a.default;
    if (a.type === 'named' && typeof a.name === 'string') put(a.name.replace(/^-{1,2}|=$/g, ''), v);
    if (typeof a.valueHint === 'string') put(a.valueHint, v);
  }
  return vars;
}

/** A package URL for the chosen package (purl spec), or null. */
export function purlOf(type, id, version) {
  const v = typeof version === 'string' && version && version !== 'latest' ? '@' + encodeURIComponent(version) : '';
  if (type === 'npm') return 'pkg:npm/' + id.split('/').map(encodeURIComponent).join('/') + v;
  if (type === 'pypi') return 'pkg:pypi/' + encodeURIComponent(id.toLowerCase().replace(/[-_.]+/g, '-')) + v;
  if (type === 'cargo') return 'pkg:cargo/' + encodeURIComponent(id) + v;
  if (type === 'golang') return 'pkg:golang/' + id.split('/').map(encodeURIComponent).join('/') + v;
  if (type === 'nuget') return 'pkg:nuget/' + encodeURIComponent(id) + v;
  return null;
}

/**
 * The sandbox launch block for one package of a registry entry (or of the seed list, when the registry has no entry),
 * or { detail } saying why it cannot run here.
 */
export async function launchFor(pkg, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const type = String(pkg.registryType || pkg.registry || '').toLowerCase();
  const id = typeof pkg.identifier === 'string' ? pkg.identifier.trim() : '';
  if (!['npm', 'pypi', 'oci', 'cargo', 'nuget', 'mcpb'].includes(type)) return { detail: 'unsupported_package' };
  const base = typeof pkg.registryBaseUrl === 'string' ? pkg.registryBaseUrl : null;
  if (base && type !== 'oci' && type !== 'mcpb' && !DEFAULT_BASE[type].includes(base)) return { detail: 'private_registry' };
  const tr = transportOf(pkg.transport, transportVars(pkg));
  if (tr.detail) return tr;
  const { args, unfilled } = packageArgs(pkg.packageArguments);
  const { env, names } = packageEnv(pkg.environmentVariables);
  const version = typeof pkg.version === 'string' && SEMVER.test(pkg.version) ? pkg.version : 'latest';
  const common = { ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}), ...(tr.transport === 'http' ? { transport: 'http', http: tr.http } : {}) };
  const choice = { type, identifier: id, version, transport: tr.transport, runtime_hint: typeof pkg.runtimeHint === 'string' ? pkg.runtimeHint : null, args_n: args.length, args_unfilled: unfilled, env_names: names, oci_digest: null, purl: null };
  if (type === 'npm') {
    if (!NPM_NAME.test(id)) return { detail: 'launch_invalid' };
    choice.purl = purlOf('npm', id, version);
    // Install scripts run (native modules are built where they can be): the install is in the sandbox under gVisor,
    // its egress only through the allowlist proxy, its syscalls traced, and what it asked the proxy for is recorded.
    return { launch: { kind: 'npm', package: id, version, install_scripts: true, ...common }, choice };
  }
  if (type === 'pypi') {
    if (!PYPI_NAME.test(id)) return { detail: 'launch_invalid' };
    choice.purl = purlOf('pypi', id, version);
    return { launch: { kind: 'pypi', package: id, version, ...common }, choice };
  }
  if (type === 'cargo') {
    // R-LP-54: built in the sandbox (mcp-surface-corpus launchPlan, kind cargo: `cargo install --locked` in its pinned
    // Rust image, crates.io only, at most 15 minutes), so it runs after the other subjects with a time limit of its own.
    if (!CRATE_NAME.test(id)) return { detail: 'launch_invalid' };
    const v = version === 'latest' || CRATE_VERSION.test(version) ? version : 'latest';
    choice.version = v; choice.purl = purlOf('cargo', id, v);
    return { launch: { kind: 'cargo', crate: id, version: v, ...common }, choice };
  }
  if (type === 'mcpb') {
    // R-LP-72: the bundle is read here as data (corpus/mcpb.mjs) and unpacked in the sandbox (mcp-surface-corpus launchPlan,
    // kind mcpb) from exactly the bytes read, its sha256 pinned; it runs in the image its runtime needs.
    if (tr.transport !== 'stdio') return { detail: 'unsupported_transport', why: 'mcpb_http' };
    const { launch, info } = await mcpbLaunch(pkg, { fetch: fetchImpl, transportArgs: args, env });
    choice.version = typeof pkg.version === 'string' && SAFE_VERSION.test(pkg.version) ? pkg.version : 'latest';
    choice.mcpb = info;
    return { launch, choice };
  }
  if (type === 'nuget') {
    // R-LP-57: a .NET tool package, installed in the sandbox (mcp-surface-corpus launchPlan, kind nuget: `dotnet tool
    // install --tool-path` in its pinned .NET SDK image, NuGet's two hosts only), its command the one its
    // DotnetToolSettings.xml declares, run on the image's runtime.
    if (!NUGET_ID.test(id)) return { detail: 'launch_invalid' };
    const v = version === 'latest' || NUGET_VERSION.test(version) ? version : 'latest';
    choice.version = v; choice.purl = purlOf('nuget', id, v);
    return { launch: { kind: 'nuget', package: id, version: v, ...common }, choice };
  }
  const ref = parseOciRef(id);
  if (!ref) return { detail: 'launch_invalid' };
  if (!OCI_HOSTS.includes(ref.host)) return { detail: 'oci_host_not_allowed' };
  const { digest, bytes } = await resolveOciImage(ref, { fetch: fetchImpl });
  choice.oci_digest = digest.slice('sha256:'.length);
  choice.oci_bytes = bytes;
  choice.version = ref.tag;
  return { launch: { kind: 'docker', image: ref.host + '/' + ref.path + ':' + ref.tag + '@' + digest, ...common }, choice };
}

/**
 * Registry entries (latest versions) whose repository is the subject or whose packages are the seed list's. Each says
 * how it matched: seed (it carries a package of the seed list), namespace (its name is io.github.<subject owner>/...,
 * which the registry verifies), repository (only its repository URL, free text anyone can publish).
 */
export const REGISTRY_PAGE = 100;
export const REGISTRY_MIN_QUERY = 3;
export async function registryEntries(subject, seedPkgs, { fetch: fetchImpl = globalThis.fetch, base = REGISTRY_BASE, stats = null } = {}) {
  const [owner, name] = subject.split('/');
  const seedIds = new Set(seedPkgs.map((p) => String(p.registry).toLowerCase() + ':' + String(p.identifier).toLowerCase()));
  // The registry refuses a search shorter than REGISTRY_MIN_QUERY with a 422 (getsigit/si, anderson-0/qh): such a query
  // is never sent; owner/name is always long enough (R-LP-76).
  const queries = [...new Set([name, owner + '/' + name, ...seedPkgs.filter((p) => ['npm', 'pypi', 'cargo', 'nuget'].includes(p.registry)).map((p) => p.identifier.split('/').pop())])].filter((q) => q && q.length >= REGISTRY_MIN_QUERY && q.length <= 200).slice(0, 5);
  const found = new Map();
  for (const q of queries) {
    const d = await getJson(fetchImpl, base + '/v0.1/servers?search=' + encodeURIComponent(q) + '&version=latest&limit=100');
    // A search page of 100 is full, and we do not page: the entry we want may be on a page we never fetched (R-LP-38).
    if (stats && Array.isArray(d && d.servers) && d.servers.length >= REGISTRY_PAGE) stats.full = true;
    for (const x of Array.isArray(d && d.servers) ? d.servers : []) {
      const s = x && isObj(x.server) ? x.server : x;
      if (!isObj(s) || typeof s.name !== 'string' || found.has(s.name)) continue;
      const byRepo = repoOfUrl(s.repository && s.repository.url) === subject.toLowerCase();
      const bySeed = (Array.isArray(s.packages) ? s.packages : []).some((p) => isObj(p) && seedIds.has(String(p.registryType).toLowerCase() + ':' + String(p.identifier).toLowerCase()));
      const byNamespace = byRepo && s.name.toLowerCase().startsWith('io.github.' + owner.toLowerCase() + '/');
      if (byRepo || bySeed) found.set(s.name, { server: s, seed: bySeed, namespace: byNamespace, repository: byRepo, by: [byRepo && 'repository', byNamespace && 'namespace', bySeed && 'seed'].filter(Boolean).join('+') });
    }
  }
  // Entries carrying a package of the seed list first (the seed names what was sampled), then by name.
  return [...found.values()].sort((a, b) => (b.seed - a.seed) || (b.namespace - a.namespace) || (a.server.name < b.server.name ? -1 : 1));
}

/** The resolve details that put a bundle's own failure on the subject (R-LP-72): only for an entry in its namespace. */
export const SUBJECT_RESOLVE_DETAILS = Object.freeze(['bundle_unavailable', 'bundle_hash_mismatch', 'bundle_invalid', 'package_not_runnable']);
// Our limits before a package's own failure: a subject is not shown at fault while any of its packages failed on our side.
const DETAIL_ORDER = ['unverified_registry_entry', 'image_too_large', 'oci_host_not_allowed', 'unsupported_transport', 'image_registry_unreadable', 'image_access_denied', 'registry_query_refused', 'start_needs_config', 'platform_unsupported', 'bundle_runtime_unsupported', 'bundle_unreadable', 'bundle_too_large', 'bundle_host_not_allowed', 'bundle_fetch_refused', 'bundle_unowned', 'image_unavailable', 'bundle_unavailable', 'bundle_hash_mismatch', 'bundle_invalid', 'package_not_runnable', 'launch_invalid', 'private_registry', 'unsupported_package'];

/**
 * R-LP-91: the sandbox launch of a Go repository with no registry package: `go install <package path>@<full commit>`
 * (corpus/go-entry.mjs chooses the path). The arguments, environment names and transport come from the registry-format
 * server.json the repository itself ships, when it ships one: never a value we invent. Returns { launch, choice, commit },
 * { detail } (with `why` for a transport we do not run), or {} when the repository has no go.mod at its root.
 */
async function goLaunchFor(item, own, { fetch: fetchImpl, token }) {
  const g = await goSource({ repo: item.repo, sha: item.sha || null, names: own.map((e) => e.server.name), fetch: fetchImpl, token, httpDetail });
  if (g.none) return {};
  if (g.detail) return { detail: g.detail };
  const pkg = isObj(g.serverJson) && Array.isArray(g.serverJson.packages) && isObj(g.serverJson.packages[0]) ? g.serverJson.packages[0] : {};
  const tr = transportOf(pkg.transport, transportVars(pkg));
  if (tr.detail) return { detail: tr.detail, why: tr.why, identifier: g.launch.package };
  const { args, unfilled } = packageArgs(pkg.packageArguments);
  const { env, names } = packageEnv(pkg.environmentVariables);
  const common = { ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}), ...(tr.transport === 'http' ? { transport: 'http', http: tr.http } : {}) };
  const { package: path, commit, module, dir } = g.launch;
  return {
    launch: { kind: 'go', module: path, version: commit, ...common },
    choice: { type: 'go', identifier: path, version: commit, transport: tr.transport, runtime_hint: null, args_n: args.length, args_unfilled: unfilled, env_names: names, oci_digest: null, purl: purlOf('golang', path, commit), go: { module, dir: dir || '.' } },
    commit,
  };
}

/**
 * How to run one subject: { status: 'runnable', launch, choice, registry, subdir } or { status: 'skipped', detail }.
 * Never throws; a fetch that failed gives rate_limited or upstream_error (retryable).
 */
export async function resolveSubject(item, { seed = new Map(), fetch: fetchImpl = globalThis.fetch, base = REGISTRY_BASE, chains, ghToken = process.env.GH_TOKEN || null } = {}) {
  const out = { status: 'skipped', detail: null, registry: null, choice: null, launch: null, subdir: null, seed_packages: 0, candidates: [] };
  if (!item.repo) { out.detail = 'bad_subject'; return out; }
  const seedPkgs = seed.get(item.repo.toLowerCase()) || [];
  out.seed_packages = seedPkgs.length;
  try {
    const lookup = { full: false };
    const entries = await registryEntries(item.repo, seedPkgs, { fetch: fetchImpl, base, stats: lookup });
    const cands = [];
    for (const e of entries) for (const p of Array.isArray(e.server.packages) ? e.server.packages.slice(0, 20) : []) if (isObj(p)) cands.push({ server: e.server, entry: e, by: e.by, pkg: p });
    if (!entries.length) for (const p of seedPkgs) cands.push({ server: null, entry: null, by: 'seed-only', pkg: { registryType: p.registry, identifier: p.identifier } });
    const inSeed = (c) => seedPkgs.some((p) => p.registry === String(c.pkg.registryType).toLowerCase() && p.identifier.toLowerCase() === String(c.pkg.identifier).toLowerCase());
    const rank = (c) => [inSeed(c) ? 0 : 1, TRANSPORT_RANK[(c.pkg.transport && c.pkg.transport.type) || 'stdio'] ?? 9, TYPE_RANK[String(c.pkg.registryType).toLowerCase()] ?? 9];
    cands.sort((a, b) => { const x = rank(a); const y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
    out.candidates = cands.map((c) => ({ registry_type: String(c.pkg.registryType || '').slice(0, 20), identifier: String(c.pkg.identifier || '').slice(0, 300), transport: String((c.pkg.transport && c.pkg.transport.type) || 'stdio').slice(0, 30), server: c.server ? String(c.server.name).slice(0, 250) : null }));
    const details = [];
    for (const c of cands.slice(0, 8)) {
      let r;
      try { r = await launchFor(c.pkg, { fetch: fetchImpl }); } catch (e) {
        if (e && (e.detail === 'rate_limited' || e.detail === 'upstream_error')) throw e;
        r = { detail: (e && e.detail) || 'launch_invalid' };
      }
      if (r.detail) {
        // R-LP-72: a failure that would be the package's own counts against the subject only when the entry is the
        // subject's (its namespace). Anyone can publish an entry naming someone else's repository with a dead bundle URL.
        if (SUBJECT_RESOLVE_DETAILS.includes(r.detail) && !(c.entry && c.entry.namespace)) details.push(c.entry && !c.entry.seed ? 'unverified_registry_entry' : 'bundle_unowned');
        else details.push(r.detail);
        // Which transport we could not run, and why (R-LP-86): kept in raw/resolution.json.
        if (r.detail === 'unsupported_transport') out.transport_refused = [...(out.transport_refused || []), { identifier: String(c.pkg.identifier || '').slice(0, 200), type: String((c.pkg.transport && c.pkg.transport.type) || 'stdio').slice(0, 30), why: r.why || null }].slice(0, 8);
        continue;
      }
      // An entry that matched on its repository URL alone is anyone's claim: its package must point back to the repo.
      let verifiedBy = !c.entry ? 'seed' : c.entry.seed ? 'seed' : c.entry.namespace ? 'namespace' : null;
      if (!verifiedBy) {
        const why = {};
        // R-LP-76: one candidate's provenance answer that a registry refused (a 4xx) leaves that candidate unverified; it
        // does not end the subject (an outage or rate limit still does, and is retried).
        try { verifiedBy = await packageVerifiedBy(c.pkg, item.repo, { fetch: fetchImpl, chains, out: why }); } catch (e) {
          if (!(e && e.detail === 'registry_query_refused')) throw e;
          verifiedBy = null; why.why = 'provenance_refused';
        }
        if (!verifiedBy) { details.push('unverified_registry_entry'); out.unverified = [...(out.unverified || []), { identifier: String(c.pkg.identifier || '').slice(0, 200), why: why.why || null }].slice(0, 8); continue; }
        // Install exactly the version whose provenance was checked (R-LP-17).
        if (why.version && (r.launch.kind === 'npm' || r.launch.kind === 'pypi')) {
          if (r.launch.version !== 'latest' && r.launch.version !== why.version) { details.push('unverified_registry_entry'); continue; }
          r.launch.version = why.version; r.choice.version = why.version; r.choice.purl = purlOf(r.launch.kind, r.launch.package, why.version);
        }
        if (why.signer) r.choice.provenance_signer = why.signer;
      }
      const s = c.server;
      out.status = 'runnable'; out.launch = r.launch; out.choice = { ...r.choice, matched_by: c.by, verified_by: verifiedBy };
      // A PyPI launch runs the console script the wheel declares, not a guess from the package name (R-LP-48).
      if (out.launch.kind === 'pypi' && !out.launch.entry) {
        const e = await pypiEntry(out.launch.package, out.launch.version, { fetch: fetchImpl, args: out.launch.args || [] });
        // The sandbox takes at most 40 args: a module launch that would not fit stays on the guess.
        const fits = !e.args_prefix || e.args_prefix.length + (out.launch.args || []).length <= 40;
        if (e.entry && fits) {
          // R-LP-82: an entry the registry's first package argument named takes that argument.
          const rest = (out.launch.args || []).slice(Number.isInteger(e.args_drop) ? e.args_drop : 0);
          const args = [...(e.args_prefix || []), ...rest];
          const { args: _a, ...l } = out.launch;
          out.launch = { ...l, entry: e.entry, ...(args.length ? { args } : {}) };
        }
        out.choice.entry_source = e.entry && !fits ? 'too_many_args' : e.entry_source;
        out.choice.entry_wheel = e.wheel || null;
        out.choice.entry = (fits && e.entry) || null;
        // What the release declares and ships: failureDetail tells the server's own modules from its dependencies (R-LP-61).
        if (e.deps) out.choice.pydeps = e.deps;
        // What PyPI said of the release (R-LP-90): found, and how many files it has; failureDetail needs both.
        if (isObj(e.release)) out.choice.pypi_release = e.release;
        // The extra that holds the MCP server (or its CLI's dependencies) installs with the package (R-LP-66).
        const extras = EMIT_PYPI_EXTRAS ? serverExtras(e.deps) : [];
        if (extras.length) { out.launch = { ...out.launch, extras }; out.choice.extras = extras; }
      }
      if (s) {
        out.registry = { name: s.name, version: typeof s.version === 'string' ? s.version.slice(0, 64) : null, entries: entries.length, transports: [...new Set((s.packages || []).map((p) => (p && p.transport && typeof p.transport.type === 'string' ? p.transport.type : 'stdio')))].slice(0, 5), remotes: Array.isArray(s.remotes) ? s.remotes.length : 0 };
        const sub = s.repository && typeof s.repository.subfolder === 'string' ? s.repository.subfolder.replace(/^\.?\/+|\/+$/g, '') : '';
        if (sub && SUBDIR.test(sub)) out.subdir = sub;
      }
      return out;
    }
    // A remote-only entry counts only when it is the subject's own (seed or namespace); otherwise it is someone's claim.
    const own = entries.filter((e) => e.seed || e.namespace);
    if (!cands.length) out.detail = own.some(({ server }) => Array.isArray(server.remotes) && server.remotes.length) ? 'remote_only' : entries.length > own.length ? 'unverified_registry_entry' : lookup.full ? 'registry_lookup_truncated' : 'no_package';
    else out.detail = DETAIL_ORDER.find((d) => details.includes(d)) || 'unsupported_package';
    if (own.length) out.registry = { name: own[0].server.name, version: typeof own[0].server.version === 'string' ? own[0].server.version.slice(0, 64) : null, entries: own.length, transports: [], remotes: Array.isArray(own[0].server.remotes) ? own[0].server.remotes.length : 0 };
    // R-LP-91: no package we can run, but the repository may be a Go module whose main package we can build at its commit.
    // The package path is chosen from the repository at that commit (corpus/go-entry.mjs), never a guess: the module root if
    // it is a main package, else the one cmd/ package, else the one named for the repository or its registry name.
    if (out.detail === 'no_package' || out.detail === 'unsupported_package') {
      const g = await goLaunchFor(item, own, { fetch: fetchImpl, token: ghToken });
      if (g.launch) {
        out.status = 'runnable'; out.detail = null; out.launch = g.launch; out.commit = g.commit;
        out.choice = { ...g.choice, matched_by: 'repository', verified_by: 'source_commit' };
      } else if (g.detail) { out.detail = g.detail; if (g.why) out.transport_refused = [{ identifier: String(g.identifier || '').slice(0, 200), type: 'streamable-http', why: g.why }]; }
    }
  } catch (e) {
    out.status = 'skipped';
    // R-LP-76: a detail code of ours stands (an outage, a rate limit, a refused query); an exception without one is a bug
    // of ours, never somebody else's outage: resolver_error (tool), with the error's class kept.
    out.detail = e && typeof e.detail === 'string' && Object.hasOwn(DETAILS, e.detail) && DETAILS[e.detail][2] === 'resolve' ? e.detail : 'resolver_error';
    if (out.detail === 'resolver_error') out.error_class = String((e && e.name) || typeof e).replace(/[^A-Za-z]/g, '').slice(0, 40) || null;
    out.launch = null; out.choice = null;
  }
  return out;
}

/** The forgery server as one line of JavaScript for `node -e` (comment lines dropped). */
export function forgeryScript(file = FORGERY_SERVER) {
  const s = readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.trim()).filter(Boolean).join(' ');
  if (s.length > 2000 || /[\u0000\n\r]/.test(s)) throw new Error('the forgery server does not fit one sandbox argument');
  return s;
}

/** A fresh forgery marker: hex only, so no secret pattern can match it. */
export const newMarker = () => 'liveprobe-' + randomBytes(16).toString('hex');

/** The sandbox's target lists: the two controls, and the runnable subjects. */
export function targetLists(plan, { node24Image, forgery = forgeryScript() }) {
  if (!/^docker\.io\/library\/node:[0-9a-z.-]+@sha256:[0-9a-f]{64}$/.test(String(node24Image))) throw new Error('the sandbox has no pinned node image');
  const controls = {
    format: TARGETS_FORMAT, about: 'live-probe controls', defaults: { timeout_s: 300 },
    targets: [
      { id: KNOWN_ANSWER.id, repo: KNOWN_ANSWER.repo, commit: KNOWN_ANSWER.commit, registry: KNOWN_ANSWER.registry, launch: { ...KNOWN_ANSWER.launch, args: [...KNOWN_ANSWER.launch.args] }, timeout_s: KNOWN_ANSWER.timeout_s + ORACLE_ALLOWANCE_S + (plan.fuzz ? FUZZ_ALLOWANCE_S : 0) },
      { id: FORGERY.id, repo: FORGERY.repo, commit: FORGERY.commit, launch: { kind: 'docker', image: node24Image, entrypoint: 'node', args: ['-e', forgery, plan.marker] }, timeout_s: FORGERY.timeout_s + ORACLE_ALLOWANCE_S + (plan.fuzz ? FUZZ_ALLOWANCE_S : 0) },
    ],
  };
  const isOci = (x) => x.target && x.target.launch.kind === 'docker';
  const built = (x) => x.target && isBuild(x.target.launch);
  const subjects = { format: TARGETS_FORMAT, about: 'live-probe subjects', defaults: { timeout_s: plan.subject_timeout_s }, targets: plan.items.filter((x) => x.target && !isOci(x) && !built(x)).map((x) => x.target) };
  // Crates build after the other subjects, one after another, each within its own longer limit (R-LP-55).
  const builds = { format: TARGETS_FORMAT, about: 'live-probe subjects built in the sandbox', defaults: { timeout_s: plan.subject_timeout_s }, targets: plan.items.filter(built).map((x) => x.target) };
  // OCI subjects run one at a time after the others, each only when the disk has room for its image (corpus/live-probe-sandbox.sh).
  const oci = plan.items.filter(isOci).map((x) => ({ id: x.target.id, image: x.target.launch.image, bytes: Number.isSafeInteger(x.resolution.choice && x.resolution.choice.oci_bytes) ? x.resolution.choice.oci_bytes : OCI_MAX_BYTES, list: { format: TARGETS_FORMAT, about: 'live-probe OCI subject', defaults: { timeout_s: plan.subject_timeout_s }, targets: [x.target] } }));
  return { controls, subjects, builds, oci };
}

/** Each subject's time limit: the subject budget shared out, within bounds. */
export const subjectTimeout = (n, reserveS = 0) => Math.max(SUBJECT_TIMEOUT_MIN_S, Math.min(SUBJECT_TIMEOUT_MAX_S, Math.floor((SUBJECT_BUDGET_S - 90 - reserveS) / Math.max(1, n))));

/**
 * The shard plan. validateTarget is the sandbox's own check of one target (mcp-surface-corpus src/targets.mjs): a
 * target it refuses becomes a launch_invalid skip instead of stopping the whole list.
 */
export async function planShard({ inputs, seed = new Map(), fetch: fetchImpl = globalThis.fetch, validateTarget = () => {}, marker = newMarker(), now = () => new Date(), clock = () => Date.now(), base = REGISTRY_BASE, fuzz = false, ghToken = process.env.GH_TOKEN || null }) {
  const items = [];
  for (const it of inputs.items) {
    const t0 = clock();
    const r = await resolveSubject(it, { seed, fetch: fetchImpl, base, ghToken });
    const x = { index: it.index, subject: it.subject, repo: it.repo, run_key: it.run_key, fence: it.fence, target_id: null, target: null, resolution: r, resolve_ms: clock() - t0 };
    if (r.status === 'runnable') {
      const target = { id: targetId(it.index), repo: it.repo, ...(it.sha ? { commit: it.sha } : r.commit ? { commit: r.commit } : { ref: 'HEAD' }), ...(r.subdir ? { subdir: r.subdir } : {}), ...(r.registry && REGISTRY_NAME.test(r.registry.name) ? { registry: r.registry.name } : {}), launch: r.launch };
      try { validateTarget(target, it.index); x.target_id = target.id; x.target = target; } catch (e) {
        r.status = 'skipped'; r.detail = 'launch_invalid'; r.invalid = String((e && e.message) || e).slice(0, 200);
      }
    }
    items.push(x);
  }
  const runnable = items.filter((x) => x.target).length;
  const builds = items.filter((x) => x.target && isBuild(x.target.launch)).length;
  const timeout = subjectTimeout(runnable - builds, builds ? BUILD_RESERVE_S : 0);
  // The oracle stage runs only for stdio targets (corpus/live-probe-driver.mjs): only they get its allowance.
  // The fuzz stage (off unless switched on) runs for the same targets and has an allowance of its own.
  for (const x of items) if (x.target) x.target.timeout_s = timeout + ((x.target.launch.transport || 'stdio') === 'stdio' ? ORACLE_ALLOWANCE_S : 0);
  if (fuzz) for (const x of items) if (x.target && (x.target.launch.transport || 'stdio') === 'stdio') x.target.timeout_s += FUZZ_ALLOWANCE_S;
  for (const x of items) if (x.target && PACKAGE_ALLOWANCE_S[x.target.launch.kind]) x.target.timeout_s += PACKAGE_ALLOWANCE_S[x.target.launch.kind];
  // The sandbox's own bound is 1800 s a target (mcp-surface-corpus MAX_TIMEOUT_S).
  for (const x of items) if (x.target && isBuild(x.target.launch)) x.target.timeout_s = Math.min(1800, x.target.timeout_s + BUILD_ALLOWANCE_S);
  return { format: PLAN_FORMAT, shard_id: inputs.shardId, attempt_id: inputs.attemptId, marker, planned_at: now().toISOString(), subject_timeout_s: timeout, runnable, ...(fuzz ? { fuzz: true } : {}), items };
}

// ------------------------------------------------------------------ grading

const SECTIONS = ['spec', 'anthropic', 'openai', 'security', 'quality', 'surface'];

/** The tools/list result(s) of a probe, as `mcp-check -- <server>` hands them to the engine: one page, or every page. */
export function listText(rawPages) {
  const results = (Array.isArray(rawPages) ? rawPages : []).map((p) => (p && isObj(p.result) ? p.result : null)).filter(Boolean);
  if (!results.length) return null;
  return JSON.stringify(results.length === 1 ? results[0] : results);
}

/**
 * Grades a live list. summary: our numbers only (tools by position, never by name), for results/ and controls/.
 * report: the findings with the subject's names and messages, for raw/. Throws InputError when the engine refuses it.
 */
export function gradeList(text, label = 'the live tool list') {
  const parsed = parseList(text, label);
  const r = analyseList(parsed, null);
  const index = new Map();
  parsed.tools.forEach((t, i) => { if (t && typeof t.name === 'string' && !index.has(t.name)) index.set(t.name, i); });
  const all = M.allFindings(r);
  const checkCounts = {};
  for (const f of all) checkCounts[f.id] = (checkCounts[f.id] || 0) + 1;
  const summary = {
    tool_count: r.input.tools,
    catalog_hash: r.input.catalogHash,
    era: r.input.era,
    sections: Object.fromEntries(SECTIONS.map((k) => {
      const s = r.sections[k];
      return [k, { grade: s.grade || null, score: s.score ?? null, ready: k === 'surface' ? null : s.ready ?? null, counts: s.counts || null, caps: s.caps || [] }];
    })),
    check_counts: checkCounts,
    findings: all.map((f) => ({ id: f.id, severity: f.severity, section: f.section || null, tool_index: f.tool && index.has(f.tool) ? index.get(f.tool) : null })),
  };
  const report = { findings: all.map((f) => ({ id: f.id, severity: f.severity, section: f.section || null, tool: f.tool || null, path: f.path || null, message: f.message || null })) };
  return { summary, report, names: parsed.tools.map((t) => (t && typeof t.name === 'string' ? t.name : null)) };
}

/** What a grade is compared on: the list's identity, the letters and the checks that fired. */
export const answerOf = (summary) => ({
  tool_count: summary.tool_count,
  catalog_hash: summary.catalog_hash,
  grades: Object.fromEntries(SECTIONS.map((k) => [k, summary.sections[k].grade])),
  checks: Object.keys(summary.check_counts).sort(),
});

/** The engine's catalog hash and size of a probe's list, or null (for the per-config record). */
function catalogOf(probe) {
  const text = listed(probe) ? listText(probe.lists['tools/list'].raw_pages) : null;
  if (!text) return null;
  try { const p = M.parseInput(text); if (p.error) return null; const r = M.analyse(p); return { tool_count: r.input.tools, catalog_hash: r.input.catalogHash }; } catch { return null; }
}

/** A probe that got a whole tools/list answer. */
export const listed = (p) => !!(p && isObj(p.lists) && isObj(p.lists['tools/list']) && p.lists['tools/list'].ok === true && Array.isArray(p.lists['tools/list'].raw_pages) && p.lists['tools/list'].raw_pages.length > 0);

/** mcp-check's own reader as the sandbox ran it (corpus/static-read.cjs), and the id of this checkout's copy of it. */
const StaticRead = createRequire(import.meta.url)('./static-read.cjs');
export const READER_ID = StaticRead.readerId();
/** Why a static list is not compared, in scan-static's words (usableList's problem -> its skip detail). */
const STATIC_SKIP = { none: 'no_tools', names: 'names_only', multiple: 'multiple_servers', incomplete: 'reader_limit' };

/**
 * The static side, read and graded as scan-static reads and grades a subject (R-LP-77): the scan of mcp-check's own
 * reader (static.json `reader`, from sandbox/static.mjs --reader), never the sandbox's vendored candidates; a scan from
 * another reader is not used (R-LP-78). { skip } when there is no list to grade, else { candidate, grade }.
 */
export function staticAnswer(stat, readerId = READER_ID) {
  const sr = stat && isObj(stat.reader) ? stat.reader : null;
  if (!sr || sr.format !== StaticRead.FORMAT) return { skip: 'reader_missing' };
  if (sr.reader_id !== readerId) return { skip: 'reader_mismatch' };
  if (typeof sr.error === 'string' || !isObj(sr.scan) || !Array.isArray(sr.scan.candidates)) return { skip: 'reader_error' };
  const scan = { ...sr.scan, best: Number.isInteger(sr.scan.best_index) && sr.scan.best_index >= 0 ? sr.scan.candidates[sr.scan.best_index] || null : null };
  const u = usableList(scan);
  if (u.problem) return { read: true, skip: STATIC_SKIP[u.problem] || 'reader_error' };
  try { return { read: true, candidate: u.candidate, grade: gradeCandidate(u.candidate) }; } catch (e) {
    return { read: true, skip: 'list_rejected', error: e instanceof InputError ? e.code : 'engine_error' };
  }
}

/** Live against static: counts and letters for results/; the names on each side for raw/. */
export function compareStatic(live, stat, readerId = READER_ID) {
  const a = staticAnswer(stat, readerId);
  if (a.skip) return { summary: { static_read: !!a.read, static_graded: false, static_skip: a.skip, ...(a.error ? { static_error: a.error } : {}) }, raw: null };
  const best = a.candidate; const g = { summary: a.grade.summary, report: a.grade.report, names: a.grade.parsed.tools.map((t) => (t && typeof t.name === 'string' ? t.name : null)) };
  const ln = new Set(live.names.filter(Boolean)); const sn = new Set(g.names.filter(Boolean));
  const onlyLive = [...ln].filter((n) => !sn.has(n)); const onlyStatic = [...sn].filter((n) => !ln.has(n));
  const differing = SECTIONS.filter((k) => live.summary.sections[k].grade !== g.summary.sections[k].grade);
  return {
    summary: {
      static_read: true, static_graded: true, static_reader: readerId.slice(0, 12),
      static_kind: safeText(best.kind, /^[a-z][a-z0-9_-]{0,39}$/), static_fidelity: safeText(best.fidelity, /^[a-z][a-z0-9_-]{0,39}$/),
      live_tool_count: live.summary.tool_count, static_tool_count: g.summary.tool_count,
      names_in_both: [...ln].filter((n) => sn.has(n)).length, names_only_live: onlyLive.length, names_only_static: onlyStatic.length,
      same_catalog_hash: live.summary.catalog_hash === g.summary.catalog_hash,
      static_grades: Object.fromEntries(SECTIONS.map((k) => [k, g.summary.sections[k].grade])),
      sections_differing: differing,
      checks_only_live: Object.keys(live.summary.check_counts).filter((c) => !(c in g.summary.check_counts)).sort(),
      checks_only_static: Object.keys(g.summary.check_counts).filter((c) => !(c in live.summary.check_counts)).sort(),
    },
    raw: { names_only_live: onlyLive.slice(0, 500), names_only_static: onlyStatic.slice(0, 500), static_report: g.report },
  };
}

// ------------------------------------------------------------------ reading the sandbox's output

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
function readText(file) { try { return readFileSync(file); } catch { return null; } }

/** Telemetry records about one target (and the run's own, subject null), as raw JSON lines. */
export function telemetryFor(file, id) {
  const buf = readText(file);
  if (!buf) return { lines: [], records: [] };
  const lines = []; const records = [];
  for (const l of buf.toString('utf8').split('\n')) {
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (!isObj(r) || (r.subject !== id && r.subject !== null)) continue;
    lines.push(l); if (r.subject === id) records.push(r);
  }
  return { lines, records };
}

/** network_event values: what the server and its install looked up or tried to reach, in our words. */
export function networkEvents(records, cap = 200) {
  const out = [];
  for (const r of records) {
    if (out.length >= cap) break;
    if (r.type === 'dns_query') out.push({ source: 'netlog', kind: 'dns_query', role: r.role ?? null, qtype: safeText(String(r.qtype ?? ''), /^[A-Z0-9]{1,10}$/), answer: safeText(String(r.answer ?? ''), /^[a-z]{1,12}$/), host: safeText(r.qname, SAFE_HOST), host_sha256: typeof r.qname === 'string' ? sha256(r.qname) : null });
    else if (r.type === 'connection') out.push({ source: 'netlog', kind: 'connection', role: r.role ?? null, proto: safeText(String(r.proto ?? ''), /^[a-z]{3}$/), port: int(r.port), bytes: int(r.bytes), host: safeText(r.sni || (isObj(r.http) ? r.http.host : null), SAFE_HOST) });
    else if (r.type === 'egress') out.push({ source: 'proxy', kind: 'egress', role: 'install', host: safeText(r.host, SAFE_HOST), port: int(r.port), allowed: r.allowed === true, up: int(r.up), down: int(r.down) });
    else if (r.type === 'host_drop') out.push({ source: 'host', kind: 'host_drop', chain: safeText(String(r.chain ?? ''), /^[a-z0-9]{1,12}$/), proto: safeText(String(r.proto ?? ''), /^[A-Za-z0-9]{1,10}$/), dst: safeText(String(r.dst ?? ''), /^[0-9a-f.]{1,45}$/), dpt: int(r.dpt), n: int(r.n) });
  }
  return out;
}

/** Package-level install errors: the package, its version or its launcher is not there (the server's own publishing). */
/** Signs that pip or npm could not reach the index properly (our proxy, a name lookup, TLS, a time-out). */
const PIP_NOT_THE_PACKAGE = /Retrying \(Retry\(|ProxyError|SSLError|ConnectionError|Max retries exceeded|Temporary failure in name resolution|Name or service not known|Read timed out|timed out/i;
const NPM_NOT_THE_PACKAGE = /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPROXY|ERR_SOCKET_TIMEOUT|UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT_IN_CHAIN)\b|socket hang up|npm error network/i;
/** pip's word that a release exists for other Pythons or platforms only: no defect of the package. */
const PIP_PLATFORM = /require a different python version|Requires-Python|is not a supported wheel|not a supported wheel on this platform/i;
const escRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * R-LP-90: an npm or PyPI install failure is the package's own (install_failed, subject) only on the installer's word
 * about this very package, for a registry entry in the subject's namespace (owned), with no sign of trouble reaching
 * the index, as cargo and NuGet (R-LP-56, R-LP-58). PyPI: "No matching distribution found for <the package>" (PEP 503
 * names), and the planner's PyPI JSON showed the release missing or with no file at all; a release for other Pythons or
 * platforms only is unsupported_platform; a dependency with no distribution, a network retry, anything else is ours.
 * npm: E404 for the package's own registry URL, or ETARGET for its own name; our entry helper's "declares no bin" is
 * entry_unresolved (our reading of package.json). Returns a detail.
 */
export function packageInstallEvidence(kind, text, { launch = null, owned = false, release = null } = {}) {
  const t = String(text || '');
  const pkg = isObj(launch) && typeof launch.package === 'string' ? launch.package : null;
  if (kind === 'pypi') {
    if (PIP_PLATFORM.test(t)) return 'unsupported_platform';
    if (!pkg || PIP_NOT_THE_PACKAGE.test(t)) return 'install_build_failed';
    const named = [...t.matchAll(/No matching distribution found for ([A-Za-z0-9][A-Za-z0-9._-]{0,120})/g)].map((m) => normDist(m[1]));
    const own = named.length > 0 && named.every((n) => n === normDist(pkg));
    const gone = isObj(release) && (release.found === false || release.files === 0);
    return own && owned && gone ? 'install_failed' : 'install_build_failed';
  }
  if (kind === 'npm') {
    if (/declares no bin|has no bin of that name/.test(t)) return 'entry_unresolved';
    if (!pkg || NPM_NOT_THE_PACKAGE.test(t)) return 'install_build_failed';
    const url = 'https://registry\\.npmjs\\.org/' + escRe(pkg.startsWith('@') ? pkg.replace('/', '%2f') : pkg);
    const e404 = /\bE404\b/.test(t) && new RegExp('404 Not Found - GET ' + url + '(?:\\s|$)', 'i').test(t);
    const etarget = /\bETARGET\b/.test(t) && new RegExp('No matching version found for ' + escRe(pkg) + '@', 'i').test(t);
    return (e404 || etarget) && owned ? 'install_failed' : 'install_build_failed';
  }
  return 'install_build_failed';
}
/** npm's own refusal of a package for another platform (EBADPLATFORM, `notsup`). */
const NPM_PLATFORM = /\bEBADPLATFORM\b|\bnotsup\b[^\n]{0,40}\b(?:Unsupported platform|Valid (?:os|cpu|libc))\b/;
/**
 * Stderr that says the server needs configuration (R-LP-44): a config file missing or unreadable, a kubeconfig or
 * current-context, --config, a usage block, a missing or required argument, option, flag or environment variable, or
 * "please create/set/provide/specify".
 */
const CONFIG_BASE = [
  String.raw`\bconfig(?:uration)?(?:[\s_.-]?(?:file|path|dir(?:ectory)?))?\b[^\n]{0,100}?(?:not found|not exist|no such file|missing|not readable|failed to (?:read|load|open)|cannot (?:read|open|load|find)|could not (?:read|open|load|find)|unable to (?:read|open|load|find))`,
  String.raw`(?:not found|no such file|missing|failed to (?:read|load|open)|cannot (?:read|open|load|find)|could not (?:read|open|load|find)|unable to (?:read|open|load|find))[^\n]{0,100}?\bconfig(?:uration)?\b`,
  String.raw`kubeconfig`, String.raw`current-context`, String.raw`--config\b`, String.raw`\busage:`,
  String.raw`\b(?:missing|required|expected)\s+(?:required\s+)?(?:positional\s+)?(?:argument|option|flag|parameter|env(?:ironment)?(?:\s+var(?:iable)?)?)`,
  String.raw`\b(?:argument|option|flag|parameter|env(?:ironment)?\s+var(?:iable)?)s?\b[^\n]{0,60}?\b(?:is|are)\s+(?:required|missing|not set)`,
  String.raw`\bplease\s+(?:create|set|provide|specify)\b`,
];
/** R-LP-63: configuration requests the 26 Nov start-failure review found the patterns above missed. */
const CONFIG_MORE = [
  String.raw`\bmissing\s+required\s+(?:[a-z]+\s+){0,2}?(?:settings?|credentials?|parameters?|keys?|values?|fields?)\b`,
  String.raw`\bconfiguration[\s_-]*(?:path[\s_-]*)?(?:error|required)\b`, String.raw`\binvalid\s+config(?:uration)?\b`,
  String.raw`\b(?:not|partially|incompletely)\s+configured\b`, String.raw`\bno\s+(?:[A-Za-z]+\s+){0,2}?(?:credentials?|api[\s_-]?keys?|tokens?)\s+(?:configured|found|supplied|provided|set)\b`,
  String.raw`\b(?:pass|provide|specify)\s+--[a-z][a-z0-9-]{1,40}\b`, String.raw`\b(?:run|initiali[sz]e|configure)\s+[^\n]{1,40}?\s+first\b`,
];
/**
 * Case-sensitive configuration requests (R-LP-69): a read of an unset environment variable (`os.environ['GITHUB_TOKEN']`
 * raises `KeyError: 'GITHUB_TOKEN'`), and pydantic settings that failed validation for a required field.
 */
const CONFIG_CASE = [
  String.raw`(?:^|\n)KeyError: '[A-Z][A-Z0-9_]{2,80}'`,
  String.raw`\bvalidation errors? for \w{0,60}(?:Settings|Config|Env)\w{0,20}\b`, String.raw`(?:^|\n)\s{0,8}Field required\b`,
];
export const CONFIG_TEXT = new RegExp([...CONFIG_BASE, ...CONFIG_MORE].join('|'), 'i');
const CONFIG_CASE_RE = new RegExp(CONFIG_CASE.join('|'));
const CONFIG_BASE_RE = new RegExp(CONFIG_BASE.join('|'), 'i');
const CONFIG_MORE_RE = new RegExp(CONFIG_MORE.join('|'), 'i');

/**
 * A named setting the server says is missing (R-LP-47): an environment-style name (with an underscore, case-sensitive) next
 * to missing, required, not set or undefined. A server that throws its own "API_KEY missing" error with a stack is asking
 * for configuration, not crashing.
 */
export const ENV_NAME_TEXT = new RegExp([
  String.raw`\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b[^\n]{0,40}?\b(?:missing|required|not set|is not defined|undefined|must be set)\b`,
  String.raw`\b(?:[Mm]issing|[Rr]equired|[Ss]et(?: the)?)\s+(?:env(?:ironment)?\s+(?:var(?:iable)?\s+)?)?[A-Z][A-Z0-9]*_[A-Z0-9_]+\b`,
].join('|'));

/**
 * Stderr that shows the server itself crashed (R-LP-45): a panic, a Python traceback, an uncaught or unhandled
 * exception or rejection, a segmentation fault, a missing module, an import, syntax, reference or type error, a fatal
 * error, a stack overflow.
 */
export const CRASH_TEXT = new RegExp([
  // Case-sensitive and in the form each runtime prints, at the start of a line: a log line or a validation message that
  // merely mentions "panic:", "ImportError" or "TypeError" is no crash (R-LP-46).
  String.raw`(?:^|\n)panic: `, String.raw`thread '[^']*' panicked at `, String.raw`thread '[^']*' has overflowed its stack`,
  String.raw`(?:^|\n)Traceback \(most recent call last\):`, String.raw`(?:^|\n)(?:ModuleNotFoundError|ImportError|SyntaxError): `,
  // A JavaScript error is a crash only with its stack: the next line is a frame ("    at ...").
  String.raw`(?:^|\n)(?:Uncaught )?(?:TypeError|ReferenceError|SyntaxError|RangeError|Error): [^\n]*\n\s+at `,
  String.raw`(?:^|\n)(?:\(node:\d+\) )?(?:Uncaught \w*(?:Error|Exception)|Unhandled promise rejection|UnhandledPromiseRejection)`,
  String.raw`(?:^|\n)Error: Cannot find module '`, String.raw`Segmentation fault|\bSIGSEGV\b|\(core dumped\)`,
  // A Go runtime fatal error prints its goroutine dump after it.
  String.raw`(?:^|\n)fatal error: [^\n]*\n(?:[^\n]*\n){0,4}goroutine \d+ \[`,
].join('|'));

const OOM_TEXT = /\bENOMEM\b|out of memory|\bOOM\b/i;

// The mutation check (R-LP-65): a test switches one start rule off and shows its regression fixture is then blamed on
// the server, so no rule is dead code. Never set outside the tests.
let MUTED = null;
export function setStartMutation(id) { MUTED = id || null; }
const on = (id) => MUTED !== id && MUTED !== 'all';

/**
 * Stderr that shows our sandbox, not the server, stopped the start (R-LP-60): a write the read-only root or uid 65534
 * refused, a shared library or loader our slim images lack, a binary for another CPU, an executable that is not in them, or a file under /tmp,
 * the working directory we force, that the image expected under its own WORKDIR.
 */
export const ENV_TEXT = new RegExp([
  String.raw`Read-only file system`, String.raw`\bEROFS\b`, String.raw`\[Errno (?:30|13)\]`, String.raw`\bEACCES\b`, String.raw`\bPermission denied\b`,
  String.raw`unable to open database file`,
  String.raw`cannot open shared object file`, String.raw`error while loading shared libraries`, String.raw`version \x60GLIBC_[0-9.]+' not found`,
  String.raw`Exec format error`,
  String.raw`Cannot find module '/tmp/`, String.raw`can't open file '/tmp/`,
  // A library that needs an executable or a native build our images lack (GitPython without git, a missing .node file).
  String.raw`Bad git executable`, String.raw`Could not locate the bindings file`,
  // A file or folder at an absolute path the image or our mounts do not have, a full disk, our own stop (R-LP-69).
  String.raw`FileNotFoundError: \[Errno 2\] No such file or directory: '/`, String.raw`\bENOENT: no such file or directory, (?:open|stat|scandir|lstat|access|mkdir) '/`,
  String.raw`\[Errno 28\]`, String.raw`No space left on device`, String.raw`\bENOSPC\b`, String.raw`(?:^|\n)KeyboardInterrupt\b`,
// Case-insensitive: Go and glibc print these in lower case (`open /data/x.db: read-only file system`).
].join('|'), 'i');
/** An executable the server tried to run that is not in our image: [whole match, name]. */
const MISSING_BIN = [
  /FileNotFoundError: \[Errno 2\] No such file or directory: '([A-Za-z0-9_+-]+(?:\.exe)?)'/,
  /\bspawn ([A-Za-z0-9_.+-]+) ENOENT\b/,
  /(?:^|\n)(?:\/bin\/)?(?:ba|da)?sh: (?:\d+: )?([A-Za-z0-9_.+-]+): (?:command )?not found/,
  /\bexec: "([A-Za-z0-9_.+-]+)": executable file not found in \$PATH/,
];
/** Executables only macOS or Windows have: a server that needs one cannot start on Linux at all. */
const PLATFORM_BIN = /^(?:xcrun|xcodebuild|xcode-select|osascript|sw_vers|pbcopy|pbpaste|launchctl|mdfind|powershell(?:\.exe)?|cmd\.exe|wmic(?:\.exe)?|reg\.exe)$/i;
/** A server that says it runs on another operating system only (R-LP-62). */
export const PLATFORM_TEXT = new RegExp([
  String.raw`\b(?:windows|macos|mac\s?os(?:\s?x)?|darwin|win32)[\s-]+only\b`,
  String.raw`\bonly\s+(?:be\s+)?(?:supported|available|works?|runs?|run)\s+(?:on|for|under)\s+(?:windows|macos|mac\s?os(?:\s?x)?|darwin)\b`,
  String.raw`\brequires?\s+(?:microsoft\s+)?(?:windows|macos|mac\s?os(?:\s?x)?|darwin)\b`,
  String.raw`\bnot\s+supported\s+on\s+(?:linux|this\s+(?:platform|os|operating\s+system))\b`,
  String.raw`\bunsupported\s+(?:platform|operating\s+system)\b`,
].join('|'), 'i');
/** Stderr that shows the server reaching for the network, when the telemetry did not record it (R-LP-64). */
export const NETWORK_TEXT = new RegExp([
  String.raw`\bgetaddrinfo\s+(?:ENOTFOUND|EAI_AGAIN)\b`, String.raw`Temporary failure in name resolution`, String.raw`Name or service not known`,
  String.raw`\b(?:ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b`, String.raw`Network is unreachable`, String.raw`Failed to establish a new connection`,
  String.raw`Could not resolve host`, String.raw`(?:^|\n)(?:[\w.]+\.)?(?:ConnectError|ConnectionError|ConnectTimeout|NameResolutionError): `,
  // Go's resolver and dialer, Python's socket.gaierror, Node's fetch.
  String.raw`\bno such host\b`, String.raw`\bconnection refused\b`, String.raw`\bgaierror\b`, String.raw`\[Errno -[23]\]`, String.raw`(?:^|\n)TypeError: fetch failed\b`,
].join('|'), 'i');
/** A server telling us to install one of its extras: `pip install 'pkg[extra]'` (R-LP-61). */
const EXTRA_HINT = /pip install\s+["']?[A-Za-z0-9._-]+\[[A-Za-z0-9_.,-]+\]/;
/** Import names whose distribution is named otherwise (PEP 503), for the common ones. */
const IMPORT_DIST = Object.freeze({ yaml: 'pyyaml', pil: 'pillow', cv2: 'opencv-python', sklearn: 'scikit-learn', bs4: 'beautifulsoup4', dotenv: 'python-dotenv', jwt: 'pyjwt', dateutil: 'python-dateutil', magic: 'python-magic', docx: 'python-docx', pptx: 'python-pptx', git: 'gitpython', attr: 'attrs', google: 'protobuf', fitz: 'pymupdf' });
const normDist = (s) => String(s).toLowerCase().replace(/[-_.]+/g, '-');

/**
 * The import names of common distributions (PEP 503 name -> top-level modules, as their wheels' top_level.txt lists
 * them). A missing module is undeclared only when every distribution the release declares is listed here and none
 * provides it (R-LP-71): an import name often differs from its distribution's (jose from python-jose, Crypto from
 * pycryptodome), and we read no dependency's wheel, so a declared distribution not listed could be the one.
 */
export const DIST_IMPORTS = Object.freeze(Object.fromEntries(Object.entries({
  // Named otherwise.
  pyyaml: ['yaml', '_yaml'], pillow: ['PIL'], 'opencv-python': ['cv2'], 'opencv-python-headless': ['cv2'], 'opencv-contrib-python': ['cv2'], 'opencv-contrib-python-headless': ['cv2'],
  'scikit-learn': ['sklearn'], beautifulsoup4: ['bs4'], 'python-dotenv': ['dotenv'], pyjwt: ['jwt'], 'python-dateutil': ['dateutil'], 'python-magic': ['magic'],
  'python-docx': ['docx'], 'python-pptx': ['pptx'], gitpython: ['git'], attrs: ['attr', 'attrs'], protobuf: ['google'], pymupdf: ['fitz', 'pymupdf'], 'python-jose': ['jose'],
  pycryptodome: ['Crypto'], pycryptodomex: ['Cryptodome'], pyserial: ['serial'], pyopenssl: ['OpenSSL'], 'markdown-it-py': ['markdown_it'], 'python-multipart': ['multipart', 'python_multipart'],
  'google-auth': ['google'], 'google-api-python-client': ['googleapiclient', 'apiclient'], 'google-genai': ['google'], 'google-generativeai': ['google'], 'google-cloud-storage': ['google'],
  'typing-extensions': ['typing_extensions'], 'pydantic-settings': ['pydantic_settings'], 'pydantic-core': ['pydantic_core'], 'mcp-server': ['mcp_server'], 'python-slugify': ['slugify'],
  'beautifulsoup': ['BeautifulSoup'], pywin32: ['win32api', 'win32con'], 'msgpack-python': ['msgpack'], 'python-json-logger': ['pythonjsonlogger'], 'ruamel-yaml': ['ruamel'],
  'sse-starlette': ['sse_starlette'], 'azure-identity': ['azure'], 'azure-core': ['azure'], 'aws-lambda-powertools': ['aws_lambda_powertools'], 'faiss-cpu': ['faiss'], 'llama-index': ['llama_index'],
  // Named alike.
  mcp: ['mcp'], fastmcp: ['fastmcp'], httpx: ['httpx'], requests: ['requests'], pydantic: ['pydantic'], anyio: ['anyio'], starlette: ['starlette'], uvicorn: ['uvicorn'], fastapi: ['fastapi'],
  click: ['click'], typer: ['typer'], rich: ['rich'], numpy: ['numpy'], pandas: ['pandas'], scipy: ['scipy'], aiohttp: ['aiohttp'], websockets: ['websockets'], jinja2: ['jinja2'],
  sqlalchemy: ['sqlalchemy'], psycopg2: ['psycopg2'], 'psycopg2-binary': ['psycopg2'], psycopg: ['psycopg'], redis: ['redis'], boto3: ['boto3'], botocore: ['botocore'], openai: ['openai'],
  anthropic: ['anthropic'], tiktoken: ['tiktoken'], lxml: ['lxml'], markdown: ['markdown'], certifi: ['certifi'], urllib3: ['urllib3'], idna: ['idna'], tenacity: ['tenacity'], loguru: ['loguru'],
  structlog: ['structlog'], cryptography: ['cryptography'], jsonschema: ['jsonschema'], orjson: ['orjson'], tomli: ['tomli'], toml: ['toml'], packaging: ['packaging'], psutil: ['psutil'],
  docker: ['docker'], kubernetes: ['kubernetes'], paramiko: ['paramiko'], playwright: ['playwright'], selenium: ['selenium'], networkx: ['networkx'], matplotlib: ['matplotlib'],
}).map(([k, v]) => [normDist(k), v.map(normDist)])));

/**
 * The import that failed, from a Python traceback's last import error: { module, kind } where kind is `missing` (the
 * top-level module is not installed at all) or `api` (the module is there but lacks the submodule, name or attribute
 * imported from it); or a Node ESM import of a name or subpath a package does not export. Null when there is none.
 */
export function failedImport(err) {
  let last = null;
  const re = /(?:^|\n)(?:ModuleNotFoundError: No module named '([A-Za-z_][\w.]{0,200})'|ImportError: cannot import name '\w+' from '([A-Za-z_][\w.]{0,200})'|AttributeError: module '([A-Za-z_][\w.]{0,200})' has no attribute )/g;
  for (const m of String(err).matchAll(re)) {
    if (m[1]) last = { module: m[1], kind: m[1].includes('.') ? 'api' : 'missing', runtime: 'python' };
    else last = { module: m[2] || m[3], kind: 'api', runtime: 'python' };
  }
  if (last) return last;
  const esm = /(?:^|\n)SyntaxError: The requested module '([^'\s]{1,200})' does not provide an export named /.exec(err) || /\[ERR_PACKAGE_PATH_NOT_EXPORTED\]: Package subpath '[^']{1,200}' is not defined by "exports" in [^\n]*?node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\/package\.json/.exec(err);
  if (esm && !/^(?:[./]|file:|node:)/.test(esm[1])) return { module: esm[1], kind: 'api', runtime: 'node' };
  // CommonJS: a bare package that is not installed (a path is the package's own file, or our /tmp, ENV_TEXT).
  const cjs = /(?:^|\n)Error: Cannot find module '([^'\s]{1,200})'/.exec(err);
  if (cjs && !/^(?:[./]|file:|node:)/.test(cjs[1])) return { module: cjs[1], kind: 'missing', runtime: 'node' };
  return null;
}

/**
 * Whether a failed import is the server's own code (its own module), a dependency that changed under it, an extra we
 * did not install, or not ours to tell. own | drift | extra | env.
 */
/** Top-level names Python ships (3.11's list, which still holds those 3.12 and 3.13 removed) and the venv's own tools. */
const PY_STDLIB = new Set([
  'abc aifc antigravity argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii bisect',
  'builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall',
  'concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm',
  'decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp',
  'fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip',
  'hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword',
  'lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt',
  'multiprocessing netrc nis nntplib nt ntpath nturl2path numbers opcode operator optparse os ossaudiodev pathlib',
  'pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd',
  'py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter runpy',
  'sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd',
  'sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau',
  'symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap this threading time timeit',
  'tkinter token tokenize tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata',
  'unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp',
  'zipfile zipimport zlib zoneinfo',
].join(' ').split(' ').concat(['setuptools', 'pkg_resources', 'pip', 'wheel', '_distutils_hack']));

/** The last frame of a Python traceback: { path, top } where top is the site-packages folder it is in (PEP 503), else null. */
export function lastFrame(err) {
  let last = null;
  for (const m of String(err).matchAll(/(?:^|\n)\s{0,8}File "([^"\n]{1,400})", line \d+/g)) last = m[1];
  if (!last) return null;
  const sp = /\/site-packages\/([A-Za-z_][A-Za-z0-9_]*)(?:\.py|\/)/.exec(last);
  return { path: last, top: sp ? normDist(sp[1]) : null, script: /\/(?:venv\/)?bin\/[^/]+$/.test(last) };
}

/** The release's own top-level modules, or (without its wheel) the one named like the package; null when neither is known. */
function ownTopsOf(pydeps, pkg) {
  if (isObj(pydeps) && Array.isArray(pydeps.top) && pydeps.top.length) return pydeps.top.map(normDist);
  return pkg ? [normDist(pkg)] : null;
}

/** Whether a Python crash's last frame is inside an installed dependency: neither the server's own module nor its script. */
export function frameInDependency(err, { pydeps = null, pkg = null } = {}) {
  if (!/(?:^|\n)Traceback \(most recent call last\):|(?:^|\n)\s{0,8}File "[^"\n]{1,400}", line \d+\n[\s\S]{0,2000}?(?:^|\n)SyntaxError: /.test(err)) return false;
  const f = lastFrame(err);
  const own = ownTopsOf(pydeps, pkg);
  return !!(f && f.top && own && !own.includes(f.top) && !PY_STDLIB.has(f.top));
}

export function importCause(imp, { pydeps = null, pkg = null, err = '', installedExtras = [] } = {}) {
  if (!imp) return null;
  if (imp.runtime === 'node') {
    const name = imp.module.startsWith('@') ? imp.module.split('/').slice(0, 2).join('/') : imp.module.split('/')[0];
    if (pkg && name === pkg) return 'own';
    // A dependency npm did not install (an optional or native one, or one never declared) is not ours to tell.
    return imp.kind === 'missing' ? 'env' : 'drift';
  }
  const top = normDist(imp.module.split('.')[0]);
  const ownTops = isObj(pydeps) && Array.isArray(pydeps.top) ? pydeps.top.map(normDist) : null;
  const pkgName = pkg ? normDist(pkg) : null;
  // With the wheel read, only its own top-level modules are the server's; without it, only one named like the package.
  const own = ownTops && ownTops.length ? ownTops.includes(top) : !!pkgName && pkgName === top;
  // A submodule of its own package that its wheel lacks (stratevo.cli.commands): its packaging (R-LP-68).
  if (own) return imp.kind === 'api' && imp.module.includes('.') && ownTops && ownTops.length ? 'own_missing' : 'own';
  const dist = IMPORT_DIST[top] || top;
  const has = (k) => isObj(pydeps) && Array.isArray(pydeps[k]) && (pydeps[k].includes(dist) || pydeps[k].includes(top));
  const viaImports = (k) => on('importmap') && isObj(pydeps) && Array.isArray(pydeps[k]) && pydeps[k].some((d) => (DIST_IMPORTS[normDist(d)] || []).includes(top));
  if (imp.kind === 'missing') {
    if (has('extra_only') || viaImports('extra_only')) return 'extra';
    // Python's own (one this Python lacks or removed) or the venv's tools: our environment.
    if (PY_STDLIB.has(top.replace(/-/g, '_'))) return 'env';
    // Not installed and never declared, imported by the server's own code, not Python's own or the venv's: the release
    // forgot to declare it (or to ship it, `utils`). Declared in base but missing is a failed install: ours. With no
    // facts, or imported from inside a dependency, not ours to tell.
    const f = lastFrame(err);
    const fromOwn = !!f && (f.script || (!!f.top && !!ownTops && ownTops.includes(f.top)));
    // Declared when any declared distribution may provide it: by name, by IMPORT_DIST, by its listed import names, or
    // because its import names are not known to us (R-LP-71). Only a release whose every declared distribution is
    // known, none providing it, leaves it undeclared.
    const declaredDists = isObj(pydeps) ? [...(Array.isArray(pydeps.base) ? pydeps.base : []), ...(Array.isArray(pydeps.extra_only) ? pydeps.extra_only : [])].map(normDist) : [];
    const declared = has('base') || viaImports('base') || (on('importmap') && declaredDists.some((d) => !DIST_IMPORTS[d]));
    // A server extra (mcp, server, cli) we did not install may bring it transitively (FinanceToolkit's [mcp] brings
    // mcp, which brings anyio): not ours to tell which, so the extra's.
    const skipped = (isObj(pydeps) && Array.isArray(pydeps.extras) ? pydeps.extras : []).filter((x) => ['mcp', 'server', 'cli'].includes(x) && !installedExtras.includes(x));
    if (!declared && skipped.length) return 'extra';
    if (ownTops && ownTops.length && isObj(pydeps) && Array.isArray(pydeps.base) && !declared && !PY_STDLIB.has(top.replace(/-/g, '_')) && fromOwn) return 'undeclared';
    return 'env';
  }
  // The dependency is there but lacks what the server imports: it changed under the release. Called drift only when
  // the release declares it with no upper bound; anything else is not ours to tell (env, still not the server's fault).
  return has('uncapped') ? 'drift' : 'env';
}
/** A list error that is the server's own: a malformed result. (A JSON-RPC error is told by its numeric code.) */
const MALFORMED_LIST = /^the .* result has no .* array$|^nextCursor is not a string$|^the server repeated the same cursor$|^the answer has no result object$/;

/** Signs that crates.io could not be reached properly (our proxy, a name lookup, a time-out), not that the crate is missing. */
const CARGO_NOT_THE_CRATE = /spurious network error|failed to download|failed to query|Couldn't resolve|timed out|Connection|failed to get|proxy|SSL|certificate/i;

/**
 * R-LP-54: a crate's install failed for the crate's own reason only when cargo says so before anything compiled (a build
 * script prints what it likes once building starts) and nothing shows trouble reaching crates.io: "could not find
 * `<the crate>` in registry `crates-io`" (no such crate, or no such version) gives install_failed, "there is nothing to
 * install in `<the crate> ...`, because it has no binaries" gives package_not_runnable. The same evidence rule as
 * isokron-ai/mcp-writecheck-action loop/skips.mjs (R-WC-26, R-WC-31). Returns a detail or null.
 */
export function cargoInstallEvidence(text, crate) {
  const t = String(text || '');
  if (/^\s*Compiling /m.test(t) || CARGO_NOT_THE_CRATE.test(t)) return null;
  const same = (n) => String(n).toLowerCase().replace(/_/g, '-') === String(crate).toLowerCase().replace(/_/g, '-');
  const missing = /^error: could not find `([A-Za-z0-9_-]{1,64})` in registry `crates-io`/m.exec(t);
  if (missing && same(missing[1])) return 'install_failed';
  const nothing = /^error: there is nothing to install in `([A-Za-z0-9_-]{1,64}) v[0-9][^`]{0,80}`, because it has no binaries/m.exec(t);
  if (nothing && same(nothing[1])) return 'package_not_runnable';
  return null;
}

/** Signs that NuGet could not be reached properly (our proxy, a name lookup, TLS, a time-out), not that the package is missing. */
const NUGET_NOT_THE_PACKAGE = /NU1301|NU1801|NU1302|Unable to load the service index|Failed to retrieve information|Failed to download|proxy|SSL|certificate|timed out|timeout|Connection refused|Name or service not known|No such host|Resource temporarily unavailable/i;

/**
 * R-LP-57: a .NET tool's failed install is the package's own only on the .NET CLI's word, about this package id, with no
 * sign of trouble reaching NuGet (a NuGet install runs no code of the package, so nothing it ships can print): NU1101
 * (no package with this id) or NU1102 (no such version) gives install_failed; "is not a .NET tool" or no
 * DotnetToolSettings.xml in the package gives package_not_runnable. Returns a detail or null.
 */
export function nugetInstallEvidence(text, id) {
  const t = String(text || '');
  if (NUGET_NOT_THE_PACKAGE.test(t)) return null;
  const same = (n) => String(n).toLowerCase() === String(id).toLowerCase();
  const missing = /\berror NU110[12]: Unable to find package ([A-Za-z0-9_.-]{1,100})\b/.exec(t);
  if (missing && same(missing[1])) return 'install_failed';
  const notTool = /\b(?:Package|The package) '?([A-Za-z0-9_.-]{1,100})'? is not a \.NET tool|Settings file 'DotnetToolSettings\.xml' was not found in the package/.exec(t);
  if (notTool && (!notTool[1] || same(notTool[1]))) return 'package_not_runnable';
  return null;
}

/**
 * The answer of the install's entry helper (mcp-surface-corpus sandbox/cargo-entry.mjs, nuget-entry.mjs), as a detail
 * (R-LP-54, R-LP-56, R-LP-58). The install itself succeeded, so whatever the helper could not find (no binary, no tool
 * settings its store walk reached) is a limit of its own checks: never the package's.
 */
export function entryDetail(code) {
  if (code === 'several_binaries' || code === 'several_commands') return 'entry_ambiguous';
  // A build for other platforms only, or for a newer .NET than the sandbox's runtime: ours to run, not the package's lack.
  if (code === 'no_linux_build' || code === 'runtime_too_new') return 'platform_unsupported';
  return 'entry_unresolved';
}

/**
 * Whether the chosen package's registry entry is the subject's own: its name is in the owner's namespace
 * (io.github.<owner>/...), which the registry verifies. A seed-only package, an entry matched by the seed list's package
 * alone, or one matched by its repository URL is not shown to be theirs (R-LP-56).
 */
export const ownedEntry = (choice) => !!(choice && typeof choice.matched_by === 'string' && choice.matched_by.split('+').includes('namespace'));

/** Everything the install steps and the steps log say, as one text (step fields are only strings the driver wrote). */
function installText(inst, stepsLog) {
  const parts = [];
  for (const st of Array.isArray(inst.steps) ? inst.steps : []) if (st) for (const k of ['stderr', 'stdout', 'error', 'message', 'tail']) if (typeof st[k] === 'string') parts.push(st[k]);
  if (typeof stepsLog === 'string') parts.push(stepsLog);
  else if (Buffer.isBuffer(stepsLog)) parts.push(stepsLog.toString('utf8'));
  return parts.join('\n');
}

/** How many installs the proxy refused: the count the lane records, or the refused entries of the egress list. */
function refusedCount(inst) {
  if (Number.isInteger(inst.egress_refused)) return inst.egress_refused;
  return (Array.isArray(inst.egress) ? inst.egress : []).filter((e) => e && e.allowed === false).length;
}

/**
 * Network evidence in a runsc trace summary (mcp-surface-corpus trace-summary.mjs): a failed network call, a connect,
 * a send or a looked-up name. The trace is kept when the netlog files are lost (R-LP-41). Not counts.network: a healthy
 * server that touched no network showed counts.network 4 (local sockets inside the runtime), so it would mark every
 * server as needing the network and nothing could be the server's own failure (R-LP-42).
 */
function traceNetwork(sum) {
  if (!isObj(sum)) return false;
  const n = isObj(sum.network) ? sum.network : {};
  const len = (v) => (Array.isArray(v) ? v.length : Number(v) || 0);
  return (isObj(sum.failed) && Number(sum.failed.network) > 0) || len(n.connects) > 0 || len(n.sends) > 0 || len(n.dns_names) > 0;
}

/** Whether the server itself tried the network (the run has none): a lookup or connection in its role, or a failed network call in its trace. */
export function serverNetworkAttempt(records) {
  return (Array.isArray(records) ? records : []).some((r) => isObj(r) && r.role === 'server' && (r.type === 'dns_query' || r.type === 'connection'
    || (r.type === 'trace_summary' && traceNetwork(r.summary))));
}

/**
 * How the server's process ended, from the probe: { exit, signal }, read from the transport, else from the error text,
 * else (an HTTP-mode server, which has no stdio transport) from the sandbox's records of the server's containers, when
 * every one says it had exited by itself with the same code and the server's output was read back (R-LP-67).
 */
export function exitOf(p, records = []) {
  const e = exitRaw(p, records);
  // 128+n is a process killed by signal n (130 our interrupt, 137 a kill, 139 a segfault under the runtime, 143 our
  // docker stop): a signal, never the server's own exit code (R-LP-70).
  if (Number.isInteger(e.exit) && e.exit > 128 && e.exit < 160) return { exit: null, signal: SIGNAL_NAMES[e.exit - 128] || 'SIG' + (e.exit - 128) };
  return e;
}
const SIGNAL_NAMES = Object.freeze({ 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 6: 'SIGABRT', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 15: 'SIGTERM' });

function exitRaw(p, records) {
  const t = isObj(p.transport) ? p.transport : {};
  if (Number.isInteger(t.exit) || (typeof t.signal === 'string' && t.signal)) return { exit: Number.isInteger(t.exit) ? t.exit : null, signal: t.signal || null };
  const m = /\(exit (-?\d+|null), signal ([A-Za-z0-9]+|null)\)/.exec(String(p.initialize_error || p.error || ''));
  if (m) return { exit: m[1] === 'null' ? null : Number(m[1]), signal: m[2] === 'null' ? null : m[2] };
  // Only with the server's output in hand: before mcp-surface-corpus R-SBX-47 its stderr was not read back, and a
  // silent exit is no evidence against it.
  if (p.mode === 'http' && Number(p.stderr_bytes) > 0) {
    const c = (Array.isArray(records) ? records : []).filter((r) => isObj(r) && r.type === 'container' && r.role === 'server');
    const ok = c.length > 0 && c.every((r) => Number.isInteger(r.exit) && !r.timed_out && r.oom_killed !== true && !r.signal && r.exit === c[0].exit);
    if (ok) return { exit: c[0].exit, signal: null };
  }
  return { exit: null, signal: null };
}

/** How long the probe whose exit we read ran: its own total_ms (in the record's probe entry or the probe), else captured_at - started_at. */
function probeMs(rec, p, tag) {
  const t = [isObj(p.timing) ? p.timing.total_ms : null, isObj(rec.probes) && isObj(rec.probes[tag]) && isObj(rec.probes[tag].timing) ? rec.probes[tag].timing.total_ms : null];
  for (const v of t) if (Number.isFinite(v) && v >= 0) return v;
  const d = Date.parse(p.captured_at) - Date.parse(p.started_at);
  return Number.isFinite(d) && d >= 0 ? d : null;
}

/**
 * A server that did not declare the tools capability at initialize and answered tools/list "method not found"
 * (-32601): the answer the specification allows such a server (a prompts-only or resources-only one), not a failure
 * (R-LP-75). Only with an initialize answer in hand: a 2026-07-28 server that refused initialize declared nothing we read.
 */
export function noToolsCapability(p) {
  if (!isObj(p) || !isObj(p.initialize)) return false;
  const caps = p.initialize.capabilities;
  // A capabilities object is required: an initialize answer without one is malformed, not a statement of no tools.
  if (!isObj(caps)) return false;
  const declared = caps.tools !== undefined && caps.tools !== null && caps.tools !== false;
  const L = isObj(p.lists) ? p.lists['tools/list'] : null;
  return !declared && isObj(L) && L.error_code === -32601;
}

/** A list that did not come: the server's own fault only when it sent a JSON-RPC error or a malformed result. */
function listDetail(p) {
  if (noToolsCapability(p)) return 'no_tools_capability';
  const L = isObj(p.lists) ? p.lists['tools/list'] : null;
  const err = isObj(L) && typeof L.error === 'string' ? L.error : null;
  if (err) {
    if (Number.isInteger(L.error_code) && !/^HTTP \d{3}/.test(err)) return 'list_failed';
    if (MALFORMED_LIST.test(err)) return 'list_failed';
  }
  return 'list_probe_limited';
}

/**
 * Why an item that had a target got no live list: a detail code (DETAILS). The server is the one at fault (subject) only
 * with evidence our own environment cannot explain (R-LP-29..38); anything else is ours (tool). `ctx` carries what the lane
 * records beside the driver's record: records (this target's telemetry), stepsLog (the install's log text), launch and
 * argsUnfilled (the plan's resolution of it), and pydeps (a PyPI release's own modules and declared dependencies, R-LP-61).
 * Our sandbox's limits, another platform, the network, extras and dependency drift are told apart before any crash
 * is blamed (R-LP-59..65).
 */
export function failureDetail(rec, bare, envp, { deadlineHit = false, records = [], stepsLog = null, launch = null, argsUnfilled = null, pydeps = null, owned = false, crashNotEvidence = false, entryGuess = false, pypiRelease = null } = {}) {
  if (!rec) return deadlineHit ? 'shard_deadline' : 'harness_error';
  if (rec.excluded) return 'sandbox_evidence_missing';
  const inst = rec.install;
  if (!inst) return rec.timed_out ? 'shard_deadline' : 'harness_error';
  if (!inst.ok) {
    // The planner already read this image's digest, so a failed pull is not the image's absence (R-LP-37).
    // An image for another platform than linux/amd64 is no defect: we run that one only (mcp-surface-corpus R-SBX-46).
    if (inst.kind === 'docker') return isObj(inst.oci) && inst.oci.platform_unsupported ? 'unsupported_platform' : 'image_pull_failed';
    const steps = Array.isArray(inst.steps) ? inst.steps : [];
    if (rec.timed_out || steps.some((s) => s && s.timed_out)) return 'install_timeout';
    const failed = steps.filter((s) => s && Number.isInteger(s.exit) && s.exit !== 0);
    if (!failed.length) return 'harness_error';
    const text = installText(inst, stepsLog);
    if (failed.some((s) => s.exit === 137 || s.exit === 124) || OOM_TEXT.test(text)) return 'install_resource_limit';
    if (refusedCount(inst) > 0) return 'install_blocked';
    // R-LP-86: npm refused a package built for another OS, CPU or libc (package.json `os`/`cpu`/`libc`): we run Linux on
    // amd64 only; that is no fault of the package.
    if (inst.kind === 'npm' && NPM_PLATFORM.test(text)) return 'unsupported_platform';
    if (inst.kind === 'cargo') {
      // Only cargo's own words before any build, or our entry helper's answer, can be the crate's (R-LP-54).
      const entry = failed.find((s) => s.name === 'entry');
      if (entry) return entryDetail(isObj(entry.result) ? entry.result.error : null);
      const ev = failed.some((s) => s.name === 'install') && cargoInstallEvidence(text, isObj(launch) ? launch.crate : null);
      // The crate's own word counts against the subject only when its registry entry is the subject's (R-LP-56).
      return ev ? (owned ? ev : 'package_error_unowned') : 'install_build_failed';
    }
    if (inst.kind === 'mcpb') {
      // R-LP-73: the planner already read these very bytes (their sha256 is pinned) and judged the bundle; what goes wrong
      // in the sandbox (the download, our caps, a uv bundle's pip install, which runs its dependencies' builds) is ours.
      const fetchStep = failed.find((s) => s.name === 'fetch');
      const code = fetchStep && isObj(fetchStep.result) ? fetchStep.result.error : null;
      return ['too_large', 'too_many_files', 'too_big_unpacked'].includes(code) ? 'install_resource_limit' : 'install_build_failed';
    }
    if (inst.kind === 'nuget') {
      const entry = failed.find((s) => s.name === 'entry');
      if (entry) return entryDetail(isObj(entry.result) ? entry.result.error : null);
      const ev = failed.some((s) => s.name === 'install') && nugetInstallEvidence(text, isObj(launch) ? launch.package : null);
      // The CLI's word counts against the subject only when the registry entry is the subject's (R-LP-56, R-LP-58).
      return ev ? (owned ? ev : 'package_error_unowned') : 'install_build_failed';
    }
    return packageInstallEvidence(inst.kind, text, { launch, owned, release: pypiRelease });
  }
  const p = envp || bare;
  if (!p) return rec.timed_out ? 'start_timeout' : 'harness_error';
  if (p.initialize || p.era === 'modern') return listDetail(p);
  if (rec.timed_out || /^time limit/.test(String(p.error || ''))) return 'start_timeout';
  // The sandbox refused the image's WORKDIR (under /proc, /sys or /dev) and ran it in /tmp: not where it expects to run.
  if (isObj(inst.oci) && inst.oci.workdir_refused) return 'start_env_limited';
  // Credentials only when the publisher declares a required env var (the registry entry). A secret-looking name in the
  // README or the source is no such evidence: optional keys are common, and the server failed with dummies too.
  const needsEnv = !!(rec.env && rec.env.names && Array.isArray(rec.env.names.registry) && rec.env.names.registry.length);
  const net = serverNetworkAttempt(records);
  const { exit, signal } = exitOf(p, records);
  // 125 is docker run's own failure, 126 and 127 are not-executable and command-not-found (what an unresolved PyPI
  // venv/bin/<package> guess gives), 137 a kill: none is the server's own exit (R-LP-39).
  const own = Number.isInteger(exit) && exit !== 0 && ![125, 126, 127, 137].includes(exit) && !signal;
  // A PyPI launch with no entry runs venv/bin/<package name>, a guess: the console script often has another name.
  // A lone console script with no server signal is our pick too (R-LP-82): run, but never evidence.
  const guess = !isObj(launch) || !launch.kind || (launch.kind === 'pypi' && (!launch.entry || entryGuess));
  const sound = own && argsUnfilled === 0 && !guess;
  // R-LP-58: a .NET tool built for an older runtime ran rolled forward onto the sandbox's .NET 10; R-LP-74: a bundle that
  // does not run here as shipped (its manifest does not list linux, it is python or uv on an environment we rebuilt, or
  // links were left out when it was unpacked). Its exit may be ours, so nothing below counts it against the server (a
  // crash, a module it lacks, a quiet exit with a declared variable).
  const noEvidence = rolledForward(inst) || crashNotEvidence;
  const blamable = sound && !noEvidence;
  const err = typeof p.stderr === 'string' ? p.stderr : '';
  // What stopped the start before the server's own code could fail, in our words (R-LP-60..64), ahead of any
  // finding against the server: another operating system, the network, our sandbox's limits.
  const bin = MISSING_BIN.map((re) => re.exec(err)).find(Boolean);
  if (on('platform') && (PLATFORM_TEXT.test(err) || (bin && PLATFORM_BIN.test(bin[1])))) return 'unsupported_platform';
  if (net || (on('network') && NETWORK_TEXT.test(err))) return 'start_needs_network';
  if (on('env') && (ENV_TEXT.test(err) || bin)) return 'start_env_limited';
  // An import that failed: an extra we did not install, a dependency that changed under the release, or one we cannot
  // tell; only the server's own module can be its crash (R-LP-61, R-LP-62).
  const imp = importCause(failedImport(err), { pydeps, pkg: isObj(launch) ? launch.package : null, err, installedExtras: isObj(launch) && Array.isArray(launch.extras) ? launch.extras : [] });
  if (on('extra') && (EXTRA_HINT.test(err) || imp === 'extra')) return 'start_needs_extra';
  // R-LP-81: the MCP SDK's own word that a 1.x server got 2.x is drift, whatever the import looked like.
  if (on('drift') && (imp === 'drift' || MCP2_TEXT.test(err))) return 'start_dependency_drift';
  if (on('import') && imp === 'env') return 'start_env_limited';
  // The server's own packaging (R-LP-68): its wheel lacks a module of its own package, or its own code imports a module
  // the release neither ships nor declares, and that is not installed. Only with the release's facts in hand.
  if (imp === 'own_missing' && blamable) return 'missing_own_module';
  if (imp === 'undeclared' && blamable) return 'undeclared_dependency';
  // A declared variable makes a quiet own exit needs_credentials; a crash that asks for no configuration is a crash.
  if (needsEnv && !blamable) return 'start_env_limited';
  if (needsEnv && !(CRASH_TEXT.test(err) && !CONFIG_TEXT.test(err) && !CONFIG_CASE_RE.test(err) && !ENV_NAME_TEXT.test(err))) return 'needs_credentials';
  // The probe's own duration, not the record's total (which holds the install and the analysis too, R-LP-40).
  const ms = probeMs(rec, p, p === envp ? 'env' : 'bare');
  // The server's own exit and its stderr: it said it needs configuration we did not give it (R-LP-44), which is no defect.
  if (own && (CONFIG_BASE_RE.test(err) || (on('config') && (CONFIG_MORE_RE.test(err) || CONFIG_CASE_RE.test(err))) || ENV_NAME_TEXT.test(err))) return 'start_needs_config';
  // A Python crash whose last frame is inside a dependency (a SyntaxError or `X | Y` TypeError of a Python version it
  // does not support, a bug of its own) is not the server's code failing (R-LP-69).
  if (on('frame') && frameInDependency(err, { pydeps, pkg: isObj(launch) ? launch.package : null })) return 'start_env_limited';
  // A crash signature is the evidence; an early exit with no telling stderr is not (R-LP-45).
  return blamable && ms !== null && ms < START_QUICK_MS && CRASH_TEXT.test(err) ? 'start_failed' : 'start_env_limited';
}

/**
 * R-LP-74: whether a bundle's crash is no evidence against it: the planner said so (no linux in its manifest, python or uv
 * on an environment we rebuilt), or the sandbox left links out when it unpacked it (a file the server may need is missing).
 */
export function crashNotEvidenceOf(choice, rec) {
  if (choice && isObj(choice.mcpb) && choice.mcpb.crash_not_evidence) return true;
  const inst = rec && isObj(rec.install) ? rec.install : null;
  if (!inst || inst.kind !== 'mcpb') return false;
  const f = (Array.isArray(inst.steps) ? inst.steps : []).find((x) => x && x.name === 'fetch');
  return !!(f && isObj(f.result) && Number(f.result.links_skipped) > 0);
}

/**
 * R-LP-82: an entry that is our pick, not the publisher's, so its failure is never evidence against the server: a lone
 * script with no server signal, and the script read from the registry's first package argument (our reading of the
 * args: a `uvx <package> <args>` launch passes them to the package's own script).
 */
export const ENTRY_GUESS_SOURCES = Object.freeze(['lone_script', 'registry_args']);
export const entryGuessOf = (choice) => !!(isObj(choice) && ENTRY_GUESS_SOURCES.includes(choice.entry_source));

/**
 * Whether a .NET tool ran on another runtime than it was built for: its entry's target framework is not net10.0 or newer
 * (net8.0, netcoreapp3.1, netstandard2.0, a platform-suffixed or unreadable one, or none recorded). Only a tool built for
 * the sandbox's own runtime runs as shipped (R-LP-58).
 */
export function rolledForward(inst) {
  if (!isObj(inst) || inst.kind !== 'nuget') return false;
  const e = (Array.isArray(inst.steps) ? inst.steps : []).find((x) => x && x.name === 'entry');
  const tfm = e && isObj(e.result) && typeof e.result.tfm === 'string' ? e.result.tfm : '';
  const m = /^net([0-9]{1,2})\.([0-9])$/.exec(tfm);
  return !m || Number(m[1]) * 10 + Number(m[2]) < 100;
}

// ------------------------------------------------------------------ observations

/** One observations line, checked against FIELDS. A value of the wrong type is written as null with why. */
export function obs(field, value, why) {
  const type = FIELDS[field] || (EMIT_TOOL_LIST_FIELDS ? TOOL_LIST_FIELDS[field] : undefined) || (EMIT_TOOL_NAMES_FIELD ? TOOL_NAMES_FIELDS[field] : undefined) || (EMIT_LAUNCH_RETRY_FIELD ? LAUNCH_RETRY_FIELDS[field] : undefined) || (EMIT_ORACLE_FIELDS ? ORACLE_FIELDS[field] : undefined) || (EMIT_FUZZ_FIELDS ? FUZZ_FIELDS[field] : undefined);
  if (!type) throw new Error('not a field of this lane: ' + field);
  const ok = value !== null && value !== undefined && checkType(type, value);
  return JSON.stringify(ok ? { field, value, stage: STAGE } : { field, value: null, why: why || (value === null || value === undefined ? 'not observed' : 'not of the registry type'), stage: STAGE });
}
function checkType(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isSafeInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'enum': return typeof v === 'string' && ENUM_RE.test(v);
    case 'array': return Array.isArray(v);
    case 'object': return isObj(v);
    case 'timestamp': return isDateTime(v);
    case 'hash': return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
    default: return false;
  }
}

const CAP_KEYS = ['tools', 'prompts', 'resources', 'logging', 'completions', 'experimental'];
/** capabilities_flags: what the server declared, as booleans; other keys only counted. */
export function capabilityFlags(caps) {
  if (!isObj(caps)) return null;
  const sub = (k, f) => isObj(caps[k]) && caps[k][f] === true;
  return {
    tools: k(caps, 'tools'), tools_list_changed: sub('tools', 'listChanged'),
    prompts: k(caps, 'prompts'), prompts_list_changed: sub('prompts', 'listChanged'),
    resources: k(caps, 'resources'), resources_subscribe: sub('resources', 'subscribe'), resources_list_changed: sub('resources', 'listChanged'),
    logging: k(caps, 'logging'), completions: k(caps, 'completions'), experimental: k(caps, 'experimental'),
    other_keys: Object.keys(caps).filter((x) => !CAP_KEYS.includes(x)).length,
  };
  function k(o, n) { return o[n] !== undefined && o[n] !== null && o[n] !== false; }
}

/** server_info: name, version and title when they are plain, always their hashes. */
export function serverInfo(info) {
  if (!isObj(info)) return null;
  const f = (x, re) => (typeof x === 'string' ? { v: safeText(x, re), h: sha256(x) } : { v: null, h: null });
  const n = f(info.name, SAFE_NAME); const v = f(info.version, SAFE_VERSION); const t = f(info.title, SAFE_NAME);
  return { name: n.v, version: v.v, title: t.v, name_sha256: n.h, version_sha256: v.h, title_sha256: t.h, other_keys: Object.keys(info).filter((x) => !['name', 'version', 'title'].includes(x)).length };
}

/** The registry and package fields, from the resolution (subject strings only when safeText passes). */
function resolutionObs(r) {
  const lines = [];
  const reg = r && r.registry; const c = r && r.choice;
  if (reg) {
    lines.push(obs('registry_name', safeText(reg.name, REGISTRY_NAME), 'not a plain registry name'));
    lines.push(obs('registry_version', safeText(reg.version, SAFE_VERSION), 'no plain version'));
    if (reg.transports && reg.transports.length) lines.push(obs('transports_offered', reg.transports.map((x) => safeText(x, /^[a-z][a-z-]{0,29}$/)).filter(Boolean)));
  }
  if (c) {
    lines.push(obs('registry_package_register_type', c.type));
    lines.push(obs('registry_package_identifier', safeText(c.identifier, /^[A-Za-z0-9@][A-Za-z0-9@._/:-]{0,299}$/), 'not a plain package name'));
    lines.push(obs('registry_package_version', safeText(c.version, SAFE_VERSION), 'no plain version'));
    lines.push(obs('registry_package_transport', c.transport === 'http' ? 'streamable-http' : 'stdio'));
    if (c.runtime_hint) lines.push(obs('registry_package_runtime_hint', safeText(c.runtime_hint, /^[a-z][a-z0-9_-]{0,29}$/), 'not a plain runtime hint'));
    if (c.purl) lines.push(obs('package_purl', safeText(c.purl, /^pkg:[a-z]+\/[A-Za-z0-9%._/@-]{1,300}$/), 'not a plain package URL'));
    if (c.oci_digest) lines.push(obs('oci_digest', c.oci_digest));
  }
  return lines;
}

// ------------------------------------------------------------------ oracles

/** Every tool of a probe's tools/list pages, in order (our reader's list, for the oracle judge). */
export function toolsOf(rawPages) {
  return (Array.isArray(rawPages) ? rawPages : []).flatMap((p) => (p && isObj(p.result) && Array.isArray(p.result.tools) ? p.result.tools : []));
}

/**
 * R-LP-87: sha256(JSON.stringify([...new Set(names)].sort())) of the live list's tool names (the wire names the engine
 * counts for tool_count; a tool with no string name has none): deduplicated, then the default JavaScript sort (UTF-16
 * code units, not localeCompare), with no case or space folding. Byte for byte the ast-grep oracle's tool_set_sha256
 * (corpus/ast-grep/index.mjs summarize), so the source reads and the live list compare by names (tool-qa state/oracle.mjs,
 * the three-way rule). Null when no tool is named.
 */
export function toolNamesSha256(names) {
  const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string');
  return list.length ? sha256(JSON.stringify([...new Set(list)].sort())) : null;
}

/**
 * The oracle records the driver wrote for a target (corpus/live-probe-driver.mjs): the one judged (the full stage,
 * else the clients-only one), every record kept for raw/, and their time together. null when there is none.
 */
export function oracleRecord(dir) {
  const all = ['oracles.json', 'oracles-unlisted.json', 'oracles-error.json'].map((f) => ({ file: f, rec: readJson(join(dir, f)) })).filter((x) => x.rec);
  if (!all.length) return null;
  return { ...all[0], all, ms: all.reduce((a, x) => a + (int(x.rec.ms) || 0), 0) };
}

/**
 * One target's oracle results: the field lines, the raw record, a summary for results/, and the oracle components
 * for the meta file. reader: our own reader's view of the same target (judge.mjs).
 */
export function oracleFor(dir, item, reader, ctx) {
  const pins = ctx.oraclePins;
  const found = dir ? oracleRecord(dir) : null;
  const transport = item.target && item.target.launch ? item.target.launch.transport || 'stdio' : null;
  const lines = []; const raw = [];
  if (!pins) return { lines, raw, summary: null, components: [] };
  const baseline = ctx.oracleBaseline && ctx.oracleBaseline.subjects ? ctx.oracleBaseline.subjects[item.subject] || null : null;
  const j = judgeOracles(found ? found.rec : null, { reader, pins, baseline });
  if (!found) {
    j.why = transport && transport !== 'stdio' ? 'http_transport' : ctx.oracleInstalled === false ? 'not_installed' : 'not_run';
  }
  lines.push(obs('oracle_stage', { status: j.status, mode: j.mode, why: j.why, ms: j.ms, record: found ? found.file.replace(/\.json$/, '') : null, probe_listed: !!(reader && reader.listed) }));
  if (j.status === 'ran') {
    lines.push(obs('sdk_client_results', j.clients));
    if (j.conformance) {
      lines.push(obs('conformance_suite', { ...j.conformance.suite, bridge: j.conformance.bridge }));
      lines.push(obs('conformance_summary', { problem: j.conformance.problem, revisions: j.conformance.summary }));
      lines.push(obs('conformance_checks', j.conformance.checks));
    }
    lines.push(obs('oracle_disagreements', j.disagreements));
  }
  if (found) for (const x of found.all) raw.push(['raw/' + x.file, Buffer.from(json(x.rec))]);
  const summary = {
    status: j.status, mode: j.mode, why: j.why, ms: found ? found.ms : j.ms,
    clients: j.clients.map((c) => ({ client: c.client, outcome: c.outcome, protocol: c.protocol_negotiated, tool_count: c.tool_count })),
    conformance: j.conformance ? Object.fromEntries(Object.entries(j.conformance.summary).map(([k, v]) => [k, { pass: v.pass, fail: v.fail, expected_fail: v.expected_fail, not_applicable: v.not_applicable, bridge_excluded: v.bridge_excluded, scenarios_run: v.scenarios_run }])) : null,
    disagreements: j.disagreements.map((d) => d.class + ' ' + d.kind + ' ' + d.oracle_a + ' ' + d.oracle_b),
    baseline_problems: baseline ? baselineProblems(j, baseline) : null,
  };
  return { lines, raw, summary, components: j.components };
}


// ------------------------------------------------------------------ the fuzz stage

const FUZZ_WORD = /^[a-z][a-z0-9_-]{0,59}$/;
const CODEPOINT = /^U\+[0-9A-F]{4,6}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** Evidence as it may leave raw/: counts, hashes and code points only. A server's strings never pass. */
export function safeEvidence(ev) {
  if (!isObj(ev)) return {};
  const out = {};
  for (const [k, v] of Object.entries(ev)) {
    if (!FUZZ_WORD.test(k)) continue;
    if (Number.isSafeInteger(v) || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && (HEX64.test(v) || FUZZ_WORD.test(v))) out[k] = v;
    else if (k === 'findings' && Array.isArray(v)) out[k] = v.slice(0, 50).map((f) => ({ primitive: safeText(f.primitive, /^(tools|prompts|resources|templates|\*)$/), field: safeText(f.field, /^(name|uri|\*)$/), index: int(f.index), kind: safeText(f.kind, FUZZ_WORD), codepoints: (Array.isArray(f.codepoints) ? f.codepoints : []).filter((c) => typeof c === 'string' && CODEPOINT.test(c)).slice(0, 8), name_sha256: HEX64.test(f.name_sha256) ? f.name_sha256 : null }));
  }
  return out;
}

/** One result as it goes into results/ and the fields. */
export function fuzzRow(r) {
  return { id: safeText(r.id, /^(FZ-[A-Z]+-[0-9]|\*)$/), primitive: safeText(r.primitive, /^(tools|prompts|resources|templates|\*)$/), verdict: safeText(r.verdict, /^(pass|fail|warn|observation|na|inconclusive)$/), kind: safeText(r.kind, FUZZ_WORD), fault: r.fault === 'subject' || r.fault === 'tool' ? r.fault : null, reproduced: r.reproduced === true ? true : r.reproduced === false ? false : null, evidence: safeEvidence(r.evidence) };
}

/** probe_ms without the stages that run inside the driver's probe call (the oracle stage, R-ORC-02, and the fuzz stage). */
export const withoutStages = (probeMs, ...stageMs) => (probeMs === null || probeMs === undefined ? null : Math.max(0, probeMs - stageMs.reduce((a, x) => a + (Number.isSafeInteger(x) ? x : 0), 0)));

export function fuzzRecord(dir) {
  const rec = dir ? readJson(join(dir, 'fuzz.json')) : null;
  return isObj(rec) && rec.format === 'isokron-live-probe-fuzz/1' ? rec : null;
}

/**
 * One target's fuzz results: the field lines (only while EMIT_FUZZ_FIELDS), the raw record, and a summary for
 * results/. Null when the stage is not switched on for this shard: such a bundle holds nothing of it.
 */
export function fuzzFor(dir, item, ctx) {
  if (!ctx.plan || ctx.plan.fuzz !== true) return null;
  const transport = item.target && item.target.launch ? item.target.launch.transport || 'stdio' : null;
  const rec = fuzzRecord(dir);
  const lines = []; const raw = [];
  const status = !rec ? 'not_run' : rec.mode === 'full' ? 'ran' : rec.mode === 'skipped' ? 'skipped' : 'error';
  const why = !rec ? (transport && transport !== 'stdio' ? 'http_transport' : 'not_run') : safeText(rec.why, FUZZ_WORD);
  const rows = rec && Array.isArray(rec.results) ? rec.results.map(fuzzRow) : [];
  const stage = { status, mode: rec ? safeText(rec.mode, FUZZ_WORD) : null, why, ms: rec ? int(rec.ms) : null, rounds: rec && Array.isArray(rec.rounds) ? rec.rounds.length : 0, sessions: rec && Array.isArray(rec.containers) ? rec.containers.length : 0 };
  if (rec) raw.push(['raw/fuzz.json', Buffer.from(json(rec))]);
  if (EMIT_FUZZ_FIELDS) {
    lines.push(obs('fuzz_stage', stage));
    if (status === 'ran') {
      lines.push(obs('invariant_results', rows.filter((r) => !r.id || !r.id.startsWith('FZ-UNI'))));
      lines.push(obs('unicode_identifier_findings', rows.filter((r) => r.id && r.id.startsWith('FZ-UNI'))));
      const det = rows.filter((r) => (r.id === 'FZ-CAT-1' || r.id === 'FZ-CAT-2') && r.primitive === 'tools' && (r.verdict === 'pass' || r.verdict === 'fail' || r.verdict === 'warn'));
      if (det.length) lines.push(obs('list_determinism', det.every((r) => r.verdict === 'pass')));
    }
  }
  return { lines, raw, summary: { ...stage, counts: rec && rec.summary ? rec.summary : null, results: rows } };
}

/**
 * The configuration the listing probe ran with (R-LP-80): none (the bare probe), defaults (every name it set is one the
 * registry entry declares with a default we passed as given), dummy (any dummy value: a required name with no default,
 * a name read from the README or the source).
 */
export function configStateOf(probe, bare, rec, launch) {
  if (probe === bare) return 'none';
  const used = isObj(rec) && isObj(rec.env) && isObj(rec.env.names) && Array.isArray(rec.env.names.used) ? rec.env.names.used : null;
  const given = isObj(launch) && isObj(launch.env) ? launch.env : {};
  return used && used.length && used.every((n) => typeof given[n] === 'string') ? 'defaults' : 'dummy';
}

// ------------------------------------------------------------------ one retry (R-LP-81)

export const RETRY_FORMAT = 'isokron-mcp-check-live-probe-retry/1';
/** The MCP SDK's own word that a server written for 1.x got 2.x: its message, or the 1.x module 2.x no longer has. */
const MCP2_TEXT = /\bThis is mcp 2\.x\b|No module named 'mcp\.server\.fastmcp'/;

/** A launch with a retry's change applied: { constraints } added to a PyPI install, { args_prefix } before its args. */
export function retryLaunch(launch, change) {
  if (!isObj(launch) || !isObj(change)) return launch;
  const out = { ...launch };
  if (Array.isArray(change.constraints)) out.constraints = [...(Array.isArray(launch.constraints) ? launch.constraints : []), ...change.constraints];
  if (Array.isArray(change.args_prefix)) out.args = [...change.args_prefix, ...(Array.isArray(launch.args) ? launch.args : [])];
  return out;
}

/** The subcommands that serve MCP, in the order one is tried (R-LP-83). */
export const SERVE_SUBCOMMANDS = Object.freeze(['mcp', 'stdio', 'serve', 'server', 'run', 'start']);
/** A command line's own usage banner: argparse, Click and Typer, commander, and the plain "a subcommand must be given". */
const USAGE_TEXT = /(?:^|\n)\s*usage:\s|(?:^|\n)Commands:\s*\n|\bsubcommand (?:must be|is required)|\bmissing (?:sub)?command\b|\bthe following arguments are required: (?:command|subcommand|\{)/i;

/**
 * The subcommand a usage banner lists that serves MCP, or null: a word of SERVE_SUBCOMMANDS that the banner names as a
 * choice (argparse `{reviews,mcp}`, `<serve|compare>`, a Click/Typer or commander `Commands:` list, `e.g. 'x stdio ...'`).
 * Never one it does not list.
 */
export function serveSubcommand(text) {
  const t = String(text || '').slice(0, 20000);
  if (!USAGE_TEXT.test(t)) return null;
  const listedWords = new Set();
  for (const m of t.matchAll(/[{<]([A-Za-z0-9_-]+(?:[,|][A-Za-z0-9_-]+)+)[}>]/g)) for (const w of m[1].split(/[,|]/)) listedWords.add(w.toLowerCase());
  const cmds = /(?:^|\n)\s*(?:Commands|Available commands|Subcommands):\s*\n((?:[ \t]*(?:[│|][ \t]*)?[A-Za-z0-9_-]+(?:[ \t,][^\n]*)?\n?){1,60})/i.exec(t);
  if (cmds) for (const line of cmds[1].split('\n')) { const w = /^[ \t]*(?:[│|][ \t]*)?([A-Za-z0-9_-]+)/.exec(line); if (w) listedWords.add(w[1].toLowerCase()); }
  for (const m of t.matchAll(/\be\.g\.?\s*['"`]?[A-Za-z0-9_.-]+\s+([A-Za-z0-9_-]+)/g)) listedWords.add(m[1].toLowerCase());
  return SERVE_SUBCOMMANDS.find((w) => listedWords.has(w)) || null;
}

/**
 * Whether a subject's first run earns one retry with a changed launch, and which: { reason, change } or null. Never a
 * change of fault: the retry only tests whether the cause we named was the cause. mcp_drift: a PyPI server whose start
 * failed on an import the MCP SDK's 2.x line no longer has (`mcp.server.fastmcp`, a name or attribute of `mcp`), or on
 * the SDK's own "This is mcp 2.x" message, while its release declares `mcp` with no upper bound (pip installed today's
 * newest, long after the release): run again with `mcp<2`. The release-date resolve (pip --uploaded-prior-to, uv
 * --exclude-newer) needs the sandbox to take it; until then the known cap is the change.
 */
export function retryFor(item, { rec, bare, envp } = {}) {
  const l = isObj(item) && isObj(item.target) ? item.target.launch : null;
  if (!isObj(l)) return null;
  return driftRetry(item, l, { rec, bare, envp }) || cliRetry(l, { rec, bare, envp });
}

function driftRetry(item, l, { rec, bare, envp }) {
  if (l.kind !== 'pypi') return null;
  if (listed(envp) || listed(bare) || !isObj(rec) || !isObj(rec.install) || rec.install.ok !== true) return null;
  const err = [bare, envp].map((p) => (isObj(p) && typeof p.stderr === 'string' ? p.stderr : '')).join('\n');
  const imp = failedImport(err);
  const mcpApi = !!imp && imp.runtime === 'python' && imp.kind === 'api' && normDist(imp.module.split('.')[0]) === 'mcp';
  if (!mcpApi && !MCP2_TEXT.test(err)) return null;
  const pydeps = isObj(item.resolution) && isObj(item.resolution.choice) ? item.resolution.choice.pydeps : null;
  // A release that caps mcp cannot have floated to 2.x; one we know nothing about may have.
  if (isObj(pydeps) && Array.isArray(pydeps.base) && pydeps.base.includes('mcp') && !(Array.isArray(pydeps.uncapped) && pydeps.uncapped.includes('mcp'))) return null;
  const cons = Array.isArray(l.constraints) ? l.constraints : [];
  if (cons.length >= 10 || cons.some((c) => /^mcp\s*[<>=~!]/i.test(String(c)))) return null;
  return { reason: 'mcp_drift', change: { constraints: ['mcp<2'] } };
}

/**
 * R-LP-83: cli_subcommand. A PyPI or npm entry that is a command line with subcommands printed its usage and exited
 * (nothing tells us which subcommand serves MCP): when the banner lists one of SERVE_SUBCOMMANDS, run again once with it
 * first. Never a subcommand the banner does not list, and not when the arguments already begin with one.
 */
function cliRetry(l, { rec, bare, envp }) {
  if (!['pypi', 'npm'].includes(l.kind)) return null;
  if (listed(envp) || listed(bare) || !isObj(rec) || !isObj(rec.install) || rec.install.ok !== true) return null;
  const args = Array.isArray(l.args) ? l.args : [];
  if (args.length >= 40 || (args[0] && SERVE_SUBCOMMANDS.includes(String(args[0]).toLowerCase()))) return null;
  for (const p of [bare, envp]) {
    if (!isObj(p) || typeof p.stderr !== 'string') continue;
    // It exited by itself (argparse 2, Click/Typer 2, others 0 or 1), not a signal or a time limit.
    const t = isObj(p.transport) ? p.transport : {};
    if (!Number.isInteger(t.exit) || ![0, 1, 2, 64].includes(t.exit) || t.signal) continue;
    const sub = serveSubcommand(p.stderr);
    if (sub) return { reason: 'cli_subcommand', change: { args_prefix: [sub] } };
  }
  return null;
}

/**
 * Plan the retries from the subjects' first runs (driver-subjects, read as data): targets-retry.json (the same targets,
 * the changed launch, each checked by the sandbox's own target check) and retry.json. Returns the retries.
 */
export function planRetries({ work, validateTarget = () => {} }) {
  const plan = readJson(join(work, 'plan.json'));
  if (!plan || plan.format !== PLAN_FORMAT) throw new Error('no plan in the work folder');
  const subj = readJson(join(work, 'targets-subjects.json'));
  const ran = new Set(isObj(subj) && Array.isArray(subj.targets) ? subj.targets.map((t) => isObj(t) && t.id) : []);
  const targets = []; const retries = [];
  for (const it of plan.items) {
    if (!isObj(it.target) || !ran.has(it.target.id)) continue;
    const dir = join(work, 'driver-subjects', it.target.id);
    const r = retryFor(it, { rec: readJson(join(dir, 'record.json')), bare: readJson(join(dir, 'probe-bare.json')), envp: readJson(join(dir, 'probe-env.json')) });
    if (!r) continue;
    const target = { ...it.target, launch: retryLaunch(it.target.launch, r.change) };
    try { validateTarget(target, targets.length); } catch { continue; }
    targets.push(target); retries.push({ id: it.target.id, reason: r.reason, change: r.change });
  }
  writeFileSync(join(work, 'targets-retry.json'), json({ format: TARGETS_FORMAT, about: 'live-probe retries', defaults: { timeout_s: plan.subject_timeout_s }, targets }));
  writeFileSync(join(work, 'retry.json'), json({ format: RETRY_FORMAT, retries }));
  return retries;
}

/** retry.json as the bundle step trusts it: { <target id>: { reason, change } }, only well-formed entries. */
export function retriesOf(file) {
  const j = readJson(file);
  const out = {};
  if (!isObj(j) || j.format !== RETRY_FORMAT || !Array.isArray(j.retries)) return out;
  for (const x of j.retries.slice(0, 100)) {
    if (!isObj(x) || typeof x.id !== 'string' || !/^s[0-9]{3}$/.test(x.id) || !['mcp_drift', 'cli_subcommand'].includes(x.reason)) continue;
    const ch = isObj(x.change) ? x.change : {};
    const c = x.reason === 'mcp_drift'
      ? (Array.isArray(ch.constraints) && ch.constraints.every((v) => typeof v === 'string' && /^[A-Za-z0-9._-]{1,60}[<>=!~]{1,2}[0-9][0-9.]{0,20}$/.test(v)) ? { constraints: ch.constraints.slice(0, 10) } : null)
      : (Array.isArray(ch.args_prefix) && ch.args_prefix.length === 1 && SERVE_SUBCOMMANDS.includes(ch.args_prefix[0]) ? { args_prefix: [ch.args_prefix[0]] } : null);
    if (c) out[x.id] = { reason: x.reason, change: c };
  }
  return out;
}

// ------------------------------------------------------------------ one item

/** Everything about one item: { status, detail, files, skips, subjectSha }. Never throws on subject data. */
export function buildItem(item, ctx) {
  const files = {};
  const r = item.resolution;
  const lines = [obs('subject_id', item.subject)];
  const result = {
    format: FORMAT, lane: LANE, subject: item.subject, status: null, detail: null, skip_reason: null, fault: null, retryable: false,
    engine_version: VERSION, rubric_version: M.RUBRIC_VERSION, spec_version: M.SPEC_VERSION,
    install: null, unverified: null, live: null, static_vs_live: null, timing: { resolve_ms: int(item.resolve_ms) }, sandbox: ctx.sandboxSummary,
    driver: null, oracles: null, raw_truncated: [],
  };
  if (r) {
    lines.push(...resolutionObs(r));
    result.install = r.choice ? { method: r.choice.type, matched_by: safeText(r.choice.matched_by, /^[a-z+-]{1,40}$/), verified_by: safeText(r.choice.verified_by, /^[a-z_]{1,20}$/), provenance_signer: safeText(r.choice.provenance_signer, /^[a-z_]{1,40}$/), oci_bytes: int(r.choice.oci_bytes), transport: r.choice.transport, version_requested: safeText(r.choice.version, SAFE_VERSION), args: r.choice.args_n, args_unfilled: r.choice.args_unfilled, env_declared: r.choice.env_names.length, registry_entries: r.registry ? r.registry.entries : 0, entry_source: safeText(r.choice.entry_source, /^[a-z_]{1,30}$/) } : null;
    if (Array.isArray(r.unverified)) result.unverified = r.unverified.map((u) => safeText(u.why, /^[a-z_]{1,40}$/));
    files['raw/resolution.json'] = json({ registry: r.registry, choice: r.choice, candidates: r.candidates, launch: r.launch, subdir: r.subdir, seed_packages: r.seed_packages, invalid: r.invalid ?? null, unverified: r.unverified ?? null, transport_refused: r.transport_refused ?? null, ...(r.error_class ? { error_class: safeText(r.error_class, /^[A-Za-z]{1,40}$/) } : {}) });
  }
  let detail = null; let subjectSha = null; let deadlineHit = ctx.deadlineHit;
  let oracle = { lines: [], raw: [], summary: null, components: [] };
  if (!r || r.status !== 'runnable' || !item.target_id) {
    detail = (r && r.detail) || 'harness_error';
  } else {
    const oci = item.target && item.target.launch && item.target.launch.kind === 'docker' && ctx.ociOut;
    const build = !oci && item.target && isBuild(item.target.launch) && ctx.buildsOut;
    let dir = oci ? join(ctx.ociOut, item.target_id, item.target_id) : build ? join(ctx.buildsOut, item.target_id) : join(ctx.subjectsOut, item.target_id);
    let telemetryFile = oci ? join(ctx.ociOut, item.target_id, '_shard', 'telemetry.jsonl') : build ? ctx.buildsTelemetry : ctx.subjectsTelemetry;
    const ociRun = oci ? (ctx.ociRuns || {})[item.target_id] : null;
    if (oci) deadlineHit = !ociRun || ociRun.outcome === 'deadline' || ociRun.rc === 124 || ociRun.rc === 137;
    // The builds ran after the subjects (or did not, when the deadline came first: builds_rc stays -1).
    if (build) deadlineHit = !Number.isInteger(ctx.state.builds_rc) || ctx.state.builds_rc < 0 || ctx.state.builds_rc === 124 || ctx.state.builds_rc === 137;
    let rec = readJson(join(dir, 'record.json'));
    let bare = readJson(join(dir, 'probe-bare.json'));
    let envp = readJson(join(dir, 'probe-env.json'));
    let stat = readJson(join(dir, 'static.json'));
    // R-LP-81: the one retry with a changed launch (`retry` planned it from this first run; retry.json). When it lists
    // tools, its run is the item's; when it does not (or never ran), the first run's cause stands with its fault. Both
    // runs are kept: the other one's record, probes and steps under raw/first/ or raw/retry/.
    const retry = !oci && !build && !listed(envp) && !listed(bare) && isObj(ctx.retries) ? ctx.retries[item.target_id] : null;
    let other = null;
    if (retry) {
      const rdir = join(ctx.retryOut, item.target_id);
      const r2 = { rec: readJson(join(rdir, 'record.json')), bare: readJson(join(rdir, 'probe-bare.json')), envp: readJson(join(rdir, 'probe-env.json')) };
      const won = listed(r2.envp) || listed(r2.bare);
      result.retry = { reason: retry.reason, change: retry.change, ran: !!r2.rec, listed: won, detail: null };
      if (won) {
        // What ran differs from the plan's launch: say so where the install is described (R-LP-81).
        if (result.install) result.install.retry = { reason: retry.reason, change: retry.change };
        lines.push(...(EMIT_LAUNCH_RETRY_FIELD ? [obs('launch_retry', { reason: retry.reason, change: retry.change })] : []));
        other = { prefix: 'raw/first/', dir, rec, bare, envp };
        dir = rdir; rec = r2.rec; bare = r2.bare; envp = r2.envp; stat = readJson(join(rdir, 'static.json')) || stat; telemetryFile = ctx.retryTelemetry;
      } else {
        other = { prefix: 'raw/retry/', dir: rdir, ...r2 };
        if (r2.rec) result.retry.detail = failureDetail(r2.rec, r2.bare, r2.envp, { records: telemetryFor(ctx.retryTelemetry, item.target_id).records, stepsLog: readText(join(rdir, 'steps.log')), launch: retryLaunch(r.launch, retry.change), argsUnfilled: r.choice ? r.choice.args_unfilled : null, owned: ownedEntry(r.choice), pydeps: r.choice ? r.choice.pydeps : null, crashNotEvidence: crashNotEvidenceOf(r.choice, r2.rec) });
      }
    }
    if (rec) {
      const gh = rec.source && rec.source.github;
      subjectSha = gh && typeof gh.sha === 'string' && /^[0-9a-f]{40}$/.test(gh.sha) ? gh.sha : null;
      result.driver = { public_exit: int(rec.public_exit), timed_out: rec.timed_out === true, excluded: !!rec.excluded, layers: isObj(rec.layers) ? { registry: !!rec.layers.registry, live: !!rec.layers.live, static: !!rec.layers.static, readme: !!rec.layers.readme } : null, errors: Array.isArray(rec.errors) ? rec.errors.map((e) => safeText(String(e && e.step), /^[a-z]{1,20}$/)).filter(Boolean) : [] };
      const tm = isObj(rec.timing) ? rec.timing : {};
      Object.assign(result.timing, { static_ms: int(tm.static_ms), install_ms: int(tm.install_ms), probe_ms: int(tm.probe_ms), analyse_ms: int(tm.analyse_ms), total_ms: int(tm.total_ms) });
      if (subjectSha) lines.push(obs('commit_sha', subjectSha));
      if (rec.source && rec.source.github && isObj(rec.source.github.commit) && isDateTime(rec.source.github.commit.date)) lines.push(obs('commit_date', rec.source.github.commit.date));
      const inst = rec.install;
      if (isObj(inst)) {
        const egress = Array.isArray(inst.egress) ? inst.egress : [];
        lines.push(obs('install_phase_behaviour', { kind: safeText(String(inst.kind), /^[a-z]{2,8}$/), ok: inst.ok === true, steps: (Array.isArray(inst.steps) ? inst.steps : []).slice(0, 10).map((s) => ({ name: safeText(String(s && s.name), /^[a-z]{1,12}$/), exit: Number.isInteger(s && s.exit) ? s.exit : null, ms: int(s && s.ms), timed_out: !!(s && s.timed_out) })), egress_allowed: egress.filter((e) => e && e.allowed === true).length, egress_refused: egress.filter((e) => e && e.allowed === false).length, resolved_version: safeText(inst.resolved_version, SAFE_VERSION) }));
      }
      lines.push(obs('observation_coverage', { registry: !!(rec.layers && rec.layers.registry), live: !!(rec.layers && rec.layers.live), static: !!(rec.layers && rec.layers.static), readme: !!(rec.layers && rec.layers.readme), probes: ['bare', 'env'].filter((k) => isObj(rec.probes) && rec.probes[k]) }));
    }
    const primary = listed(envp) ? envp : listed(bare) ? bare : null;
    let reader = { listed: false };
    const tel = telemetryFor(telemetryFile, item.target_id);
    // R-LP-75: no tools capability and tools/list "method not found": nothing to grade and nobody's fault (no skip).
    const noTools = !primary ? [envp, bare].find(noToolsCapability) || null : null;
    if (noTools) {
      result.detail = 'no_tools_capability';
      result.live = { tools_capability: false, tool_count: 0, config_state: configStateOf(noTools, bare, rec, r.launch) };
      reader = { listed: false, no_tools_capability: true, capabilities: noTools.initialize.capabilities };
      lines.push(obs('protocol_era', 'legacy'));
      lines.push(obs('protocol_negotiated', safeText(noTools.initialize.protocolVersion, /^[0-9A-Za-z.-]{1,40}$/), 'not a plain protocol version'));
      lines.push(obs('server_info', serverInfo(noTools.initialize.serverInfo), 'no serverInfo object'));
      lines.push(obs('capabilities_flags', capabilityFlags(noTools.initialize.capabilities), 'no capabilities object'));
    } else if (!primary) {
      detail = ociRun && ociRun.outcome === 'disk_low' ? 'disk_low' : failureDetail(rec, bare, envp, { deadlineHit, records: tel.records, stepsLog: readText(join(dir, 'steps.log')), launch: r.launch, argsUnfilled: r.choice ? r.choice.args_unfilled : null, owned: ownedEntry(r.choice), pydeps: r.choice ? r.choice.pydeps : null, crashNotEvidence: crashNotEvidenceOf(r.choice, rec), entryGuess: entryGuessOf(r.choice), pypiRelease: r.choice ? r.choice.pypi_release : null });
      // R-LP-81: a retry was planned because the first run's cause was ours to test (an SDK we let float, a subcommand
      // we did not give): that first run is never the server's fault, whatever its detail would say alone.
      if (retry && (DETAILS[detail] || [])[3] === 'subject') { result.retry.first_detail = detail; detail = retry.reason === 'mcp_drift' ? 'start_dependency_drift' : 'start_env_limited'; }
    } else {
      const text = listText(primary.lists['tools/list'].raw_pages);
      let g = null;
      const g0 = Date.now();
      try { g = gradeList(text); } catch (e) {
        if (!(e instanceof InputError)) throw e;
        detail = 'list_rejected'; result.live = { list_error: safeText(e.code, /^[a-z_]{1,40}$/) };
      }
      result.timing.grade_ms = Date.now() - g0;
      if (g) {
        result.live = { ...g.summary, config_state: configStateOf(primary, bare, rec, r.launch), pages: int(primary.lists['tools/list'].pages), tool_names_sha256: toolNamesSha256(g.names) };
        reader = { listed: true, tool_count: g.summary.tool_count, catalog_hash: g.summary.catalog_hash, names: g.names, tools: toolsOf(primary.lists['tools/list'].raw_pages), pages: int(primary.lists['tools/list'].pages), check_ids: Object.keys(g.summary.check_counts), capabilities: isObj(primary.initialize) && isObj(primary.initialize.capabilities) ? primary.initialize.capabilities : null };
        files['raw/report.json'] = json({ findings: g.report.findings, tool_names: g.names });
        const cmp = compareStatic(g, stat);
        result.static_vs_live = cmp.summary;
        if (cmp.raw) files['raw/static-compare.json'] = json(cmp.raw);
        lines.push(obs('static_vs_live_agreement', cmp.summary));
        if (EMIT_TOOL_LIST_FIELDS) { lines.push(obs('tool_count', g.summary.tool_count)); lines.push(obs('tool_list_sha256', g.summary.catalog_hash)); }
        // R-LP-87: next to them, the names-only hash (null, with why, when the list names no tool).
        if (EMIT_TOOL_NAMES_FIELD) lines.push(obs('tool_names_sha256', toolNamesSha256(g.names), 'the list names no tool'));
        const init = isObj(primary.initialize) ? primary.initialize : null;
        lines.push(obs('protocol_era', primary.era === 'modern' ? 'modern' : 'legacy'));
        lines.push(obs('client_version', safeText(primary.protocol_offered, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)));
        if (init) {
          lines.push(obs('protocol_negotiated', safeText(init.protocolVersion, /^[0-9A-Za-z.-]{1,40}$/), 'not a plain protocol version'));
          lines.push(obs('server_info', serverInfo(init.serverInfo), 'no serverInfo object'));
          lines.push(obs('capabilities_flags', capabilityFlags(init.capabilities), 'no capabilities object'));
          if (isObj(init.capabilities)) lines.push(obs('capabilities_jcs_sha256', sha256(canonical(init.capabilities))));
          if (typeof init.instructions === 'string') { lines.push(obs('instructions_len_chars', init.instructions.length)); lines.push(obs('instructions_sha256', sha256(init.instructions))); }
        }
        const tm = isObj(primary.timing) ? primary.timing : {};
        lines.push(obs('startup_ms', int(tm.initialize_ms), 'no initialize answer'));
        lines.push(obs('latency_cold_ms', int(primary.lists['tools/list'].ms), 'not timed'));
        lines.push(obs('startup_without_config', bare ? (listed(bare) ? 'lists_tools' : 'no_list') : 'not_run'));
        lines.push(obs('config_state', configStateOf(primary, bare, rec, r.launch)));
        lines.push(obs('catalog_per_config_state', { none: bare ? { listed: listed(bare), ...(catalogOf(bare) || {}) } : null, dummy: envp ? { listed: listed(envp), ...(catalogOf(envp) || {}) } : null }));
        const tr = isObj(primary.transport) ? primary.transport : {};
        lines.push(obs('stdout_noise_lines', int(tr.non_json_lines), 'not counted'));
        lines.push(obs('stderr_counts', { bytes: int(primary.stderr_bytes), truncated: primary.stderr_truncated === true }));
        lines.push(obs('list_changed_notifications', (Array.isArray(tr.notifications) ? tr.notifications : []).filter((n) => n === 'notifications/tools/list_changed').length));
        const tl = primary.lists['tools/list'];
        lines.push(obs('pagination_behaviour', { pages: int(tl.pages), page_sizes: Array.isArray(tl.page_sizes) ? tl.page_sizes.filter((n) => int(n) !== null).slice(0, 100) : [], paginated: int(tl.pages) > 1 }));
      }
    }
    oracle = oracleFor(dir, item, reader, ctx);
    lines.push(...oracle.lines);
    result.oracles = oracle.summary;
    const fuzz = fuzzFor(dir, item, ctx);
    if (fuzz) { lines.push(...fuzz.lines); result.fuzz = fuzz.summary; }
    // The driver times its probe around the probe option, so its probe_ms holds the oracle stage too (R-ORC-02):
    // step_telemetry keeps the two apart.
    const oms = oracle.summary ? int(oracle.summary.ms) : null;
    // The fuzz stage runs inside the same probe call: its time comes out of probe_ms too.
    const fms = fuzz && fuzz.summary ? int(fuzz.summary.ms) : null;
    if (oms !== null) result.timing.oracle_ms = oms;
    if (fms !== null) result.timing.fuzz_ms = fms;
    if ('probe_ms' in result.timing) result.timing.probe_ms = withoutStages(result.timing.probe_ms, oms, fms);
    // The captured bytes: the tools/list answers, each probe whole, the static read, the registry entry, the logs.
    const raw = [];
    if (primary) raw.push(['raw/tools-list.json', Buffer.from(json(primary.lists['tools/list'].raw_pages))]);
    for (const [k, p] of [['bare', bare], ['env', envp]]) if (p) raw.push(['raw/probe-' + k + '.json', Buffer.from(json(p))]);
    if (rec) raw.push(['raw/record.json', Buffer.from(json(rec))]);
    for (const f of ['registry.json', 'static.json', 'analysis.json', 'steps.log']) { const b = readText(join(dir, f)); if (b) raw.push(['raw/' + f.replace(/\.log$/, '.txt'), b]); }
    if (other) {
      for (const [k, p] of [['bare', other.bare], ['env', other.envp]]) if (p) raw.push([other.prefix + 'probe-' + k + '.json', Buffer.from(json(p))]);
      if (other.rec) raw.push([other.prefix + 'record.json', Buffer.from(json(other.rec))]);
      const b = readText(join(other.dir, 'steps.log')); if (b) raw.push([other.prefix + 'steps.txt', b]);
    }

    if (tel.lines.length) raw.push(['raw/telemetry.jsonl', Buffer.from(tel.lines.join('\n') + '\n')]);
    lines.push(...networkEvents(tel.records).map((e) => obs('network_event', e)));
    raw.push(...oracle.raw);
    if (fuzz) raw.push(...fuzz.raw);
    addRaw(files, raw, result);
  }
  lines.push(obs('step_telemetry', result.timing));
  lines.push(obs('sandbox_tier', 'gvisor'));
  lines.push(obs('runner_env', ctx.runnerEnv, 'the sandbox wrote no shard record'));
  lines.push(obs('our_tool_versions', ctx.toolVersions));
  if (detail) {
    const [reason, retryable, stage, fault] = DETAILS[detail] || DETAILS.harness_error;
    result.status = 'skipped'; result.detail = detail; result.skip_reason = reason; result.fault = fault; result.retryable = retryable;
    lines.push(obs('error_taxonomy_code', detail));
    files[RESULT_PATH] = json(result);
    files['observations/live.ndjson'] = lines.join('\n') + '\n';
    return { status: 'skipped', detail, files, skips: [{ stage, reason, fault, evidence: RESULT_PATH, ...(retryable ? { retryable: true } : {}) }], subjectSha, components: oracle.components };
  }
  // A server with no tools capability is assessed with nothing to grade (R-LP-75): status no_tools, no skip, fault none.
  const status = result.detail === 'no_tools_capability' ? 'no_tools' : 'graded';
  result.status = status;
  files[RESULT_PATH] = json(result);
  files['observations/live.ndjson'] = lines.join('\n') + '\n';
  return { status, detail: null, files, skips: [], subjectSha, components: oracle.components };
}

/** Raw files, each capped at RAW_FILE_CAP and all at RAW_TOTAL_CAP; what was cut is recorded. */
function addRaw(files, raw, result) {
  let total = 0;
  for (const [path, buf] of raw) {
    let b = buf.length > RAW_FILE_CAP ? buf.subarray(0, RAW_FILE_CAP) : buf;
    if (total + b.length > RAW_TOTAL_CAP) b = b.subarray(0, Math.max(0, RAW_TOTAL_CAP - total));
    if (b.length < buf.length) result.raw_truncated.push({ path, bytes: buf.length, kept: b.length });
    if (!b.length) continue;
    files[path] = b; total += b.length;
  }
}

// ------------------------------------------------------------------ controls

/** The known-answer control's expected answer, computed from the saved capture of our own server. */
export function knownAnswerFrom(captureFile = KNOWN_ANSWER_CAPTURE) {
  const g = gradeList(readFileSync(captureFile, 'utf8'), 'the known-answer capture');
  return { format: CONTROL_FORMAT, control: 'known-answer', server: KNOWN_ANSWER.launch.package + '@' + KNOWN_ANSWER.launch.version, rubric_version: M.RUBRIC_VERSION, answer: answerOf(g.summary) };
}

/** The identity keys and envelope shape ingest's forgery check looks for in a control output. */
export function leaks(text, marker) {
  if (text.includes(marker)) return true;
  if (/"(attempt[_-]?id|attemptid|run[_-]?key|runkey|fence|fencing[_-]?(?:no|number)|fencingno|fence[_-]?token)"\s*:/i.test(text)) return true;
  if (/"schema_version"\s*:/.test(text) && /"files"\s*:/.test(text)) return true;
  return /["']?\b(attempt[_-]?id|run[_-]?key|fencing[_-]?(?:no|number)|fence)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{1,128}/i.test(text);
}

/**
 * The three controls, from the sandbox's output. Each returns { control, files }; observed is the expected label only
 * when the evidence shows it. known_good: our own server's live list and grades are the known answer. forgery: the
 * forgery server's list came back (its marker is in raw/), and what this lane wrote about it outside raw/ (the same
 * results and observations a subject gets) holds neither the marker nor anything ingest reads as an identity or an
 * envelope. malicious: the sandbox self test blocked and logged every escape attempt, and its telemetry check passed.
 */
export function evaluateControls(ctx, { knownFile = KNOWN_ANSWER_FILE } = {}) {
  const out = [];
  // known answer
  {
    const dir = join(ctx.controlsOut, KNOWN_ANSWER.id);
    const p = [readJson(join(dir, 'probe-env.json')), readJson(join(dir, 'probe-bare.json'))].find(listed) || null;
    const expected = readJson(knownFile);
    let observed = null; let pages = null;
    if (p) { pages = p.lists['tools/list'].raw_pages; try { observed = answerOf(gradeList(listText(pages)).summary); } catch { observed = null; } }
    const match = !!(observed && expected && JSON.stringify(observed) === JSON.stringify(expected.answer));
    out.push({
      control: { kind: 'known_good', expected: 'match', observed: !p ? 'not_run' : match ? 'match' : 'mismatch', output: 'controls/known-answer.json' },
      files: { 'controls/known-answer.json': json({ format: CONTROL_FORMAT, control: 'known-answer', server: KNOWN_ANSWER.launch.package + '@' + KNOWN_ANSWER.launch.version, engine_version: VERSION, rubric_version: M.RUBRIC_VERSION, match, expected: expected && expected.answer, observed }), ...(pages ? { 'raw/control-known-answer/tools-list.json': json(pages) } : {}) },
    });
  }
  // forgery
  {
    const marker = ctx.plan.marker;
    const dir = join(ctx.controlsOut, FORGERY.id);
    const bare = readJson(join(dir, 'probe-bare.json'));
    let observed = 'not_run'; let outText = json({ format: CONTROL_FORMAT, control: 'forgery', status: 'not_run' }); let rawText = null;
    if (listed(bare)) {
      rawText = json(bare);
      // The forgery server runs through the same item code as a subject, against the controls' output.
      const fake = { index: 0, subject: 'isokron-ai/mcp-check', repo: 'isokron-ai/mcp-check', target_id: FORGERY.id, resolve_ms: 0, resolution: { status: 'runnable', detail: null, registry: null, choice: null, candidates: [], launch: null, subdir: null, seed_packages: 0 } };
      const built = buildItem(fake, { ...ctx, subjectsOut: ctx.controlsOut, subjectsTelemetry: ctx.controlsTelemetry });
      const ours = Object.entries(built.files).filter(([k]) => !k.startsWith('raw/'));
      outText = json({ format: CONTROL_FORMAT, control: 'forgery', status: built.status, files: Object.fromEntries(ours.map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('utf8') : v])) });
      const tools = (bare.lists['tools/list'].raw_pages || []).length;
      observed = built.status !== 'graded' || !tools || !rawText.includes(marker) ? 'not_run' : leaks(outText, marker) ? 'leaked' : 'contained';
    }
    out.push({
      control: { kind: 'forgery', expected: 'contained', observed, output: 'controls/forgery.json', marker },
      files: { 'controls/forgery.json': outText, ...(rawText ? { 'raw/control-forgery/probe.json': rawText } : {}) },
    });
  }
  // the oracle stage on our own server: the clients and the suite give the known answer (only when the stage ran)
  if (ctx.oraclePins && ctx.oracleInstalled !== false) {
    const dir = join(ctx.controlsOut, KNOWN_ANSWER.id);
    const p = [readJson(join(dir, 'probe-env.json')), readJson(join(dir, 'probe-bare.json'))].find(listed) || null;
    let reader = { listed: false };
    if (p) {
      try {
        const g = gradeList(listText(p.lists['tools/list'].raw_pages));
        reader = { listed: true, tool_count: g.summary.tool_count, catalog_hash: g.summary.catalog_hash, names: g.names, tools: toolsOf(p.lists['tools/list'].raw_pages), pages: int(p.lists['tools/list'].pages), check_ids: Object.keys(g.summary.check_counts), capabilities: isObj(p.initialize) && isObj(p.initialize.capabilities) ? p.initialize.capabilities : null };
      } catch { reader = { listed: false }; }
    }
    const found = oracleRecord(dir);
    const expected = ctx.oracleBaseline && ctx.oracleBaseline.controls ? ctx.oracleBaseline.controls.known_good : null;
    const j = judgeOracles(found ? found.rec : null, { reader, pins: ctx.oraclePins, baseline: expected });
    const problems = j.status === 'absent' ? ['the oracle stage did not run'] : baselineProblems(j, expected);
    const observed = !p ? 'not_run' : problems.length ? 'mismatch' : 'match';
    out.push({
      control: { kind: 'known_good', expected: 'match', observed, output: 'controls/oracle-known-answer.json' },
      files: {
        'controls/oracle-known-answer.json': json({ format: CONTROL_FORMAT, control: 'oracle-known-answer', server: KNOWN_ANSWER.launch.package + '@' + KNOWN_ANSWER.launch.version, match: observed === 'match', problems: problems.slice(0, 50), clients: j.clients, conformance: j.conformance ? j.conformance.summary : null, disagreements: j.disagreements }),
        ...(found ? { 'raw/control-known-answer/oracles.json': json(found.rec) } : {}),
      },
    });
  }
  // sandbox self test
  {
    const res = readJson(join(ctx.work, 'selftest', 'results.json'));
    const cases = res && Array.isArray(res.cases) ? res.cases.map((c) => ({ case: safeText(String(c && c.case), /^[a-z0-9-]{1,30}$/), blocked: !!(c && c.blocked), logged: !!(c && c.logged), pass: !!(c && c.pass) })) : [];
    const ok = ctx.state && ctx.state.selftest_check_rc === 0 && cases.length > 0 && res.total === cases.length && cases.every((c) => c.pass);
    out.push({
      control: { kind: 'malicious', expected: 'blocked', observed: ok ? 'blocked' : 'not_blocked', output: 'controls/sandbox-selftest.json' },
      files: { 'controls/sandbox-selftest.json': json({ format: CONTROL_FORMAT, control: 'sandbox-selftest', check_rc: ctx.state ? ctx.state.selftest_check_rc : null, gvisor_release: res ? safeText(res.gvisor_release, /^[0-9.a-z-]{1,40}$/) : null, passed: res ? int(res.passed) : null, total: res ? int(res.total) : null, cases }) },
    });
  }
  return out;
}

// ------------------------------------------------------------------ the shard

/** What happened to each OCI subject (corpus/live-probe-sandbox.sh): { id: { outcome: ran|disk_low|deadline, rc, avail, need } }. */
export function ociRuns(file) {
  const out = {};
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return out; }
  for (const l of text.split('\n')) {
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (isObj(r) && typeof r.id === 'string' && /^s[0-9]{3}$/.test(r.id) && ['ran', 'disk_low', 'deadline'].includes(r.outcome)) out[r.id] = { outcome: r.outcome, rc: Number.isInteger(r.rc) ? r.rc : null, avail: int(r.avail), need: int(r.need) };
  }
  return out;
}

/** The settings digest: SETTINGS, our version and the sandbox commit. */
export function settingsDigest(mscCommit) {
  const s = { ...SETTINGS, engine_version: VERSION, rubric_version: M.RUBRIC_VERSION, spec_version: M.SPEC_VERSION, surface_corpus: mscCommit || null };
  return sha256(JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]])));
}

/**
 * The components a bundle reports in manifest `tools`, as tool-qa's version pins (R-PIN-01) expect them: this
 * repository at the commit that ran (the package, and the fuzz stage only when it ran), and the sandbox at the
 * mcp-surface-corpus commit it used.
 */
export function toolsRan({ commit, mscCommit, fuzz }) {
  return [
    { name: '@isokron/mcp-check', version: commit },
    ...(mscCommit ? [{ name: 'isokron-ai/mcp-surface-corpus', version: mscCommit }] : []),
    ...(fuzz ? [{ name: 'fuzz', version: commit }] : []),
  ];
}

/**
 * Builds every item's bundle from <work>. Throws ControlFailure when a control did not give its expected outcome: then
 * nothing is written and nothing may be uploaded.
 */
export function bundleShard({ work, env = process.env, now = () => new Date(), log = () => {}, knownFile = KNOWN_ANSWER_FILE, pinsFile = ORACLE_PINS_FILE, baselineFile = ORACLE_BASELINE_FILE }) {
  const plan = readJson(join(work, 'plan.json'));
  if (!plan || plan.format !== PLAN_FORMAT) throw new ControlFailure('no plan in the work folder');
  const state = readJson(join(work, 'sandbox.json')) || {};
  const shardJson = readJson(join(work, 'driver-subjects', '_shard', 'shard.json')) || readJson(join(work, 'driver-builds', '_shard', 'shard.json')) || readJson(join(work, 'driver-controls', '_shard', 'shard.json'));
  const runner = shardJson && isObj(shardJson.runner) ? shardJson.runner : null;
  const mscCommit = typeof state.msc_commit === 'string' && /^[0-9a-f]{40}$/.test(state.msc_commit) ? state.msc_commit : null;
  const ctx = {
    work, plan, state,
    controlsOut: join(work, 'driver-controls'), controlsTelemetry: join(work, 'driver-controls', '_shard', 'telemetry.jsonl'),
    subjectsOut: join(work, 'driver-subjects'), subjectsTelemetry: join(work, 'driver-subjects', '_shard', 'telemetry.jsonl'),
    deadlineHit: state.subjects_rc === 124 || state.subjects_rc === 137,
    ociOut: join(work, 'driver-oci'), ociRuns: ociRuns(join(work, 'oci-runs.jsonl')),
    buildsOut: join(work, 'driver-builds'), buildsTelemetry: join(work, 'driver-builds', '_shard', 'telemetry.jsonl'),
    retryOut: join(work, 'driver-retry'), retryTelemetry: join(work, 'driver-retry', '_shard', 'telemetry.jsonl'), retries: retriesOf(join(work, 'retry.json')),
    runnerEnv: runner ? { os: safeText(runner.os, /^[a-z]{1,10}$/), arch: safeText(runner.arch, /^[a-z0-9_]{1,10}$/), kernel: safeText(runner.kernel, /^[A-Za-z0-9._+-]{1,60}$/), node: safeText(runner.node, /^v[0-9.]{1,20}$/), docker: safeText(runner.docker, /^[0-9][0-9A-Za-z.+-]{0,30}$/), container_platform: safeText(runner.container_platform, /^[a-z0-9/]{1,30}$/) } : null,
    toolVersions: { mcp_check: VERSION, rubric: M.RUBRIC_VERSION, spec: M.SPEC_VERSION, surface_corpus: mscCommit, worker_kit: safeText(state.worker_kit_ref, /^[0-9a-f]{40}$/), gvisor: safeText(state.gvisor_release, /^[0-9.a-z-]{1,40}$/) },
    sandboxSummary: { runtime: 'runsc', selftest: state.selftest_check_rc === 0 ? 'passed' : 'failed', controls_rc: int(state.controls_rc), subjects_rc: int(state.subjects_rc), swept: state.swept === true },
    oraclePins: readJson(pinsFile), oracleBaseline: readJson(baselineFile),
    // false when the oracles were not installed (no clients.json from corpus/oracles/install.mjs): then no oracle
    // control, and each item says so. A partial install is recorded per client inside the stage's results.
    oracleInstalled: state.oracles_installed === true,
  };
  const controls = evaluateControls(ctx, { knownFile });
  const bad = controls.filter((c) => c.control.observed !== c.control.expected);
  if (bad.length) throw new ControlFailure('controls failed: ' + bad.map((c) => c.control.kind + '=' + c.control.observed).join(', '));
  const left = isObj(state.left) ? state.left : null;
  if (state.swept !== true || !left || !['labelled', 'containers', 'volumes', 'uid_65534_processes', 'runsc_processes'].every((k) => left[k] === 0)) throw new ControlFailure('the sandbox was not shown to be gone before upload');
  const digest = settingsDigest(mscCommit);
  const finishedAt = now().toISOString();
  const outRoot = join(work, 'out');
  rmSync(outRoot, { recursive: true, force: true });
  const summary = [];
  for (const item of plan.items) {
    const b = buildItem(item, ctx);
    const files = { ...b.files };
    for (const c of controls) Object.assign(files, c.files);
    files['logs/live-probe.log'] = 'item ' + item.index + ': ' + b.status + (b.detail ? ' (' + b.detail + ')' : '') + '\n';
    const dir = join(outRoot, String(item.index));
    for (const [p, data] of Object.entries(files)) { mkdirSync(dirname(join(dir, 'bundle', p)), { recursive: true }); writeFileSync(join(dir, 'bundle', p), data); }
    const meta = {
      subject: { id: item.subject, repo: item.repo, sha: b.subjectSha },
      tools: toolsRan({ commit: ranCommit(env), mscCommit, fuzz: plan.fuzz === true }),
      oracles: [...new Map((b.components || []).map((c) => [c.name + '@' + c.version, c])).values()].filter((c) => /^[A-Za-z0-9@][A-Za-z0-9@/._-]{0,127}$/.test(c.name) && /^[A-Za-z0-9][A-Za-z0-9.+:_-]{0,127}$/.test(String(c.version))),
      settings_manifest_digest: digest,
      started_at: plan.planned_at,
      finished_at: finishedAt,
      skips: b.skips,
      controls: controls.map((c) => c.control),
    };
    writeFileSync(join(dir, 'meta.json'), json(meta));
    summary.push({ index: item.index, status: b.status, detail: b.detail });
    log('item ' + item.index + ': ' + b.status + (b.detail ? ' (' + b.detail + ', ' + DETAILS[b.detail][0] + ', ' + DETAILS[b.detail][3] + (DETAILS[b.detail][1] ? ', retryable' : '') + ')' : ''));
  }
  return summary;
}

// ------------------------------------------------------------------ the pull request self test

/**
 * Judges dry-run bundles with tool-qa's own code at the pinned commit (a checkout in toolQa): the manifest schema,
 * ingest's forgery checks (identity, files, claims, controls), the field registry and the secret scan. Returns the
 * problems found and each bundle's results file.
 */
/** The tool-qa files verify imports, with what they import; the workflows' sparse checkout of tool-qa must hold them. */
export const TOOL_QA_FILES = Object.freeze(['worker-kit/contract.mjs', 'worker-kit/manifest.schema.json', 'worker-kit/tar.mjs', 'ingest/forgery.mjs', 'ingest/redact.mjs', 'ingest/registry.mjs', 'scripts/lib/yaml-lite.mjs', 'history/seed-v1.json']);

/**
 * The self test's oracle expectations for one baselined item: the stage ran, matches its baseline, every client
 * installed and ran (the control tolerates an install outage; the self test does not), and the meta file names the
 * oracles.
 */
export function oracleExpectProblems(res, manifest) {
  const p = [];
  const o = res.oracles;
  if (!o || o.status !== 'ran') p.push({ reason: 'oracles_not_run', got: o ? o.status + (o.why ? ' (' + o.why + ')' : '') : null });
  else if (!Array.isArray(o.baseline_problems) || o.baseline_problems.length) p.push({ reason: 'oracle_baseline', problems: o.baseline_problems });
  const off = o && Array.isArray(o.clients) ? o.clients.filter((c) => c.outcome === 'unavailable' || c.outcome === 'skipped').map((c) => c.client) : [];
  if (off.length) p.push({ reason: 'oracle_client_unavailable', clients: off });
  if (!manifest || !Array.isArray(manifest.oracles) || !manifest.oracles.length) p.push({ reason: 'oracle_components_missing' });
  return p;
}

/** The self test's checks of the fuzz stage on our own servers: it ran, and found nothing (they are the controls of the invariants). */
export function fuzzExpectProblems(res) {
  const f = res.fuzz;
  if (!f || f.status !== 'ran') return [{ reason: 'fuzz_not_run', got: f ? f.status + (f.why ? ' (' + f.why + ')' : '') : null }];
  const bad = f.results.filter((r) => r.verdict === 'fail' || r.verdict === 'warn' || r.fault === 'subject').map((r) => r.id + ' ' + r.primitive + ' ' + r.verdict + ' ' + r.kind);
  const p = bad.length ? [{ reason: 'fuzz_finding_on_our_own_server', results: bad }] : [];
  // The time guard: the stage must stay inside its own budget, or the lease and the shard time are wrong (corpus/FUZZ.md, "Time").
  if (!Number.isSafeInteger(f.ms) || f.ms > FUZZ_STAGE_MAX_MS) p.push({ reason: 'fuzz_over_budget', ms: f.ms, max: FUZZ_STAGE_MAX_MS });
  return p;
}

/** What ingest would check a self test bundle's identity against: the worker kit records GITHUB_WORKFLOW_SHA. */
export function expectedIdentity(manifest, item, expect, env) {
  return { attempt_id: env.ATTEMPT_ID || expect.attempt_id, fence: item.fence, run_key: item.run_key, repo: env.GITHUB_REPOSITORY, workflow_file: manifest.workflow && manifest.workflow.file, workflow_sha: env.GITHUB_WORKFLOW_SHA, run_id: Number(env.GITHUB_RUN_ID) };
}

export async function verifyBundles({ toolQa, ingest = toolQa, tars, expect, env = process.env, fetch: fetchImpl = globalThis.fetch, registryFile = null }) {
  // The worker kit's commit builds the bundle; ingest's commit (tool-qa's main, which judges for real) checks it,
  // with the field registry it pins.
  const imp = (dir, p) => import(pathToFileURL(join(dir, p)).href);
  const { validateManifest } = await imp(toolQa, 'worker-kit/contract.mjs');
  const { readTar } = await imp(toolQa, 'worker-kit/tar.mjs');
  const { checkBundle } = await imp(ingest, 'ingest/forgery.mjs');
  const { scanFiles } = await imp(ingest, 'ingest/redact.mjs');
  const reg = await imp(ingest, 'ingest/registry.mjs');
  const registry = registryFile ? reg.parseRegistry(readFileSync(registryFile, 'utf8')) : await reg.loadRegistry({ fetch: fetchImpl });
  const problems = []; const results = [];
  for (const t of tars) {
    const entries = readTar(readFileSync(t));
    const files = new Map(entries.map((e) => [e.path, e.data]));
    const manifestBuf = files.get('manifest.json'); files.delete('manifest.json');
    const manifest = JSON.parse(manifestBuf.toString('utf8'));
    const v = validateManifest(manifest);
    if (!v.ok) problems.push({ tar: t, reason: 'manifest_invalid', detail: v.errors.slice(0, 5) });
    const item = expect.items.find((x) => x.run_key === manifest.run_key);
    if (!item) { problems.push({ tar: t, reason: 'unexpected_run_key' }); continue; }
    const exp = expectedIdentity(manifest, item, expect, env);
    for (const p of checkBundle(manifest, files, exp)) problems.push({ tar: t, ...p });
    const obsFiles = new Map([...files].filter(([k]) => k.startsWith('observations/')));
    const ov = reg.validateObservations(obsFiles, registry);
    if (!ov.ok) for (const p of ov.errors) problems.push({ tar: t, ...p });
    if (!ov.records) problems.push({ tar: t, reason: 'no_observations' });
    const hits = scanFiles(new Map([...files].filter(([k]) => !k.startsWith('raw/'))));
    if (hits.length) problems.push({ tar: t, reason: 'secret_outside_raw', n: hits.length, paths: [...new Set(hits.map((h) => h.path))].slice(0, 5) });
    const res = JSON.parse(files.get(RESULT_PATH).toString('utf8'));
    results.push({ index: expect.items.indexOf(item), subject: item.subject, status: res.status, detail: res.detail, skip_reason: res.skip_reason, live: res.live ? answerOf2(res.live) : null, oracles: res.oracles || null, skips: manifest.skips, controls: manifest.controls.map((c) => c.kind + ':' + c.observed) });
    const want = item.expect || {};
    if (want.status && res.status !== want.status) problems.push({ tar: t, reason: 'unexpected_status', want: want.status, got: res.status, detail: res.detail });
    if (want.skip_reason && res.skip_reason !== want.skip_reason) problems.push({ tar: t, reason: 'unexpected_skip_reason', want: want.skip_reason, got: res.skip_reason });
    if (want.catalog_hash && (!res.live || res.live.catalog_hash !== want.catalog_hash)) problems.push({ tar: t, reason: 'unexpected_catalog', want: want.catalog_hash, got: res.live && res.live.catalog_hash });
    if (want.min_tools && (!res.live || !(res.live.tool_count >= want.min_tools))) problems.push({ tar: t, reason: 'too_few_tools', want: want.min_tools, got: res.live && res.live.tool_count });
    // With the oracle stage, a fourth control: the oracles' known answer on our own server.
    const oracleRun = expect.items.some((x) => x.expect && x.expect.oracles);
    if (manifest.controls.length !== (oracleRun ? 4 : 3)) problems.push({ tar: t, reason: 'controls_missing', got: manifest.controls.length });
    if (oracleRun && !manifest.controls.some((c) => c.kind === 'known_good' && c.output === 'controls/oracle-known-answer.json' && c.observed === 'match')) problems.push({ tar: t, reason: 'oracle_control_missing' });
    if (want.oracles) for (const p of oracleExpectProblems(res, manifest)) problems.push({ tar: t, ...p });
    if (want.fuzz) for (const p of fuzzExpectProblems(res)) problems.push({ tar: t, ...p });
  }
  if (results.length !== expect.items.length) problems.push({ reason: 'bundle_count', want: expect.items.length, got: results.length });
  return { problems, results };
}
function answerOf2(live) { return live && live.sections ? { tool_count: live.tool_count, catalog_hash: live.catalog_hash, grades: Object.fromEntries(SECTIONS.map((k) => [k, live.sections[k] && live.sections[k].grade])) } : live; }

// ------------------------------------------------------------------ command line

function output(env, lines, stdout) {
  const text = lines.map((l) => l + '\n').join('');
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, text); else stdout.write(text);
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, fetch: fetchImpl = globalThis.fetch } = {}) {
  const [cmd, ...rest] = argv;
  const say = (s) => stdout.write(s + '\n');
  if (cmd === 'known-answer' && rest.length <= 1) { stdout.write(json(knownAnswerFrom(rest[0] || KNOWN_ANSWER_CAPTURE))); return 0; }
  if (cmd === 'plan') {
    const work = rest[0];
    const opt = {}; for (let i = 1; i < rest.length; i += 2) opt[rest[i]] = rest[i + 1];
    if (!work || !opt['--msc'] || Object.keys(opt).some((k) => !['--msc', '--seed'].includes(k))) { say('usage: node corpus/live-probe.mjs plan <work> --msc <dir> [--seed <seed-v1.json>]'); return 2; }
    let inputs;
    try { inputs = parseInputs({ shardId: env.SHARD_ID, attemptId: env.ATTEMPT_ID, items: env.ITEMS }); } catch (e) {
      if (e instanceof InputProblem) { say('::error title=' + LANE + '::' + e.message + ' (' + e.code + ')'); return 1; }
      throw e;
    }
    const { validateTarget } = await import(pathToFileURL(join(resolve(opt['--msc']), 'src', 'targets.mjs')).href);
    const images = JSON.parse(readFileSync(join(resolve(opt['--msc']), 'images.json'), 'utf8'));
    const seed = loadSeed(opt['--seed']);
    const plan = await planShard({ inputs, seed, fetch: fetchImpl, validateTarget, fuzz: env.LIVE_PROBE_FUZZ === 'on', ghToken: env.GH_TOKEN || null });
    const lists = targetLists(plan, { node24Image: images.node24 });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'plan.json'), json(plan));
    writeFileSync(join(work, 'targets-controls.json'), json(lists.controls));
    writeFileSync(join(work, 'targets-subjects.json'), json(lists.subjects));
    writeFileSync(join(work, 'targets-builds.json'), json(lists.builds));
    mkdirSync(join(work, 'oci'), { recursive: true });
    for (const o of lists.oci) writeFileSync(join(work, 'oci', o.id + '.json'), json(o.list));
    writeFileSync(join(work, 'oci.json'), json(lists.oci.map((o) => ({ id: o.id, image: o.image, bytes: o.bytes }))));
    const lines = ['subject_timeout_s=' + plan.subject_timeout_s, 'runnable=' + plan.runnable, 'fuzz=' + (plan.fuzz ? 'on' : 'off')];
    for (const it of plan.items) lines.push('has_' + it.index + '=true', 'fence_' + it.index + '=' + it.fence, 'run_key_' + it.index + '=' + it.run_key);
    output(env, lines, stdout);
    for (const it of plan.items) say('item ' + it.index + ': ' + (it.target ? 'runnable (' + it.resolution.choice.type + ', ' + it.resolution.choice.transport + ')' : 'skipped (' + it.resolution.detail + ')'));
    say(plan.runnable + ' of ' + plan.items.length + ' subjects runnable; each has ' + plan.subject_timeout_s + ' s');
    return 0;
  }
  if (cmd === 'retry' && rest.length === 3 && rest[1] === '--msc') {
    const { validateTarget } = await import(pathToFileURL(join(resolve(rest[2]), 'src', 'targets.mjs')).href);
    const retries = planRetries({ work: rest[0], validateTarget });
    say(retries.length + ' retr' + (retries.length === 1 ? 'y' : 'ies') + (retries.length ? ': ' + retries.map((x) => x.id + ' ' + x.reason).join(', ') : ''));
    return 0;
  }
  if (cmd === 'bundle' && rest.length === 1) {
    try { bundleShard({ work: rest[0], log: say }); } catch (e) {
      if (e instanceof ControlFailure) { say('::error title=' + LANE + '::' + e.message + '; nothing is uploaded'); return 3; }
      throw e;
    }
    return 0;
  }
  if (cmd === 'verify' && rest.length >= 3) {
    let ingest = null;
    if (rest[0] === '--ingest') { ingest = rest[1]; rest.splice(0, 2); }
    const [toolQa, expectFile, ...tars] = rest;
    if (!toolQa || !expectFile || !tars.length) { say('usage: node corpus/live-probe.mjs verify [--ingest <tool-qa dir>] <tool-qa dir> <expect.json> <tar>...'); return 2; }
    const expect = JSON.parse(readFileSync(expectFile, 'utf8'));
    const { problems, results } = await verifyBundles({ toolQa, ingest: ingest || toolQa, tars, expect, env, fetch: fetchImpl });
    for (const r of results) say(JSON.stringify(r));
    for (const p of problems) say('::error title=' + LANE + ' self test::' + JSON.stringify(p));
    say(problems.length ? problems.length + ' problem(s)' : 'every bundle passed tool-qa\'s checks and the expected outcomes');
    return problems.length ? 3 : 0;
  }
  stderr.write('usage: node corpus/live-probe.mjs plan <work> --msc <dir> [--seed <file>] | bundle <work> | verify [--ingest <tool-qa dir>] <tool-qa dir> <expect.json> <tar>... | known-answer [<capture.json>]\n');
  return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((rc) => { process.exitCode = rc; }, (e) => { process.stderr.write(LANE + ': harness error: ' + String((e && e.stack) || e).slice(0, 2000) + '\n'); process.exitCode = 3; });
}
