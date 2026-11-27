// Turns the CLI's input options into tool lists to grade. Each item is
//   { label, text }                       a file or stdin, graded as given
//   { label, data, source }               a fetched list: data is what the engine's parseData accepts
//   { label, error, code }                a server that could not be listed (code 'unreachable' or 'usage')
// Live inputs run or call the user's own servers from this machine; static inputs read published source or a local folder.
// Nothing is sent to IsoKron. Header values are never printed: notes name the headers only.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { capture, CaptureError, splitCommand } from '../capture.js';

const require = createRequire(import.meta.url);
const Client = require('./mcp-client.cjs');
const Config = require('./mcp-config.cjs');
const Repo = require('./repo-source.cjs');

export class InputFailure extends Error {
  /** code: 'unreachable' (exit 3) or 'usage' (exit 2) */
  constructor(message, code = 'unreachable', extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** One line of text from a server or a file, safe to print: no control characters, bounded length. */
export const line = (s, n = 300) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, n);

/** "$TOKEN" / "${TOKEN}" in a header value is read from the environment, so secrets stay out of shell history. */
export function expandEnv(v, env = process.env) {
  return v.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (m, n) => (env[n] !== undefined ? env[n] : m));
}

export const FIDELITY = {
  exact: (c) => 'exact: ' + (c.kind === 'snapshots' ? 'committed tool snapshots (every toolset and flag variant in them; the server\'s default list may be smaller)' : c.kind === 'mcpb' ? 'MCPB manifest static tools/list' : c.kind === 'catalog' ? 'committed mcp-catalog-snap snapshot ' + c.path + (c.foreign ? ' of ' + line(c.server || 'an unnamed server', 100) + ', which may not be this repository\'s server' : '') : 'committed tool list ' + c.path + (Array.isArray(c.notUsed) && c.notUsed.length ? ' (of ' + (c.notUsed.length + 1) + ' committed lists, the one nearest the server; not used: ' + c.notUsed.slice(0, 5).map((x) => line(x, 200)).join(', ') + (c.notUsed.length > 5 ? ' and ' + (c.notUsed.length - 5) + ' more' : '') + ')' : '')),
  literal: () => 'literal: tool definitions written as literals in the source',
  derived: (c) => 'derived: reproduced from ' + (c && c.language ? c.language + ' ' : '') + 'SDK registrations in the source; schemas follow the SDK\'s output and may differ in detail',
  names: () => 'names only: an MCPB manifest lists names and descriptions; schema checks do not apply',
};

/** Tools read from source whose registration the reader did not see (Go: a tool type built only inside another type,
 *  or never visibly built). They are listed, never dropped; this names them. */
export function registrationNotSeen(c) {
  return (Array.isArray(c && c.marked) ? c.marked : []).filter((m) => !m.excluded && m.reasons.some((x) => /^registration-not-seen/.test(x))).map((m) => m.name);
}

/** The provenance of a repository list: its fidelity, then the tools left out as off by default and the ones kept under a condition. */
export function repoProvenance(c) {
  const left = Array.isArray(c.excluded) ? c.excluded : [];
  const cond = (Array.isArray(c.marked) ? c.marked : []).filter((m) => !m.excluded && m.reasons.some((x) => /^conditional-/.test(x)));
  const unseen = registrationNotSeen(c);
  const transformed = (Array.isArray(c.marked) ? c.marked : []).filter((m) => !m.excluded && m.reasons.some((x) => /^schema-transform/.test(x)));
  const tfns = [...new Set(transformed.flatMap((m) => m.reasons.filter((x) => /^schema-transform/.test(x)).map((x) => x.replace(/^schema-transform \((.*)\)$/, '$1'))))];
  const reasons = [...new Set(left.flatMap((x) => x.reasons.map((y) => y.replace(/ \(.*$/, ''))))];
  const u = c.unreadable || {};
  const parts = [['inputSchema', 'input schema'], ['description', 'description'], ['annotations', 'annotations']].filter(([k]) => Array.isArray(u[k]) && u[k].length).map(([k, w]) => u[k].length + ' ' + w + (u[k].length === 1 || k === 'annotations' ? '' : 's'));
  const extra = (left.length ? '; ' + left.length + ' tool' + (left.length === 1 ? '' : 's') + ' left out (' + reasons.join(', ') + ')' : '') + (cond.length ? '; ' + cond.length + ' kept but registered under a condition' : '')
    + (parts.length ? '; not readable from source, so their checks are skipped: ' + parts.join(', ') : '')
    + (u.text && Object.keys(u.text).length ? '; ' + Object.keys(u.text).length + ' tool' + (Object.keys(u.text).length === 1 ? '' : 's') + ' with source text not readable as part of the tool, scanned for hidden instructions' : '')
    + (c.unresolvedNames ? '; ' + c.unresolvedNames + ' registration' + (c.unresolvedNames === 1 ? '' : 's') + ' with a name the reader could not resolve, not listed' : '')
    + (Array.isArray(c.notes) && c.notes.length ? '; ' + c.notes.map((x) => line(x, 300)).join('; ') : '')
    + (transformed.length ? '; ' + transformed.length + ' tool' + (transformed.length === 1 ? '' : 's') + ' with a schemars transform the reader does not follow (' + line(tfns.join(', '), 160) + '), input schema not read' : '')
    + (unseen.length ? '; ' + unseen.length + ' tool' + (unseen.length === 1 ? '' : 's') + ' listed whose registration the reader did not see (built only inside another type, or never visibly built)' : '');
  return { provenance: FIDELITY[c.fidelity](c) + extra, left, cond };
}

const withDeadline = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Client.McpFetchError('timeout', what + ' did not finish within the time limit of ' + Math.round(ms / 1000) + ' s.')), ms); })]).finally(() => clearTimeout(t));
};

function mapCapture(e) {
  if (e instanceof CaptureError) {
    if (e.code === 'usage') return new InputFailure(e.message, 'usage');
    return new InputFailure(e.message, 'unreachable', { stderr: e.stderr || '' });
  }
  return e;
}

async function fromStdio(argv, opt, extra = {}) {
  try {
    const r = await capture(argv, { timeoutMs: opt.timeout * 1000, cwd: extra.cwd, extraEnv: extra.env || null, stderr: opt.serverStderr === false ? null : process.stderr });
    return { data: r.answers, source: { kind: 'stdio', command: argv.join(' '), era: r.era, protocolVersion: r.protocolVersion, serverInfo: r.serverInfo } };
  } catch (e) { throw mapCapture(e); }
}

async function fromUrl(url, headers, opt, { requireHttps = false } = {}) {
  if (requireHttps && !/^https:\/\//i.test(url)) throw new InputFailure('only https URLs from the registry are used: ' + line(url), 'unreachable');
  try {
    // With headers set, redirects are refused, so a header value never goes to a host it was not meant for.
    const r = await withDeadline(Client.listToolsHttp(url, { headers, protocol: opt.protocol, timeoutMs: Math.min(opt.timeout, 30) * 1000, redirect: Object.keys(headers).length ? 'error' : 'follow' }), opt.timeout * 1000, 'Listing tools at ' + url);
    return { data: r.pages, source: { kind: 'http', url: r.url, era: r.era, protocolVersion: r.protocolVersion, serverInfo: r.serverInfo } };
  } catch (e) {
    if (e instanceof Client.McpFetchError) {
      const code = e.code === 'bad_url' ? 'usage' : 'unreachable';
      throw new InputFailure(e.message.replace(/ In a browser this usually means[\s\S]*$/, ''), code, { auth: e.code === 'auth' });
    }
    throw e;
  }
}

async function fromRepo(ref, opt, via = null) {
  const token = opt.githubTokenEnv ? process.env[opt.githubTokenEnv] : undefined;
  if (opt.githubTokenEnv && !token) throw new InputFailure('--github-token-env ' + opt.githubTokenEnv + ' is not set in the environment', 'usage');
  let r;
  try { r = await withDeadline(Repo.fromGitHub(ref, { githubToken: token, effects: !!opt.codeEffects, effectsDepth: opt.codeEffectsDepth }), opt.timeout * 1000, 'Reading ' + ref); } catch (e) {
    if (e && /Not a GitHub repository URL/.test(e.message)) throw new InputFailure(e.message + ' Use github.com/owner/repo.', 'usage');
    throw new InputFailure('could not read ' + line(ref) + ': ' + line(e.message), 'unreachable');
  }
  const parsed = Repo.parseRepoRef(ref) || {};
  const where = r.repo + (parsed.subdir ? '/' + parsed.subdir : '');
  const pick = (folder) => '--repo github.com/' + r.repo + '/tree/' + (parsed.ref || String(r.sha || 'HEAD')) + '/' + folder;
  const c = cliUsable(r, line(where), pick);
  const { provenance: prov, left, cond } = repoProvenance(c);
  const provenance = prov + budgetNote(r);
  return { data: c.tools, reader: readerNotes(c), ...(opt.codeEffects ? { effects: c.effects || null } : {}), source: { kind: 'repo', repo: r.repo, sha: r.sha, via: r.via, fidelity: c.fidelity, approximate: isApproximate(c), provenance, from: c.kind, ...(c.language ? { language: c.language.toLowerCase() } : {}), ...(registrationNotSeen(c).length ? { registration_not_seen: registrationNotSeen(c).map((x) => line(x, 128)) } : {}), files: c.files || [c.path], ...(unreadableNames(c) ? { unreadable: unreadableNames(c) } : {}), ...(c.unresolvedNames ? { unresolved_names: c.unresolvedNames } : {}), ...(left.length ? { left_out: left.map((x) => ({ name: line(x.name, 128), reasons: x.reasons.map((y) => line(y, 160)) })) } : {}), ...(cond.length ? { conditional: cond.map((x) => line(x.name, 128)) } : {}), ...(via ? { registry: via } : {}) } };
}

/** The advice every "cannot grade this read" message ends with (the CLI's and the Action's names for the live inputs). */
export const LIVE_ADVICE = 'Grade the live list instead: start the server with --command "<start command>", or give a saved tools/list file '
  + '(in the GitHub Action: set command or tools-file).';

/** The tools the reader could not read in full, by part (inputSchema, description, annotations; `text`: tools with
 *  source text it could not place, which is scanned), for the report's source; null when none. */
export function unreadableNames(c) {
  const u = c && c.unreadable; if (!u) return null;
  const o = {}; Object.keys(u).forEach((k) => { if (k === 'text') { const n = Object.keys(u.text || {}); if (n.length) o.text = n; } else if (Array.isArray(u[k]) && u[k].length) o[k] = u[k]; });
  return Object.keys(o).length ? o : null;
}

/** A scan that stopped at the byte limit says so wherever its provenance is shown. */
export const budgetNote = (r) => (r && r.scanned && r.scanned.budgetHit ? '; reading stopped at the 64 MiB limit for one scan, so some files were not read' : '');

/** What the reader itself knows about a list it read from source (never taken from the list): parts it could not read,
 *  and registrations whose name it could not resolve, with their text for the poisoning scan. null for other lists. */
export function readerNotes(c) {
  if (!c || c.kind !== 'source') return null;
  return { unreadable: c.unreadable || {}, unresolved: Array.isArray(c.unresolved) ? c.unresolved : [] };
}

/** No tool definitions in a folder: the message names the live alternatives (the CLI's and the Action's). */
export function noToolsMessage(where, r) {
  return 'no tool definitions found in ' + where + ' (' + scannedText(r) + '). ' + LIVE_ADVICE;
}

/** What a scan read: "scanned 120 of 130 source files, and the committed tool lists and MCPB manifests", with the limits it hit. */
export function scannedText(r) {
  const s = r.scanned || {};
  const read = s.read !== undefined ? s.read : s.source;
  let out = 'scanned ' + read + ' of ' + s.sourceTotal + ' source files, and the committed tool lists and MCPB manifests';
  if (s.candidates !== undefined && s.candidates > s.source) out += '; ' + s.candidates + ' files may define a tool and the first ' + s.source + ' were read for tools';
  if (s.budgetHit) out += '; reading stopped at the 64 MiB limit for one scan, so some files were not read';
  if (r.truncated && r.via !== 'directory') out += '; GitHub cut the repository listing short (truncated), so files were missed: point --repo at the server\'s folder (…/tree/<ref>/<folder>)';
  return out;
}

/** Snapshots of other servers that were found and not used (several, and no tool defined in the source). */
export function foreignNote(r) {
  const f = (r.hints && r.hints.foreignSnapshots) || [];
  return f.length ? ' Not used: ' + f.length + ' mcp-catalog-snap snapshots of other servers (' + f.map((x) => line(x.path, 200) + ': ' + line(x.server || 'unnamed', 100)).join(', ') + ').' : '';
}

/** A list read from source (literal or derived) is approximate; an exact committed list or snapshot is not. */
export const isApproximate = (c) => !!c && c.fidelity !== 'exact';
/** The words every surface uses for an approximate list. */
export const APPROXIMATE = 'approximate: read from source, not the server\'s live list';

/**
 * What a repository scan (RepoSource.fromGitHub / fromDirectory) gives to grade. Shared by the CLI and the Action, so
 * both decide the same way:
 *   { candidate }                       one list to grade
 *   { problem: 'none' }                 no tool definition found (or only in folders that are not the server)
 *   { problem: 'names', candidate }     only tool names (an MCPB manifest), which cannot be graded
 *   { problem: 'multiple' }             tools of more than one server (or several committed lists): nothing is merged or picked
 *   { problem: 'incomplete' }           the reader had to skip tool candidates at its work limit: the list would be incomplete
 */
export function usableList(r) {
  const c = r.best;
  if (r.hints && r.hints.incomplete) return { problem: 'incomplete' };
  const multi = !!(r.hints && (r.hints.servers || r.hints.lists));
  if ((!c || c.fidelity === 'names') && multi) return { problem: 'multiple' };
  if (!c) return { problem: 'none' };
  if (c.fidelity === 'names') return { problem: 'names', candidate: c };
  return { candidate: c };
}

const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
/** The servers (or committed lists) a scan found, best first: "src/a (server constructor, 9 tools), src/b (3 tools)". */
export function serverChoices(r) {
  const h = r.hints || {};
  if (h.servers) return h.servers.map((x) => line(x.path || '.', 200) + ' (' + [x.constructor ? 'server constructor' : null, x.tools ? plural(x.tools, 'tool') : 'no tool read'].filter(Boolean).join(', ') + ')').join(', ');
  return (h.lists || []).map((x) => line(x.path, 200) + ' (' + plural(x.tools, 'tool') + ')').join(', ');
}
/** The folders to choose from, for the advice: package folders, or the folders of the committed lists. */
export function serverFolders(r) {
  const h = r.hints || {};
  // a module file of one Rust crate (R-RD-10) is a server, but no folder holds it alone: it is not offered as a folder
  if (h.servers) return h.servers.filter((x) => !/\.rs$/.test(x.path || '')).map((x) => x.path || '.');
  return Array.from(new Set((h.lists || []).map((x) => (x.path.includes('/') ? x.path.slice(0, x.path.lastIndexOf('/')) : '.'))));
}

/** The Go, Rust and C# SDK forms the reader knows, for the message when none was found. */
const READ_LANGS = {
  Go: 'mark3labs/mcp-go NewTool and options, the official go-sdk AddTool with mcp.Tool, mcp-golang RegisterTool, and helpers that build them',
  Rust: 'rmcp #[tool] methods, rust-mcp-sdk #[mcp_tool] structs, and Tool::new or Tool { … } built by hand',
  'C#': 'the official C# SDK\'s [McpServerTool] methods in [McpServerToolType] classes or classes given to WithTools<T>()',
};

/** Why nothing usable was found, beyond "no tool definitions": languages not read, folders set aside, lists not used. */
export function whyNothing(r) {
  const h = r.hints || {};
  let s = '';
  const lang = (h.otherLanguages || [])[0];
  const ext = (n) => '.' + ({ Go: 'go', Rust: 'rs', 'C#': 'cs', Java: 'java', Kotlin: 'kt', Ruby: 'rb', PHP: 'php', Swift: 'swift' }[n] || n);
  if (lang && lang.files >= lang.readFiles && READ_LANGS[lang.name]) s += ' The source here is ' + lang.name + ' (' + plural(lang.files, ext(lang.name) + ' file') + '): no tool definition the reader knows was found in it (' + READ_LANGS[lang.name] + ').';
  else if (lang && lang.files >= lang.readFiles) s += ' The source here is ' + lang.name + ' (' + plural(lang.files, ext(lang.name) + ' file') + '): ' + lang.name + ' source is not read yet (the reader reads TypeScript, JavaScript, Python, Go, Rust and C#).';
  const ign = (h.ignoredFolders || []).filter((x) => x.tools);
  if (ign.length) s += ' Tool definitions were found only in folders that look like admin, console, docs, examples, evaluation or test code, which are not graded from a parent folder: ' + ign.map((x) => line(x.path, 200) + ' (' + plural(x.tools, 'tool') + ')').join(', ') + '; if one of them is the server, point the check at that folder.';
  const host = (h.hostPlugins || []).filter((x) => x.tools);
  if (host.length) s += ' Tool definitions for another agent host\'s plugin API were found (not MCP tools, so not graded): ' + host.slice(0, 5).map((x) => line(x.path, 200) + ' (' + line(x.module, 60) + ', ' + plural(x.tools, 'tool') + ')').join(', ') + (host.length > 5 ? ' and ' + (host.length - 5) + ' more' : '') + '.';
  if (h.serverWithoutTools) s += ' A server is constructed in ' + line(h.serverWithoutTools || '.', 200) + ', but none of its tools could be read.';
  if (h.unresolvedNames) s += ' ' + plural(h.unresolvedNames, 'tool registration') + ' had a name the reader could not resolve (computed at run time).';
  if (h.lists) s += ' Not used: ' + plural(h.lists.length, 'committed tool list') + ' in different places (' + h.lists.map((x) => line(x.path, 200)).join(', ') + '); grade one by giving the file itself.';
  return s + foreignNote(r);
}

/** Where a names-only list came from: an MCPB manifest that lists names and descriptions without schemas. */
export function namesOnlyText(c) {
  return line(c.path, 200) + ' lists names and descriptions without schemas';
}

/** Why a scan was refused as incomplete (the reader's work limit), with the files to look at. */
export function incompleteText(r) {
  const x = (r.hints && r.hints.incomplete) || { candidates: 0, files: [] };
  const why = Array.isArray(x.reasons) && x.reasons.length ? x.reasons.map((r) => line(r, 120)).join('; ') : 'the reader\'s work limit on deeply nested source, a reader error, or more unreadable text than it keeps';
  // a server whose registrations the reader did not see (R-RD-43): what it found besides, as for no tools at all
  const more = x.why === 'registration_not_seen' ? whyNothing(r).replace(/[.]$/, '') : '';
  return plural(x.candidates, 'possible tool definition') + ' in ' + x.files.slice(0, 3).map((f) => line(f, 200)).join(', ') + (x.files.length > 3 ? ' and ' + (x.files.length - 3) + ' more' : '') + ' could not be read completely (' + why + '), so the list would be incomplete and nothing was graded' + (more ? '.' + more : '');
}

/** The CLI's reading of a scan: the candidate to grade, or an InputFailure (exit 3) with the same advice as the Action. */
function cliUsable(r, where, pick) {
  const u = usableList(r);
  if (u.problem === 'incomplete') throw new InputFailure('reading ' + where + ': ' + incompleteText(r) + '. ' + LIVE_ADVICE, 'unreachable');
  if (u.problem === 'none') throw new InputFailure(noToolsMessage(where, r) + whyNothing(r), 'unreachable');
  if (u.problem === 'names') throw new InputFailure('only tool names were found in ' + where + ' (' + namesOnlyText(u.candidate) + '), which cannot be graded. ' + LIVE_ADVICE, 'unreachable');
  if (u.problem === 'multiple') {
    const folders = serverFolders(r); const live = LIVE_ADVICE.charAt(0).toLowerCase() + LIVE_ADVICE.slice(1);
    throw new InputFailure('found tool definitions of more than one server in ' + where + ': ' + serverChoices(r) + '. Nothing was merged or picked. '
      + (folders.length ? 'Check one server at a time (' + folders.slice(0, 3).map((f) => pick(f)).join(', ') + '), or ' + live : 'They are modules of one crate, so no folder holds one alone: ' + live), 'unreachable');
  }
  return u.candidate;
}

/** A local checkout, read like --repo: no network, nothing run. */
async function fromRepoDir(dir, opt) {
  let r;
  // The --compare file is what the list is compared with, never the list itself.
  const cmp = opt.compare ? relative(resolve(String(dir)), resolve(String(opt.compare))).split(sep).join('/') : '';
  const exclude = cmp && !cmp.startsWith('..') && !isAbsolute(cmp) ? [cmp] : [];
  try { r = await withDeadline(Repo.fromDirectory(dir, { exclude, effects: !!opt.codeEffects, effectsDepth: opt.codeEffectsDepth }), opt.timeout * 1000, 'Reading ' + dir); } catch (e) {
    if (e && e.code === 'not_found') throw new InputFailure(line(e.message), 'usage');
    throw new InputFailure('could not read ' + line(dir) + ': ' + line(e && e.message), 'unreachable');
  }
  const base = String(dir).replace(/\/+$/, '') || '.';
  const c = cliUsable(r, line(dir), (folder) => '--repo-dir ' + (folder === '.' ? base : base + '/' + folder));
  const { provenance: prov, left, cond } = repoProvenance(c);
  const provenance = prov + budgetNote(r);
  return { data: c.tools, where: c.where || null, reader: readerNotes(c), ...(opt.codeEffects ? { effects: c.effects || null } : {}), source: { kind: 'dir', dir: r.repo, fidelity: c.fidelity, approximate: isApproximate(c), provenance, from: c.kind, ...(c.language ? { language: c.language.toLowerCase() } : {}), ...(registrationNotSeen(c).length ? { registration_not_seen: registrationNotSeen(c).map((x) => line(x, 128)) } : {}), files: c.files || [c.path], ...(unreadableNames(c) ? { unreadable: unreadableNames(c) } : {}), ...(c.unresolvedNames ? { unresolved_names: c.unresolvedNames } : {}), ...(c.built ? { built: true } : {}), ...(r.truncated ? { truncated: true } : {}), ...(left.length ? { left_out: left.map((x) => ({ name: line(x.name, 128), reasons: x.reasons.map((y) => line(y, 160)) })) } : {}), ...(cond.length ? { conditional: cond.map((x) => line(x.name, 128)) } : {}) } };
}

async function fromRegistry(name, opt, note) {
  let s;
  try { s = await withDeadline(Repo.fromRegistry(name), opt.timeout * 1000, 'The registry lookup'); } catch (e) { throw new InputFailure('could not reach the MCP Registry: ' + line(e.message), 'unreachable'); }
  if (!s.found) throw new InputFailure('not in the MCP Registry: ' + line(name) + (s.similar.length ? '. Similar: ' + s.similar.map((x) => line(x, 100)).join(', ') : ''), 'unreachable');
  const via = { name: s.name, version: s.version || null };
  // Public streamable-http remotes first, plain URLs before "?login"-style variants; no user headers are sent.
  const remotes = Array.from(new Set(s.remotes.filter((x) => x.type === 'streamable-http' && !x.templated && !x.needsHeaders).map((x) => x.url)))
    .sort((a, b) => (a.includes('?') ? 1 : 0) - (b.includes('?') ? 1 : 0));
  let last = null;
  for (const u of remotes) {
    note('registry: ' + line(s.name) + ' ' + line(s.version || '') + ' -> remote ' + line(u));
    try {
      const got = await fromUrl(u, {}, opt, { requireHttps: true });
      got.source.registry = via;
      return got;
    } catch (e) { last = e; note(line(u) + ': ' + line(e.message)); }
  }
  const pkg = s.packages.find((p) => p.command && p.transport === 'stdio');
  if (s.repository && /^https:\/\/github\.com\//.test(s.repository.url)) {
    const repo = s.repository.url.replace(/\/$/, '') + (s.repository.subfolder ? '/tree/HEAD/' + s.repository.subfolder : '');
    note('registry: ' + line(s.name) + ' -> source ' + line(repo) + (pkg ? ' (to run it instead: mcp-check --command "' + line(pkg.command) + '")' : ''));
    return fromRepo(repo, opt, via);
  }
  if (last) throw last;
  if (pkg) throw new InputFailure('no public remote or GitHub source for ' + line(s.name) + '. Run it locally: mcp-check --command "' + line(pkg.command) + '"', 'unreachable');
  throw new InputFailure('no usable remote, package or repository in the registry entry for ' + line(s.name), 'unreachable');
}

function readConfigFile(path) {
  try { return readFileSync(path, 'utf8'); } catch (e) { throw new InputFailure('cannot read ' + path + ': ' + e.message, 'usage'); }
}

async function fromConfig(opt, note) {
  let files;
  if (opt.config === 'auto') {
    files = Config.knownConfigPaths(homedir(), process.platform, process.env.APPDATA, process.cwd()).filter((c) => existsSync(c.path));
    if (!files.length) throw new InputFailure('no MCP client config found in the usual places. Give the file: --config <path>.', 'usage');
  } else files = [{ client: 'config', path: opt.config }];
  const out = [];
  for (const f of files) {
    const cfg = Config.parseConfig(readConfigFile(f.path), { env: process.env });
    if (cfg.error) { if (opt.config !== 'auto') throw new InputFailure(f.path + ': ' + cfg.error, 'usage'); note(f.path + ': ' + cfg.error); continue; }
    for (const s of cfg.servers) {
      if (opt.server && s.name !== opt.server) continue;
      const label = f.client + ' / ' + line(s.name, 100);
      if (s.error) { out.push({ label, error: s.error, code: 'unreachable' }); continue; }
      if (s.disabled) { note(label + ': disabled in the config, skipped'); continue; }
      if (s.unresolved && s.unresolved.length) { out.push({ label, error: 'needs values this checker cannot fill: ' + s.unresolved.join(', '), code: 'unreachable' }); continue; }
      try {
        let got;
        if (s.transport === 'stdio') {
          note(label + ': starting ' + line([s.command].concat(s.args).join(' ')));
          got = await fromStdio([s.command].concat(s.args), opt, { env: s.env, cwd: s.cwd });
        } else if (s.transport === 'http') {
          const names = Object.keys(s.headers || {});
          note(label + ': ' + line(s.url) + (names.length ? ' (headers: ' + names.map((n) => line(n, 60)).join(', ') + ')' : ''));
          got = await fromUrl(s.url, s.headers || {}, opt);
        } else { out.push({ label, error: 'the deprecated HTTP+SSE transport is not supported', code: 'unreachable' }); continue; }
        got.source.config = f.path;
        got.source.server = s.name;
        out.push({ label, ...got });
      } catch (e) {
        if (!(e instanceof InputFailure)) throw e;
        out.push({ label, error: e.message + (e.auth ? ' Pass a token in the config headers.' : ''), code: e.code, stderr: e.stderr });
      }
    }
  }
  if (opt.server && !out.length) throw new InputFailure('no server named ' + opt.server + ' in ' + files.map((f) => f.path).join(', '), 'usage');
  return out;
}

/** Collects the items to grade for the parsed CLI options. Throws InputFailure for a single input that fails. */
export async function collect(opt, note = () => {}) {
  if (opt.file) {
    try { return [{ label: opt.file === '-' ? 'stdin' : opt.file, text: opt.file === '-' ? readFileSync(0, 'utf8') : readFileSync(opt.file, 'utf8') }]; } catch (e) { throw new InputFailure('cannot read ' + (opt.file === '-' ? 'stdin' : opt.file) + ': ' + e.message, 'usage'); }
  }
  if (opt.url) {
    const headers = {};
    for (const [k, v] of Object.entries(opt.headers)) headers[k] = expandEnv(v);
    return [{ label: opt.url, ...(await fromUrl(opt.url, headers, opt)) }];
  }
  if (opt.argv || opt.command) {
    let argv;
    try { argv = opt.argv || splitCommand(opt.command); } catch (e) { throw mapCapture(e); }
    if (!argv.length) throw new InputFailure('the command is empty', 'usage');
    note('starting ' + line(argv.join(' ')));
    return [{ label: argv.join(' '), ...(await fromStdio(argv, opt, { env: Object.keys(opt.env).length ? opt.env : null })) }];
  }
  if (opt.config) return fromConfig(opt, note);
  if (opt.repo) { const got = await fromRepo(opt.repo, opt); note('found ' + got.data.length + ' tools in ' + got.source.repo + '@' + String(got.source.sha).slice(0, 12) + ' (' + got.source.provenance + ')'); return [{ label: got.source.repo, ...got }]; }
  if (opt.repoDir) { const got = await fromRepoDir(opt.repoDir, opt); note('found ' + got.data.length + ' tools in ' + line(opt.repoDir) + ' (' + got.source.provenance + ')'); return [{ label: line(opt.repoDir), ...got }]; }
  if (opt.registry) { const got = await fromRegistry(opt.registry, opt, note); return [{ label: opt.registry, ...got }]; }
  return [];
}

/** The one-line provenance shown with every report of a fetched list. Server-supplied text is sanitised. */
export function sourceLine(s) {
  if (!s) return null;
  const si = s.serverInfo && typeof s.serverInfo === 'object' && typeof s.serverInfo.name === 'string' ? ', ' + line(s.serverInfo.name, 80) + (typeof s.serverInfo.version === 'string' ? ' ' + line(s.serverInfo.version, 40) : '') : '';
  const reg = s.registry ? ' via MCP Registry ' + line(s.registry.name, 120) + (s.registry.version ? ' ' + line(s.registry.version, 40) : '') : '';
  if (s.kind === 'http') return 'Source: live server ' + line(s.url) + ' (' + s.era + (s.protocolVersion ? ', protocol ' + line(s.protocolVersion, 20) : '') + si + ')' + reg;
  if (s.kind === 'stdio') return 'Source: local server ' + line(s.command || s.server) + ' (' + s.era + ', protocol ' + line(s.protocolVersion, 20) + si + ')';
  if (s.kind === 'dir') return 'Source: local folder ' + line(s.dir) + ' (read statically, nothing was run), ' + s.provenance + (s.built ? '; read from build output, since no source file defines a tool' : '') + (s.truncated ? '; the folder holds more files than the listing limit, so the deepest were not read' : '');
  if (s.kind === 'repo') return 'Source: ' + s.repo + '@' + String(s.sha).slice(0, 12) + ' (' + s.via + '), ' + s.provenance + reg;
  return null;
}

/** For a list read from source: the line every report of it carries, saying the grades are approximate and how to get exact ones. */
export function approximateLine(s) {
  if (!s || !s.approximate) return null;
  return 'Approximate: read from source, not the server\'s live list. For exact grades, run the server (--command "<start command>") or grade a saved tools/list file.';
}

/** What --save writes: the fetched list in a shape every input accepts (a JSON-RPC answer, pages, or {tools}). */
export function savedList(item) {
  const d = item.data;
  if (Array.isArray(d) && d.length && d[0] && d[0].jsonrpc) return d.length === 1 ? d[0] : d;
  return { tools: d };
}
