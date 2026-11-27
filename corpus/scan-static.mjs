#!/usr/bin/env node
// Loop worker of isokron-ai/tool-qa's scan-static lane (.github/workflows/scan-static.yml): reads the tool list of
// public GitHub repositories from source, at the head of their default branch, and grades it, the way
// `mcp-check --repo` does. Nothing of a subject is run, installed or built.
//
//   node corpus/scan-static.mjs run <out-dir>    scan the dispatched items (environment: SHARD_ID, ATTEMPT_ID,
//                                                ITEMS, GITHUB_TOKEN optional) and write one bundle per item
//   node corpus/scan-static.mjs known-answer     print corpus/fixtures/known-answer.json as the code computes it
//
// For every item i, <out-dir>/<i>/bundle/ holds the result files of tool-qa's worker contract
// (worker-kit/README.md) and <out-dir>/<i>/meta.json the meta file; the step outputs has_<i>, fence_<i> and
// run_key_<i> name it for the worker-kit step that seals and uploads it as result-<attempt_id>-<i>.tar.age. A
// subject that cannot be graded still reports, with a skip and its fault side (SKIPS): not retryable when asking
// again will not help (gone or empty: the subject's; no tool found, an unsupported language or layout, a reader
// limit or error: ours); rate_limited or upstream_unavailable, marked retryable, when it may (a rate limit, an
// upstream error, the time limit), so tool-qa sends the item out again (retry_later); results/ says which case it
// was. Exit 0 whatever the subjects did; 1 when the dispatch inputs are malformed
// (nothing is read); 3 on a harness error, including a control that did not give its expected outcome (nothing is
// reported); 2 on a usage error.
//
// Subject text (tool names, descriptions, schemas, file paths, the repository's own name for its branch) is
// written under raw/ only. results/, controls/, observations/ and logs/ hold our own codes, counts, grades and
// check ids, never a key or a value taken from a subject, and never an attempt identity.
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker, isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import M from '../src/engine.js';
import { InputError } from '../src/limits.js';
import { parseList } from '../src/tools.js';
import { analyseList } from '../src/unreadable.js';
import { codeEffectsReport } from '../src/code-effects.js';
import { isApproximate, readerNotes, registrationNotSeen, repoProvenance, usableList } from '../src/inputs/collect.js';
import { VERSION } from '../src/version.js';
import { ranCommit } from './tool-commit.mjs';
import { oracleForScan } from './ast-grep/hook.mjs';

const require = createRequire(import.meta.url);
const Repo = require('../src/inputs/repo-source.cjs');

export const FORMAT = 'isokron-mcp-check-scan-static/1';
export const CONTROL_FORMAT = 'isokron-mcp-check-scan-static-control/1';
/** The pump's shard_size for scan-static (tool-qa pump/workflows.json); the workflow has one upload step per item. */
export const MAX_ITEMS = 25;
export const MAX_ITEMS_CHARS = 60000;
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A GitHub owner/repo: an owner of up to 39 letters, digits and hyphens; a repository name of up to 100 characters. */
export const SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const RUN_KEY_RE = /^[0-9a-f]{64}$/;
export const MARKER_RE = /^[A-Za-z0-9_-]{16,128}$/;
/** One subject: listing, reading and grading, before it counts as timed out (and is sent again). */
export const SUBJECT_TIMEOUT_MS = 90 * 1000;
/** No subject is started after this long: the job's limit is 45 minutes, the pump's lease 52. */
export const SHARD_BUDGET_MS = 32 * 60 * 1000;
export const STAGE = 'static';
export const RESULT_PATH = 'results/scan-static.json';
/**
 * Size caps (R-SS-01). Each raw/ file is written compact and cut to RAW_FILE_CAP: a list keeps the entries that fit
 * and says how many there were, and results/ names every file that was cut (raw_truncated). A subject's raw/ holds
 * at most four such files, so a bundle stays far under tool-qa's caps (worker-kit/contract.mjs: 8 MiB per file,
 * 64 MiB per bundle). A bundle that still breaks them (or cannot be built or written at all) is replaced by a
 * minimal one: results, observations, logs and controls, no subject raw/, skipped as bundle_error.
 */
export const RAW_FILE_CAP = 4 * 1024 * 1024;
export const BUNDLE_FILE_CAP = 8 * 1024 * 1024;
export const BUNDLE_CAP = 60 * 1024 * 1024;
const SECTIONS = ['spec', 'anthropic', 'openai', 'security', 'quality', 'surface'];
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const KNOWN_ANSWER_FILE = join(FIXTURES, 'known-answer.json');
const API = 'https://api.github.com';
const API_CAP = 1024 * 1024;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

/** Why a subject has no grades, when that will not change by asking again. bad_subject: not a GitHub owner/name. */
export const PERMANENT = Object.freeze(['bad_subject', 'repo_unavailable', 'repo_empty', 'no_tools', 'unsupported_language', 'names_only', 'multiple_servers', 'reader_limit', 'list_rejected', 'listing_too_large', 'reader_error', 'bundle_error']);
/** Why a subject has no grades for now; results/ marks the skip retryable. */
export const TRANSIENT = Object.freeze(['rate_limited', 'upstream_error', 'timeout', 'read_failed', 'shard_deadline']);
/**
 * The skip reasons (tool-qa worker-kit/contract.mjs SKIP_REASONS) a skipped item is recorded with; results/ holds
 * the exact detail code. A passing failure is recorded with `retryable: true`, as rate_limited (a GitHub rate limit)
 * or upstream_unavailable (GitHub answered 5xx or something unreadable, the read broke off, the subject ran out of
 * time, or the shard ran out of time before it started, which only happens when upstream calls are slow): tool-qa
 * then sends the item out again after a backoff.
 */
export const SKIP_REASON = 'no_runnable_artifact';
export const SKIP_RATE_LIMITED = 'rate_limited';
export const SKIP_UPSTREAM = 'upstream_unavailable';

/**
 * The tool-qa skip reason and fault side of every detail code (R-SS-14; tool-qa worker-kit SKIP_FAULTS). A lasting
 * failure of ours is never recorded as the subject's: our reader's limits and errors have reasons of their own, all
 * with fault "tool". Only a repository that is gone, private, blocked or empty is the subject's. A subject that is
 * not a GitHub owner/name is ours too: this lane reads GitHub only. no_tools (no registration found) is ours until a
 * person says the repository is not a server.
 */
export const SKIPS = Object.freeze({
  bad_subject: Object.freeze(['no_runnable_artifact', 'tool']),
  repo_unavailable: Object.freeze(['no_runnable_artifact', 'subject']),
  repo_empty: Object.freeze(['no_runnable_artifact', 'subject']),
  no_tools: Object.freeze(['no_tools_found', 'tool']),
  unsupported_language: Object.freeze(['unsupported_language', 'tool']),
  names_only: Object.freeze(['reader_limit', 'tool']),
  multiple_servers: Object.freeze(['unsupported_layout', 'tool']),
  reader_limit: Object.freeze(['reader_limit', 'tool']),
  list_rejected: Object.freeze(['tool_error', 'tool']), // list_error too_large: too_large
  listing_too_large: Object.freeze(['too_large', 'tool']),
  reader_error: Object.freeze(['tool_error', 'tool']),
  bundle_error: Object.freeze(['tool_error', 'tool']),
  rate_limited: Object.freeze([SKIP_RATE_LIMITED, 'infra']),
  upstream_error: Object.freeze([SKIP_UPSTREAM, 'infra']),
  timeout: Object.freeze([SKIP_UPSTREAM, 'infra']),
  read_failed: Object.freeze([SKIP_UPSTREAM, 'infra']),
  shard_deadline: Object.freeze([SKIP_UPSTREAM, 'infra']),
});

/** The skip reason a skip with this detail code (and list error, for list_rejected) is recorded with. */
export function skipReasonFor(detail, listError = null) {
  if (detail === 'list_rejected' && listError === 'too_large') return 'too_large';
  return Object.hasOwn(SKIPS, detail) ? SKIPS[detail][0] : 'tool_error';
}

/** Who a skip with this detail code is down to: tool, subject or infra (tool-qa worker-kit FAULT_SIDES). */
export function skipFaultFor(detail) {
  return Object.hasOwn(SKIPS, detail) ? SKIPS[detail][1] : 'tool';
}
/** A subject id the result manifest accepts (subject.id: no whitespace, at most 512 characters). */
export const SUBJECT_ID_RE = /^[^\s]{1,512}$/;

/** What a run is configured with; its digest is the meta file's settings_manifest_digest. */
export const SETTINGS = Object.freeze({
  lane: 'scan-static',
  format: FORMAT,
  subject_ref: 'default branch head',
  reader: 'repo-source fromGitHub, no jsDelivr fallback, default file limits',
  grading: 'parseList + analyseList, as mcp-check --repo',
  subject_timeout_ms: SUBJECT_TIMEOUT_MS,
  shard_budget_ms: SHARD_BUDGET_MS,
});

export class InputProblem extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const json = (v) => JSON.stringify(v, null, 2) + '\n';

export function isDateTime(s) {
  const m = typeof s === 'string' ? DATE_TIME_RE.exec(s) : null;
  if (!m) return false;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || se > 60) return false;
  return !Number.isNaN(Date.parse(s));
}

export function settingsDigest() {
  const s = { ...SETTINGS, engine_version: VERSION, rubric_version: M.RUBRIC_VERSION, spec_version: M.SPEC_VERSION };
  return sha256(JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]])));
}

/** A fresh forgery marker: hex only, so no secret pattern can match it. */
export const newMarker = () => 'scanstatic-' + randomBytes(16).toString('hex');

/**
 * The dispatch inputs, checked whole. Throws InputProblem; its message never repeats the input. A subject that the
 * manifest can name but that is not a GitHub owner/name gets repo null: its item reports a bad_subject skip.
 * @returns {{shardId: string, attemptId: string, items: {index: number, subject: string, repo: string|null, run_key: string, fence: number}[]}}
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
      if (!x || typeof x !== 'object' || Array.isArray(x)) throw new InputProblem('bad_item', 'items[' + i + '] is not an object');
      if (Object.keys(x).some((k) => !['subject', 'run_key', 'fence'].includes(k))) throw new InputProblem('bad_item', 'items[' + i + '] has keys other than subject, run_key and fence');
      if (typeof x.subject !== 'string' || !SUBJECT_ID_RE.test(x.subject) || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(x.subject)) throw new InputProblem('bad_subject', 'items[' + i + '].subject must be 1 to 512 characters with no space or control character');
      if (typeof x.run_key !== 'string' || !RUN_KEY_RE.test(x.run_key)) throw new InputProblem('bad_run_key', 'items[' + i + '].run_key must be 64 lower-case hex digits');
      if (!Number.isSafeInteger(x.fence) || x.fence < 1) throw new InputProblem('bad_fence', 'items[' + i + '].fence must be a positive whole number');
      if (seen.has(x.run_key)) throw new InputProblem('duplicate_run_key', 'items[' + i + '] repeats the run_key of an earlier item');
      seen.add(x.run_key);
      const repo = SUBJECT_RE.test(x.subject) && !/\/\.\.?$/.test(x.subject) ? x.subject : null;
      return { index: i, subject: x.subject, repo, run_key: x.run_key, fence: x.fence };
    }),
  };
}

// ------------------------------------------------------------------ grading

/**
 * Grades a list read from a repository. summary: our numbers only (tools by position, never by name), for
 * results/ and controls/. report: everything, with the subject's names, paths and messages, for raw/.
 */
export function gradeCandidate(c) {
  const parsed = parseList(c.tools, 'the tool list read from source');
  const r = analyseList(parsed, readerNotes(c));
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
    skipped_checks: r.skipped_checks || null,
  };
  const report = { findings: all.map((f) => ({ id: f.id, severity: f.severity, section: f.section || null, tool: f.tool || null, path: f.path || null, message: f.message || null })) };
  return { summary, report, parsed };
}

/** The registration_provenance field (class P-s): how the list was read, in our codes and counts. */
export function provenanceOf(c, r, toolCount) {
  const { left, cond } = repoProvenance(c);
  const u = c.unreadable || {};
  const n = (k) => (Array.isArray(u[k]) ? u[k].length : 0);
  return {
    fidelity: c.fidelity,
    from: c.kind,
    language: c.language ? String(c.language).toLowerCase() : null,
    approximate: isApproximate(c),
    tools_listed: toolCount,
    tools_left_out: left.length,
    tools_conditional: cond.length,
    unresolved_names: Number.isInteger(c.unresolvedNames) ? c.unresolvedNames : 0,
    registration_not_seen: registrationNotSeen(c).length,
    unreadable: { input_schemas: n('inputSchema'), descriptions: n('description'), annotations: n('annotations') },
    listing_truncated: !!r.truncated,
  };
}

/** Share of a subject's time limit after which no more server folders of a multi-server repository are read. */
export const SERVERS_SHARE = 0.6;

/** Languages the reader reads besides TypeScript, JavaScript and Python: a repository mostly in one of them is not
 * `unsupported_language` (one list for the subject and for each server folder). */
export const READ_LANGUAGES = Object.freeze(['Go', 'Rust', 'C#']);
/** A scan that found no source file of any language: no file the reader reads, and none in another language. */
export function noSource(scan) {
  const s = (scan && scan.scanned) || {};
  return s.sourceTotal === 0 && !((scan.hints && scan.hints.otherLanguages) || []).length;
}
/** Why one server folder of a multi-server repository has no grades: the subject's codes (usableList). */
export function serverSkip(scan) {
  const u = usableList(scan);
  if (u.problem === 'incomplete') return 'reader_limit';
  if (u.problem === 'multiple') return 'multiple_servers';
  if (u.problem === 'names') return 'names_only';
  if (u.problem === 'none') {
    const lang = ((scan.hints && scan.hints.otherLanguages) || [])[0];
    return (lang && lang.files >= lang.readFiles && !READ_LANGUAGES.includes(lang.name)) || noSource(scan) ? 'unsupported_language' : 'no_tools';
  }
  return null;
}

/**
 * The per-server breakdown of a repository of several servers (R-SS-13): each server folder the reader found
 * (hints.servers, in its order) read on its own (serverScans) and graded like a subject. servers: for results/,
 * by position only, with our codes, counts and grades (never a folder name, a tool name or a message); raw: the
 * folder, tools and findings of each, for raw/subject/servers.json. `declared`: a server.json of the repository
 * names that folder as its repository.subfolder. One server's failure never stops the others.
 */
export function serverBreakdown(serverScans, r) {
  const servers = [];
  const raw = [];
  serverScans.forEach((x, index) => {
    const rec = { index, status: 'skipped', detail: null, declared: x.declared === true, list_error: null, list: null, tool_count: null, catalog_hash: null, era: null, sections: null, check_counts: null, findings: null, skipped_checks: null };
    const rr = { index, path: typeof x.path === 'string' ? x.path : null, tools: null, provenance: null, files: null, findings: null };
    servers.push(rec);
    raw.push(rr);
    if (!x.scan) { rec.detail = PERMANENT.includes(x.skipped) || TRANSIENT.includes(x.skipped) ? x.skipped : 'reader_error'; return; }
    const skip = serverSkip(x.scan);
    const c = x.scan.best;
    if (c && c.tools) rr.tools = c.tools;
    if (skip) { rec.detail = skip; return; }
    let g;
    try { g = gradeCandidate(c); } catch (e) {
      const ge = gradeError(e);
      rec.detail = ge && ge.detail ? ge.detail : 'reader_error';
      rec.list_error = ge && typeof ge.listError === 'string' && /^[a-z_]{1,40}$/.test(ge.listError) ? ge.listError : null;
      return;
    }
    Object.assign(rec, { status: 'graded', ...g.summary, list: provenanceOf(c, { truncated: !!(r && r.truncated) }, g.summary.tool_count) });
    Object.assign(rr, { provenance: repoProvenance(c).provenance, files: c.files || [c.path], findings: g.report.findings });
  });
  return { servers, raw };
}

// ------------------------------------------------------------------ GitHub

const fail = (detail, extra = {}) => Object.assign(new Error(detail), { detail }, extra);

async function readBody(res, cap) {
  const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
  if (len > cap) throw fail('upstream_error', { status: res.status });
  const t = await res.text();
  if (t.length > cap) throw fail('upstream_error', { status: res.status });
  return t;
}

/** An HTTP failure from the GitHub API, as a detail code. */
export function httpDetail(status, header, body) {
  if (status === 429 || (status === 403 && (header('x-ratelimit-remaining') === '0' || header('retry-after') != null || /rate limit/i.test(body)))) return 'rate_limited';
  // Any other 403 is a refusal of this repository (blocked, or forbidden to us): asking again will not help (R-SS-07).
  if (status === 404 || status === 410 || status === 451 || status === 403) return 'repo_unavailable';
  return 'upstream_error';
}

async function ghJson(f, path, token) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'isokron-mcp-check-scan-static' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await f(API + path, { headers, redirect: 'follow', credentials: 'omit' });
  if (!res.ok) {
    let body = '';
    try { body = await readBody(res, 64 * 1024); } catch { /* the status is enough */ }
    const header = (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
    throw fail(httpDetail(res.status, header, body), { status: res.status });
  }
  try { return JSON.parse(await readBody(res, API_CAP)); } catch { throw fail('upstream_error', { status: res.status }); }
}

/** A RangeError that means the list was too large: a string or a buffer past what the runtime can hold. */
export const TOO_LARGE_RE = /Invalid string length|allocation failed/i;

/**
 * What grading a list failed with, as the error scanSubject records: an input refusal is list_rejected with its
 * code; a list too large to hold (R-SS-11) is list_rejected / too_large. Any other error, other RangeErrors such as
 * "Maximum call stack size exceeded" included, is returned as it is and recorded as reader_error (R-SS-12).
 */
export function gradeError(e) {
  if (e instanceof InputError) return fail('list_rejected', { listError: e.code });
  if (e instanceof RangeError && TOO_LARGE_RE.test(String(e.message))) return fail('list_rejected', { listError: 'too_large' });
  return e;
}

/**
 * A failure of the reader (RepoSource.fromGitHub), as a detail code. The reader calls any 403 or 429 a rate limit;
 * here a 403 is one only when GitHub said so on a refused answer this subject got (`refused`):
 * x-ratelimit-remaining 0, retry-after, or "rate limit" at the start of the body (GitHub's secondary limits send no
 * headers). A 403 from the reader without any of these is unexplained: upstream_error, retryable, so tool-qa's
 * bounded retries decide (R-SS-07, R-SS-09). The repository's own refusal shows on the API call before the reader
 * (httpDetail: repo_unavailable).
 */
export function readDetail(e, aborted, refused = null) {
  if (aborted || (e && e.name === 'AbortError')) return 'timeout';
  const limited = !!refused && (refused.status === 429 || refused.remaining === '0' || refused.retryAfter != null || refused.rateLimitBody === true);
  if (e && (e.status === 429 || ((e.code === 'rate_limited' || e.status === 403) && limited))) return 'rate_limited';
  if (e && (e.code === 'rate_limited' || e.status === 403)) return 'upstream_error';
  if (e && e.code === 'incomplete') return 'read_failed';
  if (e && e.code === 'too_large') return 'listing_too_large';
  if (e && Number.isInteger(e.status)) return 'upstream_error';
  if (e && (e.name === 'SyntaxError' || (e.name === 'TypeError' && /fetch failed|network/i.test(String(e.message))))) return 'upstream_error';
  return 'reader_error';
}

const safeName = (s) => (typeof s === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(s) ? s : null);

/** A skipped scan that read nothing: a subject that is not owner/name, or one not started (detail). */
export const notRead = (detail) => ({
  status: 'skipped', detail, retryable: TRANSIENT.includes(detail), skip_reason: skipReasonFor(detail),
  http_status: null, list_error: null, error_name: null, language_hint: null, repository: null, commit: null, listing: null, list: null, grade: null, raw: {},
});

/**
 * One subject. Never throws. status: 'graded' or 'skipped'; a skip has a detail (PERMANENT or TRANSIENT), retryable
 * (TRANSIENT) and the skip_reason it is recorded with. Everything outside `raw` is ours; `raw` holds what the
 * subject wrote, for raw/ only.
 */
export async function scanSubject(subject, { fetch: fetchImpl = globalThis.fetch, token = null, timeoutMs = SUBJECT_TIMEOUT_MS, codeEffects = false } = {}) {
  const out = {
    status: null, detail: null, retryable: false, skip_reason: null, http_status: null, list_error: null, error_name: null, language_hint: null,
    repository: null, commit: null, listing: null, list: null, grade: null, servers: null, raw: {},
  };
  const ctl = new AbortController();
  let refused = null; // the last 403 or 429 this subject got, with GitHub's rate-limit headers
  const f = async (url, init = {}) => {
    const res = await fetchImpl(url, { ...init, signal: ctl.signal });
    if (res && (res.status === 403 || res.status === 429)) {
      const h = (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
      refused = { status: res.status, remaining: h('x-ratelimit-remaining'), retryAfter: h('retry-after'), rateLimitBody: false };
      // GitHub's secondary rate limits come without rate-limit headers; their body says so (R-SS-09).
      if (typeof res.clone === 'function') {
        try { refused.rateLimitBody = /rate limit/i.test((await res.clone().text()).slice(0, 2048)); } catch { /* the headers are enough */ }
      }
    }
    return res;
  };
  let phase = 'repo';
  const started = Date.now();
  const work = (async () => {
    const [owner, name] = subject.split('/');
    const info = await ghJson(f, '/repos/' + owner + '/' + name, token);
    if (!info || typeof info !== 'object' || Array.isArray(info)) throw fail('upstream_error');
    if (info.private === true || info.disabled === true) throw fail('repo_unavailable');
    const full = typeof info.full_name === 'string' && SUBJECT_RE.test(info.full_name) ? info.full_name : subject;
    out.repository = { moved: full.toLowerCase() !== subject.toLowerCase(), archived: info.archived === true, fork: info.fork === true };
    out.raw.repo = { full_name: full, default_branch: typeof info.default_branch === 'string' ? info.default_branch.slice(0, 300) : null };
    const branch = typeof info.default_branch === 'string' && info.default_branch.length > 0 && info.default_branch.length <= 255 ? info.default_branch : null;
    if (!branch) throw fail('repo_empty');

    phase = 'branch';
    let b;
    try { b = await ghJson(f, '/repos/' + full + '/branches/' + branch.split('/').map(encodeURIComponent).join('/'), token); } catch (e) {
      if (e.status === 404 || e.status === 409) throw fail('repo_empty', { status: e.status });
      throw e;
    }
    const sha = b && b.commit && typeof b.commit.sha === 'string' && SHA_RE.test(b.commit.sha) ? b.commit.sha : null;
    if (!sha) throw fail('upstream_error');
    const c0 = b.commit.commit && typeof b.commit.commit === 'object' ? b.commit.commit : {};
    const date = c0.committer && typeof c0.committer === 'object' ? c0.committer.date : null;
    out.commit = { sha, date: isDateTime(date) ? date : null };

    phase = 'read';
    let r;
    // servers: a repository of several servers is also read server by server, from the same listing (R-SS-13)
    const ropts = { fetch: f, githubToken: token || undefined, noFallback: true, servers: true, serversDeadline: started + Math.floor(timeoutMs * SERVERS_SHARE), ...(codeEffects ? { effects: true } : {}) };
    try { r = await Repo.fromGitHub('github.com/' + full + '/tree/' + sha, ropts); } catch (e) {
      throw fail(readDetail(e, ctl.signal.aborted, refused), { status: Number.isInteger(e && e.status) ? e.status : undefined, errorName: e && e.name });
    }
    const s = r.scanned || {};
    out.listing = { via: r.via === 'github' ? 'github' : null, truncated: !!r.truncated, source_files: Number.isInteger(s.sourceTotal) ? s.sourceTotal : null, files_read: Number.isInteger(s.read) ? s.read : Number.isInteger(s.source) ? s.source : null, budget_hit: !!s.budgetHit };
    out.raw.scan = { scanned: r.scanned || null, hints: r.hints || null };
    const u = usableList(r);
    if (u.candidate) out.raw.tools = u.candidate.tools;
    if (u.problem === 'incomplete') throw fail('reader_limit');
    if (u.problem === 'multiple') {
      if (Array.isArray(r.serverScans) && r.serverScans.length && !ctl.signal.aborted) {
        // the breakdown never turns the subject's own outcome into another one
        try { const b = serverBreakdown(r.serverScans, r); out.servers = b.servers; out.raw.servers = b.raw; } catch { out.servers = null; delete out.raw.servers; }
      }
      throw fail('multiple_servers');
    }
    if (u.problem === 'names') throw fail('names_only');
    if (u.problem === 'none') {
      const lang = ((r.hints && r.hints.otherLanguages) || [])[0];
      if (lang && lang.files >= lang.readFiles && !READ_LANGUAGES.includes(lang.name)) {
        out.language_hint = typeof lang.name === 'string' && /^[A-Za-z#+]{1,20}$/.test(lang.name) ? lang.name : null;
        throw fail('unsupported_language');
      }
      // no source file of any language (a README, manifest or Dockerfile only): what the reader reads is not here (R-RD-43)
      if (noSource(r)) throw fail('unsupported_language');
      throw fail('no_tools');
    }

    phase = 'grade';
    const c = u.candidate;
    let g;
    try { g = gradeCandidate(c); } catch (e) {
      throw gradeError(e);
    }
    out.grade = g.summary;
    out.list = provenanceOf(c, r, g.summary.tool_count);
    out.raw.report = { provenance: repoProvenance(c).provenance, files: c.files || [c.path], findings: g.report.findings };
    // opt-in (codeEffects): what the handlers touch, in raw/ only; results/ and the grades are the same with it on or off
    // never attention in loop output until real-repo QA: maxSeverity advice
    if (codeEffects) { try { out.raw.code_effects = codeEffectsReport(g.parsed.tools, c.effects || null, { unreadable: c.unreadable, maxSeverity: 'advice' }); } catch { out.raw.code_effects = { version: 0, error: 'code_effects_failed' }; } }
  })();
  work.catch(() => {}); // a subject that timed out may still fail later; that is not unhandled
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(fail('timeout')); }, timeoutMs); });
  try {
    await Promise.race([work, deadline]);
    out.status = 'graded';
  } catch (e) {
    let detail = e && e.detail;
    if (!detail) {
      if (ctl.signal.aborted || (e && e.name === 'AbortError')) detail = 'timeout';
      else if (phase === 'repo' || phase === 'branch' || (e && e.name === 'TypeError' && /fetch failed|network/i.test(String(e.message)))) detail = 'upstream_error';
      else detail = 'reader_error';
    }
    out.detail = detail;
    if (detail !== 'multiple_servers') out.servers = null;
    out.status = 'skipped';
    out.retryable = TRANSIENT.includes(detail);
    out.http_status = e && Number.isInteger(e.status) ? e.status : null;
    out.list_error = e && typeof e.listError === 'string' && /^[a-z_]{1,40}$/.test(e.listError) ? e.listError : null;
    out.skip_reason = skipReasonFor(detail, out.list_error);
    if (detail === 'reader_error') out.error_name = safeName((e && e.errorName) || (e && e.name));
    out.grade = null;
    out.list = null;
  } finally {
    clearTimeout(timer);
  }
  return out;
}

// ------------------------------------------------------------------ controls

const answerOf = (summary) => ({
  tool_count: summary.tool_count,
  catalog_hash: summary.catalog_hash,
  grades: Object.fromEntries(SECTIONS.map((k) => [k, summary.sections[k].grade])),
  checks: Object.keys(summary.check_counts).sort(),
});

/** A commit id for the known-answer fixture served as a GitHub repository (any 40 hex will do: nothing is fetched). */
const FIXTURE_SHA = 'f'.repeat(40);
const FIXTURE_REPO = 'isokron-fixture/known-answer';

/**
 * A fetch that serves a folder as the GitHub repository FIXTURE_REPO at FIXTURE_SHA: the recursive tree from the
 * API and each file from raw.githubusercontent.com, the two hosts the reader uses. No network (R-SS-04).
 */
export function fixtureFetch(dir) {
  const paths = [];
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), r);
      else if (e.isFile()) paths.push(r);
    }
  };
  walk(dir, '');
  const tree = { sha: FIXTURE_SHA, truncated: false, tree: paths.map((p) => ({ path: p, type: 'blob', size: statSync(join(dir, ...p.split('/'))).size })) };
  const rawBase = 'https://raw.githubusercontent.com/' + FIXTURE_REPO + '/' + FIXTURE_SHA + '/';
  return async (url) => {
    const u = String(url);
    if (u === API + '/repos/' + FIXTURE_REPO + '/git/trees/' + FIXTURE_SHA + '?recursive=1') {
      return new Response(JSON.stringify(tree), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith(rawBase)) {
      const rel = u.slice(rawBase.length).split('/').map(decodeURIComponent).join('/');
      if (paths.includes(rel)) return new Response(readFileSync(join(dir, ...rel.split('/'))), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
}

/**
 * The known-answer control's answer, read and graded from corpus/fixtures/known-answer/: from the folder
 * (via 'directory'), or served as a GitHub repository through fromGitHub, the reader the subjects go through
 * (via 'github').
 */
export async function knownAnswer({ via = 'directory' } = {}) {
  const dir = join(FIXTURES, 'known-answer');
  const r = via === 'github'
    ? await Repo.fromGitHub('github.com/' + FIXTURE_REPO + '/tree/' + FIXTURE_SHA, { fetch: fixtureFetch(dir), noFallback: true })
    : await Repo.fromDirectory(dir);
  const u = usableList(r);
  if (!u.candidate) throw new Error('known-answer fixture: no list read (' + u.problem + ')');
  return answerOf(gradeCandidate(u.candidate).summary);
}

/** The committed expected answer file, as the code computes it now. */
export async function knownAnswerFile() {
  return { format: CONTROL_FORMAT, control: 'known-answer', rubric_version: M.RUBRIC_VERSION, answer: await knownAnswer() };
}

/**
 * { control, files }: kind known_bad (the fixture hides an instruction), expected "match": the fixture read from
 * its folder and read through fromGitHub must both give the committed answer.
 */
export async function knownAnswerControl({ expectedFile = KNOWN_ANSWER_FILE } = {}) {
  const expected = JSON.parse(readFileSync(expectedFile, 'utf8')).answer;
  const observed = await knownAnswer();
  const observedGithub = await knownAnswer({ via: 'github' });
  const match = isDeepStrictEqual(observed, expected) && isDeepStrictEqual(observedGithub, expected);
  const output = { format: CONTROL_FORMAT, control: 'known-answer', engine_version: VERSION, rubric_version: M.RUBRIC_VERSION, match, expected, observed, observed_github: observedGithub };
  return {
    control: { kind: 'known_bad', expected: 'match', observed: match ? 'match' : 'mismatch', output: 'controls/known-answer.json' },
    files: { 'controls/known-answer.json': json(output) },
  };
}

/** Keys of a JSON value, at every level. */
function keysOf(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}
const IDENTITY_KEY = (k) => /^(attempt_?id|run_?key|fence|fencing_?(no|number)|fence_?token)$/.test(String(k).toLowerCase().replace(/[-\s]/g, '_'));
// What tool-qa's ingest takes for an identity claim in text (ingest/forgery.mjs TEXT_CLAIM_RE).
const TEXT_CLAIM_RE = /["']?\b(attempt[_-]?id|run[_-]?key|fencing[_-]?(?:no|number)|fence)\b["']?\s*[:=]\s*["']?([A-Za-z0-9._-]{1,128})/i;

/** What a bundle file outside raw/ shows that it must not: the marker, an identity key or claim, an envelope. */
function leakIn(path, text, marker) {
  if (text.includes(marker)) return 'marker';
  let docs = null;
  try {
    if (path.endsWith('.json')) docs = [JSON.parse(text)];
    else if (path.endsWith('.ndjson')) docs = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { docs = null; }
  if (!docs) return TEXT_CLAIM_RE.test(text) ? 'identity_claim' : null;
  for (const d of docs) {
    const keys = keysOf(d);
    if ([...keys].some(IDENTITY_KEY)) return 'identity_key';
    if (keys.has('schema_version') && keys.has('files')) return 'envelope';
  }
  return null;
}

/** A scan of what the reader read (`r`), as scanSubject records a graded subject; for the controls. */
function scanOfRead(r) {
  const u = usableList(r);
  const s = r.scanned || {};
  const scan = { ...notRead('no_tools'), raw: {} };
  scan.listing = { via: r.via === 'github' ? 'github' : null, truncated: !!r.truncated, source_files: Number.isInteger(s.sourceTotal) ? s.sourceTotal : null, files_read: Number.isInteger(s.read) ? s.read : Number.isInteger(s.source) ? s.source : null, budget_hit: !!s.budgetHit };
  scan.raw.scan = { scanned: r.scanned || null, hints: r.hints || null };
  if (u.problem === 'multiple') {
    Object.assign(scan, notRead('multiple_servers'), { listing: scan.listing });
    if (Array.isArray(r.serverScans) && r.serverScans.length) { const b = serverBreakdown(r.serverScans, r); scan.servers = b.servers; scan.raw.servers = b.raw; }
    return scan;
  }
  if (!u.candidate) return scan;
  scan.raw.tools = u.candidate.tools;
  const g = gradeCandidate(u.candidate);
  Object.assign(scan, { status: 'graded', detail: null, retryable: false, skip_reason: null, grade: g.summary, list: provenanceOf(u.candidate, r, g.summary.tool_count) });
  scan.raw.report = { provenance: repoProvenance(u.candidate).provenance, files: u.candidate.files || [u.candidate.path], findings: g.report.findings };
  return scan;
}

/**
 * The forgery control: corpus/fixtures/forgery/ with a fresh marker, read, graded and reported like a subject,
 * through resultOf and buildBundle (R-SS-03). Its tool texts are a result envelope of another attempt and its names
 * are identity keys. It also reads corpus/fixtures/forgery-servers/, two such servers in folders whose names carry
 * the marker, with the per-server breakdown (R-SS-13). Contained: the marker came back in raw/ (the breakdown's in
 * raw/subject/servers.json, with both servers graded), and no file either bundle would hold outside raw/ (nor the
 * control output) holds the marker, an identity key or claim, or an envelope.
 */
export async function forgeryControl({ marker = newMarker(), tmp = tmpdir() } = {}) {
  if (!MARKER_RE.test(marker)) throw new Error('forgery control: bad marker');
  const dir = mkdtempSync(join(tmp, 'scan-static-forgery-'));
  try {
    // the single server, and a repository of two servers whose folder names carry the marker too (R-SS-13)
    const copy = (from, to) => {
      mkdirSync(to, { recursive: true });
      for (const e of readdirSync(from, { withFileTypes: true })) {
        const target = join(to, e.name.split('__MARKER__').join(marker));
        if (e.isDirectory()) copy(join(from, e.name), target);
        else writeFileSync(target, readFileSync(join(from, e.name), 'utf8').split('__MARKER__').join(marker));
      }
    };
    copy(join(FIXTURES, 'forgery'), join(dir, 'one'));
    copy(join(FIXTURES, 'forgery-servers'), join(dir, 'several'));
    const scan = scanOfRead(await Repo.fromDirectory(join(dir, 'one')));
    const multi = scanOfRead(await Repo.fromDirectory(join(dir, 'several'), { servers: true }));
    const at = new Date(0).toISOString();
    const item = { index: 0, subject: 'control/forgery', repo: 'control/forgery', run_key: '0'.repeat(64), fence: 1 };
    const { files } = buildBundle({ item, scan, controls: [], startedAt: at, finishedAt: at });
    const { files: multiFiles } = buildBundle({ item, scan: multi, controls: [], startedAt: at, finishedAt: at });
    const outside = Object.entries(files).filter(([p]) => !p.startsWith('raw/'));
    const multiOutside = Object.entries(multiFiles).filter(([p]) => !p.startsWith('raw/'));
    const leaks = outside.map(([p, text]) => [p, leakIn(p, text, marker)]).filter(([, why]) => why)
      .concat(multiOutside.map(([p, text]) => ['servers/' + p, leakIn(p, text, marker)]).filter(([, why]) => why));
    const rawHasMarker = Object.entries(files).some(([p, text]) => p.startsWith('raw/') && text.includes(marker));
    const multiRawHasMarker = typeof multiFiles['raw/subject/servers.json'] === 'string' && multiFiles['raw/subject/servers.json'].includes(marker);
    const multiGraded = Array.isArray(multi.servers) ? multi.servers.filter((x) => x.status === 'graded' && x.tool_count >= 2).length : 0;
    const g = scan.grade;
    const output = {
      format: CONTROL_FORMAT, control: 'forgery', status: scan.status,
      tool_count: g ? g.tool_count : null, catalog_hash: g ? g.catalog_hash : null, grades: g ? answerOf(g).grades : null,
      check_counts: g ? g.check_counts : null, findings: g ? g.findings : null,
      servers_status: multi.status, servers_detail: multi.detail, servers_graded: multiGraded,
      files_checked: outside.length + multiOutside.length, leaks: leaks.map(([p, why]) => ({ path: p, why })),
    };
    const outText = json(output);
    const outLeak = leakIn('controls/forgery.json', outText, marker);
    const observed = scan.status !== 'graded' || g.tool_count < 2 || !rawHasMarker || multi.detail !== 'multiple_servers' || multiGraded < 2 || !multiRawHasMarker ? 'not_read'
      : leaks.length || outLeak ? 'leaked' : 'contained';
    return {
      control: { kind: 'forgery', expected: 'contained', observed, output: 'controls/forgery.json', marker },
      files: { 'controls/forgery.json': outText, 'raw/control-forgery/tools.json': rawText({ tools: scan.raw.tools ?? null }).text },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ bundles

/** The observations of one subject: commit_sha, commit_date, registration_provenance (stage "static"). */
export function observationsOf(scan) {
  const rec = (field, value, why) => JSON.stringify(value === null || value === undefined ? { field, value: null, why, stage: STAGE } : { field, value, stage: STAGE });
  const noCommit = 'the default branch head was not read (' + scan.detail + ')';
  return [
    rec('commit_sha', scan.commit ? scan.commit.sha : null, noCommit),
    rec('commit_date', scan.commit ? scan.commit.date : null, scan.commit ? 'GitHub gave no committer date for the commit' : noCommit),
    rec('registration_provenance', scan.list, 'no tool list was graded (' + scan.detail + ')'),
    // where the reader and the ast-grep oracle differ (a lead about our reader, never a verdict on the subject); only then
    ...(scan.oracle && scan.oracle.entries.length ? [rec('oracle_disagreements', scan.oracle.entries)] : []),
  ].join('\n') + '\n';
}

/** The result record of one subject (results/scan-static.json): our codes, counts and grades only. */
export function resultOf(item, scan, scannedAt) {
  const g = scan.grade;
  return {
    format: FORMAT,
    subject: item.repo,
    status: scan.status,
    detail: scan.detail,
    retryable: scan.status === 'skipped' ? scan.retryable : false,
    scanned_at: scannedAt,
    engine_version: VERSION,
    rubric_version: M.RUBRIC_VERSION,
    spec_version: M.SPEC_VERSION,
    http_status: scan.http_status,
    list_error: scan.list_error,
    error_name: scan.error_name,
    language_hint: scan.language_hint,
    repository: scan.repository,
    commit: scan.commit,
    listing: scan.listing,
    list: scan.list,
    tool_count: g ? g.tool_count : null,
    catalog_hash: g ? g.catalog_hash : null,
    era: g ? g.era : null,
    sections: g ? g.sections : null,
    check_counts: g ? g.check_counts : null,
    findings: g ? g.findings : null,
    skipped_checks: g ? g.skipped_checks : null,
    // a repository of several servers: each one's grades, by position (R-SS-13); raw/subject/servers.json names them
    servers: Array.isArray(scan.servers) ? scan.servers : null,
    // the ast-grep oracle's answer (corpus/ast-grep/), only when it ran: counts and codes, no subject text
    ...(scan.oracle ? { oracle_ast_grep: scan.oracle.fact } : {}),
  };
}

const logLine = (at, text) => at + ' ' + STAGE + ': ' + text;

const OVER = Symbol('over the cap');

/**
 * Compact JSON of `value`, or null as soon as it would pass `cap` characters. It never builds more than about `cap`
 * characters, however large the value is once expanded (a constant shared by every tool serialises once per use).
 */
export function jsonUpTo(value, cap) {
  const parts = [];
  let n = 0;
  const put = (s) => {
    n += s.length;
    if (n > cap) throw OVER;
    parts.push(s);
  };
  const walk = (v, depth) => {
    if (depth > 200) throw OVER;
    if (typeof v === 'string') {
      if (v.length > cap - n) throw OVER;
      put(JSON.stringify(v));
    } else if (v === null || typeof v === 'boolean' || typeof v === 'number') {
      put(JSON.stringify(v));
    } else if (Array.isArray(v)) {
      put('[');
      for (let i = 0; i < v.length; i++) {
        if (i) put(',');
        const x = v[i];
        walk(x === undefined || typeof x === 'function' || typeof x === 'symbol' ? null : x, depth + 1);
      }
      put(']');
    } else if (typeof v === 'object') {
      if (typeof v.toJSON === 'function') { walk(v.toJSON(), depth); return; }
      put('{');
      let first = true;
      for (const k of Object.keys(v)) {
        const x = v[k];
        if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
        put((first ? '' : ',') + JSON.stringify(k) + ':');
        first = false;
        walk(x, depth + 1);
      }
      put('}');
    } else {
      put('null');
    }
  };
  try {
    walk(value, 0);
    return parts.join('');
  } catch (e) {
    if (e === OVER) return null;
    throw e;
  }
}

/**
 * One raw/ file (R-SS-01): compact JSON of `value`, at most `cap` bytes. When it does not fit, a list keeps the
 * entries that do, as {truncated: true, cap_bytes, total, kept, items}; anything else keeps nothing.
 * @returns {{ text: string, truncated: boolean }}
 */
export function rawText(value, cap = RAW_FILE_CAP) {
  const whole = jsonUpTo(value, cap - 1);
  if (whole !== null && Buffer.byteLength(whole) < cap) return { text: whole + '\n', truncated: false };
  const list = Array.isArray(value) ? value : null;
  const kept = [];
  let used = 160; // the wrapper
  if (list) {
    for (const x of list) {
      const s = jsonUpTo(x === undefined ? null : x, cap - used);
      if (s === null) break;
      const b = Buffer.byteLength(s) + 1;
      if (used + b > cap) break;
      kept.push(s);
      used += b;
    }
  }
  return {
    text: '{"truncated":true,"cap_bytes":' + cap + ',"total":' + (list ? list.length : 'null') + ',"kept":' + kept.length + ',"items":[' + kept.join(',') + ']}\n',
    truncated: true,
  };
}

/** The raw/ files of one subject: { files, truncated } (paths of the files that were cut). */
export function rawFiles(raw, cap = RAW_FILE_CAP) {
  const files = {};
  const truncated = [];
  const add = (path, value) => {
    if (value === undefined) return;
    const r = rawText(value, cap);
    files[path] = r.text;
    if (r.truncated) truncated.push(path);
  };
  if (raw.repo) add('raw/subject/repo.json', raw.repo);
  add('raw/subject/tools.json', raw.tools);
  if (raw.scan) add('raw/subject/scan.json', raw.scan);
  if (raw.report) add('raw/subject/report.json', raw.report);
  if (raw.servers) add('raw/subject/servers.json', raw.servers);
  if (raw.code_effects) add('raw/subject/code-effects.json', raw.code_effects);
  return { files, truncated };
}

/** The bundle breaks a size cap of tool-qa's (thrown by buildBundle; the item then gets a minimal bundle). */
export class BundleTooLarge extends Error {
  constructor(message) { super(message); this.name = 'BundleTooLarge'; }
}

/**
 * { files, meta } of one reported item. files: bundle path -> text. Throws BundleTooLarge when a file is over
 * fileCap or the files are over bundleCap together.
 */
export function buildBundle({ item, scan, controls, startedAt, finishedAt, digest = settingsDigest(), commit = ranCommit(), rawCap = RAW_FILE_CAP, fileCap = BUNDLE_FILE_CAP, bundleCap = BUNDLE_CAP }) {
  // A subject scanned in its own thread brings its raw/ texts built and capped already (R-SS-08).
  const base = scan.rawFiles && typeof scan.rawFiles === 'object' ? scan.rawFiles : rawFiles(scan.raw || {}, rawCap);
  const raw = { files: { ...base.files }, truncated: [...base.truncated] };
  if (scan.oracle) {
    const o = rawText(scan.oracle.raw, rawCap);
    raw.files['raw/subject/ast-grep.json'] = o.text;
    if (o.truncated) raw.truncated.push('raw/subject/ast-grep.json');
  }
  const files = {};
  files[RESULT_PATH] = json({ ...resultOf(item, scan, finishedAt), raw_truncated: raw.truncated });
  files['observations/static.ndjson'] = observationsOf(scan);
  const log = [logLine(startedAt, 'started; mcp-check ' + VERSION + ', rubric ' + M.RUBRIC_VERSION)];
  if (scan.commit) log.push(logLine(finishedAt, 'default branch head read'));
  if (scan.listing) log.push(logLine(finishedAt, 'listing via ' + scan.listing.via + (scan.listing.truncated ? ' (cut short by GitHub)' : '') + '; ' + scan.listing.files_read + ' of ' + scan.listing.source_files + ' source files read'));
  log.push(logLine(finishedAt, scan.status === 'graded' ? 'graded: ' + scan.grade.tool_count + ' tools' : 'skipped: ' + scan.detail + (scan.retryable ? ' (retryable)' : '')));
  if (scan.oracle) log.push(logLine(finishedAt, scan.oracle.log));
  if (raw.truncated.length) log.push(logLine(finishedAt, 'raw files cut to ' + rawCap + ' bytes: ' + raw.truncated.join(', ')));
  for (const c of controls) log.push(logLine(finishedAt, 'control ' + c.control.kind + ': ' + c.control.observed));
  files['logs/scan.log'] = log.join('\n') + '\n';
  Object.assign(files, raw.files);
  for (const c of controls) Object.assign(files, c.files);
  let total = 0;
  for (const [p, text] of Object.entries(files)) {
    const n = Buffer.byteLength(text);
    if (n > fileCap) throw new BundleTooLarge(p + ' would be ' + n + ' bytes, over ' + fileCap);
    total += n;
  }
  if (total > bundleCap) throw new BundleTooLarge('the bundle would be ' + total + ' bytes, over ' + bundleCap);
  const meta = {
    subject: { id: item.subject, repo: item.repo, sha: scan.commit ? scan.commit.sha : null },
    // The commit that ran, not the package version: tool-qa's version pins (R-PIN-01) are commits of this repository.
    tools: [{ name: 'mcp-check', version: commit }],
    oracles: scan.oracle ? [scan.oracle.component] : [],
    settings_manifest_digest: digest,
    started_at: startedAt,
    finished_at: finishedAt,
    skips: scan.status === 'skipped' ? [{
      stage: STAGE, reason: scan.skip_reason || skipReasonFor(scan.detail, scan.list_error), evidence: RESULT_PATH, retryable: scan.retryable === true,
      fault: skipFaultFor(scan.detail),
    }] : [],
    controls: controls.map((c) => c.control),
  };
  return { files, meta };
}

export function writeItem(dir, { files, meta }) {
  for (const [p, text] of Object.entries(files)) {
    const file = join(dir, 'bundle', ...p.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  writeFileSync(join(dir, 'meta.json'), json(meta));
}

/**
 * Build and write one item's bundle; never throws for the subject's sake (R-SS-01). When the full bundle cannot be
 * built or written (too large, a string past what the runtime can hold, a write error), the folder is cleared and a
 * minimal bundle written instead: results, observations, logs and controls, no subject raw/, a non-retryable
 * bundle_error skip. Only a failure of that minimal bundle throws (a harness error).
 * @returns {{ scan: object, fallback: string|null }} the scan as reported, and why the fallback was used
 */
export function reportItem(dir, { item, scan, controls, startedAt, finishedAt, digest, write = writeItem, ...caps }) {
  try {
    write(dir, buildBundle({ item, scan, controls, startedAt, finishedAt, digest, ...caps }));
    return { scan, fallback: null };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    const why = safeName(e && e.name) || 'Error';
    const minimal = { ...notRead('bundle_error'), error_name: why, commit: scan.commit, repository: scan.repository };
    writeItem(dir, buildBundle({ item, scan: minimal, controls, startedAt, finishedAt, digest }));
    return { scan: minimal, fallback: why };
  }
}

// ------------------------------------------------------------------ one subject in its own thread

const WORKER_URL = new URL('./scan-subject-worker.mjs', import.meta.url);
/** A subject's thread gets this long past SUBJECT_TIMEOUT_MS to stop on its own before it is terminated. */
export const SUBJECT_GRACE_MS = 5 * 1000;
/** API calls one subject takes (repository, branch, tree), and how many to leave unused (R-SS-09). */
export const CALLS_PER_SUBJECT = 3;
export const RATE_RESERVE = 10;
/** Largest answer body handed to a subject's thread (the reader's own caps are lower). */
const PROXY_BODY_CAP = 16 * 1024 * 1024;
/** Heap limit of a subject's thread: well above a large real repository, well below the runner's memory. */
export const SUBJECT_HEAP_MB = 1536;
/** The only hosts a subject's thread may reach: GitHub's API and its raw file host (R-SS-10). */
const PROXY_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);
const PASSED_HEADERS = ['content-length', 'content-type', 'x-ratelimit-remaining', 'x-ratelimit-limit', 'x-ratelimit-reset', 'retry-after', 'location', 'etag'];

async function readCappedBody(res, cap) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      chunks.push(value);
      if (n > cap) { try { await reader.cancel(); } catch { /* ignore */ } break; }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  }
  if (typeof res.arrayBuffer === 'function') return Buffer.from(await res.arrayBuffer()).subarray(0, cap + 1);
  return Buffer.from(String(await res.text()).slice(0, cap + 1));
}

/**
 * scanSubject() in a worker thread, terminated at timeoutMs + SUBJECT_GRACE_MS whatever it is doing (R-SS-02): the
 * subject's own timer cannot interrupt synchronous work (reading or grading a crafted source), terminate() can.
 * The thread has no environment and no network of its own: its requests go through `fetch` here (so the caller
 * sees every answer, onResponse(url, status, header)). Never throws.
 */
export function scanInWorker(subject, { fetch: fetchImpl = globalThis.fetch, token = null, timeoutMs = SUBJECT_TIMEOUT_MS, graceMs = SUBJECT_GRACE_MS, onResponse = () => {}, workerUrl = WORKER_URL, codeEffects = false } = {}) {
  return new Promise((resolve) => {
    const inflight = new Map();
    let settled = false;
    let worker;
    let timer = null;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const c of inflight.values()) c.abort();
      if (worker) worker.terminate().catch(() => {});
      resolve(out);
    };
    const failed = (detail, name) => ({ ...notRead(detail), error_name: safeName(name) });
    try {
      // The thread gets no token (the requests it asks for get it here) and a heap limit (R-SS-08, R-SS-10).
      worker = new Worker(workerUrl, { workerData: { subject, timeoutMs, ...(codeEffects ? { codeEffects: true } : {}) }, env: {}, resourceLimits: { maxOldGenerationSizeMb: SUBJECT_HEAP_MB } });
    } catch (e) {
      finish(failed('reader_error', e && e.name));
      return;
    }
    timer = setTimeout(() => finish(notRead('timeout')), timeoutMs + graceMs);
    worker.on('message', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'done') { finish(m.out); return; }
      if (m.type === 'abort') { inflight.get(m.id)?.abort(); inflight.delete(m.id); return; }
      if (m.type !== 'fetch') return;
      const ctl = new AbortController();
      inflight.set(m.id, ctl);
      (async () => {
        try {
          let host = null;
          try { host = new URL(m.url).protocol === 'https:' ? new URL(m.url).host : null; } catch { host = null; }
          if (!PROXY_HOSTS.has(host)) throw Object.assign(new Error('requests go to ' + [...PROXY_HOSTS].join(' and ') + ' only'), { name: 'RefusedHost' });
          const headers = { ...(m.headers || {}) };
          for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k];
          if (token && host === 'api.github.com') headers.Authorization = 'Bearer ' + token;
          const res = await fetchImpl(m.url, { headers, redirect: m.redirect || 'follow', credentials: 'omit', signal: ctl.signal });
          const get = (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
          const passed = {};
          for (const k of PASSED_HEADERS) { const v = get(k); if (v !== null && v !== undefined) passed[k] = String(v); }
          onResponse(m.url, res.status, get);
          const body = res.status === 204 || res.status === 304 ? null : await readCappedBody(res, PROXY_BODY_CAP);
          if (!settled) worker.postMessage({ type: 'response', id: m.id, status: res.status, headers: passed, body });
        } catch (e) {
          if (!settled) worker.postMessage({ type: 'response', id: m.id, error: { name: String((e && e.name) || 'Error'), message: String((e && e.message) || e).slice(0, 300) } });
        } finally {
          inflight.delete(m.id);
        }
      })();
    });
    worker.once('error', (e) => finish(failed('reader_error', e && e.name)));
    worker.once('exit', () => finish(failed('reader_error', 'WorkerExit')));
  });
}

/**
 * Scans a shard and writes <out>/<i>/ for every item. Returns { outputs, items } where outputs are the step output
 * lines and items says, per item, what happened (no grades). onOutputs(lines) is called with each item's lines as
 * soon as its bundle is written (R-SS-02), and with controls_ok=true once the controls passed, so the uploads can
 * start on whatever was written if the step is stopped. A control that fails later calls it with
 * controls_failed=true before throwing. Throws InputProblem on malformed inputs (before anything is read or
 * written) and Error on a harness problem.
 */
export async function runShard({ shardId, attemptId, items, out, codeEffects = false, astGrep = false, oracle = oracleForScan, fetch: fetchImpl = globalThis.fetch, token = null, now = () => new Date(), marker = newMarker, tmp = tmpdir(), log = () => {}, budgetMs = SHARD_BUDGET_MS, timeoutMs = SUBJECT_TIMEOUT_MS, clock = () => performance.now(), knownAnswerExpected = KNOWN_ANSWER_FILE, onOutputs = () => {}, isolate = true, workerUrl, graceMs = SUBJECT_GRACE_MS, caps = {}, write }) {
  const input = parseInputs({ shardId, attemptId, items });
  if (existsSync(out) && readdirSync(out).length) throw new Error('the output folder is not empty');
  const t0 = clock();
  const digest = settingsDigest();
  const outputs = [];
  const emit = (lines) => { outputs.push(...lines); onOutputs(lines); };
  const controlFailed = (what) => {
    emit(['controls_failed=true']);
    return new Error(what);
  };
  // The controls run before any subject: a pipeline that fails them reports nothing.
  const known = await knownAnswerControl({ expectedFile: knownAnswerExpected });
  if (known.control.observed !== known.control.expected) throw controlFailed('the known-answer control gave ' + known.control.observed + ': the grades of corpus/fixtures/known-answer/ are not the ones in known-answer.json');
  const first = await forgeryControl({ marker: marker(), tmp });
  if (first.control.observed !== first.control.expected) throw controlFailed('the forgery control gave ' + first.control.observed);
  emit(['controls_ok=true']);
  // What GitHub says is left of the token's API budget (R-SS-07).
  let remaining = null;
  const onResponse = (url, status, get) => {
    if (!String(url).startsWith(API + '/')) return;
    const r = Number(get('x-ratelimit-remaining'));
    if (get('x-ratelimit-remaining') !== null && Number.isFinite(r)) remaining = r;
  };
  const tracked = async (url, init) => {
    const res = await fetchImpl(url, init);
    onResponse(url, res && res.status, (k) => (res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null));
    return res;
  };
  const done = [];
  let stop = null;
  for (const item of input.items) {
    const i = item.index;
    if (!stop && clock() - t0 > budgetMs) stop = 'shard_deadline';
    // Each subject takes a few API calls: stop before the budget runs dry, not after (R-SS-07).
    // One subject takes about 3 API calls; stop when not even that is left above a reserve (R-SS-09).
    if (!stop && item.repo && remaining !== null && remaining < CALLS_PER_SUBJECT + RATE_RESERVE) stop = 'rate_limited';
    let scan;
    const startedAt = now().toISOString();
    if (stop) scan = notRead(stop);
    else if (!item.repo) scan = notRead('bad_subject');
    else {
      scan = isolate
        ? await scanInWorker(item.repo, { fetch: fetchImpl, token, timeoutMs, graceMs, onResponse, workerUrl, codeEffects })
        : await scanSubject(item.repo, { fetch: tracked, token, timeoutMs, codeEffects });
      if (scan.detail === 'rate_limited') stop = 'rate_limited'; // the next subjects would hit it too: they are not read
    }
    // The ast-grep oracle (corpus/ast-grep/), when turned on: the same commit's source, read by rules instead of the reader.
    // It never changes what the reader said and a failure of it is not one of the subject's.
    if (astGrep && scan.status && !stop) {
      try { const o = await oracle(item, scan); if (o) scan = { ...scan, oracle: o }; } catch { /* the oracle adds nothing */ }
    }
    const finishedAt = now().toISOString();
    const forgery = i === input.items[0].index ? first : await forgeryControl({ marker: marker(), tmp });
    if (forgery.control.observed !== forgery.control.expected) throw controlFailed('the forgery control gave ' + forgery.control.observed);
    const reported = reportItem(join(out, String(i)), { item, scan, controls: [forgery, known], startedAt, finishedAt, digest, write, ...caps });
    emit(['has_' + i + '=true', 'fence_' + i + '=' + item.fence, 'run_key_' + i + '=' + item.run_key]);
    const s = reported.scan;
    log('item ' + i + ': ' + s.status + (s.detail ? ' (' + s.detail + (s.retryable ? ', retryable' : '') + ')' : '') + (reported.fallback ? '; full bundle failed (' + reported.fallback + '), minimal bundle written' : ''));
    done.push({ index: i, status: s.status, detail: s.detail });
  }
  return { outputs, items: done };
}

const oneLine = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').slice(0, 300);

export async function main(argv, env, { fetch: fetchImpl = globalThis.fetch, stdout = process.stdout } = {}) {
  if (argv.length === 1 && argv[0] === 'known-answer') { stdout.write(json(await knownAnswerFile())); return 0; }
  if (argv.length !== 2 || argv[0] !== 'run') { stdout.write('usage: node corpus/scan-static.mjs run <out-dir> | known-answer\n'); return 2; }
  try {
    // Each item's outputs go out as soon as its bundle is written (R-SS-02): if the step is stopped part-way, the
    // upload steps still find every bundle that was finished.
    const put = (lines) => {
      const text = lines.length ? lines.join('\n') + '\n' : '';
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, text); else stdout.write(text);
    };
    const res = await runShard({
      shardId: env.SHARD_ID, attemptId: env.ATTEMPT_ID, items: env.ITEMS, out: argv[1],
      fetch: fetchImpl, token: env.GITHUB_TOKEN || null, log: (s) => stdout.write(s + '\n'), onOutputs: put, codeEffects: env.SCAN_STATIC_CODE_EFFECTS === '1', astGrep: env.SCAN_STATIC_AST_GREP === '1',
    });
    stdout.write(res.items.filter((x) => x.status === 'graded').length + ' of ' + res.items.length + ' items graded; every item has a bundle\n');
    return 0;
  } catch (e) {
    if (e instanceof InputProblem) { stdout.write('::error title=scan-static::' + e.code + ': ' + oneLine(e.message) + '\n'); return 1; }
    stdout.write('::error title=scan-static::harness error: ' + oneLine(e && e.message || e) + '\n');
    return 3;
  }
}

if (isMainThread && process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
