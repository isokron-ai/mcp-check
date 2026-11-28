// Which command runs a PyPI package's server.
//
// The sandbox runs `venv/bin/<entry>` after `pip install <package>`. With no entry it falls back to the package
// name, a guess that is often wrong: the console script a package declares frequently has another name (on 25 Nov
// 2026 that guess failed for 5 of the first 20 subjects, all exit 127). This reads the package's own declaration
// from its wheel, before anything is installed: `*.dist-info/entry_points.txt` [console_scripts]. A wheel that
// declares none but ships a top-level `<module>/__main__.py` runs as `python -m <module>`.
//
// The wheel is untrusted input read on the planner host: it is size-capped before and after download, only the
// central directory and one or two small members are read, every offset is bounds-checked, and inflation is capped.
// Nothing here ever executes package code. Any failure gives { entry_source } with no entry: the run then uses the
// old guess, and failureDetail keeps treating a guessed entry as our limit, never the server's fault (R-LP-39).

import { inflateRawSync } from 'node:zlib';

export const WHEEL_CAP = 30 * 1024 * 1024;
const JSON_CAP = 8 * 1024 * 1024;
const MEMBER_CAP = 256 * 1024;
const onWheelHost = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && x.hostname === 'files.pythonhosted.org' && !x.username && !x.password && !x.port; } catch { return false; } };
// Same shape the sandbox accepts for an entry (mcp-surface-corpus src/targets.mjs BIN).
const BIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MODULE = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;

/** PEP 503 normalised name. */
export const normName = (s) => String(s).toLowerCase().replace(/[-_.]+/g, '-');

async function getCapped(fetchImpl, url, { cap, accept, timeoutMs }) {
  let res;
  try {
    // No redirects: the host checked is the host read (pypi.org and files.pythonhosted.org serve directly).
    res = await fetchImpl(url, { headers: { accept, 'user-agent': 'isokron-mcp-check-live-probe' }, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
  } catch { return { error: 'fetch_failed' }; }
  if (!res.ok) return { error: res.status === 404 ? 'not_found' : 'http_' + res.status };
  const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
  if (len > cap) return { error: 'too_large' };
  // Read as a stream and stop at the cap: a chunked response has no content-length to check first.
  const parts = [];
  let total = 0;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > cap) { try { await reader.cancel(); } catch { /* ignore */ } return { error: 'too_large' }; }
        parts.push(Buffer.from(value));
      }
    } else {
      const b = Buffer.from(await res.arrayBuffer());
      total = b.length;
      if (total > cap) return { error: 'too_large' };
      parts.push(b);
    }
  } catch { return { error: 'fetch_failed' }; }
  return { buf: Buffer.concat(parts, total) };
}

/**
 * The members of a zip archive: [{ name, method, csize, usize, offset }], or null when it is not a zip this reads
 * (no end record, zip64, entries outside the buffer). Never throws.
 */
export function zipMembers(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return null;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) return null; // zip64: not read
  if (cdOff + cdSize > eocd) return null;
  const out = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > eocd) return null;
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, csize, usize, offset });
    p += 46 + nameLen + extraLen + commentLen;
    if (out.length > 50_000) return null;
  }
  return out;
}

/** One member's bytes (stored or deflated), at most `cap` bytes, or null. Never throws. */
export function zipRead(buf, m, cap = MEMBER_CAP) {
  try {
    if (!m || m.usize > cap || m.csize > buf.length) return null;
    if (m.offset + 30 > buf.length || buf.readUInt32LE(m.offset) !== 0x04034b50) return null;
    const start = m.offset + 30 + buf.readUInt16LE(m.offset + 26) + buf.readUInt16LE(m.offset + 28);
    if (start + m.csize > buf.length) return null;
    const data = buf.subarray(start, start + m.csize);
    if (m.method === 0) return data.length <= cap ? Buffer.from(data) : null;
    if (m.method === 8) return inflateRawSync(data, { maxOutputLength: cap });
    return null;
  } catch { return null; }
}

/** [console_scripts] of an entry_points.txt: [[name, target]] with names the sandbox accepts. */
export function consoleScripts(text) {
  const out = [];
  let inSection = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) { inSection = sec[1].trim() === 'console_scripts'; continue; }
    if (!inSection) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    const target = line.slice(eq + 1).trim();
    if (BIN.test(name) && target) out.push([name, target.slice(0, 200)]);
  }
  return out.slice(0, 50);
}

// A script or module that looks like an MCP server: its name or its target says mcp or server.
const SERVER_SIGNAL = /mcp|server/i;
// Top-level folders that are never the server.
const NOT_SERVER_DIR = /^(tests?|docs?|examples?|scripts?|benchmarks?)$/i;

/**
 * Pick the server's console script among those a package declares, or null when the choice is not clear.
 * A picked entry is no longer a guess, so a failure can count against the server: every fallback needs a server
 * signal. Order: the one named exactly like the package; the only `<pkg>-mcp`-style name (`<pkg>-mcp`, `mcp-<pkg>`,
 * `<pkg>-mcp-server`, `mcp-server-<pkg>`); the only one with mcp in its name; the only script, if its name or
 * target says mcp or server.
 */
export function pickScript(scripts, pkg) {
  if (!scripts.length) return null;
  const want = normName(pkg);
  // Named exactly like the package first: that is what ran before, and it already works for every assessed server
  // that also declares a <pkg>-mcp script (sdcreader, prufgate, marketmirror, mathguard, ru-humanizer on 25 Nov).
  const exact = scripts.find(([n]) => normName(n) === want);
  if (exact) return exact[0];
  const named = new Set([want + '-mcp', 'mcp-' + want, want + '-mcp-server', 'mcp-server-' + want]);
  const affixed = scripts.filter(([n]) => named.has(normName(n)));
  if (affixed.length === 1) return affixed[0][0];
  const mcp = scripts.filter(([n]) => /mcp/i.test(n));
  if (mcp.length === 1) return mcp[0][0];
  if (scripts.length === 1 && (SERVER_SIGNAL.test(scripts[0][0]) || SERVER_SIGNAL.test(scripts[0][1]))) return scripts[0][0];
  return null;
}

/**
 * R-LP-82: the console script to run, with how it was chosen: { entry, drop, source } or null. First a first package
 * argument that names a declared script exactly (source registry_args; drop 1 of the args): our reading of the args,
 * not the publisher's word (a `uvx <package> <args>` launch passes them to the package's own script), so like
 * lone_script its failure is never evidence (live-probe.mjs entryGuessOf). Then pickScript's choice (source console_script). Then a package's only script
 * with no server signal (source lone_script): it is what a user would run, so it is run, but it is still our pick, so a
 * failure of it is never evidence against the server (failureDetail treats it like the package-name guess).
 */
export function scriptChoice(scripts, pkg, args = []) {
  if (!scripts.length) return null;
  const first = Array.isArray(args) && typeof args[0] === 'string' ? args[0] : null;
  if (first && BIN.test(first)) { const named = scripts.find(([n]) => n === first); if (named) return { entry: named[0], drop: 1, source: 'registry_args' }; }
  const picked = pickScript(scripts, pkg);
  if (picked) return { entry: picked, drop: 0, source: 'console_script' };
  if (scripts.length === 1) return { entry: scripts[0][0], drop: 0, source: 'lone_script' };
  return null;
}

/**
 * The top-level module with a __main__.py to run as `python -m`: the one named like the package, else the only one,
 * if its name says mcp or server. Tests, docs, examples and scripts never count.
 */
export function pickMainModule(names, pkg) {
  const mods = [...new Set(names.map((n) => /^([^/]+)\/__main__\.py$/.exec(n)).filter(Boolean).map((m) => m[1]))].filter((m) => MODULE.test(m) && !NOT_SERVER_DIR.test(m));
  if (!mods.length) return null;
  const want = normName(pkg);
  const same = mods.find((m) => normName(m) === want);
  if (same) return same;
  return mods.length === 1 && SERVER_SIGNAL.test(mods[0]) ? mods[0] : null;
}

const DIST = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const EXTRA = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * One PEP 508 requirement string: { name (PEP 503), extra (the `extra == "x"` its marker needs, else null), capped
 * (the specifier has an upper bound: <, <=, ~=, == or ===) }, or null when it is not one this reads.
 */
export function requirementOf(s) {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;]*?)\s*(?:;\s*(.*))?$/.exec(String(s).slice(0, 400));
  if (!m) return null;
  const name = normName(m[1]);
  if (!DIST.test(name)) return null;
  const spec = m[2].replace(/[()\s]/g, '');
  const ex = /\bextra\s*==\s*["']([^"']+)["']|["']([^"']+)["']\s*==\s*extra\b/.exec(m[3] || '');
  // A direct reference (`name @ https://...`) is one exact artifact: capped.
  return { name, extra: ex ? normName(ex[1] || ex[2]) : null, capped: /<|~=|(?:^|,)===?|^@/.test(spec) };
}

/**
 * What a release declares and ships, for telling a crash in the server's own code from our environment (R-LP-61):
 * top (its top-level import names, from the wheel), base (dependencies every install gets), uncapped (base ones with
 * no upper bound), extra_only (dependencies only an extra brings), extras (Provides-Extra); PEP 503 names, capped.
 * top is null when the wheel was not read.
 */
export function pypiDeps(info, memberNames = null) {
  const base = new Set(); const uncapped = new Set(); const inExtra = new Set(); const extras = new Set();
  const reqs = info && Array.isArray(info.requires_dist) ? info.requires_dist.slice(0, 300) : [];
  for (const s of reqs) {
    if (typeof s !== 'string') continue;
    const r = requirementOf(s);
    if (!r) continue;
    if (r.extra) { inExtra.add(r.name); if (EXTRA.test(r.extra)) extras.add(r.extra); continue; }
    base.add(r.name);
    if (!r.capped) uncapped.add(r.name);
  }
  for (const e of info && Array.isArray(info.provides_extra) ? info.provides_extra.slice(0, 50) : []) { const n = normName(e); if (EXTRA.test(n)) extras.add(n); }
  let top = null;
  if (Array.isArray(memberNames)) {
    const t = new Set();
    // A package with its own __init__.py, or a top-level module file: a namespace folder (google/, azure/) is shared
    // with other distributions, so a module under it is not the server's own.
    for (const n of memberNames) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\/__init__\.py|\.py)$/.exec(n);
      if (m) t.add(normName(m[1]));
      if (t.size >= 50) break;
    }
    top = [...t];
  }
  const cap = (x) => [...x].slice(0, 100);
  return { top, base: cap(base), uncapped: cap(uncapped), extra_only: cap([...inExtra].filter((n) => !base.has(n))), extras: cap(extras) };
}

/** The wheel to read among a release's files: a pure-Python one first, then the smallest. */
export function pickWheel(files) {
  const wheels = (Array.isArray(files) ? files : []).filter((f) => f && f.packagetype === 'bdist_wheel' && typeof f.url === 'string' && onWheelHost(f.url) && !f.yanked);
  if (!wheels.length) return null;
  const pure = wheels.filter((f) => /-none-any\.whl$/.test(String(f.filename || f.url)));
  const pool = pure.length ? pure : wheels;
  return [...pool].sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0))[0];
}

/**
 * How to run a PyPI package: { entry, args_prefix?, args_drop?, entry_source, script_count?, wheel? } (wheel: the file
 * read; args_drop: how many of the registry's package arguments the entry takes, R-LP-82). entry_source:
 * registry_args | console_script | lone_script | module_main | ambiguous | no_wheel | no_entry_point | wheel_unreadable
 * | lookup_failed. Only the first four set an entry; the rest leave the run on the package-name guess.
 */
export async function pypiEntry(pkg, version, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 20_000, args = [] } = {}) {
  const url = 'https://pypi.org/pypi/' + encodeURIComponent(pkg) + (version && version !== 'latest' ? '/' + encodeURIComponent(version) : '') + '/json';
  const meta = await getCapped(fetchImpl, url, { cap: JSON_CAP, accept: 'application/json', timeoutMs });
  // R-LP-90: PyPI's own 404 for the release is the one fact that it is not there.
  if (meta.error) return { entry_source: 'lookup_failed', ...(meta.error === 'not_found' ? { release: { found: false, files: 0 } } : {}) };
  let j;
  try { j = JSON.parse(meta.buf.toString('utf8')); } catch { return { entry_source: 'lookup_failed' }; }
  const release = { found: true, files: j && Array.isArray(j.urls) ? j.urls.length : null };
  const info = j && typeof j === 'object' && j.info && typeof j.info === 'object' ? j.info : null;
  const { members, ...r } = await entryOf(j, pkg, fetchImpl, timeoutMs, args);
  return { ...r, deps: pypiDeps(info, members || null), release };
}

async function entryOf(j, pkg, fetchImpl, timeoutMs, args = []) {
  const wheel = pickWheel(j && j.urls);
  if (!wheel) return { entry_source: 'no_wheel' };
  if (Number(wheel.size) > WHEEL_CAP) return { entry_source: 'wheel_unreadable' };
  const got = await getCapped(fetchImpl, wheel.url, { cap: WHEEL_CAP, accept: 'application/octet-stream', timeoutMs: timeoutMs * 3 });
  if (got.error) return { entry_source: got.error === 'too_large' ? 'wheel_unreadable' : 'lookup_failed' };
  const whl = String(wheel.filename || '').slice(0, 200);
  const members = zipMembers(got.buf);
  if (!members) return { entry_source: 'wheel_unreadable' };
  const names = members.map((m) => m.name);
  // Exactly one top-level *.dist-info/entry_points.txt counts; anything else is not a wheel this trusts.
  const eps = members.filter((m) => /^[^/]+\.dist-info\/entry_points\.txt$/.test(m.name));
  if (eps.length > 1) return { entry_source: 'wheel_unreadable', members: names };
  let scripts = [];
  if (eps.length) {
    const text = zipRead(got.buf, eps[0]);
    // A declaration we cannot read is not "no declaration": never fall through to a module guess.
    if (!text) return { entry_source: 'wheel_unreadable', members: names };
    scripts = consoleScripts(text.toString('utf8'));
  }
  if (scripts.length) {
    const c = scriptChoice(scripts, pkg, args);
    return c ? { entry: c.entry, ...(c.drop ? { args_drop: c.drop } : {}), entry_source: c.source, script_count: scripts.length, wheel: whl, members: names } : { entry_source: 'ambiguous', script_count: scripts.length, members: names };
  }
  const mod = pickMainModule(names, pkg);
  if (mod) return { entry: 'python', args_prefix: ['-m', mod], entry_source: 'module_main', script_count: 0, wheel: whl, members: names };
  return { entry_source: 'no_entry_point', script_count: 0, members: names };
}
