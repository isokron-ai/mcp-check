// Which Go package runs a Go repository's server, when the repository has no registry package (R-LP-91).
//
// The sandbox builds `go install <package path>@<full commit>` in its pinned Go image (mcp-surface-corpus launchPlan,
// kind go: the module proxy and checksum database only, read-only module files). This decides the package path, before
// anything is built, from the repository as GitHub serves it at that commit: the module line of the root go.mod, and
// which directories hold `package main`. Everything read is data: a tree listing, a go.mod, the first bytes of a few
// .go files. Nothing here runs, builds or downloads source of the subject; only api.github.com is asked.
//
// The picker (pickMain) is pure: the module root when it is a main package, else the one main package under cmd/, else
// the one named for the repository or the registry name; several and none named is `entry_ambiguous`, which is ours
// (we would have to guess), and none at all is `no_main_package` (a library: nothing to start, nobody's defect).

export const GITHUB_API = 'https://api.github.com';
/** A Go package path as the sandbox takes it (mcp-surface-corpus src/targets.mjs GO_MODULE). */
export const GO_MODULE = /^[a-z0-9][A-Za-z0-9.-]*\.[a-z]{2,}(?:\/[A-Za-z0-9._~-]+)+$/;
const DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const JSON_CAP = 2 * 1024 * 1024;
/** The most .go files read in one directory, the most cmd/ directories read, the biggest file read. */
export const FILES_PER_DIR = 6;
export const MAX_CMD_DIRS = 12;
export const FILE_CAP = 512 * 1024;
export const GOMOD_CAP = 64 * 1024;

const fail = (detail, extra = {}) => Object.assign(new Error(detail), { detail }, extra);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * The module path of a go.mod and whether it holds a directive `go install pkg@version` refuses (replace, exclude: the
 * go command will not build a module whose go.mod would be read differently from outside it). Comments are dropped,
 * block forms count.
 */
export function parseGoMod(text) {
  const src = String(text || '').replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const m = /^\s*module\s+(?:"([^"\n]{1,300})"|`([^`\n]{1,300})`|([^\s"`()]{1,300}))\s*$/m.exec(src);
  return {
    module: m ? (m[1] || m[2] || m[3]) : null,
    replace: /^\s*replace(?:\s*\(|\s+\S)/m.test(src),
    exclude: /^\s*exclude(?:\s*\(|\s+\S)/m.test(src),
  };
}

/**
 * The package clause of a Go file and its build constraints: { name, ignored } or null when no clause is found.
 * `ignored` is a file kept out of every build by `//go:build ignore` (or the old `// +build ignore`), as a generator
 * script is.
 */
export function packageHead(src) {
  const s = String(src || '');
  const n = s.length; let i = 0; let ignored = false;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') { i++; continue; }
    if (s.startsWith('//', i)) {
      let e = s.indexOf('\n', i); if (e < 0) e = n;
      const m = /^\/\/\s*(?:go:build|\+build)\s+(.*)$/.exec(s.slice(i, e).trim());
      if (m && m[1].trim() === 'ignore') ignored = true;
      i = e + 1; continue;
    }
    if (s.startsWith('/*', i)) { const e = s.indexOf('*/', i + 2); if (e < 0) return null; i = e + 2; continue; }
    const p = /^package\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(i, i + 200));
    return p ? { name: p[1], ignored } : null;
  }
  return null;
}

/** The .go files of a tree listing that may hold a main package, main.go first. */
export function goFilesOf(tree) {
  return (Array.isArray(tree) ? tree : [])
    .filter((e) => isObj(e) && e.type === 'blob' && typeof e.path === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.go$/.test(e.path) && !e.path.endsWith('_test.go') && SHA40.test(String(e.sha)))
    .sort((a, b) => (a.path === 'main.go' ? -1 : b.path === 'main.go' ? 1 : a.path < b.path ? -1 : 1));
}

const norm = (s) => String(s || '').toLowerCase();

/**
 * Chooses the main package. root: { main: bool } for the module root; cmds: [{ name, main }] for the directories of cmd/;
 * names: the names a command may be named for (the repository's, the registry entry's). Returns { dir } ('' for the root)
 * or { detail, candidates }.
 */
export function pickMain({ root, cmds, names }) {
  if (root && root.main === true) return { dir: '' };
  const mains = (Array.isArray(cmds) ? cmds : []).filter((c) => c && c.main === true);
  if (!mains.length) return { detail: 'no_main_package' };
  if (mains.length === 1) return { dir: 'cmd/' + mains[0].name };
  const want = new Set((Array.isArray(names) ? names : []).map(norm).filter(Boolean));
  const named = mains.filter((c) => want.has(norm(c.name)));
  if (named.length === 1) return { dir: 'cmd/' + named[0].name };
  return { detail: 'entry_ambiguous', candidates: mains.map((c) => c.name) };
}

/** The names a repository's command may carry: its own, and the last part of each registry name given. */
export function commandNames(repo, registryNames = []) {
  const out = new Set();
  const last = (s) => String(s || '').split('/').pop();
  out.add(last(repo));
  for (const n of registryNames) if (typeof n === 'string') out.add(last(n));
  return [...out].filter((x) => x && DIR_NAME.test(x));
}

/** One GET from api.github.com (the only host asked, the only host the token goes to). 404 gives null; others throw a detail. */
async function ghGet(fetchImpl, path, { token = null, httpDetail }) {
  let url = GITHUB_API + path;
  for (let hop = 0; hop < 4; hop++) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'isokron-mcp-check-live-probe', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: 'Bearer ' + token } : {}) }, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(20_000) });
    } catch { throw fail('upstream_error'); }
    // A renamed repository answers with a redirect to its id: followed only inside api.github.com.
    if ([301, 302, 307, 308].includes(res.status)) {
      const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      let u = null; try { u = loc ? new URL(loc, url) : null; } catch { u = null; }
      if (!u || u.protocol !== 'https:' || u.hostname !== 'api.github.com' || u.port || u.username || u.password) throw fail('upstream_error');
      url = u.href; continue;
    }
    if (res.status === 404 || res.status === 409) return null;
    if (!res.ok) throw fail(httpDetail(res.status, (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null)), { status: res.status });
    try {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > JSON_CAP) throw fail('upstream_error');
      return JSON.parse(buf.toString('utf8'));
    } catch (e) { throw e && e.detail ? e : fail('upstream_error'); }
  }
  throw fail('upstream_error');
}

/**
 * The Go package to build for a repository at a commit, or why there is none.
 *   { launch: { module, dir, package, commit }, names, serverJson }  a package path to install at `commit`
 *   { none: true }                                                    no go.mod at the root (not a Go repository we read)
 *   { detail }                                                        no_main_package, entry_ambiguous, go_install_refused,
 *                                                                     go_source_unreadable or launch_invalid
 * Throws a detail code (rate_limited, upstream_error, registry_query_refused) when GitHub could not be read.
 */
export async function goSource({ repo, sha = null, names = [], fetch: fetchImpl = globalThis.fetch, token = null, httpDetail }) {
  const r = '/repos/' + repo.split('/').map(encodeURIComponent).join('/');
  const get = (p) => ghGet(fetchImpl, r + p, { token, httpDetail });
  let commit = sha;
  if (commit === null) {
    const c = await get('/commits/HEAD');
    if (!isObj(c) || !SHA40.test(String(c.sha))) return { none: true };
    commit = c.sha;
  }
  if (!SHA40.test(commit)) return { none: true };
  const blob = async (e, cap) => {
    if (!isObj(e) || !SHA40.test(String(e.sha)) || !(Number.isSafeInteger(e.size) ? e.size <= cap : true)) return null;
    const b = await get('/git/blobs/' + e.sha);
    if (!isObj(b) || b.encoding !== 'base64' || typeof b.content !== 'string' || b.content.length > cap * 2) return null;
    const buf = Buffer.from(b.content, 'base64');
    return buf.length <= cap ? buf.toString('utf8') : null;
  };
  // An array; 'missing' (GitHub has no such tree: a repository or commit that is gone); 'truncated' (too big to list whole).
  const listing = async (sha1) => { const t = await get('/git/trees/' + sha1); return !isObj(t) || !Array.isArray(t.tree) ? 'missing' : t.truncated === true ? 'truncated' : t.tree; };
  // Is this directory a main package: any readable, non-ignored, non-test .go file whose package is main.
  const isMain = async (tree) => {
    let read = 0;
    for (const f of goFilesOf(tree)) {
      if (read >= FILES_PER_DIR) break;
      const text = await blob(f, FILE_CAP);
      if (text === null) continue;
      read++;
      const h = packageHead(text);
      if (h && !h.ignored && h.name === 'main') return true;
    }
    return false;
  };
  const top = await listing(commit);
  if (top === 'missing') return { none: true };
  if (top === 'truncated') return { detail: 'go_source_unreadable' };
  const entry = (name, type) => top.find((e) => isObj(e) && e.path === name && e.type === type);
  const modEntry = entry('go.mod', 'blob');
  if (!modEntry) return { none: true };
  const modText = await blob(modEntry, GOMOD_CAP);
  if (modText === null) return { detail: 'go_source_unreadable' };
  const mod = parseGoMod(modText);
  if (!mod.module || !GO_MODULE.test(mod.module)) return { detail: 'launch_invalid' };
  if (mod.replace || mod.exclude) return { detail: 'go_install_refused' };
  // The registry-format server.json the repository itself ships, if any: its name and arguments.
  let serverJson = null;
  const sj = entry('server.json', 'blob');
  if (sj) { const t = await blob(sj, 256 * 1024); try { const p = t === null ? null : JSON.parse(t); serverJson = isObj(p) ? p : null; } catch { serverJson = null; } }
  const allNames = [...names, ...(serverJson && typeof serverJson.name === 'string' ? [serverJson.name] : [])];
  const rootMain = await isMain(top);
  let cmds = [];
  if (!rootMain) {
    const cmdEntry = entry('cmd', 'tree');
    if (cmdEntry && SHA40.test(String(cmdEntry.sha))) {
      const dirs = await listing(cmdEntry.sha);
      if (typeof dirs === 'string') return { detail: 'go_source_unreadable' };
      const sub = dirs.filter((e) => isObj(e) && e.type === 'tree' && DIR_NAME.test(String(e.path)) && SHA40.test(String(e.sha)));
      if (sub.length > MAX_CMD_DIRS) return { detail: 'entry_ambiguous' };
      for (const d of sub) {
        const t = await listing(d.sha);
        cmds.push({ name: d.path, main: typeof t === 'string' ? false : await isMain(t) });
      }
    }
  }
  const pick = pickMain({ root: { main: rootMain }, cmds, names: commandNames(repo, allNames) });
  if (pick.detail) return { detail: pick.detail, candidates: pick.candidates };
  const pkg = pick.dir ? mod.module + '/' + pick.dir : mod.module;
  if (!GO_MODULE.test(pkg)) return { detail: 'launch_invalid' };
  return { launch: { module: mod.module, dir: pick.dir, package: pkg, commit }, serverJson };
}
