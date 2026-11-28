'use strict';
/**
 * The static layer of the live-probe lane (corpus/LIVE-PROBE.md, "Static against live"): mcp-check's own source reader
 * (src/inputs/repo-source.cjs and the modules it requires, at the commit the workflow runs), read over the source
 * archive the sandbox fetched, through the entry point scan-static uses (fromGitHub, no fallback). The two lanes then
 * read the same list from the same commit, and live-probe grades it as scan-static does (usableList, gradeCandidate).
 *
 * corpus/live-probe-driver.mjs copies these files (bundleFiles) into a folder that mcp-surface-corpus's driver puts in
 * its read-only tools volume as reader/; the sandbox's static step (sandbox/static.mjs --reader) requires this file
 * inside its container (no network) and hands it every file of the archive. The answer carries reader_id, the sha256 of
 * the bundle: live-probe compares it with its own and does not grade a list another reader read (R-LP-78).
 *
 * The archive is served to fromGitHub as GitHub serves a commit: the recursive tree (and one tree per folder on the way
 * to a subfolder), file sizes, and raw files. Differences from GitHub itself: symbolic links are not listed, a listing
 * is cut at 100,000 entries, and files .gitattributes export-ignore leaves out of the archive are not there.
 */
const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const FORMAT = 'isokron-live-probe-static/1';
// The reader's modules: repo-source.cjs and every module it requires (test: R-LP-78 keeps this list whole).
const READER_FILES = ['repo-source.cjs', 'repo-go.cjs', 'repo-rust.cjs', 'repo-csharp.cjs', 'repo-effects.cjs', 'unreadable-kind.cjs'];
const SELF = 'static-read.cjs';
const LIST_FILE_MAX = 1500000; // GitHub lists a blob of this size or more, and the reader does not read it
const TREE_MAX = 100000;

/** Where the reader's modules are: next to this file in the bundle, else src/inputs/ of this checkout. */
function sourceDir() {
  return existsSync(path.join(__dirname, 'repo-source.cjs')) ? __dirname : path.join(__dirname, '..', 'src', 'inputs');
}
/** The bundle: [name, absolute path], this file last. */
function bundleFiles() {
  const dir = sourceDir();
  return READER_FILES.map((n) => [n, path.join(dir, n)]).concat([[SELF, __filename]]);
}
/** sha256 of the bundle (each name, a NUL, its bytes, a NUL, in bundle order). */
function readerId() {
  const h = createHash('sha256');
  for (const [n, p] of bundleFiles()) { h.update(n + '\u0000'); h.update(readFileSync(p)); h.update('\u0000'); }
  return h.digest('hex');
}

/**
 * A fetch that serves `files` as the GitHub repository owner/repo at commit `sha`: the git trees API (recursive, and
 * per folder) and raw.githubusercontent.com. files: [{ path, size, data }], path relative to the repository root,
 * data a Buffer or string (null for a file not kept: one of LIST_FILE_MAX bytes or more).
 */
function archiveFetch(files, { owner, repo, sha }) {
  const data = new Map(); const blobs = [];
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || !f.path || f.path.split('/').some((s) => !s || s === '.' || s === '..')) continue;
    if (data.has(f.path)) continue;
    data.set(f.path, f.data == null ? null : f.data);
    blobs.push({ path: f.path, size: Number.isSafeInteger(f.size) ? f.size : 0 });
  }
  blobs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const dirs = new Set(['']);
  for (const b of blobs) { const parts = b.path.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
  const dirSha = (d) => (d === '' ? sha : createHash('sha1').update('tree\u0000' + d).digest('hex'));
  const bySha = new Map(Array.from(dirs).map((d) => [dirSha(d), d]));
  const under = (d) => (d === '' ? '' : d + '/');
  const tree = (d, recursive) => {
    const pre = under(d); const out = []; let truncated = false;
    const add = (e) => { if (out.length >= TREE_MAX) { truncated = true; return false; } out.push(e); return true; };
    for (const sub of Array.from(dirs).sort()) {
      if (sub === d || !sub.startsWith(pre)) continue;
      const rel = sub.slice(pre.length);
      if (!recursive && rel.includes('/')) continue;
      if (!add({ path: rel, mode: '040000', type: 'tree', sha: dirSha(sub) })) break;
    }
    for (const b of blobs) {
      if (!b.path.startsWith(pre)) continue;
      const rel = b.path.slice(pre.length);
      if (!recursive && rel.includes('/')) continue;
      if (!add({ path: rel, mode: '100644', type: 'blob', sha: createHash('sha1').update('blob\u0000' + b.path).digest('hex'), size: b.size })) break;
    }
    return { sha: dirSha(d), tree: out, truncated };
  };
  const api = 'https://api.github.com/repos/' + owner + '/' + repo + '/git/trees/';
  const rawBase = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + sha + '/';
  const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  return async (url) => {
    const u = String(url);
    if (u.startsWith(api)) {
      const [id, q] = u.slice(api.length).split('?');
      const d = bySha.get(decodeURIComponent(id));
      if (d !== undefined) return json(tree(d, q === 'recursive=1'));
    } else if (u.startsWith(rawBase)) {
      const rel = u.slice(rawBase.length).split('/').map(decodeURIComponent).join('/');
      const x = data.get(rel);
      if (x != null) return new Response(x, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
}

/** What live-probe grades from a scan: the reader's answer, JSON-safe (best is candidates[0]). */
function scanOf(r) {
  return { via: r.via, truncated: !!r.truncated, scanned: r.scanned || null, best_index: r.best ? r.candidates.indexOf(r.best) : -1, candidates: r.candidates, hints: r.hints || {} };
}

/**
 * Reads one archive's files with mcp-check's reader. opts: { repo: 'owner/name', sha: 40 hex, subdir }.
 * Returns { format, reader_id, scan } or { format, reader_id, error } (a code), never throws.
 */
async function readFiles(files, opts) {
  const out = { format: FORMAT, reader_id: null, repo: null, sha: null, subdir: null };
  try { out.reader_id = readerId(); } catch (e) { out.error = 'reader_missing'; return out; }
  const m = /^([\w.-]{1,100})\/([\w.-]{1,100})$/.exec(String(opts && opts.repo));
  const sha = String(opts && opts.sha);
  if (!m || !/^[0-9a-f]{40}$/.test(sha)) { out.error = 'bad_input'; return out; }
  const sub = String((opts && opts.subdir) || '').replace(/^\/+|\/+$/g, '');
  if (sub && sub.split('/').some((s) => !s || s === '.' || s === '..')) { out.error = 'bad_input'; return out; }
  Object.assign(out, { repo: m[1] + '/' + m[2], sha, subdir: sub || null });
  let RS;
  try { RS = require(path.join(sourceDir(), 'repo-source.cjs')); } catch (e) { out.error = 'reader_missing'; return out; }
  try {
    const r = await RS.fromGitHub('github.com/' + m[1] + '/' + m[2] + '/tree/' + sha + (sub ? '/' + sub : ''), { fetch: archiveFetch(files, { owner: m[1], repo: m[2], sha }), noFallback: true });
    out.scan = scanOf(r);
  } catch (e) {
    out.error = e && /^[a-z_]{1,40}$/.test(String(e.code)) ? 'reader_' + e.code : 'reader_error';
  }
  return out;
}

module.exports = { FORMAT, READER_FILES, SELF, LIST_FILE_MAX, bundleFiles, readerId, archiveFetch, readFiles, scanOf };
