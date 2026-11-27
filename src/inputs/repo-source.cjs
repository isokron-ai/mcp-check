// repo-source: find an MCP server's tool list from its source, without running it. Browser and Node.
// In Node it requires repo-go.cjs, repo-rust.cjs and repo-csharp.cjs; in a browser, load those three scripts first (they
// define RepoGo, RepoRust and RepoCSharp), or Go, Rust and C# are not read.
// Every download is size-capped (MAX_FILE per file, MAX_JSON per API answer); nothing fetched is executed.
// With { effects: true } (opt-in, --code-effects) the candidate also carries `effects`: what each tool's handler touches,
// read from the same files by repo-effects.cjs (TypeScript, JavaScript, Python). It never changes the list.
//
//   await RepoSource.fromGitHub('github.com/owner/repo', { fetch })   -> { candidates, best, hints }
//   await RepoSource.fromDirectory('/path/to/checkout')               -> the same, from a local folder (Node only, no network)
//   await RepoSource.fromRegistry('io.github.owner/name', { fetch })  -> server.json summary (remotes, packages, repo)
//   RepoSource.extractFromFile(path, text)                            -> tools found statically in one file
//
// Nothing is executed. Sources, best first:
//   exact    a committed tool list (tools.json, __toolsnaps__/*.snap, an mcp-catalog-snap .mcp-catalog/*.json), or an MCPB manifest.json with
//            _meta[*].static_responses["tools/list"]
//   literal  JS/TS object literals { name, description, inputSchema: {JSON Schema literal} }
//   derived  SDK registrations converted the way the SDK would: TS registerTool / server.tool with zod shapes,
//            factories, keyed tables and classes; Python @x.tool functions (type hints and docstrings), registries and
//            low-level Tool(...). Schemas are close to, not exactly, what the server sends; the report must say so.
//            Parts that cannot be read statically are marked (publicTools), and the grader skips their checks.
//            Go (mcp-go, the go-sdk, mcp-golang; repo-go.cjs) and Rust (rmcp, rust-mcp-sdk; repo-rust.cjs) tool
//            definitions, read the same way, with their schemas as the SDK derives them from Go structs and Rust types;
//            C# [McpServerTool] methods of the official C# SDK (repo-csharp.cjs), their schemas from the parameters.
//   names    an MCPB manifest "tools" array (name and description only)
// Network: GitHub's REST API (CORS for any origin, 60 requests/hour per user IP without a token) for the file tree,
// raw.githubusercontent.com for files; data.jsdelivr.com / cdn.jsdelivr.net as the fallback. The registry API at
// registry.modelcontextprotocol.io sends Access-Control-Allow-Origin: *. Nothing goes to IsoKron.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./repo-go.cjs'), require('./repo-rust.cjs'), require('./repo-csharp.cjs'), require('./repo-effects.cjs'));
  else root.RepoSource = factory(root.RepoGo, root.RepoRust, root.RepoCSharp, root.RepoEffects); // in a browser, load repo-go.cjs, repo-rust.cjs and repo-csharp.cjs first (repo-effects.cjs too, for the opt-in code effects)
})(typeof self !== 'undefined' ? self : this, function (RepoGo, RepoRust, RepoCSharp, RepoEffects) {
  'use strict';

  // ------------------------------------------------------------ tokenizer (JS/TS)
  const PUNCT_BEFORE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '&&', '||', '??', 'return', 'typeof', 'case']);
  // One escape sequence of a JS string or template at src[i] === '\\': [the text it stands for, its length]. \xHH,
  // \uXXXX, \u{X…} (any code point, so tag characters and ANSI escapes come out as the engine sees them), legacy
  // octal, the single-letter escapes and line continuations; any other character stands for itself (R-RD-17).
  const JS_ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };
  function jsEscape(src, i) {
    const e = src[i + 1]; let m;
    if (e === undefined) return ['', 1];
    if (hasOwn(JS_ESC, e)) return [JS_ESC[e], 2];
    if (e === 'x' && (m = /^[0-9a-fA-F]{2}/.exec(src.substr(i + 2, 2)))) return [String.fromCharCode(parseInt(m[0], 16)), 4];
    if (e === 'u') {
      if (src[i + 2] === '{' && (m = /^\{([0-9a-fA-F]{1,6})\}/.exec(src.substr(i + 2, 9)))) { const cp = parseInt(m[1], 16); if (cp <= 0x10ffff) return [String.fromCodePoint(cp), 2 + m[0].length]; }
      if ((m = /^[0-9a-fA-F]{4}/.exec(src.substr(i + 2, 4)))) return [String.fromCharCode(parseInt(m[0], 16)), 6];
      return ['u', 2];
    }
    if (e >= '0' && e <= '7') { m = /^[0-7]{1,3}/.exec(src.substr(i + 1, 3)); let d = m[0]; if (parseInt(d, 8) > 255) d = d.slice(0, 2); return [String.fromCharCode(parseInt(d, 8)), 1 + d.length]; }
    if (e === '\r') return ['', src[i + 2] === '\n' ? 3 : 2];
    if (e === '\n' || e === '\u2028' || e === '\u2029') return ['', 2];
    return [e, 2];
  }
  function tokenize(src) {
    const t = []; let i = 0; const n = src.length; let nl = false;
    // nl: a line break comes before the token (where automatic semicolon insertion may end a statement)
    const push = (type, value, start) => { t.push(nl ? { type, value, start, nl: true } : { type, value, start }); nl = false; };
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (/\s/.test(c)) { if (c === '\n') nl = true; i++; continue; }
      const s = i;
      if (c === '"' || c === "'") {
        let v = ''; i++;
        while (i < n && src[i] !== c) {
          if (src[i] === '\\') { const u = jsEscape(src, i); v += u[0]; i += u[1]; continue; }
          if (src[i] === '\n') break;
          v += src[i++];
        }
        i++; push('str', v, s); continue;
      }
      if (c === '`') {
        // A template: the literal parts and the source of each ${…} expression (resolved later from constants).
        const parts = ['']; const exprs = []; i++;
        while (i < n && src[i] !== '`') {
          if (src[i] === '\\') { const u = jsEscape(src, i); parts[parts.length - 1] += u[0]; i += u[1]; continue; }
          if (src[i] === '$' && src[i + 1] === '{') { const es = i + 2; i = skipTplExpr(src, es); exprs.push(src.slice(es, i - 1).trim()); parts.push(''); continue; }
          parts[parts.length - 1] += src[i++];
        }
        i++;
        if (exprs.length) { t.push(Object.assign({ type: 'tpl', value: parts.join('…'), parts, exprs, start: s }, nl ? { nl: true } : {})); nl = false; } else push('str', parts[0], s);
        continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) { const m = /^(0[xX][0-9a-fA-F_]+|[0-9_]*\.?[0-9_]+(?:[eE][+-]?[0-9]+)?)/.exec(src.slice(i, i + 40)); i += m ? m[0].length : 1; push('num', Number((m ? m[0] : c).replace(/_/g, '')), s); continue; }
      if (/[A-Za-z_$@#]/.test(c)) { const m = /^[A-Za-z_$@#][\w$]*/.exec(src.slice(i, i + 200)); i += m[0].length; push('id', m[0], s); continue; }
      if (c === '/') {
        const prev = t[t.length - 1];
        if (!prev || (prev.type === 'p' && PUNCT_BEFORE_REGEX.has(prev.value)) || (prev.type === 'id' && PUNCT_BEFORE_REGEX.has(prev.value))) {
          i++; let cls = false;
          while (i < n && (src[i] !== '/' || cls) && src[i] !== '\n') { if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; i++; }
          i++; while (/[a-z]/.test(src[i] || '')) i++;
          push('regex', src.slice(s, i), s); continue;
        }
      }
      const three = src.substr(i, 3); const two = src.substr(i, 2);
      if (['...', '===', '!==', '??='].includes(three)) { i += 3; push('p', three, s); continue; }
      if (['=>', '&&', '||', '??', '==', '!=', '<=', '>=', '?.', '++', '--'].includes(two)) { i += 2; push('p', two, s); continue; }
      i++; push('p', c, s);
    }
    return t;
  }
  // The index just past the "}" that closes a ${…} expression starting at i (strings and nested templates skipped).
  function skipTplExpr(src, i) {
    const n = src.length; let d = 1;
    while (i < n && d) {
      const c = src[i];
      if (c === '{') d++;
      else if (c === '}') { d--; if (!d) return i + 1; }
      else if (c === '/' && /[(,=:[!&|?{};]/.test((src.slice(Math.max(0, i - 40), i).match(/\S(?=\s*$)/) || ['('])[0])) {
        // a regular expression literal: /…/flags (a quote inside it is not a string)
        i++; let cls = false; while (i < n && (src[i] !== '/' || cls) && src[i] !== '\n') { if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; i++; }
      }
      else if (c === '"' || c === "'") { i++; while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++; } }
      else if (c === '`') { i++; while (i < n && src[i] !== '`') { if (src[i] === '\\') i++; else if (src[i] === '$' && src[i + 1] === '{') { i = skipTplExpr(src, i + 2); continue; } i++; } }
      i++;
    }
    return i;
  }

  // ------------------------------------------------------------ literal parser with skipping
  // parseValue returns { value, end, exact }. Non-literal values become SKIP (exact=false) and are left out of objects.
  const SKIP = { skip: true };
  function skipExpr(t, i) {
    for (; i < t.length; i++) {
      const v = t[i].type === 'p' ? t[i].value : null;
      if (v === '(' || v === '[' || v === '{') { i = matchClose(t, i); continue; } // over a bracketed part in one step
      if (v === ')' || v === ']' || v === '}') return i;
      if (v === ',' || v === ';') return i;
    }
    return i;
  }
  function isP(tok, v) { return tok && tok.type === 'p' && tok.value === v; }
  const hasOwn = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
  // A dotted chain of identifiers from token i (A.b?.c), stopping before a call: { ids, end }.
  function idChain(t, i) {
    const ids = [t[i].value]; let j = i + 1;
    while ((isP(t[j], '.') || isP(t[j], '?.')) && t[j + 1] && t[j + 1].type === 'id') { ids.push(t[j + 1].value); j += 2; }
    return { ids, end: j };
  }
  // ---- what the reader could not keep: never dropped silently
  // A value the reader cannot read (a call, a value nested past MAX_NEST, a string cut at MAX_STR) is left out of the
  // tool, but the text in it is kept for the poisoning checks: each such place hands its string literals (or the cut
  // part of a string) to the collector of the tool being read (LOST.cur). Objects and constants read earlier keep
  // what they collected and hand it on whenever they are used again. publicTools turns it into unreadable.text.
  const LOST = { cur: null };
  function lose(x) { if (LOST.cur && x && (typeof x === 'string' ? x.trim() : x.length)) LOST.cur.push(x); }
  // Like collecting, but what fn leaves is not handed on: the caller passes it on (lose) only if it uses the result.
  function quietly(fn) {
    const prev = LOST.cur; const mine = []; LOST.cur = mine;
    try { return [fn(), mine]; } finally { LOST.cur = prev; }
  }
  function collecting(fn) {
    const prev = LOST.cur; const mine = []; LOST.cur = mine;
    try { return [fn(), mine]; } finally { LOST.cur = prev; if (prev && mine.length) prev.push(mine); }
  }
  // The string literals of tokens a..b-1 (from an index of the file's literal tokens, so nothing is rescanned).
  function literalIndex(t) {
    if (t.__lit) return t.__lit;
    const ix = []; for (let k = 0; k < t.length; k++) if (t[k].type === 'str' || t[k].type === 'tpl') ix.push(k);
    Object.defineProperty(t, '__lit', { value: ix, enumerable: false });
    return ix;
  }
  function literalsArr(t, a, b) {
    const ix = literalIndex(t); let lo = 0; let hi = ix.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ix[mid] < a) lo = mid + 1; else hi = mid; }
    const out = [];
    for (let k = lo; k < ix.length && ix[k] < b; k++) { const x = t[ix[k]]; (x.type === 'str' ? [x.value] : x.parts).forEach((p) => { const q = String(p).trim(); if (q) out.push(q); }); }
    return out;
  }
  // The text a collector holds, flattened once (shared parts visited once), at most MAX_LOST characters; over that,
  // `over` is set and the list is refused rather than graded with text left unscanned.
  const MAX_LOST = 4 * 1024 * 1024;
  function lostText(tree) {
    const seen = new Set(); const parts = new Set(); let n = 0; let over = false;
    const walk = (x) => { if (over) return; if (typeof x === 'string') { if (!parts.has(x)) { parts.add(x); n += x.length; if (n > MAX_LOST) over = true; } return; } if (!Array.isArray(x) || seen.has(x)) return; seen.add(x); x.forEach(walk); };
    walk(tree);
    return { text: parts.size ? Array.from(parts).join(' … ') : '', over };
  }
  // The value of a constant or a property path into one (TOOLS.SEARCH, config.name), or null.
  // A number is taken from a constant only when it cannot change: a `let` or `var` can be assigned again (M = 10, in a
  // function or another statement), so a number read from one is not a bound, an operand or text.
  const fixedNum = (c) => !c || !c.decl || c.decl === 'const';
  function chainValue(ctx, ids) {
    if (!ctx || !ctx.consts || !hasOwn(ctx.consts, ids[0])) return null;
    const c = ctx.consts[ids[0]]; let v = c.value; if (c.lost) lose(c.lost);
    for (const k of ids.slice(1)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && hasOwn(v, k)) v = v[k];
      else return null;
    }
    return { value: v, c };
  }
  // Strings read from source are capped (a constant doubled in a chain must not blow up): longer is partial.
  const MAX_STR = 64 * 1024;
  const capStr = (r) => { if (r && typeof r.value === 'string' && r.value.length > MAX_STR) { lose(r.value.slice(MAX_STR)); r.value = r.value.slice(0, MAX_STR) + '…'; r.exact = false; r.partial = true; } return r; };
  // A template literal: its ${CONST} parts filled in from constants; others shown as "…" and the value marked partial.
  function tplValue(tok, ctx) {
    let out = tok.parts[0]; let exact = true;
    tok.exprs.forEach((e, k) => {
      const r = /^[A-Za-z_$][\w$]*(\s*\??\.\s*[A-Za-z_$][\w$]*)*$/.test(e) ? chainValue(ctx, e.split(/\s*\??\.\s*/)) : null;
      if (r && (typeof r.value === 'string' || (typeof r.value === 'number' && fixedNum(r.c)))) out += String(r.value); else { out += '…'; exact = false; }
      out += tok.parts[k + 1];
      if (out.length > MAX_STR) { lose(out.slice(MAX_STR)); out = out.slice(0, MAX_STR); exact = false; }
    });
    return capStr({ value: out, exact, partial: !exact });
  }
  // A numeric expression of literals and literal constants: 2 * 1024 * 1024, MAX_BYTES / 1048576, SECTIONS.length,
  // (A + 1) * B. Operands are number literals, constants holding a number, and .length of a constant array or string
  // read whole (no element left out). With `mulOnly`, a "+" or "-" ends it (in a string chain "+" joins strings).
  // Returns { value, end, ops } (ops: operators and .length read) or null when an operand is anything else.
  function numExpr(t, i, ctx, mulOnly, depth) {
    depth = depth || 0; if (depth > 16) return null;
    let ops = 0;
    const primary = (k) => {
      const tok = t[k]; if (!tok) return null;
      if (tok.type === 'num') return { value: tok.value, end: k + 1 };
      if (isP(tok, '-') && t[k + 1] && (t[k + 1].type === 'num' || t[k + 1].type === 'id')) { const r = primary(k + 1); return r ? { value: -r.value, end: r.end } : null; }
      if (isP(tok, '(')) { const r = numExpr(t, k + 1, ctx, false, depth + 1); if (!r || !isP(t[r.end], ')')) return null; ops += r.ops; return { value: r.value, end: r.end + 1 }; }
      if (tok.type !== 'id' || !ctx || !ctx.consts || !hasOwn(ctx.consts, tok.value) || !fixedNum(ctx.consts[tok.value])) return null;
      const ch = idChain(t, k); if (isP(t[ch.end], '(')) return null;
      if (ch.ids.length > 1 && ch.ids[ch.ids.length - 1] === 'length') {
        const r = chainValue(ctx, ch.ids.slice(0, -1)); const c = r && r.c;
        if (!r || c.exact === false || c.partial || c.holes) return null;
        if (Array.isArray(r.value) || typeof r.value === 'string') { ops++; return { value: r.value.length, end: ch.end }; }
        return null;
      }
      const r = chainValue(ctx, ch.ids);
      return r && typeof r.value === 'number' && r.c.exact !== false ? { value: r.value, end: ch.end } : null;
    };
    const opAt = (k, set) => t[k] && t[k].type === 'p' && set.includes(t[k].value) && !isP(t[k + 1], '=');
    const term = (k) => {
      let a = primary(k); if (!a) return null;
      while (opAt(a.end, ['*', '/', '%'])) {
        const op = t[a.end].value; const b = primary(a.end + 1); if (!b) return null;
        a = { value: op === '*' ? a.value * b.value : op === '/' ? a.value / b.value : a.value % b.value, end: b.end }; ops++;
      }
      return a;
    };
    let a = term(i); if (!a) return null;
    while (!mulOnly && opAt(a.end, ['+', '-'])) {
      const op = t[a.end].value; const b = term(a.end + 1); if (!b) return null;
      a = { value: op === '+' ? a.value + b.value : a.value - b.value, end: b.end }; ops++;
    }
    return Number.isFinite(a.value) ? { value: a.value, end: a.end, ops } : null;
  }
  // A string expression: string and template literals and string constants joined by "+" ('a' + NAME + `b${X}`).
  // Returns null unless at least one operand is a string; an operand that cannot be read makes the value partial.
  function stringExpr(t, i, ctx) {
    let out = ''; let exact = true; let any = false; let j = i;
    for (;;) {
      const tok = t[j]; let v = null; let end = j + 1;
      if (!tok) return null;
      const ne = tok.type === 'num' || tok.type === 'id' ? numExpr(t, j, ctx, true) : null; // 'Limit ' + MAX_BYTES / 1048576 + ' MiB'
      if (ne && ne.ops) { v = String(ne.value); end = ne.end; }
      else if (tok.type === 'str') { v = tok.value; any = true; }
      else if (tok.type === 'tpl') { const r = tplValue(tok, ctx); v = r.value; if (!r.exact) exact = false; any = true; }
      else if (tok.type === 'num') v = String(tok.value);
      else if (tok.type === 'id') {
        const ch = idChain(t, j); end = ch.end;
        if (isP(t[end], '(')) return null;
        const r = chainValue(ctx, ch.ids);
        if (r && typeof r.value === 'string') { v = r.value; any = true; if (ch.ids.length === 1 && r.c.partial) exact = false; } else if (r && typeof r.value === 'number' && fixedNum(r.c)) v = String(r.value); else { v = '…'; exact = false; }
      } else return null;
      if (out.length >= MAX_STR) { lose(v); exact = false; } else { out += v; if (out.length > MAX_STR) { lose(out.slice(MAX_STR)); out = out.slice(0, MAX_STR); exact = false; } }
      j = end;
      if (isP(t[j], '+') && t[j + 1] && /^(str|tpl|id|num)$/.test(t[j + 1].type)) { j++; continue; }
      break;
    }
    if (!any) return null;
    return capStr({ value: out, end: j, exact, partial: !exact });
  }
  function parseValue(t, i, ctx) {
    const tok = t[i];
    if (!tok) return { value: SKIP, end: i, exact: false };
    let r = null;
    // a numeric expression of literals and literal constants (2 * 1024 * 1024, SECTIONS.length)
    const ne = tok.type === 'num' || isP(tok, '-') || (tok.type === 'id' && ctx && ctx.consts && hasOwn(ctx.consts, tok.value)) ? numExpr(t, i, ctx, false) : null;
    if (ne && (ne.ops || ne.end > i + 1)) r = { value: ne.value, end: ne.end, exact: true };
    else if (tok.type === 'str' || tok.type === 'tpl') {
      r = stringExpr(t, i, ctx);
    } else if (tok.type === 'num') r = { value: tok.value, end: i + 1, exact: true };
    else if (isP(tok, '-') && t[i + 1] && t[i + 1].type === 'num') r = { value: -t[i + 1].value, end: i + 2, exact: true };
    else if (tok.type === 'id' && (tok.value === 'true' || tok.value === 'false')) r = { value: tok.value === 'true', end: i + 1, exact: true };
    else if (tok.type === 'id' && tok.value === 'null') r = { value: null, end: i + 1, exact: true };
    else if (isP(tok, '{')) r = parseObject(t, i, ctx);
    else if (isP(tok, '[')) r = parseArray(t, i, ctx);
    else if (tok.type === 'id' && ctx && ctx.zod && ctx.zodNames.has(tok.value) && isP(t[i + 1], '.')) {
      const z = parseZod(t, i, ctx);
      if (z) r = z;
    } else if (tok.type === 'id' && ctx && ctx.zod && ctx.zodNames.has(tok.value + '.') && isP(t[i + 1], '.') && t[i + 2] && t[i + 2].value === 'z' && isP(t[i + 3], '.')) {
      const z = parseZod(t, i + 2, ctx); // zod_1.z.string(): read from the z
      if (z) r = z;
    } else if (tok.type === 'id' && tok.value === 'Object' && isP(t[i + 1], '.') && t[i + 2] && t[i + 2].value === 'freeze' && isP(t[i + 3], '(')) {
      // Object.freeze({...}): the object itself
      const v = parseValue(t, i + 4, ctx);
      if (v.value !== SKIP && isP(t[v.end], ')')) r = Object.assign({}, v, { end: v.end + 1 });
    } else if (tok.type === 'id' && isP(t[i + 1], '(') && ctx && ctx.consts && hasOwn(ctx.consts, FN + tok.value)) {
      // id('Project id'), ymd().optional(): a schema factory of this file or a direct import, read with its arguments
      const call = callFactory(t, i, ctx);
      if (call && call.r.zod) {
        lose(call.lost); const nx = call.end;
        if (isP(t[nx], '.') && t[nx + 1] && t[nx + 1].type === 'id' && isP(t[nx + 2], '(')) { const z = parseZod(t, i, ctx, { value: call.r.value, exact: call.r.exact, optional: call.r.optional }, nx); if (z) r = z; }
        else r = { value: call.r.value, end: nx, exact: call.r.exact, zod: true, optional: call.r.optional };
      }
    } else if (tok.type === 'id' && ctx && ctx.consts && hasOwn(ctx.consts, tok.value) && isP(t[i + 1], '.') && t[i + 2] && t[i + 2].type === 'id' && t[i + 2].value === 'shape' && !isP(t[i + 3], '(') && !isP(t[i + 3], '.')) {
      // Schema.shape of a zod object constant: the raw shape, with the optional flags the object schema kept.
      const c = ctx.consts[tok.value]; const sch = c.value;
      // The optional keys also go with the shape object itself (OPTIONAL_OF), so they are kept when the shape is read
      // back through a registry entry (tool.inputShape in a loop over tool objects, R-RD-35).
      if (c.zod && sch && sch.type === 'object' && sch.properties) { const req = new Set(sch.required || []); const opt = new Set(Object.keys(sch.properties).filter((k) => !req.has(k))); if (opt.size && !OPTIONAL_OF.has(sch.properties)) OPTIONAL_OF.set(sch.properties, opt); r = { value: sch.properties, end: i + 3, exact: c.exact, rawShape: true, optionalKeys: opt }; }
    } else if (tok.type === 'id' && ctx && ctx.consts && hasOwn(ctx.consts, tok.value)) {
      const c = ctx.consts[tok.value]; if (c.lost) lose(c.lost);
      const ch = idChain(t, i);
      if (c.zod && isP(t[i + 1], '.') && t[i + 2] && t[i + 2].type === 'id' && isP(t[i + 3], '(')) {
        // a zod constant with more calls: Param.optional().describe('…')
        const z = parseZod(t, i, ctx, c);
        if (z) r = z;
      } else if (!isP(t[ch.end], '(') && !(typeof c.value === 'number' && !fixedNum(c))) {
        if (ch.ids.length === 1) {
          const s = typeof c.value === 'string' ? stringExpr(t, i, ctx) : null;
          r = s && (s.end > i + 1 || s.partial) ? s : { value: c.value, end: i + 1, exact: c.exact, optional: c.optional, zod: c.zod, optionalKeys: c.optionalKeys };
        } else {
          const v = chainValue(ctx, ch.ids);
          if (v && v.value !== undefined) r = typeof v.value === 'string' ? (stringExpr(t, i, ctx) || { value: v.value, end: ch.end, exact: c.exact }) : { value: v.value, end: ch.end, exact: c.exact };
        }
      }
    }
    if (r) {
      // TS: `as const`, `satisfies X`, non-null `!`
      let j = r.end;
      while (t[j] && t[j].type === 'id' && (t[j].value === 'as' || t[j].value === 'satisfies')) j = skipType(t, j + 1);
      if (isP(t[j], '!')) j++;
      const nx = t[j];
      if (!nx || isP(nx, ',') || isP(nx, '}') || isP(nx, ']') || isP(nx, ')') || isP(nx, ';') || (nx.nl && /^(id|str|tpl|num)$/.test(nx.type) && !/^(as|satisfies|in|of|instanceof)$/.test(nx.value))) return Object.assign(r, { end: j });
    }
    return { value: SKIP, end: skipExpr(t, i), exact: false };
  }
  function skipType(t, j) { // skip a TS type after `as`: identifiers, dots, generics
    let d = 0;
    for (; j < t.length; j++) {
      const v = t[j].type === 'p' ? t[j].value : null;
      if (v === '<' || v === '(' || v === '[' || v === '{') d++;
      else if (v === '>' || v === ')' || v === ']' || v === '}') { if (d === 0) return j; d--; }
      else if ((v === ',' || v === ';') && d === 0) return j;
    }
    return j;
  }
  // A TS type annotation after `const name:`, up to the "=" that starts the value (skipType does not stop at "=").
  function skipAnnotation(t, j) {
    let d = 0;
    for (let n = 0; j < t.length && n < 400; j++, n++) {
      const v = t[j].type === 'p' ? t[j].value : null;
      if (v === '<' || v === '(' || v === '[' || v === '{') d++;
      else if (v === '>' || v === ')' || v === ']' || v === '}') { if (d === 0) return j; d--; }
      else if ((v === '=' || v === ',' || v === ';') && d === 0) return j;
    }
    return j;
  }
  const HANDLER_KEYS = new Set(['handler', 'execute', 'callback', 'run', 'cb', 'fn', 'impl']);
  // An object literal. Besides the value: `unknownKeys` (keys whose value could not be read), `partialKeys` (strings read in part,
  // a template with an unresolved ${…}) and `spreadUnknown` (a ...spread that could not be read).
  // Each object of a file is parsed once per context: a nested object met again (the "{" of an object already read as
  // part of an outer one) comes from this memo, so nested source costs one read, not one per level. Callers get a copy.
  const OBJ_MEMO = new WeakMap();
  // Two limits, neither of which drops text silently (what they leave out goes to the collector, see LOST):
  //   MAX_VDEPTH  a value nested deeper than this is left out of its object or array. It is past the 64 levels a tool
  //               list may have, so whatever the engine accepts is read in full. It depends only on the value, not on
  //               where the value was met, so results stay valid in the memo.
  //   MAX_NEST    the recursion of one parse (stack safety). extractJs reads every object of a file innermost first, so
  //               its parses stay shallow; a result cut here depends on where it was met and is never kept in the memo.
  const MAX_VDEPTH = 70;
  const MAX_NEST = 600; let nest = 0; let capHits = 0;
  const DEPTHS = new WeakMap();
  function valueDepth(v) {
    if (!v || typeof v !== 'object') return 0;
    const c = DEPTHS.get(v); if (c !== undefined) return c;
    let d = 0; for (const k of Object.keys(v)) { const x = v[k]; if (x && typeof x === 'object') { const e = valueDepth(x); if (e > d) d = e; } }
    DEPTHS.set(v, d + 1); return d + 1;
  }
  const tooDeepValue = (v) => valueDepth(v) >= MAX_VDEPTH;
  function nested(t, i, fn) {
    if (nest >= MAX_NEST) { capHits++; return { value: SKIP, end: matchClose(t, i) + 1, exact: false }; }
    nest++; try { return fn(); } finally { nest--; }
  }
  function parseObject(t, i, ctx) {
    if (!ctx || typeof ctx !== 'object') return nested(t, i, () => parseObjectOnce(t, i, ctx));
    let m = OBJ_MEMO.get(ctx); if (!m) { m = new Map(); OBJ_MEMO.set(ctx, m); }
    let e = m.get(i);
    if (e) lose(e.lost);
    else {
      // only a result read with the full depth available is kept: one cut at MAX_NEST depends on where it was met
      const caps = capHits;
      const [r, lost] = collecting(() => nested(t, i, () => parseObjectOnce(t, i, ctx)));
      e = { r, lost };
      if (capHits === caps) m.set(i, e);
    }
    const r = e.r;
    const copy = r.value && r.value !== SKIP && typeof r.value === 'object' ? Object.assign({}, r.value) : r.value;
    if (copy !== r.value && OPTIONAL_OF.has(r.value)) OPTIONAL_OF.set(copy, OPTIONAL_OF.get(r.value));
    return Object.assign({}, r, { value: copy });
  }
  function parseObjectOnce(t, i, ctx) {
    const o = {}; let exact = true; const optionalKeys = new Set(); const unknown = new Set(); const partial = new Set(); let spreadUnknown = false; const childOptional = {}; const literals = {}; i++;
    while (i < t.length && !isP(t[i], '}')) {
      const k = t[i];
      if (isP(k, '...')) {
        // {...NAME} / {...NAME.member}: a constant holding a plain object (this file's, an imported one, or another file's) is merged in.
        const nx = t[i + 1]; let c = null; let end = i + 2;
        if (nx && nx.type === 'id' && ctx && ctx.consts) { const ch = idChain(t, i + 1); const v = chainValue(ctx, ch.ids); if (v) { c = ch.ids.length === 1 ? v.c : { value: v.value, exact: v.c.exact, zod: false }; end = ch.end; } else { const sp = spreadExpr(t, i + 1, ctx); if (sp) { c = sp; end = sp.end; } } }
        if (c && !c.zod && c.value && typeof c.value === 'object' && !Array.isArray(c.value) && (isP(t[end], ',') || isP(t[end], '}'))) {
          Object.assign(o, c.value); exact = exact && c.exact !== false; if (c.optionalKeys) c.optionalKeys.forEach((x) => optionalKeys.add(x));
          i = isP(t[end], ',') ? end + 1 : end; continue;
        }
        exact = false; spreadUnknown = true; { const e2 = skipExpr(t, i + 1); lose(literalsArr(t, i + 1, e2)); i = e2; } if (isP(t[i], ',')) i++; continue;
      }
      let key = null;
      if (k.type === 'str' || k.type === 'id') key = String(k.value);
      else if (k.type === 'num') key = String(k.value);
      else if (isP(k, '[')) { exact = false; i = skipExpr(t, i); if (isP(t[i], ',')) i++; continue; }
      if (key === null) return { value: SKIP, end: skipExpr(t, i), exact: false };
      // method shorthand: name(...) { } / async name() {} / get x() {}
      if (isP(t[i + 1], '(') || (k.type === 'id' && (key === 'async' || key === 'get' || key === 'set') && t[i + 1] && t[i + 1].type === 'id')) {
        const mk = isP(t[i + 1], '(') ? key : t[i + 1].value;
        let j = i + 1; while (t[j] && !isP(t[j], '{')) j++;
        j = matchClose(t, j) + 1;
        if (!HANDLER_KEYS.has(mk)) { unknown.add(mk); if (LITERAL_KEYS.has(mk)) { literals[mk] = literalsIn(t, i, j); lose(literalsArr(t, i, j)); } }
        exact = false; i = isP(t[j], ',') ? j + 1 : j; continue;
      }
      if (isP(t[i + 1], ',') || isP(t[i + 1], '}')) { // shorthand { name }
        if (ctx && ctx.consts && hasOwn(ctx.consts, key)) { const c = ctx.consts[key]; if (c.lost) lose(c.lost); o[key] = c.value; exact = exact && c.exact; if (c.optional) optionalKeys.add(key); } else { exact = false; if (!HANDLER_KEYS.has(key)) unknown.add(key); }
        i += isP(t[i + 1], ',') ? 2 : 1; continue;
      }
      let j = i + 1;
      if (isP(t[j], '?')) j++;
      if (!isP(t[j], ':')) return { value: SKIP, end: skipExpr(t, i), exact: false };
      const v = parseValue(t, j + 1, ctx);
      if (v.optional) optionalKeys.add(key);
      if (v.partial) partial.add(key);
      // annotations with a hint the reader cannot know ({ readOnlyHint: readOnly }) are not graded as if the hint were absent (R-RD-12)
      if (key === 'annotations' && v.value !== SKIP && ((v.unknownKeys && v.unknownKeys.size) || v.spreadUnknown)) partial.add(key);
      if (v.optionalKeys && v.optionalKeys.size) childOptional[key] = v.optionalKeys;
      if (v.value !== SKIP && tooDeepValue(v.value)) { lose(literalsArr(t, j + 1, v.end)); v.value = SKIP; unknown.add(key); exact = false; }
      else if (v.value !== SKIP) { o[key] = v.value; exact = exact && v.exact !== false; } else if (!HANDLER_KEYS.has(key)) { exact = false; unknown.add(key); if (LITERAL_KEYS.has(key)) literals[key] = literalsIn(t, j + 1, v.end); lose(literalsArr(t, j + 1, v.end)); if (ctx && ctx.placeholder) o[key] = {}; }
      i = v.end;
      if (isP(t[i], ',')) i++;
      else if (!isP(t[i], '}')) return { value: SKIP, end: skipExpr(t, i), exact: false };
    }
    if (optionalKeys.size) OPTIONAL_OF.set(o, optionalKeys);
    return { value: o, end: i + 1, exact, optionalKeys, unknownKeys: unknown, partialKeys: partial, spreadUnknown, childOptional, literals };
  }
  // The string literals between tokens a and b (the readable parts of an expression that cannot be read as a whole),
  // joined by " … ", so poisoning checks still see them; null when there are none.
  // Only description and title use them, and at most LITERAL_TOKENS tokens of the value are looked at, so deeply
  // nested values cost no more than reading them once.
  const LITERAL_KEYS = new Set(['description', 'title']);
  function literalsIn(t, a, b) {
    const out = []; let n = 0;
    for (const q of literalsArr(t, a, b)) { if (n >= MAX_STR) break; out.push(q); n += q.length; }
    return out.length ? out.join(' … ').slice(0, MAX_STR) : null;
  }
  const ARR_MEMO = new WeakMap();
  function parseArray(t, i, ctx) {
    if (!ctx || typeof ctx !== 'object') return nested(t, i, () => parseArrayOnce(t, i, ctx));
    let m = ARR_MEMO.get(ctx); if (!m) { m = new Map(); ARR_MEMO.set(ctx, m); }
    let e = m.get(i);
    if (e) lose(e.lost);
    else {
      const caps = capHits;
      const [r, lost] = collecting(() => nested(t, i, () => parseArrayOnce(t, i, ctx)));
      e = { r, lost };
      if (capHits === caps) m.set(i, e);
    }
    return Object.assign({}, e.r, { value: Array.isArray(e.r.value) ? e.r.value.slice() : e.r.value });
  }
  function parseArrayOnce(t, i, ctx) {
    const a = []; let exact = true; let holes = 0; i++; // holes: elements left out (a spread, a value not read)
    while (i < t.length && !isP(t[i], ']')) {
      if (isP(t[i], '...')) { exact = false; holes++; const e2 = skipExpr(t, i + 1); lose(literalsArr(t, i + 1, e2)); i = e2; if (isP(t[i], ',')) i++; continue; }
      const v = parseValue(t, i, ctx);
      if (v.value !== SKIP && !tooDeepValue(v.value)) a.push(v.value); else { exact = false; holes++; lose(literalsArr(t, i, v.end)); }
      exact = exact && v.exact !== false;
      i = v.end;
      if (isP(t[i], ',')) i++;
      else if (!isP(t[i], ']')) return { value: SKIP, end: skipExpr(t, i), exact: false };
    }
    return { value: a, end: i + 1, exact, holes };
  }
  // The index of the bracket that closes the one at i, from one pass over the tokens (cached on the token array), so
  // nested code is never rescanned. An unclosed bracket closes at the last token.
  const CLOSERS = { '(': ')', '[': ']', '{': '}' };
  function bracketIndex(t) {
    if (t.__close && t.__close.length === t.length) return t.__close;
    const close = new Int32Array(t.length).fill(-1); const stack = [];
    for (let k = 0; k < t.length; k++) {
      const x = t[k]; if (x.type !== 'p') continue;
      if (CLOSERS[x.value]) stack.push(k);
      else if (x.value === ')' || x.value === ']' || x.value === '}') { if (stack.length && CLOSERS[t[stack[stack.length - 1]].value] === x.value) close[stack.pop()] = k; }
    }
    Object.defineProperty(t, '__close', { value: close, enumerable: false, configurable: true });
    return close;
  }
  function matchClose(t, i) {
    if (!t[i] || t[i].type !== 'p' || !CLOSERS[t[i].value]) return t.length - 1;
    const c = bracketIndex(t)[i];
    return c < 0 ? t.length - 1 : c;
  }

  // ------------------------------------------------------------ schema factories
  // A top-level function of a file that returns a value the reader can read, and a direct import of one:
  //   const id = (description: string) => z.union([z.string(), z.number()]).describe(description);
  //   const rangeArgs = (defaultText) => ({ from: ymd().optional().describe(`First date. ${defaultText}`) });
  //   function ymd() { return z.string().regex(/^\d{4}-\d{2}-\d{2}$/); }
  // It is kept in the constants under FN + name (so no lookup of a plain constant sees it) as { t, params, at, ctx,
  // consts }: the parameters (names, and the token of each default), the token where the returned expression starts,
  // and the definition's own file context. A call is read with the parameters bound to the arguments read at the call
  // site; an argument that cannot be read leaves its parameter unknown (so text built from it is partial, never
  // guessed). Only a zod result is a value (callFactory in parseValue), and a plain object only when spread into a
  // shape (spreadCall). Factories may call factories, FN_DEPTH deep.
  const FN = '\u0000fn:';
  const FN_DEPTH = 4;
  // The parameters of a function from the "(" at k: [{ name, def }] (def: token of a default value, or -1), or null
  // when one is a pattern or a rest parameter.
  function fnParams(t, k) {
    const close = matchClose(t, k); const out = []; let m = k + 1;
    while (m < close) {
      const nm = t[m]; if (!nm || nm.type !== 'id' || nm.value === 'this') return null;
      let n = m + 1; if (isP(t[n], '?')) n++;
      if (isP(t[n], ':')) n = skipType(t, n + 1);
      let def = -1; if (isP(t[n], '=')) { def = n + 1; n = skipExpr(t, n + 1); }
      out.push({ name: nm.value, def });
      if (isP(t[n], ',')) m = n + 1; else if (n === close) m = close; else return null;
    }
    return { params: out, close };
  }
  // The start of the returned expression of a function body at k: an expression body, `({ … })`, or a block whose only
  // statement is `return …`. { at, paren } or null.
  function fnReturn(t, k) {
    if (isP(t[k], '{')) {
      const close = matchClose(t, k);
      if (!(t[k + 1] && t[k + 1].type === 'id' && t[k + 1].value === 'return')) return null;
      const e = skipExpr(t, k + 2); const after = isP(t[e], ';') ? e + 1 : e;
      return after === close ? { at: k + 2, stop: e } : null;
    }
    return { at: k, stop: -1 };
  }
  // A function definition at a `const NAME =` (value at j) or `function NAME(` (name at j - 1): the record, or null.
  function fnAt(t, j, ctx, consts, isDecl) {
    let k = j; let ps;
    if (isDecl) { if (!isP(t[k], '(')) return null; ps = fnParams(t, k); if (!ps) return null; k = ps.close + 1; if (isP(t[k], ':')) k = skipType(t, k + 1); }
    else if (t[k] && t[k].type === 'id' && isP(t[k + 1], '=>')) { ps = { params: [{ name: t[k].value, def: -1 }] }; k += 2; }
    else if (isP(t[k], '(')) { ps = fnParams(t, k); if (!ps) return null; k = ps.close + 1; if (isP(t[k], ':')) k = skipType(t, k + 1); if (!isP(t[k], '=>')) return null; k++; }
    else if (t[k] && t[k].type === 'id' && t[k].value === 'function' && isP(t[k + 1], '(')) return fnAt(t, k + 1, ctx, consts, true);
    else return null;
    if (isDecl && !isP(t[k], '{')) return null;
    const ret = fnReturn(t, k); if (!ret) return null;
    return { t, params: ps.params, at: ret.at, stop: ret.stop, ctx, consts };
  }
  // A call of a factory at token i (the name; "(" at i + 1): { r, end } with r the value read from its returned
  // expression, or null.
  // The text the call left unread is returned as `lost`, for the caller to pass on if it uses the value.
  function callFactory(t, i, ctx) {
    const fn = ctx.consts[FN + t[i].value]; const depth = ctx.fnDepth || 0;
    if (!fn || depth >= FN_DEPTH) return null;
    const [res, lost] = quietly(() => readCall(fn, t, i, ctx, depth));
    return res && Object.assign(res, { lost });
  }
  function readCall(fn, t, i, ctx, depth) {
    const close = matchClose(t, i + 1); const args = []; let k = i + 2;
    while (k < close) {
      const v = parseValue(t, k, ctx); args.push(v);
      if (v.value === SKIP) lose(literalsArr(t, k, v.end)); // an argument it cannot read: its text is still scanned
      k = v.end; if (isP(t[k], ',')) k++; else break;
    }
    if (k !== close) return null;
    // The parameters are bound in the definition's own table for the time of the read and restored after it (a copy
    // of the table per call would cost its size on every call).
    const consts = fn.consts; const saved = [];
    const bind = (k, v) => { saved.push([k, hasOwn(consts, k), consts[k]]); if (v === undefined) delete consts[k]; else consts[k] = v; };
    const fctx = Object.assign({}, fn.ctx, { consts, fnDepth: depth + 1 });
    const ft = fn.t; let r;
    try {
      fn.params.forEach((p, n) => {
        let v = args[n]; if (!v && p.def >= 0) v = parseValue(fn.t, p.def, fctx);
        bind(p.name, v && v.value !== SKIP && v.value !== undefined ? { value: v.value, exact: v.exact !== false, optional: !!v.optional, zod: !!v.zod, optionalKeys: v.optionalKeys || null, top: false, partial: !!v.partial, lost: null, holes: (v.holes || 0) + (v.unknownKeys ? v.unknownKeys.size : 0) + (v.spreadUnknown ? 1 : 0) } : undefined);
        bind(FN + p.name, undefined);
      });
      const endOk = (e) => (fn.stop >= 0 ? e === fn.stop : !ft[e] || isP(ft[e], ';') || isP(ft[e], ',') || isP(ft[e], ')') || isP(ft[e], '}') || !!ft[e].nl);
      if (isP(ft[fn.at], '(')) { // => ({ … }), return (…)
        const pc = matchClose(ft, fn.at); r = parseValue(ft, fn.at + 1, fctx);
        if (r.value === SKIP || r.end !== pc || !endOk(pc + 1)) return null;
      } else {
        r = parseValue(ft, fn.at, fctx);
        if (r.value === SKIP || (fn.stop >= 0 && r.end !== fn.stop)) return null;
      }
    } finally {
      for (let n = saved.length - 1; n >= 0; n--) { const [k, had, old] = saved[n]; if (had) consts[k] = old; else delete consts[k]; }
    }
    return { r, end: close + 1 };
  }
  // A spread in a shape that is not a plain constant: a factory call, or a constant object filtered by key.
  function spreadExpr(t, k, ctx) {
    const sp = spreadCall(t, k, ctx); if (sp) return sp;
    const [fe, lost] = quietly(() => filteredEntries(t, k, ctx)); if (fe) lose(lost);
    return fe;
  }
  // Object.fromEntries(Object.entries(FIELDS).filter(([key]) => key !== 'title')): the constant object FIELDS (read
  // whole) without the keys the test rejects. The test may compare the key with string literals (=== !== == !=), test
  // it with [..].includes(key) or a constant array's .includes(key), negate with !, and join with && and ||; anything
  // else, and a constant with a part the reader could not read, is not read.
  function filteredEntries(t, k, ctx) {
    const at = (n, ...vals) => vals.every((v, m) => { const x = t[n + m]; return x && (v === null ? x.type === 'id' : x.value === v && (x.type === 'p' || x.type === 'id')); });
    if (!at(k, 'Object', '.', 'fromEntries', '(', 'Object', '.', 'entries', '(', null, ')', '.', 'filter', '(', '(', '[', null)) return null;
    const outerClose = matchClose(t, k + 3); const filterClose = matchClose(t, k + 12);
    const name = t[k + 8].value; const key = t[k + 15].value;
    const c = ctx && ctx.consts && hasOwn(ctx.consts, name) ? ctx.consts[name] : null;
    if (!c || c.zod || !c.value || typeof c.value !== 'object' || Array.isArray(c.value) || c.exact === false || c.holes) return null;
    let j = k + 16; if (isP(t[j], ',') && t[j + 1] && t[j + 1].type === 'id') j += 2;
    if (!isP(t[j], ']') || !isP(t[j + 1], ')') || !isP(t[j + 2], '=>')) return null;
    if (filterClose + (isP(t[filterClose + 1], ',') ? 2 : 1) !== outerClose || !isP(t[outerClose], ')')) return null; // a trailing comma is allowed
    const strs = (n) => { // a string array literal or constant: [values, end]
      if (isP(t[n], '[')) { const v = parseValue(t, n, ctx); return Array.isArray(v.value) && v.value.every((x) => typeof x === 'string') && !v.holes ? [v.value, v.end] : null; }
      if (t[n] && t[n].type === 'id' && hasOwn(ctx.consts, t[n].value)) { const v = ctx.consts[t[n].value]; return Array.isArray(v.value) && v.value.every((x) => typeof x === 'string') && !v.holes && v.exact !== false ? [v.value, n + 1] : null; }
      return null;
    };
    // a recursive descent over the test: or := and (|| and)*, and := unary (&& unary)*, unary := !unary | (or) | atom
    let n = j + 3;
    const atom = () => {
      if (t[n] && t[n].type === 'id' && t[n].value === key && t[n + 1] && /^(===|!==|==|!=)$/.test(t[n + 1].value) && t[n + 2] && t[n + 2].type === 'str') { const op = t[n + 1].value; const lit = t[n + 2].value; n += 3; return (x) => (op[0] === '=' ? x === lit : x !== lit); }
      if (t[n] && t[n].type === 'str' && t[n + 1] && /^(===|!==|==|!=)$/.test(t[n + 1].value) && t[n + 2] && t[n + 2].type === 'id' && t[n + 2].value === key) { const op = t[n + 1].value; const lit = t[n].value; n += 3; return (x) => (op[0] === '=' ? x === lit : x !== lit); }
      const a = strs(n);
      if (a && at(a[1], '.', 'includes', '(', key, ')')) { n = a[1] + 5; const set = a[0]; return (x) => set.includes(x); }
      return null;
    };
    const unary = () => {
      if (isP(t[n], '!')) { n++; const f = unary(); return f && ((x) => !f(x)); }
      if (isP(t[n], '(')) { n++; const f = or(); if (!f || !isP(t[n], ')')) return null; n++; return f; }
      return atom();
    };
    const and = () => { let f = unary(); while (f && isP(t[n], '&&')) { n++; const g = unary(); if (!g) return null; const a = f; f = (x) => a(x) && g(x); } return f; };
    const or = () => { let f = and(); while (f && isP(t[n], '||')) { n++; const g = and(); if (!g) return null; const a = f; f = (x) => a(x) || g(x); } return f; };
    const test = or();
    if (test && isP(t[n], ',') && n + 1 === filterClose) n++;
    if (!test || n !== filterClose) return null;
    const value = {}; Object.keys(c.value).forEach((x) => { if (test(x)) value[x] = c.value[x]; });
    const optionalKeys = c.optionalKeys ? new Set(Array.from(c.optionalKeys).filter((x) => hasOwn(value, x))) : null;
    if (c.lost) lose(c.lost);
    return { value, exact: true, optionalKeys, zod: false, end: outerClose + 1 };
  }
  // ...factory(args) in a shape: the plain object it returns (its optional keys kept), with end past the call.
  function spreadCall(t, k, ctx) {
    if (!t[k] || t[k].type !== 'id' || !isP(t[k + 1], '(') || !ctx || !ctx.consts || !hasOwn(ctx.consts, FN + t[k].value)) return null;
    const call = callFactory(t, k, ctx); const v = call && call.r.value;
    if (!call || call.r.zod || !v || typeof v !== 'object' || Array.isArray(v)) return null;
    lose(call.lost);
    return { value: v, exact: call.r.exact, optionalKeys: call.r.optionalKeys || OPTIONAL_OF.get(v) || null, zod: false, end: call.end };
  }

  // ------------------------------------------------------------ zod -> JSON Schema (the common subset)
  // z.string().min(1).describe('x').optional() and friends. Unknown parts make the result inexact, not wrong.
  function parseZod(t, i, ctx, base, chainAt) {
    // collect chain: z . name ( args ) . name ( args ) ...  With `base` (a zod constant, or what a schema factory
    // returned when the chain starts at `chainAt`, after the factory call), every call modifies it.
    let j = chainAt || i + 1; const calls = base ? [{ name: '__const', args: [], base }] : [];
    while (isP(t[j], '.') && t[j + 1] && t[j + 1].type === 'id') {
      const name = t[j + 1].value; j += 2;
      let args = [];
      if (isP(t[j], '(')) {
        const close = matchClose(t, j); let k = j + 1;
        // the properties of z.object({...}) that cannot be read keep their name (an empty schema) rather than vanish
        const actx = /^(object|strictObject|looseObject)$/.test(name) && !calls.length ? Object.assign({}, ctx, { placeholder: true }) : ctx;
        while (k < close) {
          // .regex(/…/flags): the literal itself (a value the literal parser does not read)
          const v = name === 'regex' && t[k].type === 'regex' && (isP(t[k + 1], ',') || isP(t[k + 1], ')')) ? { value: { regexLiteral: t[k].value }, end: k + 1, exact: true } : parseValue(t, k, actx);
          args.push(v); k = v.end; if (isP(t[k], ',')) k++; else break;
        }
        j = close + 1;
      }
      calls.push({ name, args });
    }
    if (!calls.length || (base && calls.length < 2)) return null;
    while (calls.length > 1 && calls[0].name === 'coerce' && !calls[0].args.length) calls.shift(); // z.coerce.number()
    const out = zodToSchema(calls, ctx);
    return { value: out.schema, end: j, exact: out.exact, zod: true, optional: out.optional };
  }
  function zodToSchema(calls, ctx) {
    let s = {}; let exact = true; let optional = false;
    const fl = ctx && ctx.fl; const zod3 = !fl || !(fl.zod >= 4);
    // What wraps the schema the chain builds (see WRAPPED_OF): null, 'wrapped' or 'optional'.
    let wrap = null; const wrapAs = (w) => { if (wrap !== 'optional') wrap = w; };
    const base = calls[0]; const argv = (k) => (base.args[k] ? base.args[k].value : undefined);
    switch (base.name) {
      case '__const': s = JSON.parse(JSON.stringify(base.base.value || {})); exact = base.base.exact !== false; optional = !!base.base.optional; wrap = (base.base.value && typeof base.base.value === 'object' && WRAPPED_OF.get(base.base.value)) || null; break;
      case 'toJSONSchema': { const a = argv(0); if (a && a !== SKIP && typeof a === 'object') s = a; else exact = false; break; }
      case 'preprocess': { const a = argv(1); if (a && a !== SKIP && typeof a === 'object') { s = a; optional = !!(base.args[1] && base.args[1].optional); } else exact = false; break; }
      case 'optional': case 'nullish': { const a = argv(0); if (a && a !== SKIP && typeof a === 'object') s = JSON.parse(JSON.stringify(a)); else exact = false; optional = true; wrap = 'optional'; break; }
      case 'discriminatedUnion': { const a = argv(1); s = Array.isArray(a) ? { anyOf: a } : {}; if (!Array.isArray(a)) exact = false; break; }
      case 'string': s = { type: 'string' }; break;
      case 'number': s = { type: 'number' }; break;
      case 'int': case 'bigint': s = { type: 'integer' }; break;
      case 'boolean': s = { type: 'boolean' }; break;
      case 'null': s = { type: 'null' }; break;
      case 'any': case 'unknown': s = {}; break;
      case 'literal': s = { const: argv(0) }; break;
      case 'enum': s = Array.isArray(argv(0)) ? { type: 'string', enum: argv(0) } : (exact = false, { type: 'string' }); break;
      case 'nativeEnum': s = {}; exact = false; break;
      case 'array': { const it = argv(0); s = { type: 'array', items: it && it !== SKIP ? it : {} }; if (!it || it === SKIP || base.args[0].exact === false) exact = false; break; }
      case 'object': case 'strictObject': case 'looseObject': { const sh = argv(0); const r = shapeToSchema(sh && sh !== SKIP ? sh : {}, base.args[0] ? base.args[0].optionalKeys : null, ctx && ctx.fl); if (base.name === 'strictObject') r.schema.additionalProperties = false; s = r.schema; if (!sh || sh === SKIP || base.args[0].exact === false) exact = false; break; }
      case 'record': { const v = base.args.length > 1 ? argv(1) : argv(0); s = { type: 'object', additionalProperties: v && v !== SKIP ? v : {} }; if (ctx && ctx.fl && ctx.fl.zod >= 4) { const kk = base.args.length > 1 ? argv(0) : { type: 'string' }; s = { type: 'object', propertyNames: kk && kk !== SKIP ? kk : { type: 'string' }, additionalProperties: s.additionalProperties }; } break; }
      case 'union': {
        const a = argv(0);
        if (!Array.isArray(a)) { s = {}; exact = false; } else if (!zod3) s = { anyOf: a };
        else { const u = zod3Union(a); s = u.schema; if (!u.exact) exact = false; }
        break;
      }
      case 'url': s = { type: 'string', format: 'uri' }; break;
      case 'email': s = { type: 'string', format: 'email' }; break;
      case 'uuid': s = { type: 'string', format: 'uuid' }; break;
      default: exact = false;
    }
    for (const c of calls.slice(1)) {
      const a0 = c.args[0] ? c.args[0].value : undefined;
      switch (c.name) {
        case 'describe': if (typeof a0 === 'string') s.description = a0; else exact = false; break;
        case 'optional': case 'nullish': optional = true; wrapAs('optional'); break;
        case 'nullable': { const n = nullableOf(withIntBounds(s, fl), zod3, wrap); s = n.schema; if (!n.exact) exact = false; wrap = null; break; }
        case 'default': optional = true; wrapAs('wrapped'); if (a0 !== SKIP && a0 !== undefined) s.default = a0; break;
        case 'int': s.type = 'integer'; break;
        case 'min': if (typeof a0 === 'number') s[s.type === 'string' ? 'minLength' : s.type === 'array' ? 'minItems' : 'minimum'] = a0; else exact = false; break;
        case 'max': if (typeof a0 === 'number') s[s.type === 'string' ? 'maxLength' : s.type === 'array' ? 'maxItems' : 'maximum'] = a0; else exact = false; break;
        case 'length': if (typeof a0 === 'number') { s[s.type === 'array' ? 'minItems' : 'minLength'] = a0; s[s.type === 'array' ? 'maxItems' : 'maxLength'] = a0; } else exact = false; break;
        case 'positive': s.exclusiveMinimum = 0; break;
        case 'nonnegative': s.minimum = 0; break;
        case 'url': s.format = 'uri'; break;
        case 'email': s.format = 'email'; break;
        case 'uuid': s.format = 'uuid'; break;
        case 'datetime': s.format = 'date-time'; break;
        case 'regex': { // JSON Schema pattern: the RegExp's source, as zod 4 and zod-to-json-schema write it (flags are not
          // carried). A second .regex() moves both into allOf, and a pattern the reader cannot read is left out.
          const src = a0 && typeof a0 === 'object' && typeof a0.regexLiteral === 'string' ? regexSource(a0.regexLiteral) : null;
          if (src === null || s.pattern !== undefined || calls.filter((d) => d.name === 'regex').length > 1) { delete s.pattern; exact = false; } else s.pattern = src;
          break;
        }
        case 'refine': case 'superRefine': case 'transform': case 'brand': case 'readonly': case 'catch': case 'pipe': wrapAs('wrapped'); break;
        case 'array': s = { type: 'array', items: s }; wrap = null; break;
        case 'strict': s.additionalProperties = false; break;
        case 'passthrough': case 'catchall': delete s.additionalProperties; break;
        case 'meta': if (a0 && typeof a0 === 'object' && typeof a0.description === 'string') s.description = a0.description; break;
        case 'trim': case 'toLowerCase': case 'toUpperCase': case 'finite': case 'safe': case 'nonempty':
          if (c.name === 'nonempty') s[s.type === 'array' ? 'minItems' : 'minLength'] = 1;
          wrapAs('wrapped'); // a check the JSON Schema does not show: the option is no longer a bare primitive to zod-to-json-schema
          break;
        default: exact = false;
      }
    }
    s = withIntBounds(s, fl);
    if (fl && fl.compactUnions) compactTypeUnion(s);
    if (wrap && s && typeof s === 'object') WRAPPED_OF.set(s, wrap);
    return { schema: s, exact, optional };
  }
  function withIntBounds(s, fl) {
    if (fl && fl.intBounds && s.type === 'integer') { // zod 4 gives an integer the safe-integer range unless the schema narrows it
      if (s.minimum === undefined && s.exclusiveMinimum === undefined) s.minimum = -SAFE_INT;
      if (s.maximum === undefined && s.exclusiveMaximum === undefined) s.maximum = SAFE_INT;
    }
    return s;
  }
  // How the SDK's converters write unions and .nullable() (checked against SDK 1.29 and 1.32 with zod 3.25.76,
  // 4.3.6 and 4.6.7):
  //   zod 3 (zod-to-json-schema): a union whose options are all bare string/number/boolean/null schemas (no checks;
  //     a description of an option is dropped) is a type, or a type array; .nullable() of such a bare schema is a
  //     type array with "null", and of anything else anyOf [schema, {type: null}], the description repeated outside.
  //   zod 4: .nullable() is always anyOf [schema, {type: null}]; from 4.5.0 an anyOf of bare types becomes a type array.
  //   A schema whose JSON Schema looks bare but that zod wraps (.optional(), .refine(), .transform(), .default(), …) or
  //   that carries a check the JSON Schema does not show (.trim()) is not a primitive to zod-to-json-schema: a union
  //   with such an option, and .nullable() of it, are anyOf. An .optional()/.nullish() option is written there as
  //   anyOf [{not: {}}, schema] by zod-to-json-schema, a form the reader does not build, so that union is inexact.
  const ZOD3_PRIMITIVE = new Set(['string', 'number', 'boolean', 'null']);
  // schema object -> 'wrapped' | 'optional': set by zodToSchema for a chain with a wrapper or a hidden check.
  const WRAPPED_OF = new WeakMap();
  const wrappedOf = (o) => (o && typeof o === 'object' ? WRAPPED_OF.get(o) || null : null);
  const bareZod3 = (o, withDescription) => !!o && typeof o === 'object' && !WRAPPED_OF.has(o) && typeof o.type === 'string' && ZOD3_PRIMITIVE.has(o.type) && Object.keys(o).every((k) => k === 'type' || (withDescription && k === 'description'));
  function zod3Union(options) {
    const exact = !options.some((o) => wrappedOf(o) === 'optional');
    if (!options.length || !options.every((o) => bareZod3(o, true))) return { schema: { anyOf: options }, exact };
    const types = []; options.forEach((o) => { if (!types.includes(o.type)) types.push(o.type); });
    return { schema: { type: types.length === 1 ? types[0] : types }, exact };
  }
  function nullableOf(s, zod3, wrap) {
    if (zod3 && !wrap && bareZod3(s, true)) return { schema: Object.assign({}, s, { type: [s.type, 'null'] }), exact: true };
    const out = { anyOf: [s, { type: 'null' }] };
    if (zod3 && typeof s.description === 'string') out.description = s.description;
    return { schema: out, exact: !(zod3 && wrap === 'optional') };
  }
  // zod 4.5+'s compactTypeUnion: anyOf of options that are only { type } (nested ones first) -> type (array).
  function compactTypeUnion(schema) {
    const options = schema.anyOf;
    if (!Array.isArray(options) || !options.length || schema.type !== undefined) return;
    const types = [];
    for (const o of options) {
      if (!o || typeof o !== 'object') return;
      compactTypeUnion(o);
      const keys = Object.keys(o); if (keys.length !== 1 || keys[0] !== 'type') return;
      for (const m of [].concat(o.type)) { if (typeof m !== 'string') return; if (!types.includes(m)) types.push(m); }
    }
    delete schema.anyOf;
    schema.type = types.length === 1 ? types[0] : types;
  }
  // The source of a regular expression literal (/^[a-z]+$/i -> ^[a-z]+$), as RegExp.prototype.source gives it; null when
  // the literal is not one the engine accepts.
  function regexSource(lit) {
    const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(lit); if (!m) return null;
    try { return new RegExp(m[1], m[2]).source; } catch (e) { return null; }
  }
  // A zod raw shape { a: z.string(), b: z.number().optional() } -> object schema the way the TS SDK emits it.
  // What the TS SDK lists for a zod schema depends on the SDK major and the zod major (see tsFlavour):
  //   SDK 1.x + zod 3 (zod-to-json-schema): draft-07, objects closed (additionalProperties: false).
  //   zod 4 (z.toJSONSchema, input mode):    objects open, integers carry the safe-integer bounds; draft-07 under SDK 1.x, 2020-12 under SDK 2.x.
  const SAFE_INT = 9007199254740991;
  const DIALECT = { 'draft-07': 'http://json-schema.org/draft-07/schema#', '2020-12': 'https://json-schema.org/draft/2020-12/schema' };
  const FL_DEFAULT = { dialect: 'draft-07', closed: true, intBounds: false, execution: false, kind: null };
  function shapeToSchema(shape, optionalKeys, fl) {
    const props = {}; const required = [];
    Object.keys(shape || {}).forEach((k) => {
      const v = shape[k];
      props[k] = v; if (!(optionalKeys && optionalKeys.has(k))) required.push(k);
    });
    const s = { type: 'object', properties: props };
    if (required.length) s.required = required;
    if (!fl || fl.closed) s.additionalProperties = false;
    return { schema: s };
  }
  // The root schema of a raw shape or a zod object.
  // The optional keys of every object literal read (z.x().optional() values), kept with the object itself, so a raw
  // shape reached through a constant (const CFG = { inputSchema: { a: z.string().optional() } }) keeps them (R-RD-16).
  const OPTIONAL_OF = new WeakMap();
  function rootSchema(props, optionalKeys, fl) {
    if (!optionalKeys && props && typeof props === 'object') optionalKeys = OPTIONAL_OF.get(props);
    const f = fl || FL_DEFAULT;
    const shaped = { type: 'object', properties: props };
    const req = Object.keys(props).filter((k) => !(optionalKeys && optionalKeys.has(k))); if (req.length) shaped.required = req;
    if (f.closed && !(f.emptyShapeOpen && !Object.keys(props).length)) shaped.additionalProperties = false;
    if (DIALECT[f.dialect]) shaped.$schema = DIALECT[f.dialect];
    return shaped;
  }

  // ------------------------------------------------------------ modules: what each JS/TS file imports and exports
  // Static imports and exports of one file, read from its tokens (no evaluation):
  //   imports: [{ local, imported: 'default' | '*' | name, spec }]
  //   exports: { names: Map(exported -> local name | { spec, imported }), defaultLocal, defaultAt (token index), stars: [spec] }
  function jsModule(t) {
    const imports = []; const names = new Map(); const stars = []; let defaultLocal = null; let defaultAt = -1;
    const specAt = (k) => (t[k] && t[k].type === 'id' && t[k].value === 'from' && t[k + 1] && t[k + 1].type === 'str' ? t[k + 1].value : null);
    const braceList = (k) => { // { a, b as c, type d } -> [[a, a], [b, c]], end
      const out = []; const close = matchClose(t, k); let m = k + 1;
      while (m < close) {
        if (t[m].type === 'id' && t[m].value === 'type' && t[m + 1] && (t[m + 1].type === 'id' || t[m + 1].type === 'str') && !isP(t[m + 1], ',')) m++;
        const a = t[m]; if (!a || !(a.type === 'id' || a.type === 'str')) break;
        let b = a.value; let n = m + 1;
        if (t[n] && t[n].type === 'id' && t[n].value === 'as' && t[n + 1]) { b = t[n + 1].value; n += 2; }
        out.push([String(a.value), String(b)]); m = isP(t[n], ',') ? n + 1 : n;
        if (!isP(t[n], ',')) break;
      }
      return { list: out, end: close + 1 };
    };
    for (let i = 0; i < t.length; i++) {
      const x = t[i]; if (x.type !== 'id' || isP(t[i - 1], '.')) continue;
      if (x.value === 'import' && !isP(t[i + 1], '(') && !isP(t[i + 1], '.')) {
        let k = i + 1; if (t[k] && t[k].type === 'id' && t[k].value === 'type') k++;
        if (t[k] && t[k].type === 'str') continue; // import 'side-effect'
        const local = [];
        if (t[k] && t[k].type === 'id' && t[k].value !== 'from') { local.push(['default', t[k].value]); k++; if (isP(t[k], ',')) k++; }
        if (isP(t[k], '*') && t[k + 1] && t[k + 1].value === 'as' && t[k + 2]) { local.push(['*', t[k + 2].value]); k += 3; }
        else if (isP(t[k], '{')) { const b = braceList(k); b.list.forEach(([a, c]) => local.push([a, c])); k = b.end; }
        const spec = specAt(k); if (!spec) continue;
        local.forEach(([imported, l]) => imports.push({ local: l, imported, spec }));
      } else if (x.value === 'export') {
        let k = i + 1;
        if (t[k] && t[k].type === 'id' && t[k].value === 'type' && !isP(t[k + 1], '=')) k++;
        const y = t[k]; if (!y) continue;
        if (y.type === 'id' && y.value === 'default') {
          const z = t[k + 1];
          if (z && z.type === 'id' && !/^(function|class|async|new|await)$/.test(z.value) && (isP(t[k + 2], ';') || !t[k + 2] || t[k + 2].nl || isP(t[k + 2], '}'))) defaultLocal = z.value;
          else if (z && z.type === 'id' && (z.value === 'function' || z.value === 'class') && t[k + 2] && t[k + 2].type === 'id') defaultLocal = t[k + 2].value;
          else defaultAt = k + 1;
        } else if (y.type === 'id' && /^(const|let|var|function|class|enum|abstract|async|declare)$/.test(y.value)) {
          let m = k; while (t[m] && t[m].type === 'id' && /^(abstract|async|declare)$/.test(t[m].value)) m++;
          if (t[m] && t[m].type === 'id' && t[m].value === 'function' && isP(t[m + 1], '*')) m++;
          const nm = t[m + 1]; if (nm && nm.type === 'id') names.set(nm.value, nm.value);
        } else if (isP(y, '*')) {
          if (t[k + 1] && t[k + 1].value === 'as' && t[k + 2]) { const spec = specAt(k + 3); if (spec) names.set(t[k + 2].value, { spec, imported: '*' }); }
          else { const spec = specAt(k + 1); if (spec) stars.push(spec); }
        } else if (isP(y, '{')) {
          const b = braceList(k); const spec = specAt(b.end);
          b.list.forEach(([a, c]) => names.set(c, spec ? { spec, imported: a } : a));
        }
      }
    }
    return { imports, exports: { names, defaultLocal, defaultAt, stars } };
  }
  const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
  function normPath(p) { const out = []; p.split('/').forEach((s) => { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }); return out.join('/'); }
  // The file an import specifier names, among `paths` (a Set). Relative specifiers, and path aliases that name a folder of
  // the repository (~/x, @/x, #x, src/x, @scope/pkg/sub/path) found by their unique path suffix. Packages are not followed.
  function resolveSpec(from, spec, paths, suffixIndex) {
    const tryBase = (base) => {
      const stem = base.replace(/\.(m|c)?[jt]sx?$/, '');
      const cands = [base].concat(JS_EXT.map((e) => stem + e)).concat(JS_EXT.map((e) => stem + '/index' + e));
      return cands.find((c) => paths.has(c)) || null;
    };
    if (spec.startsWith('.')) return tryBase(normPath((from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '') + spec));
    let rest = null;
    const m = /^(?:~|@|#|\$lib|@src)\/(.+)$/.exec(spec) || /^#(.+)$/.exec(spec);
    if (m) rest = m[1];
    else if (/^src\//.test(spec)) rest = spec;
    else { const s = /^@[\w.-]+\/([\w.-]+\/.+)$/.exec(spec); if (s) rest = s[1]; }
    if (!rest) return null;
    const stem = normPath(rest).replace(/\.(m|c)?[jt]sx?$/, '');
    if (stem.split('/').length < 2 && !m) return null;
    const hits = new Set();
    [stem].concat(JS_EXT.map((e) => stem + e), JS_EXT.map((e) => stem + '/index' + e)).forEach((c) => (suffixIndex(c) || []).forEach((p) => hits.add(p)));
    return hits.size === 1 ? Array.from(hits)[0] : null;
  }
  // A top-level constant of a file that nothing in that file changes: declared once, with const, and every other use a
  // read (no assignment, ++/--, delete, push/splice/set/… on it or a member, not handed to a call other than
  // Object.entries / keys / values / freeze, and not copied into another variable by `= NAME`). Used for a registry
  // another module imports (R-RD-33), together with importersReadOnly for the modules that import it.
  const FROZEN_MUTATORS = /^(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|delete|clear|add)$/;
  // Whether the use of a name whose tokens run from k0 to k (NAME, or ns . NAME for a namespace import) may change it.
  function useMayChange(t, k0, k) {
    const pv = t[k0 - 1];
    if (pv && ((pv.type === 'id' && pv.value === 'delete') || isP(pv, '++') || isP(pv, '--'))) return true;
    let m = k + 1;
    for (let n = 0; n < 64; n++) {
      if ((isP(t[m], '.') || isP(t[m], '?.')) && t[m + 1] && t[m + 1].type === 'id') { if (FROZEN_MUTATORS.test(t[m + 1].value) && isP(t[m + 2], '(')) return true; m += 2; }
      else if (isP(t[m], '[')) m = matchClose(t, m) + 1;
      else break;
    }
    if (isP(t[m], '=') || isP(t[m], '++') || isP(t[m], '--') || (t[m] && t[m].type === 'p' && /^([-+*/%|&^]|\?\?|\|\||&&|\*\*|<<|>>)$/.test(t[m].value) && isP(t[m + 1], '='))) return true;
    if (m === k + 1 && isP(pv, '=')) return true; // const list = NAME: an alias the reader does not follow
    if (m === k + 1 && (isP(pv, '(') || isP(pv, ',') || isP(pv, '...'))) {
      // an argument: only Object.entries / keys / values / freeze(NAME) read it
      let o = k0 - 1; let d = 0; for (; o >= 0; o--) { if (isP(t[o], ')') || isP(t[o], ']') || isP(t[o], '}')) d++; else if (isP(t[o], '(') || isP(t[o], '[') || isP(t[o], '{')) { if (!d) break; d--; } }
      if (o >= 0 && isP(t[o], '(') && t[o - 1] && t[o - 1].type === 'id' && !(/^(entries|keys|values|freeze)$/.test(t[o - 1].value) && isP(t[o - 2], '.') && t[o - 3] && t[o - 3].value === 'Object') && !/^(if|while|switch|return|for)$/.test(t[o - 1].value)) return true;
    }
    return false;
  }
  function constFrozenIn(t, name) {
    let decls = 0;
    for (let k = 0; k < t.length; k++) {
      const x = t[k]; if (x.type !== 'id' || x.value !== name || isP(t[k - 1], '.') || isP(t[k - 1], '?.')) continue;
      const pv = t[k - 1];
      if (pv && pv.type === 'id' && /^(const|let|var|function|class)$/.test(pv.value)) { decls++; if (pv.value !== 'const') return false; continue; }
      if (isP(t[k + 1], ':') && (isP(pv, '{') || isP(pv, ','))) continue; // a key of an object literal
      if (useMayChange(t, k, k)) return false;
    }
    return decls === 1;
  }
  // Whether a module that imports the constant uses it only to read it: `locals` are the names it is bound to there
  // (import { TOOLS as T }), `namespaces` the names of namespace imports of a module that exports it (ns.TOOLS). A
  // declaration of the same name, or a namespace used other than as ns.member, counts as a change (not followed).
  function importerReadOnly(t, locals, namespaces, name) {
    for (let k = 0; k < t.length; k++) {
      const x = t[k]; if (x.type !== 'id' || isP(t[k - 1], '.') || isP(t[k - 1], '?.')) continue;
      const pv = t[k - 1]; const declared = pv && pv.type === 'id' && /^(const|let|var|function|class)$/.test(pv.value);
      if (locals.has(x.value)) {
        if (isP(t[k + 1], ':') && (isP(pv, '{') || isP(pv, ','))) continue;
        if (pv && pv.type === 'id' && (pv.value === 'import' || pv.value === 'as' || pv.value === 'type')) continue;
        if (isP(pv, '{') || isP(pv, ',')) { // inside the import's own braces
          let o = k - 1; while (o >= 0 && !isP(t[o], '{') && !isP(t[o], ';')) o--;
          if (o >= 0 && isP(t[o], '{') && t[o - 1] && t[o - 1].type === 'id' && t[o - 1].value === 'import') continue;
        }
        if (declared || useMayChange(t, k, k)) return false;
      } else if (namespaces.has(x.value)) {
        if (pv && pv.type === 'id' && pv.value === 'as') continue; // import * as ns
        if (declared) return false;
        if ((isP(t[k + 1], '.') || isP(t[k + 1], '?.')) && t[k + 2] && t[k + 2].type === 'id') { if (t[k + 2].value === name && useMayChange(t, k, k + 2)) return false; continue; }
        return false; // the namespace object itself handed on
      }
    }
    return true;
  }
  // Constants each file sees: its own, the ones it imports (followed through re-exports), and for imported names that
  // cannot be followed, a constant of that name defined once in the repository (globals).
  function moduleConsts(files, globals, sdk) {
    const text = new Map(files.filter(([p]) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(p)));
    const paths = new Set(text.keys());
    const tokCache = new Map(); const modCache = new Map(); const memo = new Map(); const busy = new Set();
    const toks = (p) => { if (!tokCache.has(p)) { let t = []; try { t = tokenize(text.get(p)); } catch (e) { t = []; } tokCache.set(p, t); } return tokCache.get(p); };
    const mod = (p) => { if (!modCache.has(p)) { let m; try { m = jsModule(toks(p)); } catch (e) { m = { imports: [], exports: { names: new Map(), defaultLocal: null, defaultAt: -1, stars: [] } }; } modCache.set(p, m); } return modCache.get(p); };
    let suffix = null;
    const suffixIndex = (c) => {
      if (!suffix) { suffix = new Map(); paths.forEach((p) => { const seg = p.split('/'); for (let k = 0; k < seg.length; k++) { const key = seg.slice(k).join('/'); if (!suffix.has(key)) suffix.set(key, []); suffix.get(key).push(p); } }); }
      return suffix.get(c);
    };
    const ctxOf = (p) => { const src = text.get(p); const zn = zodNamesIn(src); return { zodNames: zn, zod: zn.size > 0, fl: tsFlavour(src, typeof sdk === 'function' ? sdk(p) : sdk) }; };
    const exportValue = (p, name, depth) => {
      if (!p || depth > 6) return null;
      const ex = mod(p).exports;
      if (name === 'default') {
        if (ex.defaultLocal) { const tb = tableFor(p, depth + 1); return tb && hasOwn(tb, ex.defaultLocal) ? tb[ex.defaultLocal] : null; }
        if (ex.defaultAt >= 0) { const tb = tableFor(p, depth + 1); const v = parseValue(toks(p), ex.defaultAt, Object.assign(ctxOf(p), { consts: tb || {} })); return v.value !== SKIP ? { value: v.value, exact: v.exact, zod: !!v.zod, optional: !!v.optional, optionalKeys: v.optionalKeys || null } : null; }
        return null;
      }
      const e = ex.names.get(name);
      if (typeof e === 'string') { const tb = tableFor(p, depth + 1); return tb && hasOwn(tb, e) ? tb[e] : null; }
      if (e && e.imported === '*') return namespace(resolveSpec(p, e.spec, paths, suffixIndex), depth + 1);
      if (e) return exportValue(resolveSpec(p, e.spec, paths, suffixIndex), e.imported, depth + 1);
      for (const s of ex.stars) { const r = exportValue(resolveSpec(p, s, paths, suffixIndex), name, depth + 1); if (r) return r; }
      return null;
    };
    const namespace = (p, depth) => {
      if (!p || depth > 6) return null;
      const o = {}; mod(p).exports.names.forEach((_, k) => { const r = exportValue(p, k, depth + 1); if (r && r.value !== undefined) o[k] = r.value; });
      return Object.keys(o).length ? { value: o, exact: true, zod: false } : null;
    };
    // The constants token-level parsing sees in file p (its imports and the fallback globals), and the file's own.
    const seedFor = (p, depth) => {
      const seed = {};
      Object.keys(globals || {}).forEach((k) => { const g = globals[k]; if (g.value && typeof g.value === 'object') seed[k] = g; });
      mod(p).imports.forEach((imp) => {
        const target = resolveSpec(p, imp.spec, paths, suffixIndex);
        let v = null;
        if (target) v = imp.imported === '*' ? namespace(target, depth + 1) : exportValue(target, imp.imported, depth + 1);
        if (!v && globals && imp.imported !== '*' && imp.imported !== 'default' && hasOwn(globals, imp.imported)) v = globals[imp.imported];
        if (!v && globals && imp.imported === 'default' && hasOwn(globals, imp.local)) v = globals[imp.local];
        if (v) seed[imp.local] = v; else delete seed[imp.local];
        // a schema factory exported by name from the imported file itself (no re-export followed)
        const fx = target && imp.imported !== '*' ? mod(target).exports.names.get(imp.imported) : null;
        const tb = typeof fx === 'string' ? tableFor(target, depth + 1) : null;
        if (tb && hasOwn(tb, FN + fx)) seed[FN + imp.local] = tb[FN + fx]; else delete seed[FN + imp.local];
      });
      return seed;
    };
    function tableFor(p, depth) {
      if (memo.has(p)) return memo.get(p);
      if (busy.has(p) || (depth || 0) > 8 || !text.has(p)) return null;
      busy.add(p);
      let consts = null;
      try { consts = collectConsts(toks(p), Object.assign(ctxOf(p), { globalConsts: seedFor(p, depth || 0) })); } catch (e) { consts = {}; }
      busy.delete(p); memo.set(p, consts);
      return consts;
    }
    // Register helpers a file imports from a module of the repository (R-RD-32): one relative import, to the file that
    // defines the helper (a re-export from a further module is not followed). Map(local name -> spec).
    const wrapMemo = new Map();
    const wrappersOf = (p) => { if (!wrapMemo.has(p)) { let w; try { w = registerWrappers(toks(p)); } catch (e) { w = new Map(); } wrapMemo.set(p, w); } return wrapMemo.get(p); };
    const importedWrappers = (p) => {
      const out = new Map();
      mod(p).imports.forEach((imp) => {
        if (!imp.spec.startsWith('.') || imp.imported === '*') return;
        const target = resolveSpec(p, imp.spec, paths, suffixIndex); if (!target || target === p) return;
        const ex = mod(target).exports;
        const local = imp.imported === 'default' ? ex.defaultLocal : ex.names.get(imp.imported);
        if (typeof local !== 'string') return;
        const w = wrappersOf(target).get(local); if (w) out.set(imp.local, w);
      });
      return out;
    };
    // Whether a name file p imports (one relative import, from the file that declares it) is a constant nothing changes
    // (R-RD-33), so a registry there can be unrolled where it is iterated: the declaring file only reads it after its
    // one const declaration, and so does every file of the repository that imports it, by any name, directly or
    // through re-exports. A file that loads the declaring module some other way (require, import()) makes it unknown.
    // Asked only where a loop needs it, and kept per (declaring file, name).
    const frozenMemo = new Map();
    const frozenImport = (p, localName) => {
      const imp = mod(p).imports.find((x) => x.local === localName);
      if (!imp || !imp.spec.startsWith('.') || imp.imported === '*' || imp.imported === 'default') return false;
      const target = resolveSpec(p, imp.spec, paths, suffixIndex); if (!target || target === p) return false;
      const local = mod(target).exports.names.get(imp.imported);
      if (typeof local !== 'string') return false;
      const key = target + '\u0000' + local;
      if (!frozenMemo.has(key)) { let r = false; try { r = constFrozenIn(toks(target), local) && importersReadOnly(target, local); } catch (e) { r = false; } frozenMemo.set(key, r); }
      return frozenMemo.get(key);
    };
    // Every other file that imports `local` of `target` (followed through re-exports) uses it only to read it.
    const importersReadOnly = (target, local) => {
      // the (file, exported name) pairs that stand for the constant: its own exports, then re-exports of them
      const alias = new Set(); const key = (f, n) => f + '\u0000' + n;
      mod(target).exports.names.forEach((v, k) => { if (v === local) alias.add(key(target, k)); });
      if (mod(target).exports.defaultLocal === local) alias.add(key(target, 'default'));
      const nsOf = new Set([target]); // files whose namespace object holds the constant as a member
      const files = Array.from(paths);
      for (let round = 0, grew = true; grew && round < 8; round++) {
        grew = false;
        for (const q of files) {
          const ex = mod(q).exports;
          // import { TOOLS } from './registry'; export { TOOLS as LIST } / export default TOOLS: q passes it on too
          const imported = (n) => { const imp = mod(q).imports.find((x) => x.local === n && x.imported !== '*'); const f = imp && resolveSpec(q, imp.spec, paths, suffixIndex); return !!f && alias.has(key(f, imp.imported)); };
          if (ex.defaultLocal && !alias.has(key(q, 'default')) && imported(ex.defaultLocal)) { alias.add(key(q, 'default')); grew = true; }
          ex.names.forEach((v, k) => {
            if (typeof v === 'string') { if (!alias.has(key(q, k)) && imported(v)) { alias.add(key(q, k)); grew = true; } return; }
            if (!v || alias.has(key(q, k))) return;
            const f = resolveSpec(q, v.spec, paths, suffixIndex); if (!f) return;
            if (v.imported === '*' ? nsOf.has(f) : alias.has(key(f, v.imported))) { if (v.imported === '*') nsOf.add(q); alias.add(key(q, k)); grew = true; }
          });
          ex.stars.forEach((sp) => {
            const f = resolveSpec(q, sp, paths, suffixIndex); if (!f) return;
            alias.forEach((a) => { const [af, an] = a.split('\u0000'); if (af === f && an !== 'default' && !alias.has(key(q, an))) { alias.add(key(q, an)); nsOf.add(q); grew = true; } });
          });
        }
      }
      const holders = new Set(Array.from(alias).map((a) => a.split('\u0000')[0]));
      for (const q of files) {
        if (q === target) continue;
        const locals = new Set(); const namespaces = new Set(); let loads = false;
        mod(q).imports.forEach((imp) => {
          const f = resolveSpec(q, imp.spec, paths, suffixIndex); if (!f) return;
          if (imp.imported === '*') { if (nsOf.has(f) || holders.has(f)) namespaces.add(imp.local); }
          else if (alias.has(key(f, imp.imported))) locals.add(imp.local);
          // a re-exported namespace (export * as reg from './registry') imported by name: ns.TOOLS through it
          else { const e = mod(f).exports.names.get(imp.imported); if (e && typeof e === 'object' && e.imported === '*') { const g = resolveSpec(f, e.spec, paths, suffixIndex); if (g && (nsOf.has(g) || holders.has(g))) namespaces.add(imp.local); } }
        });
        // a CommonJS require or a dynamic import of a file that holds it: not followed
        const t = toks(q);
        for (let k = 0; k + 2 < t.length && !loads; k++) {
          if (t[k].type === 'id' && (t[k].value === 'require' || t[k].value === 'import') && isP(t[k + 1], '(') && t[k + 2].type === 'str' && !isP(t[k - 1], '.')) {
            const f = resolveSpec(q, t[k + 2].value, paths, suffixIndex); if (f && holders.has(f)) loads = true;
          }
        }
        if (loads) return false;
        if ((locals.size || namespaces.size) && !importerReadOnly(t, locals, namespaces, local)) return false;
      }
      return true;
    };
    return { seedFor: (p) => seedFor(p, 0), tokens: toks, tableFor: (p) => tableFor(p, 0), module: mod, importedWrappers, frozenImport };
  }

  // ------------------------------------------------------------ JS/TS extraction
  function zodNamesIn(src) {
    const names = new Set();
    const re = /import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"]zod(?:\/v[34])?['"]/g; let m;
    while ((m = re.exec(src))) {
      if (m[1]) m[1].split(',').forEach((p) => { const q = asParts(p); if (q[0] === 'z' || q[0] === 'zod') names.add((q[1] || q[0]).trim()); });
      if (m[2]) names.add(m[2]); if (m[3]) names.add(m[3]);
    }
    if (/require\(['"]zod['"]\)/.test(src) || /\bz\.object\s*\(/.test(src)) names.add('z');
    // compiled CommonJS (tsc): `const zod_1 = require` of zod, then zod_1.z.string(). Kept as "zod_1." (the namespace whose .z is zod).
    { const re3 = /\b(?:const|var|let)\s+([\w$]+)\s*=\s*(?:__importStar\()?require\(['"]zod(?:\/v[34])?['"]\)/g; let m3; while ((m3 = re3.exec(src))) names.add(m3[1] + '.'); }
    // zod re-exported by a module of the repository (import { zod } from '../lib/schema.js'): a binding named
    // z or zod that is used as zod.
    const re2 = /import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"][^'"]+['"]/g;
    while ((m = re2.exec(src))) {
      const bind = []; if (m[1]) m[1].split(',').forEach((p) => { const q = asParts(p.trim().replace(/^type\s+/, '')); if (q[0]) bind.push([q[0].trim(), (q[1] || q[0]).trim()]); });
      if (m[2]) bind.push([m[2], m[2]]); if (m[3]) bind.push([m[3], m[3]]);
      bind.forEach(([orig, local]) => { if (/^(z|zod)$/i.test(orig) && /^[\w$]+$/.test(local) && new RegExp('\\b' + local.replace(/\$/g, '\\$') + '\\.(object|string|number|boolean|enum|array|union|literal)\\s*\\(').test(src)) names.add(local); });
    }
    return names;
  }

  // Top-level `const NAME = <literal>` (strings and literal objects) so { description: DESC } resolves.
  // Brace/paren depth before token i: top-level constants only (a const inside a function body is not shared).
  function depthAt(t, i) { let d = 0; for (let k = 0; k < i; k++) { const v = t[k].type === 'p' ? t[k].value : null; if (v === '{' || v === '(' || v === '[') d++; else if (v === '}' || v === ')' || v === ']') d--; } return d; }
  // const / let / var NAME = <value> (any depth; `top` says whether it is at the top level of the file), and TypeScript
  // enums with literal members (enum Tools { SEARCH = 'search' }) as objects. Later definitions of a name win.
  function collectConsts(t, ctx) {
    const consts = Object.assign({}, ctx.globalConsts || {});
    let d = 0;
    for (let i = 0; i < t.length - 3; i++) {
      const tk = t[i];
      if (tk.type === 'p') { if (tk.value === '{' || tk.value === '(' || tk.value === '[') d++; else if (tk.value === '}' || tk.value === ')' || tk.value === ']') d--; continue; }
      if (tk.type !== 'id') continue;
      if ((tk.value === 'const' || tk.value === 'let' || tk.value === 'var') && t[i + 1].type === 'id' && !isP(t[i - 1], '.')) {
        let j = i + 2;
        if (isP(t[j], ':')) j = skipAnnotation(t, j + 1); // const fooTool: ToolDefinition<typeof P> = { … } (R-RD-33)
        if (!isP(t[j], '=')) continue;
        let v; let lost = [];
        try { [v, lost] = collecting(() => parseValue(t, j + 1, Object.assign({}, ctx, { consts }))); } catch (e) { v = { value: SKIP }; }
        if (v.value === SKIP && t[j + 1] && t[j + 1].type === 'id') {
          // const toolId = toolName || "web_search": the literal default
          const ch = idChain(t, j + 1);
          if ((isP(t[ch.end], '||') || isP(t[ch.end], '??')) && t[ch.end + 1] && t[ch.end + 1].type === 'str' && (isP(t[ch.end + 2], ';') || isP(t[ch.end + 2], ',') || (t[ch.end + 2] && t[ch.end + 2].nl) || !t[ch.end + 2])) v = { value: t[ch.end + 1].value, exact: false, fallback: true };
        }
        if (v.value === SKIP && d === 0) { const f = fnAt(t, j + 1, ctx, consts, false); if (f) { consts[FN + t[i + 1].value] = f; continue; } }
        if (v.value !== SKIP) consts[t[i + 1].value] = { value: v.value, exact: v.exact, optional: !!v.optional, zod: !!v.zod, optionalKeys: v.optionalKeys || null, top: d === 0 && !v.fallback, partial: !!v.partial, lost: lost.length ? lost : null, holes: (v.holes || 0) + (v.unknownKeys ? v.unknownKeys.size : 0) + (v.spreadUnknown ? 1 : 0), decl: tk.value };
      } else if (tk.value === 'function' && d === 0 && t[i + 1].type === 'id' && isP(t[i + 2], '(') && !isP(t[i - 1], '.') && !(t[i - 1] && t[i - 1].value === 'async')) {
        const f = fnAt(t, i + 2, ctx, consts, true); if (f) consts[FN + t[i + 1].value] = f;
      } else if (tk.value === 'enum' && t[i + 1].type === 'id' && isP(t[i + 2], '{')) {
        const close = matchClose(t, i + 2); const o = {}; let k = i + 3; let n = 0;
        while (k < close) {
          const key = t[k]; if (!key || !(key.type === 'id' || key.type === 'str')) break;
          if (isP(t[k + 1], '=')) { const v = parseValue(t, k + 2, Object.assign({}, ctx, { consts })); if (v.value !== SKIP) o[key.value] = v.value; k = v.end; } else { o[key.value] = n; k++; }
          n++; if (isP(t[k], ',')) k++; else break;
        }
        consts[t[i + 1].value] = { value: o, exact: true, optional: false, zod: false, optionalKeys: null, top: d === 0 };
      }
    }
    return consts;
  }

  function zodShapeAt(t, i, ctx) {
    // a raw shape object whose values are zod: returns schema with required list, or z.object(...)
    if (isP(t[i], '{')) {
      const optionalKeys = new Set(); const props = {}; let exact = true; let j = i + 1;
      while (j < t.length && !isP(t[j], '}')) {
        if (isP(t[j], '...')) { // {...SHARED, a: z.string()}
          const nx = t[j + 1]; let c = nx && nx.type === 'id' && ctx.consts && Object.prototype.hasOwnProperty.call(ctx.consts, nx.value) ? ctx.consts[nx.value] : null;
          const sp = c ? null : spreadExpr(t, j + 1, ctx); // ...rangeArgs('Defaults to today.'), ...Object.fromEntries(…)
          if (sp && (isP(t[sp.end], ',') || isP(t[sp.end], '}'))) { Object.assign(props, sp.value); exact = exact && sp.exact !== false; if (sp.optionalKeys) sp.optionalKeys.forEach((x) => optionalKeys.add(x)); j = isP(t[sp.end], ',') ? sp.end + 1 : sp.end; continue; }
          if (c && !c.zod && c.value && typeof c.value === 'object' && !Array.isArray(c.value) && (isP(t[j + 2], ',') || isP(t[j + 2], '}'))) { Object.assign(props, c.value); exact = exact && c.exact !== false; if (c.optionalKeys) c.optionalKeys.forEach((x) => optionalKeys.add(x)); j += isP(t[j + 2], ',') ? 3 : 2; continue; }
          exact = false; j = skipExpr(t, j + 1); if (isP(t[j], ',')) j++; continue;
        }
        const k = t[j]; if (!(k.type === 'id' || k.type === 'str') || !isP(t[j + 1], ':')) { exact = false; j = skipExpr(t, j); if (isP(t[j], ',')) j++; continue; }
        const v = parseValue(t, j + 2, ctx);
        if (v.value !== SKIP) { props[k.value] = v.value; if (v.optional) optionalKeys.add(String(k.value)); } else { exact = false; props[k.value] = {}; lose(literalsArr(t, j + 2, v.end)); }
        exact = exact && v.exact !== false; j = v.end; if (isP(t[j], ',')) j++;
      }
      return { schema: rootSchema(props, optionalKeys, ctx.fl), end: j + 1, exact };
    }
    const v = parseValue(t, i, ctx);
    if (v.value === SKIP || !v.value || typeof v.value !== 'object') return { schema: null, end: v.end, exact: false };
    if (v.rawShape) return { schema: rootSchema(v.value, v.optionalKeys, ctx.fl), end: v.end, exact: v.exact };
    if (v.zod && v.value.type === 'object') { const s = Object.assign({}, v.value); const d = DIALECT[(ctx.fl || FL_DEFAULT).dialect]; if (d) s.$schema = d; return { schema: s, end: v.end, exact: v.exact }; }
    return { schema: v.value, end: v.end, exact: v.exact };
  }

  const SDK_CALLS = new Set(['registerTool', 'tool', 'addTool']);
  // Keys that hold a tool's argument schema in hand-rolled tool tables: { name, description, schema: { a: z.string() } }
  const SCHEMA_KEYS = ['inputSchema', 'input_schema', 'parameters', 'schema', 'paramsSchema', 'argsSchema'];
  // The SDK a TypeScript file is written against, from its imports first and the repository's dependencies second
  // (opts.sdk = { kind: 'v1' | 'v2', version, zod }, see detectSdk). Unknown stays at the zod 3 / SDK 1 reading the reader always had.
  //   execution: SDK 1.24 to 1.x adds { taskSupport: 'forbidden' } to every McpServer tool; earlier 1.x and 2.x do not.
  //   customList (sdk.customList, see customListHandler): the server sets its own tools/list handler on the McpServer, so
  //   the $schema the SDK would add is not known and is not written; nor is execution, unless the new handler wraps the
  //   SDK's own (it keeps the SDK's fields and rewrites the schemas) (R-RD-04).
  function semver(v) { const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || '')); return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null; }
  function tsFlavour(src, sdk) {
    sdk = sdk || {};
    let kind = null;
    if (/['"]@modelcontextprotocol\/server(?:\/[^'"]*)?['"]/.test(src)) kind = 'v2';
    else if (/['"]@modelcontextprotocol\/sdk(?:\/[^'"]*)?['"]/.test(src)) kind = 'v1';
    else if (sdk.kind === 'v1' || sdk.kind === 'v2') kind = sdk.kind;
    let zod = /from\s+['"]zod\/v4['"]/.test(src) ? 4 : /from\s+['"]zod\/v3['"]/.test(src) ? 3 : (sdk.zod || null);
    if (!zod) zod = kind === 'v2' ? 4 : 3;
    const v = semver(sdk.version);
    const sameKind = !sdk.kind || sdk.kind === kind;
    const execution = kind === 'v1' && sameKind && !!v && v[0] === 1 && (v[1] >= 24);
    // zod 4.5.0 and later rewrite an anyOf of bare types as a type array (compactTypeUnion in its to-json-schema), for
    // the zod package itself only (zod/v4 inside zod 3.25 has no such pass); the lowest version the dependency allows
    // must have it.
    const zv = semver(sdk.zodVersion);
    const compactUnions = zod >= 4 && !!zv && zv[0] === 4 && zv[1] >= 5;
    // SDK 1.23.0 and later build an empty raw shape ({}) as a zod 4 mini object, which has no additionalProperties
    // whatever zod the server uses (objectFromShape in its zod-compat).
    const emptyShapeOpen = kind === 'v1' && sameKind && !!v && v[0] === 1 && v[1] >= 23;
    if (sdk.customList) return { kind, zod, dialect: null, closed: zod < 4, intBounds: zod >= 4, compactUnions, emptyShapeOpen, execution: sdk.customList === 'wrap' && execution, customList: sdk.customList };
    return { kind, zod, dialect: kind === 'v2' ? '2020-12' : 'draft-07', closed: zod < 4, intBounds: zod >= 4, compactUnions, emptyShapeOpen, execution };
  }
  // A TypeScript or JavaScript file that builds an McpServer and sets its own tools/list handler on it
  // (mcpServer.server.setRequestHandler(ListToolsRequestSchema, …) under SDK 1.x, (…, 'tools/list', …) under 2.x): the
  // server lists its tools its own way, so the reader cannot tell what the SDK would have added to them (R-RD-04).
  // Only the McpServer's own inner server counts (x.server.setRequestHandler, or this.x.server.setRequestHandler for a class
  // that holds the McpServer; this.server.setRequestHandler is how a class holds a low-level Server), in a file that
  // imports McpServer from the SDK. Returns 'wrap' when the new handler calls the SDK's (read from _requestHandlers),
  // which keeps what the SDK adds except what the wrapper rewrites, else 'replace'. Linear in the text: the SDK module
  // specifiers are found first and only the import clause before each one (at most IMPORT_WINDOW characters) is read.
  const IMPORT_WINDOW = 2000;
  const SDK_SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(\s*)['"]@modelcontextprotocol\/(?:sdk|server)(?:\/[^'"\n]*)?['"]/g;
  const LIST_OVERRIDE = /(?:^|[^\w$.])(?:this\s*\.\s*)?(?!this\b)[A-Za-z_$][\w$]*\s*\.\s*server\s*\.\s*setRequestHandler\s*\(\s*(?:[\w$.]*ListToolsRequestSchema\b|['"`]tools\/list['"`])/;
  function importsMcpServer(text) {
    SDK_SPECIFIER.lastIndex = 0; let m;
    while ((m = SDK_SPECIFIER.exec(text))) {
      const win = text.slice(Math.max(0, m.index - IMPORT_WINDOW), m.index);
      // the statement the specifier ends: from the last import / const / let / var keyword (a whole word: not the
      // "const" of "constructor" or the "var" of "variable", R-RD-22)
      const kw = /(?:^|[^\w$])(?:import|const|let|var)(?![\w$])/g; let k = -1; let km;
      while ((km = kw.exec(win))) k = km.index;
      if (k >= 0 && /\bMcpServer\b/.test(win.slice(k))) return true;
    }
    return false;
  }
  function customListHandler(path, text) {
    if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(path) || typeof text !== 'string' || text.indexOf('setRequestHandler') < 0 || text.indexOf('McpServer') < 0) return null;
    if (!LIST_OVERRIDE.test(text) || !importsMcpServer(text)) return null;
    return /\b_requestHandlers\b/.test(text) ? 'wrap' : 'replace';
  }
  // Calls that take a tool: the SDK's (registerTool, tool, addTool) and project helpers named like one (scopedTool,
  // defineTool, createTool, tool). A helper counts only when what it is given looks like a tool (a name and a config
  // with a description, schema, title or annotations).
  const TOOLISH = /^(?:tool|[a-z][\w$]*Tool)$/;
  const CONFIG_KEYS = ['description', 'title', 'annotations', 'outputSchema'].concat(SCHEMA_KEYS);
  // Parameters of the functions around token i (their names are not knowable at a registration inside them).
  // Functions as nested intervals, sorted by start, each with its parent: the functions around a token are found by a
  // binary search and a walk up (at most 64 levels), not by visiting every block.
  function fnIndex(blocks) {
    if (blocks.__fn) return blocks.__fn;
    const fns = blocks.filter((b) => b.kind === 'fn' && b.paramOpen !== undefined).sort((a, b) => a.open - b.open);
    const stack = [];
    fns.forEach((b) => { while (stack.length && stack[stack.length - 1].close < b.open) stack.pop(); b.parentFn = stack.length ? stack[stack.length - 1] : null; stack.push(b); });
    Object.defineProperty(blocks, '__fn', { value: fns, enumerable: false });
    return fns;
  }
  function paramsAround(t, blocks, i) {
    const out = new Set(); const fns = fnIndex(blocks);
    let lo = 0; let hi = fns.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (fns[mid].open <= i) lo = mid + 1; else hi = mid; }
    let b = lo > 0 ? fns[lo - 1] : null; let n = 0;
    while (b && n < 64) {
      if (b.close >= i) { for (let k = b.paramOpen + 1; k < b.paramClose && k < b.paramOpen + 256; k++) if (t[k].type === 'id') out.add(t[k].value); n++; }
      b = b.parentFn;
    }
    return out;
  }
  // A tool name at token j: a string, a constant or a property of one (TOOLS.SEARCH, dataTool.name), a template or
  // "+" of those, or `x || 'name'` / `x ?? 'name'` (the literal default). null when it cannot be known statically;
  // `param` when it is a parameter of the surrounding function (a helper, not a registration).
  function resolveName(t, j, ctx, params) {
    const tok = t[j]; if (!tok) return null;
    const term = (k) => !t[k] || isP(t[k], ',') || isP(t[k], ')') || isP(t[k], '}') || isP(t[k], ']') || isP(t[k], ';');
    if (tok.type === 'id' && params && params.has(tok.value)) {
      // name || 'default'
      const ch = idChain(t, j);
      if ((isP(t[ch.end], '||') || isP(t[ch.end], '??')) && t[ch.end + 1] && t[ch.end + 1].type === 'str' && term(ch.end + 2)) return { name: t[ch.end + 1].value, end: ch.end + 2 };
      return { param: true };
    }
    const s = (tok.type === 'str' || tok.type === 'tpl' || tok.type === 'id') ? stringExpr(t, j, ctx) : null;
    let end = s ? s.end : -1;
    if (s) { while (t[end] && t[end].type === 'id' && (t[end].value === 'as' || t[end].value === 'satisfies')) end = skipType(t, end + 1); }
    if (s && s.exact && term(end)) return { name: s.value, end };
    if (tok.type === 'id') {
      const ch = idChain(t, j);
      if ((isP(t[ch.end], '||') || isP(t[ch.end], '??')) && t[ch.end + 1] && t[ch.end + 1].type === 'str' && term(ch.end + 2)) {
        const v = chainValue(ctx, ch.ids);
        return { name: v && typeof v.value === 'string' ? v.value : t[ch.end + 1].value, end: ch.end + 2 };
      }
    }
    return null;
  }
  function extractJs(src, opts) {
    opts = opts || {};
    const t = opts.tokens || tokenize(src);
    const ctx = { zodNames: zodNamesIn(src), fl: tsFlavour(src, opts.sdk), globalConsts: opts.consts || null }; ctx.zod = ctx.zodNames.size > 0;
    ctx.consts = collectConsts(t, ctx);
    const blocks = jsBlocks(src, t);
    const tools = []; const seen = new Set(); const unresolved = [];
    let nls = null; // offsets of line breaks, for line numbers by binary search
    const lineOf = (at) => { if (!nls) { nls = []; for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) nls.push(k); } let lo = 0; let hi = nls.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (nls[mid] < at) lo = mid + 1; else hi = mid; } return lo + 1; };
    // listOf: name -> the "[" of the literal array a tool object of that name came from. The same name twice in one
    // literal tools array is what the server lists (twice), so both are kept for spec-name-unique; anywhere else a
    // second registration of a name is an alternative of the first (R-RD-08).
    const listOf = new Map();
    const add = (tool, fidelity, at, extra) => {
      if (!tool || typeof tool.name !== 'string' || !tool.name) return false;
      const inList = extra && extra.inList !== undefined ? extra.inList : null;
      if (seen.has(tool.name) && !(inList !== null && listOf.get(tool.name) === inList)) return false;
      if (tool._unreadable && !tool._unreadable.length) delete tool._unreadable;
      const dup = seen.has(tool.name);
      seen.add(tool.name); if (inList !== null && !dup) listOf.set(tool.name, inList);
      const rest = Object.assign({}, extra || {}); delete rest.inList; if (dup) rest.listDup = true;
      tools.push(Object.assign({ tool, fidelity, line: lineOf(at), offset: at }, rest)); return true;
    };
    let parents = null; // the open bracket around each token, from one pass (for the array a tool object stands in)
    const parentOf = (i) => {
      if (!parents) { parents = new Int32Array(t.length).fill(-1); const st = []; for (let k = 0; k < t.length; k++) { parents[k] = st.length ? st[st.length - 1] : -1; const x = t[k]; if (x.type !== 'p') continue; if (CLOSERS[x.value]) st.push(k); else if (x.value === ')' || x.value === ']' || x.value === '}') st.pop(); } }
      return parents[i];
    };
    // Constants seen through an overlay (R-RD-15, R-RD-12): some names bound to other values (a loop's variables, a
    // factory's parameters), some hidden (parameters and loop variables that shadow a constant), without copying the
    // file's constants for each element or call.
    const overlay = (set, hide) => {
      const base = ctx.consts || {};
      const own = (k) => hasOwn(set, k);
      const hidden = (k) => !!hide && hide.has(k) && !own(k);
      return new Proxy(base, {
        get: (b0, k) => (k === OVERLAY_BASE ? b0 : own(k) ? set[k] : hidden(k) ? undefined : b0[k]),
        has: (b0, k) => own(k) || (!hidden(k) && k in b0),
        getOwnPropertyDescriptor: (b0, k) => (own(k) ? { value: set[k], writable: true, enumerable: true, configurable: true } : hidden(k) ? undefined : Reflect.getOwnPropertyDescriptor(b0, k)),
        ownKeys: (b0) => Array.from(new Set(Reflect.ownKeys(b0).filter((k) => !hidden(k)).concat(Object.keys(set)))),
      });
    };
    // A constant of this file that nothing changes: declared once, with const, and every other use a read (not
    // assigned, not given to a call that could change it, no push/splice/… on it or a member). Only those are unrolled.
    let idUses = null; const frozenMemo = new Map();
    const MUTATORS = /^(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|delete|clear|add)$/;
    const READ_CALLS = /^(entries|keys|values|freeze)$/;
    const frozenConst = (name) => {
      if (frozenMemo.has(name)) return frozenMemo.get(name);
      if (!idUses) { idUses = new Map(); for (let k = 0; k < t.length; k++) { const x = t[k]; if (x.type !== 'id' || isP(t[k - 1], '.') || isP(t[k - 1], '?.')) continue; if (!idUses.has(x.value)) idUses.set(x.value, []); idUses.get(x.value).push(k); } }
      const uses = idUses.get(name) || []; let decls = 0; let ok = true;
      for (const k of uses) {
        const pv = t[k - 1];
        if (pv && pv.type === 'id' && /^(const|let|var)$/.test(pv.value)) { decls++; if (pv.value !== 'const') ok = false; continue; }
        if (pv && ((pv.type === 'id' && pv.value === 'delete') || isP(pv, '++') || isP(pv, '--'))) { ok = false; break; }
        if (isP(t[k + 1], ':') && (isP(pv, '{') || isP(pv, ','))) continue; // a key of an object literal
        let m = k + 1;
        for (let n = 0; n < 64; n++) {
          if ((isP(t[m], '.') || isP(t[m], '?.')) && t[m + 1] && t[m + 1].type === 'id') { if (MUTATORS.test(t[m + 1].value) && isP(t[m + 2], '(')) { ok = false; break; } m += 2; }
          else if (isP(t[m], '[')) m = matchClose(t, m) + 1;
          else break;
        }
        if (!ok) break;
        if (isP(t[m], '=') || isP(t[m], '++') || isP(t[m], '--') || (t[m] && t[m].type === 'p' && /^([-+*/%|&^]|\?\?|\|\||&&|\*\*|<<|>>)$/.test(t[m].value) && isP(t[m + 1], '='))) { ok = false; break; }
        // given to a call: only Object.entries / keys / values / freeze read it
        if (m === k + 1 && (isP(pv, '(') || isP(pv, ',') || isP(pv, '...'))) {
          const o = parentOf(k);
          if (o >= 0 && isP(t[o], '(') && !(t[o - 1] && t[o - 1].type === 'id' && READ_CALLS.test(t[o - 1].value) && isP(t[o - 2], '.') && t[o - 3] && t[o - 3].value === 'Object')) {
            if (!(isP(t[o], '(') && (isP(t[o - 1], '=>') || (t[o - 1] && t[o - 1].type === 'id' && /^(if|while|switch|return)$/.test(t[o - 1].value))))) { ok = false; break; }
          }
        }
      }
      // declared here once, or imported from a module of the repository that declares it once with const, where nothing
      // in the repository changes it (opts.frozenImport, R-RD-33)
      const r = ok && (decls === 1 || (decls === 0 && !!opts.frozenImport && opts.frozenImport(name))); frozenMemo.set(name, r); return r;
    };
    // Registrations inside a loop over a collection the reader knows (R-RD-15, R-RD-16):
    //   for (const x of LIST) / for (const [name, def] of Object.entries(TABLE)) / LIST.forEach((x) => …)
    // are read once per element, with the loop's variables bound to that element. LIST and TABLE are a literal or a
    // constant of this file that nothing changes, read in full; anything else stays an unresolved registration.
    const MAX_UNROLL = 256;
    const collectionAt = (a, b, shadowed) => { // the collection written at tokens [a, b): an array of elements, or null
      let kind = 'array'; let k = a; let e = b;
      if (t[k] && t[k].type === 'id' && t[k].value === 'Object' && isP(t[k + 1], '.') && t[k + 2] && /^(entries|keys|values)$/.test(t[k + 2].value) && isP(t[k + 3], '(') && matchClose(t, k + 3) === e - 1) { kind = t[k + 2].value; k += 4; e -= 1; }
      let v; let holes = 0;
      if (isP(t[k], '[') || isP(t[k], '{')) {
        if (matchClose(t, k) !== e - 1) return null;
        const r = isP(t[k], '[') ? parseArray(t, k, ctx) : parseObject(t, k, ctx); if (r.value === SKIP) return null;
        v = r.value; holes = (r.holes || 0) + (r.unknownKeys ? r.unknownKeys.size : 0) + (r.spreadUnknown ? 1 : 0);
      } else if (t[k] && t[k].type === 'id' && k + 1 === e) {
        const n = t[k].value;
        if (shadowed.has(n) || !ctx.consts || !hasOwn(ctx.consts, n) || !frozenConst(n)) return null;
        const c = ctx.consts[n]; v = c.value; holes = c.holes === undefined ? 1 : c.holes;
      } else return null;
      if (holes || !v || typeof v !== 'object') return null;
      if (kind === 'array') return Array.isArray(v) ? v : null;
      if (Array.isArray(v)) return null;
      const ks = Object.keys(v);
      return kind === 'keys' ? ks : kind === 'values' ? ks.map((x) => v[x]) : ks.map((x) => [x, v[x]]);
    };
    const bindingAt = (a, b) => { // a loop variable pattern at tokens [a, b): x, [k, v] or { name, description }
      if (b === a + 1 && t[a].type === 'id') { const n = t[a].value; return (el) => ({ [n]: el }); }
      if ((isP(t[a], '[') || isP(t[a], '{')) && matchClose(t, a) === b - 1) {
        const arr = isP(t[a], '['); const pairs = []; let k = a + 1; let pos = 0;
        while (k < b - 1) {
          if (t[k].type !== 'id') return null;
          if (arr) { pairs.push([pos, t[k].value]); k++; } else if (isP(t[k + 1], ':') && t[k + 2] && t[k + 2].type === 'id') { pairs.push([t[k].value, t[k + 2].value]); k += 3; } else { pairs.push([t[k].value, t[k].value]); k++; }
          pos++; if (isP(t[k], ',')) k++; else if (k !== b - 1) return null;
        }
        return (el) => { const o = {}; pairs.forEach(([from, to]) => { if (el && typeof el === 'object' && hasOwn(el, from)) o[to] = el[from]; }); return o; };
      }
      return null;
    };
    const bindVars = (a, b) => { const out = []; for (let m = a; m < b; m++) if (t[m].type === 'id' && !isP(t[m + 1], ':')) out.push(t[m].value); return out; };
    // The loop a bracket starts: { vars, envs (null when its collection is not known in full), body: [open, close] | null };
    // undefined when the bracket at `open` does not start a loop. Memoized per bracket.
    const loopMemo = new Map();
    const loopAt = (open) => {
      if (loopMemo.has(open)) return loopMemo.get(open);
      const r = loopAtOnce(open); loopMemo.set(open, r); return r;
    };
    const loopAtOnce = (open) => {
      if (open < 1 || !isP(t[open], '(') || !t[open - 1] || t[open - 1].type !== 'id') return undefined;
      const shadowed = paramsAround(t, blocks, open);
      if (t[open - 1].value === 'for') {
        const close = matchClose(t, open); let q = open + 1; if (t[q] && /^(const|let|var)$/.test(t[q].value)) q++;
        let of = -1; for (let m = q; m < close; m++) { if (CLOSERS[t[m].type === 'p' && t[m].value]) { m = matchClose(t, m); continue; } if (t[m].type === 'id' && t[m].value === 'of') { of = m; break; } }
        if (of < 0) return undefined; // for (;;) or for … in: not read
        const bind = bindingAt(q, of); const items = bind && collectionAt(of + 1, close, shadowed);
        const body = isP(t[close + 1], '{') ? [close + 1, matchClose(t, close + 1)] : null;
        return { vars: new Set(bindVars(q, of)), envs: items && items.length <= MAX_UNROLL ? items.map(bind) : null, body };
      }
      if (/^(forEach|map|flatMap)$/.test(t[open - 1].value) && isP(t[open - 2], '.')) {
        // LIST.forEach((x) => …), LIST.forEach(async x => …): the callback is the call's first argument
        let ps = open + 1; if (t[ps] && t[ps].type === 'id' && t[ps].value === 'async') ps++;
        let pe; let arrowAt;
        if (isP(t[ps], '(')) { pe = matchClose(t, ps); if (!isP(t[pe + 1], '=>')) return undefined; arrowAt = pe + 1; ps++; } else if (t[ps] && t[ps].type === 'id' && isP(t[ps + 1], '=>')) { pe = ps + 1; arrowAt = ps + 1; } else return undefined;
        let firstEnd = ps; for (; firstEnd < pe; firstEnd++) { if (CLOSERS[t[firstEnd].type === 'p' && t[firstEnd].value]) { firstEnd = matchClose(t, firstEnd); continue; } if (isP(t[firstEnd], ',')) break; }
        firstEnd = Math.min(firstEnd, pe);
        const cend = open - 2; let cstart = cend - 1;
        if (isP(t[cend - 1], ')')) { const o = parentOf(cend - 1); cstart = o >= 3 && t[o - 1].type === 'id' && /^(entries|keys|values)$/.test(t[o - 1].value) && isP(t[o - 2], '.') ? o - 3 : -1; }
        else if (isP(t[cend - 1], ']')) { cstart = parentOf(cend - 1); const pv = t[cstart - 1]; if (pv && (isP(pv, ')') || isP(pv, ']') || (pv.type === 'id' && !/^(return|of|in|case|typeof|void|await|yield)$/.test(pv.value)))) cstart = -1; } // groups['a'].forEach: an index, not a literal
        else if (!(t[cstart] && t[cstart].type === 'id') || isP(t[cstart - 1], '.') || isP(t[cstart - 1], '?.')) cstart = -1;
        const bind = bindingAt(ps, firstEnd); const items = bind && cstart >= 0 && collectionAt(cstart, cend, shadowed);
        const body = isP(t[arrowAt + 1], '{') ? [arrowAt + 1, matchClose(t, arrowAt + 1)] : null;
        return { vars: new Set(bindVars(ps, firstEnd)), envs: items && items.length <= MAX_UNROLL ? items.map(bind) : null, body };
      }
      return undefined;
    };
    // The loops around token i, innermost first (the walk goes up the brackets around i, at most 64 levels).
    const loopsAround = (i) => {
      const out = [];
      // a brace-less body: for (const x of LIST) server.registerTool(…)
      let k = i; while (k > 0 && (t[k - 1].type === 'id' || isP(t[k - 1], '.') || isP(t[k - 1], '?.')) && !/^(return|await|void|yield)$/.test(t[k - 1].value)) k--;
      if (t[k - 1] && /^(await|void)$/.test(t[k - 1].value)) k--;
      if (isP(t[k - 1], ')')) { const r = loopAt(parentOf(k - 1)); if (r !== undefined) out.push(r); }
      let p = parentOf(i); let n = 0;
      while (p >= 0 && n++ < 64) {
        let r = loopAt(p); if (r !== undefined) out.push(r);
        if (isP(t[p], '{') && isP(t[p - 1], ')')) { r = loopAt(parentOf(p - 1)); if (r !== undefined) out.push(r); } // for (…) { … }
        p = parentOf(p);
      }
      return out;
    };
    const EXITS = /^(continue|break|return|throw)$/;
    // A registration in a loop, read once per element: true when it was read (or the work limit ran out and the list
    // is refused). Not read, so counted as unresolved by the caller: an unknown collection, a name or config that does
    // not resolve for some element, a loop body that may skip the registration (continue, break, return, throw
    // before it), or a name that depends on an outer loop's variable or a parameter.
    const unrollAt = (i, at, fn, args, params) => {
      const loops = loopsAround(i); if (!loops.length || !loops[0].envs) return false;
      const loop = loops[0];
      if (loop.body) for (let m = loop.body[0] + 1; m < i; m++) if (t[m].type === 'id' && EXITS.test(t[m].value)) return false;
      const hide = new Set(params); loops.slice(1).forEach((l) => l.vars.forEach((x) => hide.add(x)));
      loop.vars.forEach((x) => hide.delete(x));
      const ps = new Set(Array.from(hide));
      const span = args[1] !== undefined ? Math.max(1, skipExpr(t, args[1]) - args[1]) : 1;
      const made = [];
      for (const env of loop.envs) {
        budget -= span; if (budget < 0) { overBudget.push({ line: lineOf(at) }); return true; }
        const set = {}; Object.keys(env).forEach((k) => { set[k] = { value: env[k], exact: true, holes: 0 }; });
        const lctx = Object.assign({}, ctx, { consts: overlay(set, hide) });
        const nm = resolveName(t, args[0], lctx, ps); if (!nm || !nm.name) return false;
        const a1 = args[1]; let tool;
        if (a1 === undefined) tool = { name: nm.name, inputSchema: { type: 'object', properties: {} } };
        else if (t[a1] && (t[a1].type === 'str' || t[a1].type === 'tpl')) {
          const d = parseValue(t, a1, lctx); tool = { name: nm.name, inputSchema: { type: 'object' }, _unreadable: ['inputSchema'].concat(d.partial || typeof d.value !== 'string' ? ['description'] : []) };
          if (typeof d.value === 'string') tool.description = d.value;
        } else { const cfg = configAt(a1, lctx); if (!cfg) return false; tool = toolFromConfig(nm.name, cfg); }
        if (ctx.fl.execution && !tool.execution) tool.execution = { taskSupport: 'forbidden' };
        made.push(tool);
      }
      made.forEach((tool) => add(tool, 'derived', at, { unrolled: true }));
      return true;
    };
    // A call of a register helper (see registerWrappers), read with the constants of c: the tool, PARAM when its name
    // is a parameter of the function around the call, or null when it cannot be read.
    const PARAM = { param: true };
    const viaWrapper = (w, args, c, ps) => {
      const slots = w.kind === 'registerTool' ? [w.name, w.cfg] : [w.name, w.desc, w.shape];
      if (slots.some((x) => args[x.p] === undefined) && w.kind === 'registerTool') return null;
      if (slots[0].key !== undefined) {
        // tool.name, tool.description, …: properties of one argument, read from its value
        const v = parseValue(t, args[slots[0].p], c);
        if (v.value === SKIP || !v.value || typeof v.value !== 'object' || Array.isArray(v.value)) return null;
        const o = v.value; const get = (x) => (hasOwn(o, x.key) ? o[x.key] : undefined);
        const unknown = (x) => !hasOwn(o, x.key) && v.exact === false; // left out because it could not be read
        const name = get(slots[0]); if (typeof name !== 'string' || !name) return null;
        if (w.kind === 'registerTool') {
          const cv = get(slots[1]); if (!cv || typeof cv !== 'object' || Array.isArray(cv)) return null;
          return toolFromConfig(name, { value: cv, exact: v.exact, unknownKeys: new Set(), partialKeys: new Set() });
        }
        const tool = { name }; const un = [];
        const d = get(slots[1]); if (typeof d === 'string') tool.description = d; else if (unknown(slots[1])) un.push('description');
        const sh = get(slots[2]);
        if (sh && typeof sh === 'object' && !Array.isArray(sh) && isRawShape(sh)) tool.inputSchema = rootSchema(sh, undefined, c.fl);
        else if (sh && typeof sh === 'object' && isSchemaObj(sh) && sh.type === 'object') tool.inputSchema = sh;
        else if (sh === undefined && !unknown(slots[2])) tool.inputSchema = { type: 'object', properties: {} };
        else { tool.inputSchema = { type: 'object' }; un.push('inputSchema'); }
        if (c.fl.execution) tool.execution = { taskSupport: 'forbidden' };
        tool._unreadable = un;
        return tool;
      }
      const nm = resolveName(t, args[slots[0].p], c, ps);
      if (nm && nm.param) return PARAM;
      if (!nm || !nm.name) return null;
      if (w.kind === 'registerTool') { const cfg = configAt(args[slots[1].p], c); return cfg ? toolFromConfig(nm.name, cfg) : null; }
      // tool(name, [description], [shape], cb): a description is a string; a shape in the description's place (an
      // object literal or a zod expression) is the shape, as the SDK reads it. An argument there that is neither and
      // cannot be read (getDesc()) leaves the description unread, and the shape is the shape argument: if that one is
      // missing or a function (the callback), the shape is unread too.
      const tool = { name: nm.name }; const un = [];
      let j = args[slots[1].p];
      const strAt = (k) => t[k] && (t[k].type === 'str' || t[k].type === 'tpl' || (t[k].type === 'id' && (() => { const r = chainValue(c, idChain(t, k).ids); return r && typeof r.value === 'string'; })()));
      const shapeAt = (k) => isP(t[k], '{') || (t[k] && t[k].type === 'id' && (c.zodNames.has(t[k].value) || (() => { const r = chainValue(c, idChain(t, k).ids); return !!r && !!r.value && typeof r.value === 'object' && !Array.isArray(r.value); })()));
      const fnAt = (k) => t[k] && ((t[k].type === 'id' && /^(async|function)$/.test(t[k].value)) || (isP(t[k], '(') && isP(t[matchClose(t, k) + 1], '=>')) || (t[k].type === 'id' && isP(t[k + 1], '=>')));
      if (j !== undefined && strAt(j)) { const d = parseValue(t, j, c); if (typeof d.value === 'string') tool.description = d.value; if (d.partial || typeof d.value !== 'string') un.push('description'); j = args[slots[2].p]; }
      else if (j !== undefined && !shapeAt(j)) {
        un.push('description'); j = args[slots[2].p];
        if (j === undefined || fnAt(j)) { tool.inputSchema = { type: 'object' }; un.push('inputSchema'); j = null; }
      }
      if (j === null) { /* unread above */ } else if (j === undefined) tool.inputSchema = { type: 'object', properties: {} };
      else if (isP(t[j], '{') || (t[j] && t[j].type === 'id' && c.zodNames.has(t[j].value))) {
        const shape = zodShapeAt(t, j, c);
        if (shape.schema && isZodShapeLike(shape.schema)) tool.inputSchema = shape.schema; else { tool.inputSchema = { type: 'object' }; un.push('inputSchema'); }
      } else {
        const v = parseValue(t, j, c);
        if (v.value !== SKIP && v.value && typeof v.value === 'object' && !Array.isArray(v.value)) tool.inputSchema = v.rawShape || (!isSchemaObj(v.value) && !v.zod) ? rootSchema(v.value, v.optionalKeys, c.fl) : v.value;
        else { tool.inputSchema = { type: 'object' }; un.push('inputSchema'); }
      }
      if (c.fl.execution) tool.execution = { taskSupport: 'forbidden' };
      tool._unreadable = un;
      return tool;
    };
    // A register helper's call in a loop over a known collection: read once per element (as unrollAt does for the SDK's
    // own calls). false when there is no such loop or some element does not give a tool.
    const unrollWrapper = (i, at, w, args, params) => {
      const loops = loopsAround(i); if (!loops.length || !loops[0].envs) return false;
      const loop = loops[0];
      if (loop.body) for (let m = loop.body[0] + 1; m < i; m++) if (t[m].type === 'id' && EXITS.test(t[m].value)) return false;
      const hide = new Set(params); loops.slice(1).forEach((l) => l.vars.forEach((x) => hide.add(x)));
      loop.vars.forEach((x) => hide.delete(x));
      const ps = new Set(Array.from(hide));
      const span = Math.max(1, matchClose(t, i + 1) - i);
      const made = [];
      for (const env of loop.envs) {
        budget -= span; if (budget < 0) { overBudget.push({ line: lineOf(at) }); return true; }
        const set = {}; Object.keys(env).forEach((k) => { set[k] = { value: env[k], exact: true, holes: 0 }; });
        const lctx = Object.assign({}, ctx, { consts: overlay(set, hide) });
        const tool = viaWrapper(w, args, lctx, ps); if (!tool || tool === PARAM) return false;
        made.push(tool);
      }
      made.forEach((tool) => add(tool, 'derived', at, { unrolled: true }));
      return true;
    };
    // What could not be read in a config object: its keys with unknown or partial values, and keys that a spread
    // it could not read may have set.
    const unreadableOf = (o, keys) => {
      const out = [];
      keys.forEach(([key, as]) => {
        const v = o.value && o.value !== SKIP ? o.value[key] : undefined;
        if ((o.unknownKeys && o.unknownKeys.has(key)) || (o.partialKeys && o.partialKeys.has(key)) || (v === undefined && o.spreadUnknown)) { if (!out.includes(as)) out.push(as); }
      });
      return out;
    };
    // registerTool's config (an object literal at token j, or a constant's value), as the SDK lists it.
    const toolFromConfig = (name, cfg) => {
      const tool = { name };
      const c = cfg.value && cfg.value !== SKIP ? wrapRawSchemas(cfg.value, cfg.childOptional) : {};
      if (typeof c.title === 'string') tool.title = c.title;
      if (typeof c.description === 'string') tool.description = c.description;
      const sk = SCHEMA_KEYS.find((k) => c[k] && typeof c[k] === 'object' && !Array.isArray(c[k]));
      tool.inputSchema = sk ? c[sk] : { type: 'object', properties: {} };
      if (c.outputSchema && typeof c.outputSchema === 'object') tool.outputSchema = c.outputSchema;
      if (c.annotations && typeof c.annotations === 'object') tool.annotations = c.annotations;
      if (c._meta) tool._meta = c._meta;
      if (ctx.fl.execution) tool.execution = { taskSupport: 'forbidden' };
      const un = unreadableOf(cfg, [['description', 'description'], ['annotations', 'annotations']].concat(sk ? [[sk, 'inputSchema']] : SCHEMA_KEYS.map((k) => [k, 'inputSchema'])));
      if (!sk && un.includes('inputSchema')) tool.inputSchema = { type: 'object' };
      if (un.includes('description') && typeof tool.description !== 'string' && cfg.literals && cfg.literals.description) tool.description = cfg.literals.description;
      tool._unreadable = un;
      return tool;
    };
    const configAt = (j, c) => {
      c = c || ctx;
      if (isP(t[j], '{')) return parseObjectWithZod(t, j, c);
      const v = parseValue(t, j, c);
      if (v.value !== SKIP && v.value && typeof v.value === 'object' && !Array.isArray(v.value)) return { value: v.value, end: v.end, exact: v.exact, unknownKeys: new Set(), partialKeys: new Set() };
      return null;
    };
    // { inputSchema: { a: z.string() } } held in a constant: the raw shape wrapped as an object schema.
    const wrapRawSchemas = (o, childOptional) => {
      const out = Object.assign({}, o);
      SCHEMA_KEYS.forEach((k) => {
        const s = out[k];
        if (isRawShape(s)) out[k] = rootSchema(s, childOptional && childOptional[k], ctx.fl);
      });
      return out;
    };
    // the text of an object that is not listed (a registration without a readable name), for the poisoning scan
    const textOf = (o) => {
      const out = {}; if (!o) return out;
      const v = o.value && o.value !== SKIP ? o.value : {};
      const d = typeof v.description === 'string' ? v.description : o.literals && o.literals.description; if (d) out.description = d;
      const ti = typeof v.title === 'string' ? v.title : o.literals && o.literals.title; if (ti) out.title = ti;
      return out;
    };
    const hasConfigKey = (cfg) => !!cfg && ((cfg.value && cfg.value !== SKIP && CONFIG_KEYS.some((k) => cfg.value[k] !== undefined)) || (cfg.unknownKeys && CONFIG_KEYS.some((k) => cfg.unknownKeys.has(k))) || (cfg.partialKeys && cfg.partialKeys.size > 0));
    const isDecl = (i) => t[i - 1] && ((t[i - 1].type === 'id' && /^(function|async|get|set|static|public|private|protected|override)$/.test(t[i - 1].value)));
    const isMethodDef = (open) => { const c = matchClose(t, open); return isP(t[c + 1], '{') || (isP(t[c + 1], ':') && !isP(t[open - 2], '.')); };
    // A tool object literal: name, schema, description, annotations; the unreadable parts marked.
    const toolFromObject = (o, nameOverride, at, flavour) => {
      const v = o.value && o.value !== SKIP ? o.value : null; if (!v) return null;
      const name = nameOverride || (typeof v.name === 'string' ? v.name : null); if (!name) return null;
      const tool = { name };
      if (typeof v.title === 'string') tool.title = v.title;
      if (typeof v.description === 'string') tool.description = v.description;
      const sk = SCHEMA_KEYS.find((k) => v[k] && typeof v[k] === 'object' && !Array.isArray(v[k]));
      let schema = sk ? v[sk] : null;
      if (schema && !isSchemaObj(schema)) {
        const k2 = findKeyToken(t, o.start, o.end, sk);
        const sh = k2 >= 0 && isP(t[k2 + 2], '{') ? zodShapeAt(t, k2 + 2, ctx) : null;
        schema = sh && sh.schema && Object.keys(sh.schema.properties).length ? sh.schema : Object.keys(schema).length ? rootSchema(schema, o.childOptional && o.childOptional[sk], ctx.fl) : { type: 'object', properties: {} };
      }
      if (flavour === 'fastmcp' && schema && schema.type === 'object' && !schema.$schema) schema = Object.assign({}, schema, { $schema: DIALECT['draft-07'] }, schema.additionalProperties === undefined ? { additionalProperties: false } : {});
      const un = unreadableOf(o, [['description', 'description'], ['annotations', 'annotations']].concat(sk ? [] : SCHEMA_KEYS.map((k) => [k, 'inputSchema'])));
      tool.inputSchema = schema || (un.includes('inputSchema') ? { type: 'object' } : { type: 'object', properties: {} });
      ['outputSchema', 'annotations', '_meta', 'icons', 'execution'].forEach((k) => { if (v[k] !== undefined && typeof v[k] === 'object') tool[k] = v[k]; });
      if (un.includes('description') && typeof tool.description !== 'string' && o.literals && o.literals.description) tool.description = o.literals.description;
      if (v.deprecated === true || (v.deprecated && typeof v.deprecated === 'object')) tool._deprecated = true; // a definition that flags itself deprecated (the server leaves it out of the list)
      tool._unreadable = un;
      return tool;
    };
    // the object a factory returns: defineTool(() => ({...})), defineTool((a) => { return {...} }), defineTool({...})
    const factoryObject = (j) => {
      if (isP(t[j], '{')) return j;
      let k = j; if (t[k] && t[k].type === 'id' && t[k].value === 'async') k++;
      if (isP(t[k], '(')) { const c = matchClose(t, k); k = c + 1; } else if (t[k] && t[k].type === 'id' && isP(t[k + 1], '=>')) k = k + 1; else return -1;
      while (t[k] && !isP(t[k], '=>') && !isP(t[k], '{') && k < j + 60) k++; // a TS return type
      if (!isP(t[k], '=>')) return -1;
      k++;
      if (isP(t[k], '(') && isP(t[k + 1], '{')) return k + 1;
      if (isP(t[k], '{')) { const c = matchClose(t, k); for (let m = k + 1; m < c; m++) if (t[m].type === 'id' && t[m].value === 'return' && isP(t[m + 1], '{')) return m + 1; }
      return -1;
    };
    // A work limit that keeps a file linear. Each token is charged once (an object nested in one already read comes from
    // the parse memo), so the limit is a safety net; if it ever runs out, the candidates it skips are counted
    // (tools.overBudget) and the scan refuses to grade the list rather than drop them silently.
    let budget = opts.workBudget !== undefined ? opts.workBudget : 8 * t.length + 200000; let paidTo = -1; const overBudget = []; // opts.workBudget: tests
    const spend = (a, b) => { const extra = Math.max(1, b - Math.max(a, paidTo)); if (b > paidTo) paidTo = b; budget -= extra; return budget >= 0; };
    let schemaObj = null;
    const schemaObjects = () => { // the "{" of every object with a schema key of its own (a key at its first level)
      if (schemaObj) return schemaObj; schemaObj = new Set(); const stack = [];
      for (let k = 0; k < t.length; k++) {
        const x = t[k];
        if (x.type === 'p') { if (CLOSERS[x.value]) stack.push(k); else if (x.value === ')' || x.value === ']' || x.value === '}') stack.pop(); continue; }
        if ((x.type === 'id' || x.type === 'str') && isP(t[k + 1], ':') && SCHEMA_KEYS.includes(x.value) && stack.length && isP(t[stack[stack.length - 1]], '{')) schemaObj.add(stack[stack.length - 1]);
      }
      return schemaObj;
    };
    // Every object and array of the file is read once, innermost first, into the memo: a later parse of any of them
    // (as a tool, a config, or part of an outer value) is a lookup, never a deep recursion or a read cut by position.
    const fastCtx = Object.assign({}, ctx, { fl: Object.assign({}, ctx.fl, { dialect: 'draft-07', closed: true, execution: false }) });
    const prepass = (c) => { LOST.cur = null; for (let k = t.length - 1; k >= 0; k--) { try { if (isP(t[k], '{')) parseObject(t, k, c); else if (isP(t[k], '[')) parseArray(t, k, c); } catch (e) { /* read again in the loop */ } } };
    prepass(ctx); if (/\baddTool\b/.test(src)) prepass(fastCtx);
    const wrappers = registerWrappers(t);
    if (opts.wrappers) opts.wrappers.forEach((w, k) => { if (!wrappers.has(k)) wrappers.set(k, w); }); // imported helpers (R-RD-32)
    // Functions of this file that build a tool object from their parameters (R-RD-12): a call is read with the
    // parameters bound to its arguments, so the literal parts (a schema, annotations) are kept and the parts built from
    // something unknown are marked unreadable.
    //   function keyTool(name, description, readOnly) { return { name, description, inputSchema: {…}, annotations: { readOnlyHint: readOnly } }; }
    //   const keyTool = (name: string, description: string) => ({ name, description, inputSchema: {…} });
    const factories = new Map(); // name -> { params: [[start, end)], obj: the returned "{" }
    {
      const keyAtTopAny = (open) => { const c = matchClose(t, open); for (let m = open + 1; m < c; m++) { if (t[m].type === 'p' && CLOSERS[t[m].value]) { m = matchClose(t, m); continue; } if ((t[m].type === 'id' || t[m].type === 'str') && SCHEMA_KEYS.includes(String(t[m].value)) && (isP(t[m + 1], ':') || isP(t[m + 1], ',') || isP(t[m + 1], '}')) && (isP(t[m - 1], '{') || isP(t[m - 1], ','))) return m; } return -1; };
      const returned = (open) => { const close = matchClose(t, open); for (let m = open + 1; m < close; m++) { if (t[m].type === 'id' && t[m].value === 'return') { let q = m + 1; while (isP(t[q], '(')) q++; return isP(t[q], '{') ? q : -1; } if (t[m].type === 'p' && CLOSERS[t[m].value]) m = matchClose(t, m); } return -1; };
      for (let k = 0; k + 3 < t.length; k++) {
        if (t[k].type !== 'id') continue;
        let name = null; let po = -1; let arrow = false;
        if (t[k].value === 'function' && t[k + 1].type === 'id' && isP(t[k + 2], '(')) { name = t[k + 1].value; po = k + 2; }
        else if (/^(const|let|var)$/.test(t[k].value) && t[k + 1].type === 'id' && isP(t[k + 2], '=')) { let q = k + 3; if (t[q] && t[q].type === 'id' && t[q].value === 'async') q++; if (isP(t[q], '(')) { name = t[k + 1].value; po = q; arrow = true; } }
        if (!name || !TOOLISH.test(name) || SDK_CALLS.has(name)) continue;
        const pc = matchClose(t, po); let b = pc + 1;
        if (isP(t[b], ':')) { let n = 0; while (t[b] && !isP(t[b], '{') && !isP(t[b], '=>') && n++ < 60) b++; } // a return type
        let obj = -1;
        if (arrow) { if (!isP(t[b], '=>')) continue; b++; let q = b; while (isP(t[q], '(')) q++; obj = isP(t[q], '{') && q > b ? q : isP(t[b], '{') ? returned(b) : -1; }
        else if (isP(t[b], '{')) obj = returned(b);
        if (obj < 0 || keyAtTopAny(obj) < 0) continue; // a tool object has a schema key of its own (not { name, found })
        const params = []; let a = po + 1;
        while (a < pc) { let e = a; for (; e < pc; e++) { if (t[e].type === 'p' && CLOSERS[t[e].value]) { e = matchClose(t, e); continue; } if (isP(t[e], ',')) break; } params.push([a, Math.min(e, pc)]); a = e + 1; }
        if (!factories.has(name)) factories.set(name, { params, obj });
      }
    }
    // A call of one of those functions: the tool it returns, read with its parameters bound, or null.
    const OVER = { over: true };
    const fromFactory = (f, args, at) => {
      const set = {}; const hide = new Set(); // the parameters: bound to the arguments, or hidden (unknown)
      f.params.forEach(([a, b], idx) => {
        const arg = args[idx];
        if (isP(t[a], '...')) { bindVars(a + 1, b).forEach((x) => { hide.add(x); }); return; }
        if (t[a].type === 'id') {
          const n = t[a].value; let v = null;
          if (arg !== undefined) v = parseValue(t, arg, ctx);
          else { let eq = a + 1; while (eq < b && !isP(t[eq], '=')) eq++; if (eq < b) v = parseValue(t, eq + 1, ctx); }
          if (v && v.value !== SKIP) set[n] = { value: v.value, exact: v.exact !== false, partial: !!v.partial, holes: 0 }; else hide.add(n);
          return;
        }
        if (isP(t[a], '{') || isP(t[a], '[')) {
          const end = matchClose(t, a) + 1; const bind = bindingAt(a, end); const vars = bindVars(a + 1, end - 1);
          const v = arg !== undefined ? parseValue(t, arg, ctx) : null;
          const env = bind && v && v.value !== SKIP ? bind(v.value) : {};
          vars.forEach((x) => { if (hasOwn(env, x)) set[x] = { value: env[x], exact: true, holes: 0 }; else hide.add(x); });
        }
      });
      budget -= Math.max(1, matchClose(t, f.obj) - f.obj); if (budget < 0) { overBudget.push({ line: lineOf(at) }); return OVER; }
      const lctx = Object.assign({}, ctx, { consts: overlay(set, hide) });
      const o = parseObjectWithZod(t, f.obj, lctx); o.start = f.obj;
      return toolFromObject(o, null, at);
    };
    // SDK methods bound to their server under another name (R-RD-13): const register = server.registerTool.bind(server)
    const bound = new Map();
    for (let k = 0; k + 7 < t.length; k++) {
      if (!(t[k].type === 'id' && /^(const|let|var)$/.test(t[k].value) && t[k + 1].type === 'id' && isP(t[k + 2], '='))) continue;
      const ch = t[k + 3] && t[k + 3].type === 'id' ? idChain(t, k + 3) : null;
      if (ch && ch.ids.length >= 3 && ch.ids[ch.ids.length - 1] === 'bind' && SDK_CALLS.has(ch.ids[ch.ids.length - 2]) && isP(t[ch.end], '(')) bound.set(t[k + 1].value, ch.ids[ch.ids.length - 2]);
    }
    if (wrappers.overBudget) overBudget.push({ line: null });
    for (let i = 0; i < t.length; i++) {
      const tok = t[i];
      const iterLost = []; LOST.cur = iterLost; const toolsBefore = tools.length; const unresBefore = unresolved.length;
      try { // one registration that cannot be read never drops the others: it is counted instead
      // 0. A function that forwards its parameters to X.registerTool(name, config, …) or X.tool(name, description,
      //    shape, …), defined in this file or imported from a module of the repository (one relative import, R-RD-32):
      //    register(server, 'name', { description, inputSchema }, handler) is read as registerTool('name', {...}), and
      //    registerTool(server, tool) as tool(tool.name, tool.description, tool.params). Inside a loop over a collection
      //    the reader knows, it is read once per element; anything else is counted as unresolved, never guessed.
      if (tok.type === 'id' && wrappers.has(tok.value) && isP(t[i + 1], '(') && !(t[i - 1] && (isP(t[i - 1], '.') || isP(t[i - 1], '?.') || isDecl(i)))) {
        if (isMethodDef(i + 1)) continue;
        const w = wrappers.get(tok.value); const args = argStarts(t, i + 1); const ps = paramsAround(t, blocks, i);
        const r = viaWrapper(w, args, ctx, ps);
        if (r === PARAM) continue; // inside another helper: its callers name the tools
        if (r) { add(r, 'derived', tok.start); continue; }
        if (unrollWrapper(i, tok.start, w, args, ps)) continue;
        const txt = {}; const ds = w.kind === 'tool' ? w.desc : null;
        if (ds && ds.key === undefined && args[ds.p] !== undefined) { try { const d = parseValue(t, args[ds.p], ctx); if (typeof d.value === 'string') txt.description = d.value; } catch (e) { /* no text */ } }
        unresolved.push(Object.assign({ line: lineOf(tok.start) }, txt));
        continue;
      }
      const member = isP(tok, '.') && t[i + 1] && t[i + 1].type === 'id' && isP(t[i + 2], '(');
      const bare = !member && tok.type === 'id' && isP(t[i + 1], '(') && !(t[i - 1] && (isP(t[i - 1], '.') || isP(t[i - 1], '?.'))) && !isDecl(i);
      const fnTok = member ? t[i + 1] : bare ? tok : null;
      const boundTo = bare && fnTok && bound.has(fnTok.value) ? bound.get(fnTok.value) : null; // const reg = server.registerTool.bind(server)
      if (fnTok && (boundTo || SDK_CALLS.has(fnTok.value) || TOOLISH.test(fnTok.value)) && !(bare && !boundTo && fnTok.value === 'tool' && !isP(t[i + 2], '{') && !(t[i + 2] && t[i + 2].type === 'str'))) {
        const open = member ? i + 2 : i + 1; const at = tok.start; const fn = boundTo || fnTok.value;
        if (bare && isMethodDef(open)) continue; // a method definition: name(args) { … }
        const sdk = SDK_CALLS.has(fn);
        const args = argStarts(t, open); const a0 = args[0]; const a1 = args[1];
        if (a0 === undefined) continue;
        // FastMCP (TypeScript, punkpeye) addTool({ name, description, parameters: z.object(...), annotations, execute }) and
        // factories that take or return a tool object: defineTool({ name, … }), defineTool((args) => ({ name, … })).
        if (!sdk && bare && factories.has(fn)) { const tool = fromFactory(factories.get(fn), args, at); if (tool === OVER) continue; if (tool) { add(tool, 'derived', at); continue; } }
        const objAt = isP(t[a0], '{') ? a0 : args.length === 1 ? factoryObject(a0) : -1;
        if (objAt >= 0) {
          const fast = fn === 'addTool';
          const actx = fast ? fastCtx : ctx;
          if (!spend(objAt, matchClose(t, objAt))) { overBudget.push({ line: lineOf(at) }); continue; }
          const o = parseObjectWithZod(t, objAt, actx); o.start = objAt;
          // keyed: { lookup_docs: tool({ ... }) } names the tool by its key
          const keyTok = !member && isP(t[i - 1], ':') && t[i - 2] && (t[i - 2].type === 'id' || t[i - 2].type === 'str') ? t[i - 2] : null;
          let nm = null;
          if (o.value && o.value !== SKIP && typeof o.value.name === 'string') nm = o.value.name;
          else { const k2 = findKeyToken(t, objAt, o.end, 'name'); const r = k2 >= 0 ? resolveName(t, k2 + 2, actx, paramsAround(t, blocks, k2)) : null; if (r && r.name) nm = r.name; else if (!keyTok && (o.unknownKeys.has('name') || k2 >= 0)) { unresolved.push(Object.assign({ line: lineOf(at) }, textOf(o))); } }
          if (!nm && keyTok && !(o.value && o.value !== SKIP && o.value.name !== undefined) && !o.unknownKeys.has('name')) nm = String(keyTok.value);
          if (nm && (sdk || hasConfigKey(o) || o.spreadUnknown)) {
            const tool = toolFromObject(o, nm, at, fast ? 'fastmcp' : null);
            if (tool) add(tool, 'derived', at, { literal: false });
          }
          continue;
        }
        const nm = resolveName(t, a0, ctx, paramsAround(t, blocks, i));
        if ((!nm || nm.param) && sdk && (member || boundTo) && unrollAt(i, at, fn, args, paramsAround(t, blocks, i))) continue;
        if (!nm || nm.param) {
          // registerTool(name, …) inside a helper takes the name from its caller (see registerWrappers); other names
          // that cannot be read are counted, so the report can say so.
          if (!nm && sdk && (member || boundTo) && a1 !== undefined && (isP(t[a1], '{') || (t[a1] && /^(str|tpl)$/.test(t[a1].type)))) {
            let txt = {};
            try { if (isP(t[a1], '{')) txt = textOf(configAt(a1)); else { const d = parseValue(t, a1, ctx); txt = { description: typeof d.value === 'string' ? d.value : literalsIn(t, a1, args[2] !== undefined ? args[2] : a1 + 1) }; } } catch (e) { txt = {}; }
            unresolved.push(Object.assign({ line: lineOf(at) }, txt));
          }
          continue;
        }
        if (a1 === undefined) { if (sdk && fn !== 'addTool') add(Object.assign({ name: nm.name, inputSchema: { type: 'object', properties: {} } }, ctx.fl.execution ? { execution: { taskSupport: 'forbidden' } } : {}), 'derived', at); continue; }
        // server.tool(name, [description], [paramsSchema], [annotations], cb), and a helper with that signature
        const strSecond = t[a1] && (t[a1].type === 'str' || t[a1].type === 'tpl' || (t[a1].type === 'id' && (() => { const r = chainValue(ctx, idChain(t, a1).ids); return r && typeof r.value === 'string'; })()));
        if (fn === 'tool' || strSecond) {
          if (!sdk && !strSecond) continue;
          const tool = { name: nm.name }; const un = []; let j = a1;
          if (strSecond) { const d = parseValue(t, j, ctx); if (typeof d.value === 'string') tool.description = d.value; if (d.partial) un.push('description'); j = args[2]; }
          if (j !== undefined && (isP(t[j], '{') || (t[j] && t[j].type === 'id' && ctx.zodNames.has(t[j].value)))) {
            const shape = zodShapeAt(t, j, ctx);
            const k = args.indexOf(j);
            if (shape.schema && isZodShapeLike(shape.schema)) { tool.inputSchema = shape.schema; const an = args[k + 1]; if (an !== undefined && isP(t[an], '{')) { const ann = parseValue(t, an, ctx); if (ann.value && ann.value !== SKIP && !Array.isArray(ann.value) && isAnnotations(ann.value)) tool.annotations = ann.value; } }
            else if (shape.schema && isAnnotations(shape.schema)) tool.annotations = shape.schema;
          } else if (j !== undefined && t[j] && t[j].type === 'id' && args.indexOf(j) < args.length - 1) {
            const v = parseValue(t, j, ctx);
            if (v.value !== SKIP && v.value && typeof v.value === 'object' && !Array.isArray(v.value)) tool.inputSchema = v.rawShape || (!isSchemaObj(v.value) && !v.zod) ? rootSchema(v.value, v.optionalKeys, ctx.fl) : v.value;
            else un.push('inputSchema');
          }
          if (!tool.inputSchema) tool.inputSchema = un.includes('inputSchema') ? { type: 'object' } : { type: 'object', properties: {} };
          if (ctx.fl.execution) tool.execution = { taskSupport: 'forbidden' };
          tool._unreadable = un;
          add(tool, 'derived', at); continue;
        }
        const cfg = configAt(a1);
        if (!cfg) { if (sdk) add(Object.assign({ name: nm.name, inputSchema: { type: 'object' }, _unreadable: ['inputSchema', 'description', 'annotations'] }), 'derived', at); continue; }
        if (!sdk && !hasConfigKey(cfg)) continue;
        add(toolFromConfig(nm.name, cfg), 'derived', at); continue;
      }
      // 2. object literals with a name and a schema (a low-level Server's tools array, a tool table, a factory's result)
      if (isP(tok, '{')) {
        // cheap pre-check: a schema key within this object at depth 1 (from one pass over the file)
        if (!schemaObjects().has(i)) continue;
        if (!spend(i, matchClose(t, i))) { overBudget.push({ line: lineOf(tok.start) }); continue; }
        const o = parseObjectWithZod(t, i, ctx); o.start = i;
        const v = o.value;
        if (!v || v === SKIP) continue;
        let name = typeof v.name === 'string' ? v.name : null;
        if (!name && o.unknownKeys.has('name')) { const k2 = findKeyToken(t, i, o.end, 'name'); const r = k2 >= 0 ? resolveName(t, k2 + 2, ctx, paramsAround(t, blocks, k2)) : null; if (r && r.name) name = r.name; }
        const key = SCHEMA_KEYS.find((k) => v[k] && typeof v[k] === 'object' && !Array.isArray(v[k])) || SCHEMA_KEYS.find((k) => o.unknownKeys.has(k));
        // where the object stands: an argument, an array element, a return value or an arrow's result is a tool the
        // code hands on; a constant is kept when something refers to it (markConditionals)
        const pv = t[i - 1]; const reach = pv && (isP(pv, '(') || isP(pv, '[') || isP(pv, ',') || isP(pv, '=>') || isP(pv, '?') || isP(pv, ':') || isP(pv, '=') || (pv.type === 'id' && /^(return|yield|default)$/.test(pv.value)) || (isP(pv, '(') && isP(t[i - 2], '=>')));
        const descOk = typeof v.description === 'string' || o.unknownKeys.has('description') || o.partialKeys.has('description');
        // other keys than inputSchema only count with a description, so config objects are not taken for tools
        if (key && name && reach && (key === 'inputSchema' || key === 'input_schema' || descOk)) {
          const tool = toolFromObject(o, name, tok.start);
          if (!tool) continue;
          const bound = isP(t[i - 1], '=') && t[i - 2] && t[i - 2].type === 'id' && t[i - 3] && /^(const|let|var)$/.test(t[i - 3].value) ? t[i - 2].value : null;
          const literalExact = o.exact && !o.sawZod && (key === 'inputSchema' || key === 'input_schema') && !(tool._unreadable && tool._unreadable.length);
          const arr = isP(pv, '[') || isP(pv, ',') ? parentOf(i) : -1;
          if (add(tool, literalExact ? 'literal' : 'derived', tok.start, Object.assign({ binding: bound, literal: true }, arr >= 0 && isP(t[arr], '[') ? { inList: arr } : {}))) i = o.end - 1;
        }
      }
      } catch (e) { const f = isP(tok, '.') ? t[i + 1] : tok; if (f && f.type === 'id' && (SDK_CALLS.has(f.value) || TOOLISH.test(f.value)) && isP(t[isP(tok, '.') ? i + 2 : i + 1], '(')) overBudget.push({ line: lineOf(tok.start), why: 'error' }); } finally {
        LOST.cur = null;
        // what this registration could not keep goes with its tools (and unnamed registrations), to be scanned
        if (iterLost.length) { for (let k = toolsBefore; k < tools.length; k++) tools[k].tool._lost = iterLost; for (let k = unresBefore; k < unresolved.length; k++) unresolved[k].lost = iterLost; }
      }
    }
    if (opts.classTools && opts.classTools.size) { let ct = []; try { ct = classTools(t, ctx, opts.classTools); } catch (e) { ct = []; overBudget.push({ line: null, why: 'error' }); } finally { LOST.cur = null; } ct.forEach((x) => add(x.tool, 'derived', x.at, { classTool: true, groupPath: opts.classTools.root ? opts.classTools.root.get(x.base) : undefined })); }
    tools.unresolved = unresolved; tools.overBudget = overBudget;
    return tools;
  }
  // Tools written as classes whose base class registers them (server.registerTool(this.name, …)):
  //   class MeasureTool extends BaseTool { readonly name = 'measure_tool'; description = '…'; annotations = {…}; constructor() { super({ inputSchema: S }) } }
  //   class LookupTool extends RecordToolBase { static toolName = "lookup"; … }
  // Read only when the repository registers tools through `this` (opts.classTools).
  function classTools(t, ctx, bases) {
    const out = [];
    for (let i = 0; i < t.length - 3; i++) {
      if (!(t[i].type === 'id' && t[i].value === 'class' && t[i + 1].type === 'id')) continue;
      let k = i + 2; if (!(t[k] && t[k].type === 'id' && t[k].value === 'extends')) continue;
      let b = k + 1; while (isP(t[b + 1], '.') && t[b + 2] && t[b + 2].type === 'id') b += 2;
      if (!t[b] || !bases.has(t[b].value)) continue;
      LOST.cur = []; // what this class's fields could not keep
      while (t[k] && !isP(t[k], '{')) { if (isP(t[k], '<')) { let d = 0; for (; k < t.length; k++) { if (isP(t[k], '<')) d++; else if (isP(t[k], '>')) { d--; if (!d) break; } } } k++; }
      if (!isP(t[k], '{')) continue;
      const open = k; const close = matchClose(t, open);
      const fields = {}; const fieldTok = {};
      // members at the class body's own depth
      for (let m = open + 1, d = 0; m < close; m++) {
        const x = t[m];
        if (isP(x, '{') || isP(x, '(') || isP(x, '[')) { d++; continue; } if (isP(x, '}') || isP(x, ')') || isP(x, ']')) { d--; continue; }
        if (d !== 0 || x.type !== 'id') continue;
        let n = m; while (t[n] && t[n].type === 'id' && /^(readonly|static|public|protected|private|override|declare)$/.test(t[n].value)) n++;
        const key = t[n]; if (!key || key.type !== 'id') continue;
        let e = n + 1; if (isP(t[e], '?') || isP(t[e], '!')) e++;
        if (isP(t[e], ':')) e = skipType(t, e + 1);
        if (!isP(t[e], '=')) continue;
        if (!/^(name|toolName|TOOL_NAME|description|title|annotations|inputSchema|schema|parameters|argsShape|paramsSchema|outputSchema)$/.test(key.value)) continue;
        fields[key.value] = parseValue(t, e + 1, ctx); fieldTok[key.value] = e + 1;
        m = Math.max(m, fields[key.value].end - 1);
      }
      const nf = fields.name || fields.toolName || fields.TOOL_NAME;
      if (!nf || typeof nf.value !== 'string' || nf.partial) continue;
      if (!['description', 'inputSchema', 'schema', 'parameters', 'argsShape', 'paramsSchema', 'annotations'].some((x) => fields[x]) && !t.slice(open, close).some((x, n) => x.type === 'id' && x.value === 'super' && isP(t[open + n + 1], '('))) continue;
      const tool = { name: nf.value }; const un = [];
      if (fields.title && typeof fields.title.value === 'string') tool.title = fields.title.value;
      if (fields.description && typeof fields.description.value === 'string') { tool.description = fields.description.value; if (fields.description.partial) un.push('description'); } else un.push('description');
      // the schema: a field, or super({ inputSchema: X }) in the constructor
      let sv = ['inputSchema', 'schema', 'parameters', 'paramsSchema', 'argsShape'].map((x) => fields[x]).find((x) => x && x.value !== SKIP);
      if (!sv) {
        for (let m = open + 1; m < close; m++) {
          if (t[m].type === 'id' && t[m].value === 'super' && isP(t[m + 1], '(') && isP(t[m + 2], '{')) {
            const o = parseObjectWithZod(t, m + 2, ctx); const v = o.value && o.value !== SKIP ? o.value : {};
            const sk = SCHEMA_KEYS.find((x) => v[x] && typeof v[x] === 'object'); if (sk) sv = { value: v[sk] };
            if (!fields.outputSchema && v.outputSchema) fields.outputSchema = { value: v.outputSchema };
            break;
          }
        }
      }
      if (sv && sv.value && typeof sv.value === 'object' && !Array.isArray(sv.value)) tool.inputSchema = sv.rawShape || (!isSchemaObj(sv.value) && !sv.zod) ? rootSchema(sv.value, sv.optionalKeys, ctx.fl) : sv.value;
      else { tool.inputSchema = { type: 'object' }; un.push('inputSchema'); }
      if (fields.annotations && fields.annotations.value && fields.annotations.value !== SKIP && typeof fields.annotations.value === 'object') tool.annotations = fields.annotations.value; else un.push('annotations');
      if (fields.outputSchema && fields.outputSchema.value && fields.outputSchema.value !== SKIP && typeof fields.outputSchema.value === 'object') tool.outputSchema = fields.outputSchema.value;
      if (ctx.fl.execution) tool.execution = { taskSupport: 'forbidden' };
      tool._unreadable = un;
      if (LOST.cur.length) tool._lost = LOST.cur;
      out.push({ tool, at: t[fieldTok.name || fieldTok.toolName || fieldTok.TOOL_NAME].start, base: t[b].value });
    }
    return out;
  }
  // Token index where each argument of the call whose "(" is at token `open` starts.
  function argStarts(t, open) {
    const close = matchClose(t, open); const out = []; let k = open + 1;
    while (k < close) { out.push(k); k = skipExpr(t, k); if (isP(t[k], ',')) k++; else break; }
    return out;
  }
  // Functions of one file that pass their own parameters on to X.registerTool(...) or X.tool(...):
  //   function register(server, name, config, fn) { server.registerTool(name, config, wrap(fn)); }
  //   const reg = (name, config, cb) => server.registerTool(name, config, cb);
  //   export function registerTool<T>(server, name, config, cb) { return server.registerTool(name, config as never, …); }
  //   function registerTool(server, name, description, params, cb) { server.tool(name, description, params, …); }
  //   const registerTool = (server, tool) => { server.tool(tool.name, tool.description, tool.params, tool.handler); };
  // Returns Map(function name -> spec): spec.kind is 'registerTool' (slots name, cfg) or 'tool' (slots name, desc,
  // shape); each slot is { p: the parameter's position, key: a property of that parameter or undefined }. A helper may
  // be named like the SDK method it wraps (registerTool): only its declaration makes it a helper.
  function skipTypeParams(t, k) { // the token after a TS type parameter list <…> at k (k itself when there is none)
    if (!isP(t[k], '<')) return k;
    let d = 0;
    for (let m = k; m < t.length && m < k + 400; m++) {
      if (isP(t[m], '<')) d++;
      else if (isP(t[m], '>')) { d--; if (!d) return m + 1; }
      else if (isP(t[m], '{') || isP(t[m], '(') || isP(t[m], '[')) m = matchClose(t, m);
    }
    return k;
  }
  function registerWrappers(t) {
    const out = new Map();
    const params = (open) => { // simple identifiers, with optional TS types and defaults; null if anything else
      const ps = []; for (const a of argStarts(t, open)) { const x = t[a]; if (!x || x.type !== 'id') return null; ps.push(x.value); } return ps;
    };
    // parameters typed as the SDK's server (server: McpServer), which make X.tool(…) on them the SDK's method
    const serverParams = (open) => {
      const out = new Set();
      argStarts(t, open).forEach((a) => {
        if (!t[a] || !isP(t[a + 1], ':')) return;
        for (let m = a + 2, d = 0; m < t.length; m++) {
          if (isP(t[m], '<') || isP(t[m], '(') || isP(t[m], '[') || isP(t[m], '{')) d++;
          else if (isP(t[m], '>') || isP(t[m], ')') || isP(t[m], ']') || isP(t[m], '}')) { if (!d) break; d--; }
          else if (!d && (isP(t[m], ',') || isP(t[m], '='))) break;
          else if (t[m].type === 'id' && t[m].value === 'McpServer') { out.add(t[a].value); break; }
        }
      });
      return out;
    };
    // X.tool(…) is the SDK's tool() only in a file that imports the MCP SDK, or on a parameter typed McpServer: a
    // .tool() method of another library (a CLI builder, an AI SDK) is not a register helper.
    const sdkFile = t.some((x) => x.type === 'str' && /^@modelcontextprotocol\//.test(x.value));
    // the functions that could be helpers: name, parameters and body range
    const fns = [];
    for (let i = 0; i < t.length - 3; i++) {
      let name = null; let open = -1;
      if (t[i].type === 'id' && t[i].value === 'function' && t[i + 1] && t[i + 1].type === 'id') { const k = skipTypeParams(t, i + 2); if (isP(t[k], '(')) { name = t[i + 1].value; open = k; } }
      else if (t[i].type === 'id' && /^(const|let|var)$/.test(t[i].value) && t[i + 1] && t[i + 1].type === 'id' && isP(t[i + 2], '=')) {
        let k = i + 3; if (t[k] && t[k].type === 'id' && t[k].value === 'async') k++;
        k = skipTypeParams(t, k);
        if (isP(t[k], '(') && isP(t[matchClose(t, k) + 1], '=>')) { name = t[i + 1].value; open = k; }
      }
      if (!name) continue;
      const ps = params(open); if (!ps || ps.length < 2) continue;
      // the body: from the closing ")" to the end of the block or the arrow's expression
      let b = matchClose(t, open) + 1; if (isP(t[b], '=>')) b++;
      while (t[b] && !isP(t[b], '{') && !(t[b].type === 'id' || isP(t[b], '('))) b++; // skip a TS return type
      const end = isP(t[b], '{') ? matchClose(t, b) : skipExpr(t, b);
      fns.push({ name, ps, b, end, open });
    }
    if (!fns.length) return out;
    // nested ranges: each function's parent, so a call finds the functions around it by a search and a short walk up
    fns.sort((x, y) => x.b - y.b); const stack = [];
    fns.forEach((f) => { while (stack.length && stack[stack.length - 1].end < f.b) stack.pop(); f.parent = stack.length ? stack[stack.length - 1] : null; stack.push(f); });
    // an argument that is a parameter, or a property of one (tool.name), with an optional `as T` cast after it: the
    // parameter's name and the property, or null
    const fwd = (a) => {
      const x = t[a]; if (!x || x.type !== 'id') return null;
      let k = a + 1; let key;
      if (isP(t[k], '.') && t[k + 1] && t[k + 1].type === 'id') { key = t[k + 1].value; k += 2; }
      while (t[k] && t[k].type === 'id' && (t[k].value === 'as' || t[k].value === 'satisfies')) k = skipType(t, k + 1);
      if (!(isP(t[k], ',') || isP(t[k], ')'))) return null;
      return { id: x.value, key };
    };
    for (let k = 0; k < t.length - 2; k++) {
      if (!(isP(t[k], '.') && t[k + 1].type === 'id' && (t[k + 1].value === 'registerTool' || t[k + 1].value === 'tool') && isP(t[k + 2], '('))) continue;
      const kind = t[k + 1].value;
      const as = argStarts(t, k + 2);
      const want = kind === 'registerTool' ? 2 : 3;
      if (as.length < want + (kind === 'tool' ? 1 : 0)) continue; // server.tool(name, description, shape, cb)
      const slots = as.slice(0, want).map(fwd);
      if (slots.some((x) => !x)) continue;
      // one parameter's properties (tool.name, tool.description, …) or the parameters themselves, not a mix
      const keyed = slots.filter((x) => x.key !== undefined).length;
      if (keyed && (keyed !== slots.length || slots.some((x) => x.id !== slots[0].id))) continue;
      let lo = 0; let hi = fns.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (fns[mid].b <= k) lo = mid + 1; else hi = mid; }
      for (let f = lo > 0 ? fns[lo - 1] : null, n = 0; f && n < 64; f = f.parent) {
        if (f.end < k) continue;
        n++;
        if (out.has(f.name)) continue;
        const pos = slots.map((x) => f.ps.indexOf(x.id));
        if (pos.some((x) => x < 0)) continue;
        if (kind === 'tool' && !sdkFile && !(t[k - 1] && t[k - 1].type === 'id' && serverParams(f.open).has(t[k - 1].value))) continue;
        const sl = slots.map((x, m) => ({ p: pos[m], key: x.key }));
        out.set(f.name, kind === 'registerTool' ? { kind, name: sl[0], cfg: sl[1], nameIdx: sl[0].p, cfgIdx: sl[1].p } : { kind, name: sl[0], desc: sl[1], shape: sl[2] });
      }
    }
    return out;
  }
  function findKeyToken(t, from, to, key) { return keyAtTop(t, from, to, key); }
  // A raw shape { a: <schema>, b: <schema> } rather than a schema (no type, $ref, composition or properties keyword).
  // A JSON Schema rather than a raw shape: a keyword with a schema value ("type": "string", "$ref", anyOf, …). A raw
  // shape can have a property named "type" whose value is a schema ({ type: z.enum([...]) }).
  function isSchemaObj(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
    const typeKw = typeof s.type === 'string' || (Array.isArray(s.type) && s.type.every((x) => typeof x === 'string'));
    return typeKw || typeof s.$ref === 'string' || Array.isArray(s.anyOf) || Array.isArray(s.oneOf) || Array.isArray(s.allOf) || Array.isArray(s.enum) || (!!s.properties && typeof s.properties === 'object' && Object.keys(s).every((k) => /^(properties|required|additionalProperties|\$schema|\$defs|definitions|title|description)$/.test(k)));
  }
  // A raw shape { a: <schema>, b: <schema> } (or {}, no arguments) rather than a schema.
  function isRawShape(s) { return !!s && typeof s === 'object' && !Array.isArray(s) && !isSchemaObj(s) && Object.values(s).every((x) => x && typeof x === 'object' && !Array.isArray(x)); }
  function isZodShapeLike(s) { return s && s.type === 'object' && s.properties; }
  function isAnnotations(s) { return s && Object.keys(s).some((k) => /Hint$/.test(k) || k === 'title'); }
  // Where zod is used in a file (a zod binding followed by ".", or .shape of a zod constant), as running counts, so
  // "is there zod between a and b" is answered without rescanning (cached per token array and constant table).
  const ZOD_PREFIX = new WeakMap();
  const OVERLAY_BASE = Symbol('overlay base'); // an overlay of constants shares the zod index of the constants under it
  function zodBetween(t, ctx, a, b) {
    let byConsts = ZOD_PREFIX.get(t); if (!byConsts) { byConsts = new WeakMap(); ZOD_PREFIX.set(t, byConsts); }
    const key = (ctx.consts && ctx.consts[OVERLAY_BASE]) || ctx.consts || ZOD_PREFIX; let pre = byConsts.get(key);
    if (!pre) {
      pre = new Int32Array(t.length + 1);
      for (let k = 0; k < t.length; k++) {
        const z = (t[k].type === 'id' && ctx.zodNames && (ctx.zodNames.has(t[k].value) || (ctx.zodNames.has(t[k].value + '.') && t[k + 2] && t[k + 2].value === 'z')) && isP(t[k + 1], '.'))
          || (t[k].type === 'id' && t[k].value === 'shape' && isP(t[k - 1], '.') && t[k - 2] && t[k - 2].type === 'id' && ctx.consts && ctx.consts[t[k - 2].value] && ctx.consts[t[k - 2].value].zod);
        pre[k + 1] = pre[k] + (z ? 1 : 0);
      }
      byConsts.set(key, pre);
    }
    return pre[Math.min(b, t.length)] - pre[Math.max(0, a)] > 0;
  }
  // The token of `key:` at the first level of the object at i (stepping over nested brackets), or -1.
  function keyAtTop(t, i, end, key) {
    for (let k = i + 1; k < end; k++) {
      if (isP(t[k], '{') || isP(t[k], '[') || isP(t[k], '(')) { k = matchClose(t, k); continue; }
      if ((t[k].type === 'id' || t[k].type === 'str') && t[k].value === key && isP(t[k + 1], ':')) return k;
    }
    return -1;
  }
  function parseObjectWithZod(t, i, ctx) {
    const r = parseObject(t, i, ctx);
    // a zod value anywhere in the object (or the .shape of a zod constant) makes it derived
    const sawZod = zodBetween(t, ctx, i, r.end);
    // inputSchema given as a raw zod shape { a: z.string() } (registerTool): wrap as an object schema
    if (r.value && r.value !== SKIP) {
      const fl = ctx.fl || FL_DEFAULT;
      ['inputSchema', 'outputSchema'].forEach((key) => {
        const s = r.value[key];
        if (sawZod && s && typeof s === 'object' && !isSchemaObj(s)) {
          // find the key in tokens to recover optional flags
          const k = keyAtTop(t, i, r.end, key); if (k >= 0) { const sh = zodShapeAt(t, k + 2, ctx); if (sh.schema) r.value[key] = sh.schema; }
        } else if (sawZod && s && s.type === 'object' && !s.$schema) { r.value[key] = Object.assign({}, s, DIALECT[fl.dialect] ? { $schema: DIALECT[fl.dialect] } : {}, fl.closed && s.additionalProperties === undefined ? { additionalProperties: false } : {}); }
      });
    }
    r.sawZod = sawZod;
    return r;
  }

  // ------------------------------------------------------------ Python source: comments, logical lines, expressions
  // Comments blanked to spaces (strings kept, line breaks kept), so offsets and line numbers stay as in the file.
  function pyStripComments(src) {
    let out = ''; let i = 0; const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '#') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; out += ' '.repeat(end - i); i = end; continue; }
      if (c === '"' || c === "'") {
        const triple = src.substr(i, 3) === c + c + c; const q = triple ? c + c + c : c; let j = i + q.length;
        while (j < n) { if (src[j] === '\\') { j += 2; continue; } if (src.substr(j, q.length) === q) { j += q.length; break; } if (!triple && src[j] === '\n') break; j++; }
        out += src.slice(i, j); i = j; continue;
      }
      out += c; i++;
    }
    return out;
  }
  // Logical lines of comment-free Python: brackets and backslashes join physical lines. { text, line, indent, start }
  function pyLogicalLines(s) {
    const out = []; let i = 0; const n = s.length; let start = 0; let line = 1; let startLine = 1; let depth = 0;
    const flush = (end) => { const text = s.slice(start, end); if (text.trim()) out.push({ text, line: startLine + (s.slice(start, end).match(/^\s*\n/g) ? 0 : 0), indent: text.search(/\S/) - (text.lastIndexOf('\n', text.search(/\S/)) + 1), start }); };
    while (i < n) {
      const c = s[i];
      if (c === '"' || c === "'") {
        const triple = s.substr(i, 3) === c + c + c; const q = triple ? c + c + c : c; let j = i + q.length;
        while (j < n) { if (s[j] === '\\') { if (s[j + 1] === '\n') line++; j += 2; continue; } if (s.substr(j, q.length) === q) { j += q.length; break; } if (s[j] === '\n') { if (!triple) break; line++; } j++; }
        i = j; continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
      else if (c === '\\' && s[i + 1] === '\n') { i += 2; line++; continue; }
      else if (c === '\n') {
        line++;
        if (depth === 0) { flush(i); start = i + 1; startLine = line; }
      }
      i++;
    }
    flush(n);
    // the line of each logical line: its first non-blank character
    let pos = 0; let ln = 1;
    out.forEach((l) => { const k = l.text.search(/\S/); const at = l.start + k; for (; pos < at; pos++) if (s.charCodeAt(pos) === 10) ln++; l.line = ln; l.text = l.text.slice(k); });
    return out;
  }
  // Python expression tokens: str (value), tpl (an f-string with {…} parts), num, id, p.
  // One escape sequence of a Python string at s[j] === '\\': [the text it stands for, its length]. \xHH, octal, and in
  // str (not bytes) literals \uXXXX and \UXXXXXXXX, as Python decodes them; \N{NAME} and any unknown escape are kept as
  // written (Python keeps the backslash of an unknown escape) (R-RD-07).
  const PY_ESC = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '\n': '' };
  function pyEscape(s, j, bytes) {
    const e = s[j + 1]; let m;
    if (e === undefined) return ['\\', 1];
    if (hasOwn(PY_ESC, e)) return [PY_ESC[e], 2];
    if (e === '\r') return ['', s[j + 2] === '\n' ? 3 : 2];
    if (e === 'x' && (m = /^[0-9a-fA-F]{2}/.exec(s.substr(j + 2, 2)))) return [String.fromCharCode(parseInt(m[0], 16)), 4];
    if (e >= '0' && e <= '7') { m = /^[0-7]{1,3}/.exec(s.substr(j + 1, 3)); return [String.fromCharCode(parseInt(m[0], 8)), 1 + m[0].length]; }
    if (!bytes && e === 'u' && (m = /^[0-9a-fA-F]{4}/.exec(s.substr(j + 2, 4)))) return [String.fromCharCode(parseInt(m[0], 16)), 6];
    if (!bytes && e === 'U' && (m = /^[0-9a-fA-F]{8}/.exec(s.substr(j + 2, 8)))) { const cp = parseInt(m[0], 16); if (cp <= 0x10ffff) return [String.fromCodePoint(cp), 10]; }
    return ['\\' + e, 2];
  }
  // The body of a plain (non-raw) Python string, escapes decoded.
  function pyUnescape(body) {
    if (body.indexOf('\\') < 0) return body;
    let out = ''; let j = 0;
    while (j < body.length) { if (body[j] === '\\') { const u = pyEscape(body, j, false); out += u[0]; j += u[1]; } else out += body[j++]; }
    return out;
  }
  const PY_PREFIX = /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/;
  function pyTokenize(s) {
    const t = []; let i = 0; const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === '#') { while (i < n && s[i] !== '\n') i++; continue; }
      if (/\s/.test(c) || (c === '\\' && s[i + 1] === '\n')) { i++; continue; }
      let pre = '';
      if (/[A-Za-z_]/.test(c)) { const m = /^[A-Za-z_]\w*/.exec(s.slice(i, i + 200)); if (PY_PREFIX.test(m[0]) && (s[i + m[0].length] === '"' || s[i + m[0].length] === "'")) pre = m[0]; else { t.push({ type: 'id', value: m[0], s: i, e: i + m[0].length }); i += m[0].length; continue; } }
      const q0 = s[i + pre.length];
      if (q0 === '"' || q0 === "'") {
        const raw = /r/i.test(pre); const f = /f/i.test(pre); const bytes = /b/i.test(pre); let j = i + pre.length;
        const triple = s.substr(j, 3) === q0 + q0 + q0; const q = triple ? q0 + q0 + q0 : q0; j += q.length;
        const parts = ['']; const exprs = [];
        while (j < n) {
          if (s[j] === '\\' && !raw) { const u = pyEscape(s, j, bytes); parts[parts.length - 1] += u[0]; j += u[1]; continue; }
          // raw: the backslash is kept, and only shields a quote or another backslash (in rf"…", "\{" still opens an expression)
          if (s[j] === '\\' && raw) { const two = s[j + 1] === q0 || s[j + 1] === '\\'; parts[parts.length - 1] += s.substr(j, two ? 2 : 1); j += two ? 2 : 1; continue; }
          if (s.substr(j, q.length) === q) { j += q.length; break; }
          if (!triple && s[j] === '\n') break;
          if (f && s[j] === '{') { if (s[j + 1] === '{') { parts[parts.length - 1] += '{'; j += 2; continue; } let d = 1; const es = j + 1; j++; while (j < n && d) { if (s[j] === '{') d++; else if (s[j] === '}') d--; j++; } exprs.push(s.slice(es, j - 1).replace(/[!:][^}]*$/, '').trim()); parts.push(''); continue; }
          if (f && s[j] === '}' && s[j + 1] === '}') { parts[parts.length - 1] += '}'; j += 2; continue; }
          parts[parts.length - 1] += s[j++];
        }
        t.push(exprs.length ? { type: 'tpl', value: parts.join('…'), parts, exprs, s: i, e: j } : { type: 'str', value: parts[0], s: i, e: j });
        i = j; continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) { const m = /^(0[xX][0-9a-fA-F_]+|[0-9_]*\.?[0-9_]+(?:[eE][+-]?[0-9]+)?)/.exec(s.slice(i, i + 40)); t.push({ type: 'num', value: Number(m[0].replace(/_/g, '')), s: i, e: i + m[0].length }); i += m[0].length; continue; }
      const two = s.substr(i, 2);
      if (['**', '//', '==', '!=', '<=', '>=', '->', ':=', '+=', '-='].includes(two)) { t.push({ type: 'p', value: two, s: i, e: i + 2 }); i += 2; continue; }
      t.push({ type: 'p', value: c, s: i, e: i + 1 }); i++;
    }
    return t;
  }
  const PY_SKIP = { skip: true };
  function pyMatch(t, i) { const c = bracketIndex(t)[i]; return c < 0 ? t.length : c; } // one pass over the tokens, cached
  function pySkip(t, i) { for (; i < t.length; i++) { const v = t[i].type === 'p' ? t[i].value : null; if (v === '(' || v === '[' || v === '{') { i = pyMatch(t, i); continue; } if (v === ')' || v === ']' || v === '}') return i; if (v === ',' || v === ':') return i; } return i; }
  // A constant of the file (or one imported, from the repository's unique module-level names): NAME, Enum.MEMBER(.value).
  function pyLookup(ctx, ids) {
    const c = ctx && ctx.consts; if (!c) return null;
    if (!hasOwn(c, ids[0])) return null;
    let v = c[ids[0]]; if (ctx.lostOf && ctx.lostOf[ids[0]]) lose(ctx.lostOf[ids[0]]);
    for (let k = 1; k < ids.length; k++) {
      if (v && typeof v === 'object' && !Array.isArray(v) && hasOwn(v, ids[k])) v = v[ids[k]];
      else if ((ids[k] === 'value') && (typeof v === 'string' || typeof v === 'number')) continue;
      else return null;
    }
    return { v };
  }
  function pyCallArgs(t, open) { // ( … ) -> { pos: [start], kw: { name: start } }
    const close = pyMatch(t, open); const pos = []; const kw = {}; let k = open + 1;
    while (k < close) {
      if (isP(t[k], '*') || isP(t[k], '**')) { k = pySkip(t, k + 1); if (isP(t[k], ',')) k++; continue; }
      if (t[k].type === 'id' && isP(t[k + 1], '=')) { kw[t[k].value] = k + 2; k = pySkip(t, k + 2); } else { pos.push(k); k = pySkip(t, k); }
      if (isP(t[k], ',')) k++; else break;
    }
    return { pos, kw, close };
  }
  // A Python expression's value when it is knowable statically: strings (adjacent, "+", f-strings with constant parts,
  // dedent(…), .strip()), numbers, True/False/None, lists, tuples, dicts, dict(...), ToolAnnotations(...), constants.
  let pyNest = 0;
  function pyValue(t, i, ctx) {
    const tok = t[i]; if (!tok) return { value: PY_SKIP, end: i };
    if (pyNest >= MAX_NEST) return { value: PY_SKIP, end: pySkip(t, i) }; // not read past MAX_NEST: the caller keeps its text (lose)
    pyNest++; try { return pyValueOnce(t, i, ctx, tok); } finally { pyNest--; }
  }
  function pyValueOnce(t, i, ctx, tok) {
    let r = null;
    if (tok.type === 'str' || tok.type === 'tpl' || (tok.type === 'id' && !isP(t[i + 1], '('))) {
      let out = ''; let exact = true; let any = false; let j = i; let ok = true;
      for (;;) {
        const x = t[j];
        if (x && x.type === 'str') { out += x.value; any = true; j++; }
        else if (x && x.type === 'tpl') { any = true; x.exprs.forEach((e, k) => { if (k === 0) out += x.parts[0]; const ids = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(e) ? pyLookup(ctx, e.split('.')) : null; if (ids && (typeof ids.v === 'string' || typeof ids.v === 'number')) out += ids.v; else { out += '…'; exact = false; } out += x.parts[k + 1]; }); j++; }
        else if (x && x.type === 'id' && !/^(True|False|None|not|and|or|in|is|if|else|lambda)$/.test(x.value)) {
          const ids = [x.value]; let m = j + 1; while (isP(t[m], '.') && t[m + 1] && t[m + 1].type === 'id') { ids.push(t[m + 1].value); m += 2; }
          if (isP(t[m], '(') || isP(t[m], '[')) { ok = false; break; }
          const lv = pyLookup(ctx, ids);
          if (lv && (typeof lv.v === 'string' || typeof lv.v === 'number')) { out += lv.v; any = any || typeof lv.v === 'string'; if (ctx.partialNames && ctx.partialNames.has(ids.join('.'))) exact = false; }
          else if (lv && j === i && (isP(t[m], ',') || isP(t[m], ')') || isP(t[m], ']') || isP(t[m], '}') || !t[m])) { return { value: lv.v, end: m, exact: true }; }
          else { out += '…'; exact = false; if (!ctx.prefixOk || !/prefix|namespace|(^|_)ns$/i.test(ids[ids.length - 1])) ok = ok && true; r = r || { unresolvedIds: ids }; }
          j = m;
        } else break;
        if (out.length > MAX_STR) { lose(out.slice(MAX_STR)); out = out.slice(0, MAX_STR) + '…'; exact = false; }
        // .strip() and friends on a string
        while (isP(t[j], '.') && t[j + 1] && /^(strip|lstrip|rstrip)$/.test(t[j + 1].value) && isP(t[j + 2], '(') && isP(t[j + 3], ')')) { out = t[j + 1].value === 'strip' ? out.trim() : t[j + 1].value === 'lstrip' ? out.replace(/^\s+/, '') : out.replace(/\s+$/, ''); j += 4; }
        if (isP(t[j], '.') && t[j + 1] && t[j + 1].value === 'format') { exact = false; j = pyMatch(t, j + 2) + 1; }
        if (isP(t[j], '+') && t[j + 1] && /^(str|tpl|id)$/.test(t[j + 1].type)) { j++; continue; }
        if (t[j] && (t[j].type === 'str' || t[j].type === 'tpl')) continue; // implicit concatenation
        break;
      }
      if (ok && any) return { value: out, end: j, exact, partial: !exact, unresolvedIds: r && r.unresolvedIds };
      if (!ok || !any) r = null;
    }
    if (tok.type === 'num') r = { value: tok.value, end: i + 1, exact: true };
    else if (isP(tok, '-') && t[i + 1] && t[i + 1].type === 'num') r = { value: -t[i + 1].value, end: i + 2, exact: true };
    else if (tok.type === 'id' && /^(True|False|None)$/.test(tok.value)) r = { value: tok.value === 'None' ? null : tok.value === 'True', end: i + 1, exact: true };
    else if (isP(tok, '[') || isP(tok, '(')) {
      const close = pyMatch(t, i); const a = []; let k = i + 1; let exact = true; let comma = false;
      // [*OTHER, x]: unpacks a list the reader may not know, so the list's length is unknown and the list is not read
      // (a list with the unpacked part left out would be read as a shorter enum or required list than the real one)
      for (let q = i + 1; q < close; q = pySkip(t, q) + 1) { if ((isP(t[q], '*') || isP(t[q], '**')) && (isP(t[q - 1], tok.value) || isP(t[q - 1], ','))) { lose(literalsArr(t, i, close + 1)); return { value: PY_SKIP, end: close + 1 }; } if (!isP(t[pySkip(t, q)], ',')) break; }
      while (k < close) { const v = pyValue(t, k, ctx); if (v.value === PY_SKIP) { exact = false; const e2 = pySkip(t, k); lose(literalsArr(t, k, e2)); k = e2; } else { a.push(v.value); exact = exact && v.exact !== false; k = v.end; } if (isP(t[k], ',')) { comma = true; k++; } else break; }
      if (k >= close || isP(t[k], tok.value === '[' ? ']' : ')')) r = isP(tok, '(') && !comma && a.length === 1 ? { value: a[0], end: close + 1, exact } : { value: a, end: close + 1, exact };
    } else if (isP(tok, '{')) {
      const close = pyMatch(t, i); const o = {}; let k = i + 1; let exact = true;
      while (k < close) {
        const kv = pyValue(t, k, ctx); if (kv.value === PY_SKIP || typeof kv.value !== 'string' || !isP(t[kv.end], ':')) { exact = false; lose(literalsArr(t, k, close)); break; }
        const v = pyValue(t, kv.end + 1, ctx); if (v.value === PY_SKIP) { exact = false; const e2 = pySkip(t, kv.end + 1); lose(literalsArr(t, kv.end + 1, e2)); k = e2; } else { o[kv.value] = v.value; exact = exact && v.exact !== false; k = v.end; }
        if (isP(t[k], ',')) k++; else break;
      }
      r = { value: o, end: close + 1, exact };
    } else if (tok.type === 'id' && isP(t[i + 1], '(') || (tok.type === 'id' && isP(t[i + 1], '.'))) {
      const ids = [tok.value]; let m = i + 1; while (isP(t[m], '.') && t[m + 1] && t[m + 1].type === 'id') { ids.push(t[m + 1].value); m += 2; }
      const fn = ids[ids.length - 1];
      if (isP(t[m], '(')) {
        const a = pyCallArgs(t, m);
        if (fn === 'dict' || fn === 'ToolAnnotations') { const o = {}; let exact = true; Object.keys(a.kw).forEach((k) => { const v = pyValue(t, a.kw[k], ctx); if (v.value !== PY_SKIP) o[k] = v.value; else exact = false; }); r = { value: o, end: a.close + 1, exact, call: fn }; }
        else if ((fn === 'dedent' || fn === 'cleandoc') && a.pos.length === 1) { const v = pyValue(t, a.pos[0], ctx); if (typeof v.value === 'string') r = { value: dedentPy(v.value), end: a.close + 1, exact: v.exact, partial: v.partial }; }
        if (r) { let j = r.end; while (isP(t[j], '.') && t[j + 1] && /^(strip|lstrip|rstrip)$/.test(t[j + 1].value) && isP(t[j + 2], '(') && isP(t[j + 3], ')')) { if (typeof r.value === 'string') r.value = r.value.trim(); j += 4; } r.end = j; }
      }
    }
    if (r) return r;
    return { value: PY_SKIP, end: pySkip(t, i) };
  }
  function dedentPy(s) { const ls = s.split('\n'); const ind = Math.min(...ls.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length).concat([1e9])); return ls.map((l) => (ind < 1e9 ? l.slice(ind) : l)).join('\n'); }
  // Module-level constants of a Python file and the members of its classes (Enum and constant holders):
  // { NAME: value, Cls: { MEMBER: value } }, plus `partial` names (strings read in part) and the names it imports.
  function pyFileConsts(lines, globals) {
    const consts = {}; const partialNames = new Set(); const imported = new Set(); const lostOf = {};
    const ctx = { consts, partialNames, lostOf };
    lines.forEach((l) => { if (l.indent !== 0) return; const m = /^from\s+[\w.]+\s+import\b([\s\S]*)$/.exec(l.text); if (m) importNames(m[1]).split(',').forEach((x) => { const q = asParts(x); if (q[0]) imported.add((q[1] || q[0]).trim()); }); });
    if (globals) imported.forEach((n) => { if (hasOwn(globals, n)) consts[n] = globals[n]; });
    let cls = null;
    lines.forEach((l) => {
      if (l.indent === 0) {
        const c = /^class\s+(\w+)\s*(\(|:)/.exec(l.text);
        cls = c ? { name: c[1], members: {} } : null;
        if (cls) { consts[cls.name] = cls.members; return; }
        const m = /^([A-Za-z_]\w*)\s*(?::\s*[^=]+?)?=(?!=)\s*([\s\S]+)$/.exec(l.text);
        if (m) { try { const t = pyTokenize(m[2]); const [v, lost] = collecting(() => pyValue(t, 0, ctx)); if (v.value !== PY_SKIP && v.end >= t.length) { consts[m[1]] = v.value; if (v.partial) partialNames.add(m[1]); if (lost.length) lostOf[m[1]] = lost; } } catch (e) { /* not a constant the reader can use */ } }
        return;
      }
      if (cls && l.indent > 0) {
        const m = /^([A-Za-z_]\w*)\s*(?::\s*[^=]+?)?=(?!=)\s*([\s\S]+)$/.exec(l.text);
        if (m && l.indent <= 8) { try { const t = pyTokenize(m[2]); const v = pyValue(t, 0, ctx); if (v.value !== PY_SKIP && v.end >= t.length && (typeof v.value === 'string' || typeof v.value === 'number')) cls.members[m[1]] = v.value; } catch (e) { /* skip */ } }
      }
    });
    return { consts, partialNames, imported, lostOf };
  }

  // ------------------------------------------------------------ Python extraction (@x.tool decorated functions)
  // Mirrors the Python SDK's FastMCP/MCPServer output: properties get a title, the schema a "<fn>Arguments" title.
  function pyTitle(name) { return name.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' '); }
  function splitTop(s, sep) {
    const out = []; let d = 0; let cur = ''; let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { cur += c; if (c === '\\') { cur += s[++i] || ''; } else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--;
      if (c === sep && d === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur);
    return out.map((x) => x.trim());
  }
  function topLevelEq(s) {
    let d = 0; let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c; else if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--;
      else if (c === '=' && d === 0 && s[i + 1] !== '=' && s[i - 1] !== '=' && s[i - 1] !== '!' && s[i - 1] !== '<' && s[i - 1] !== '>') return i;
    }
    return -1;
  }
  // Deeper than 64 brackets: not read (a default or a type the reader leaves unknown), which keeps splitTop's
  // per-level work bounded and the read linear in the text.
  function tooDeep(s, max) { let d = 0; let q = null; for (let i = 0; i < s.length; i++) { const c = s[i]; if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; } if (c === '"' || c === "'") q = c; else if (c === '(' || c === '[' || c === '{') { if (++d > max) return true; } else if (c === ')' || c === ']' || c === '}') d--; } return false; }
  function pyLiteral(s) {
    s = s.trim();
    if (tooDeep(s, 64)) { lose(pyLiterals(s)); return null; }
    if (/^(["'])(?:\\.|(?!\1).)*\1$/.test(s)) return { v: pyUnescape(s.slice(1, -1)) };
    if (/^-?\d+$/.test(s)) return { v: parseInt(s, 10) };
    if (/^-?\d*\.\d+(e-?\d+)?$/i.test(s)) return { v: parseFloat(s) };
    if (s === 'True' || s === 'False') return { v: s === 'True' };
    if (s === 'None') return { v: null };
    if (/^[A-Za-z_]\w*$/.test(s) && Object.prototype.hasOwnProperty.call(PYC, s)) return { v: PYC[s] };
    if (/^\[.*\]$/.test(s)) { const items = splitTop(s.slice(1, -1), ',').map(pyLiteral); return items.every(Boolean) ? { v: items.map((x) => x.v) } : null; }
    return null;
  }
  function pyKwargs(argstr) { const o = {}; splitTop(argstr, ',').forEach((p) => { const m = /^(\w+)\s*=\s*([\s\S]+)$/.exec(p); if (m) o[m[1]] = m[2]; }); return o; }
  function pyType(tp) {
    tp = tp.trim();
    if (tooDeep(tp, 64)) { lose(pyLiterals(tp)); return { schema: {}, exact: false }; }
    let m;
    if ((m = /^Annotated\[([\s\S]+)\]$/.exec(tp))) {
      const parts = splitTop(m[1], ','); const s = pyType(parts[0]);
      parts.slice(1).forEach((p) => { const f = /^(?:Field|pydantic\.Field)\(([\s\S]*)\)$/.exec(p); if (f) { const kw = pyKwargs(f[1]); const d = kw.description && pyLiteral(kw.description); if (d) s.schema.description = d.v; const pos = splitTop(f[1], ',')[0]; if (pos && !/=/.test(pos)) { const dv = pyLiteral(pos); if (dv && pos !== '...') { s.default = dv.v; } } if (kw.default) { const dv = pyLiteral(kw.default); if (dv) s.default = dv.v; } pyConstraints(s.schema, kw); } else if (/^["']/.test(p)) { const d = pyLiteral(p); if (d) s.schema.description = d.v; } });
      return s;
    }
    if ((m = /^(?:Optional|typing\.Optional)\[([\s\S]+)\]$/.exec(tp))) { const s = pyType(m[1]); return { schema: { anyOf: [s.schema, { type: 'null' }] }, exact: s.exact, nullable: true }; }
    const union = splitTop(tp, '|');
    if (union.length > 1) { const parts = union.map(pyType); return { schema: { anyOf: parts.map((p) => p.schema) }, exact: parts.every((p) => p.exact) }; }
    if ((m = /^(?:Literal|typing\.Literal)\[([\s\S]+)\]$/.exec(tp))) { const vals = splitTop(m[1], ',').map(pyLiteral); if (vals.every(Boolean)) { const vs = vals.map((x) => x.v); const t0 = typeof vs[0] === 'string' ? 'string' : typeof vs[0] === 'number' ? (Number.isInteger(vs[0]) ? 'integer' : 'number') : typeof vs[0] === 'boolean' ? 'boolean' : null; return { schema: vs.length === 1 ? Object.assign({ const: vs[0] }, t0 ? { type: t0 } : {}) : Object.assign({ enum: vs }, t0 ? { type: t0 } : {}), exact: true }; } }
    if ((m = /^(?:list|List|Sequence|typing\.List|set|Set)\[([\s\S]+)\]$/.exec(tp))) { const it = pyType(m[1]); return { schema: { type: 'array', items: it.schema }, exact: it.exact }; }
    if ((m = /^(?:dict|Dict|Mapping)\[([\s\S]+)\]$/.exec(tp))) { const parts = splitTop(m[1], ','); const v = pyType(parts[1] || 'Any'); return { schema: { type: 'object', additionalProperties: v.schema }, exact: v.exact }; }
    const map = { str: 'string', int: 'integer', float: 'number', bool: 'boolean', list: 'array', dict: 'object', List: 'array', Dict: 'object', None: 'null' };
    if (map[tp]) return { schema: map[tp] === 'array' ? { type: 'array', items: {} } : map[tp] === 'object' ? { type: 'object', additionalProperties: true } : { type: map[tp] }, exact: true };
    if (tp === 'Any' || tp === 'typing.Any') return { schema: {}, exact: true };
    if (tp === 'datetime' || tp === 'datetime.datetime') return { schema: { type: 'string', format: 'date-time' }, exact: true };
    return { schema: {}, exact: false }; // a model or enum class: the SDK would emit a $ref into $defs
  }
  const CTX_TYPES = /^(Context|mcp\.server\.fastmcp\.Context|ServerContext|RequestContext)\b/;
  // Module-level NAME = <literal> constants of a Python file, so Field(default=DEFAULT_X) and gt=MIN_X resolve.
  let PYC = {};
  function pyConsts(src) {
    const out = {};
    src.split('\n').forEach((l) => { const m = /^([A-Za-z_]\w*)\s*(?::\s*[^=]+?)?=\s*(.+?)\s*(?:#.*)?$/.exec(l); if (!m) return; const v = pyLiteral(m[2]); if (v) out[m[1]] = v.v; });
    return out;
  }
  // The pydantic keyword constraints of Field(...) / Annotated[..., Field(...)] as JSON Schema keywords.
  function pyConstraints(schema, kw) {
    const arr = schema.type === 'array';
    [['ge', 'minimum'], ['le', 'maximum'], ['gt', 'exclusiveMinimum'], ['lt', 'exclusiveMaximum'], ['min_length', arr ? 'minItems' : 'minLength'], ['max_length', arr ? 'maxItems' : 'maxLength'], ['multiple_of', 'multipleOf'], ['pattern', 'pattern']].forEach(([a, b]) => { if (kw[a] !== undefined) { const n = pyLiteral(kw[a]); if (n) schema[b] = n.v; } });
  }
  // Python flavours: the SDK's FastMCP/MCPServer ("sdk": titles on properties and on the argument model) and the standalone
  // fastmcp package ("fastmcp": no titles, closed argument model, docstring Args become parameter descriptions, _meta.fastmcp.tags).
  function pyFlavour(src, opts) {
    const sdk = opts && opts.sdk && opts.sdk.py;
    if (/^[ \t]*from\s+mcp\.server\.(?:fastmcp|mcpserver)\b/m.test(src) || /^[ \t]*from\s+mcp\b/m.test(src)) return 'sdk';
    if (/^[ \t]*(?:from\s+fastmcp\b|import\s+fastmcp\b)/m.test(src)) return 'fastmcp';
    return sdk === 'fastmcp' ? 'fastmcp' : 'sdk';
  }
  // Google-style docstring: the text before "Args:" is the description; "name: text" lines under Args are parameter descriptions.
  function pyDocSections(doc) {
    const lines = String(doc || '').split('\n'); const head = []; const params = {}; let section = null; let cur = null;
    for (const l of lines) {
      const sec = /^(Args|Arguments|Parameters|Returns|Raises|Yields|Examples?|Notes?):\s*$/.exec(l.trim());
      if (sec && !/^\s{2,}/.test(l.replace(/^\t/, '    ')) || (sec && section === null)) { section = sec[1]; cur = null; continue; }
      if (section === null) { head.push(l); continue; }
      if (/^(Args|Arguments|Parameters)$/.test(section)) {
        const m = /^\s+(\w+)(?:\s*\([^)]*\))?\s*:\s*(.*)$/.exec(l);
        if (m && (cur === null || l.search(/\S/) <= (cur.indent))) { cur = { name: m[1], text: m[2].trim(), indent: l.search(/\S/) }; params[m[1]] = cur; }
        else if (cur && l.trim()) cur.text += '\n' + l.slice(cur.indent).replace(/\s+$/, '');
      }
    }
    const out = {}; Object.keys(params).forEach((k) => { out[k] = params[k].text; });
    return { description: head.join('\n').trim(), params: out, hasSections: section !== null };
  }
  // Python tools:
  //   @x.tool(...) / @x.tool                          the SDK's FastMCP / MCPServer and the standalone fastmcp (any server object)
  //   @tool(...), @<name>_tool(...)                   project decorators named like one, given a name, description or title
  //   @registry.<method>(...)                         methods of the repository that register a tool (opts.pyRegistrars)
  //   x.tool(fn, name=…), x.add_tool(fn, …), Tool.from_function(fn, …), *ToolDefinition(fn=…)   a function made a tool
  //   Tool(name=…, description=…, inputSchema={…}) / types.Tool(...)                            the low-level server's tools
  // Names come from literals, constants, Enum members (Tools.STATUS.value) and f-strings of constants.
  function extractPy(src, opts) {
    opts = opts || {};
    const flavour = pyFlavour(src, opts); const fmcp = flavour === 'fastmcp';
    const clean = pyStripComments(src);
    const L = pyLogicalLines(clean);
    const fc = pyFileConsts(L, opts.pyConsts || null);
    const ctx = { consts: fc.consts, partialNames: fc.partialNames, lostOf: fc.lostOf };
    PYC = {}; Object.keys(fc.consts).forEach((k) => { const v = fc.consts[k]; if (v === null || typeof v !== 'object') PYC[k] = v; });
    const usesMcp = /^[ \t]*(?:from|import)\s+(?:mcp|fastmcp)\b/m.test(clean) || /\bFastMCP\b|\bMCPServer\b/.test(clean);
    const registrars = opts.pyRegistrars || new Set();
    let templates = opts.pyTemplates || new Map();
    // a name this file imports from mcp or fastmcp (from fastmcp.tools import tool) is the SDK's, not a factory of the repository
    // read from logical lines, so a parenthesized import over several lines counts too (R-RD-21)
    const sdkNames = new Set(); L.forEach((l) => { if (l.indent !== 0) return; const im = /^from\s+(?:mcp|fastmcp)(?:\.[\w.]+)?\s+import\b([\s\S]*)$/.exec(l.text); if (im) importNames(im[1]).split(',').forEach((x) => { const q = asParts(x); if (q[0] && /^\w+$/.test(q[0])) sdkNames.add((q[1] || q[0]).trim()); }); });
    sdkNames.forEach((n) => { if (templates.has(n)) { templates = new Map(templates); templates.delete(n); } });
    const tplCall = templates.size ? new RegExp('(?:^|[^\\w.])(?:' + Array.from(templates.keys()).join('|') + ')\\s*\\(') : null;
    const tools = []; const seen = new Set(); const unresolved = []; const overBudget = [];
    const add = (tool, line, extra) => {
      if (!tool || typeof tool.name !== 'string' || !tool.name || seen.has(tool.name)) return;
      if (tool._unreadable && !tool._unreadable.length) delete tool._unreadable;
      seen.add(tool.name); tools.push(Object.assign({ tool, fidelity: 'derived', line }, extra || {}));
    };
    // every def of the file: name -> { index of its logical line }
    const defs = new Map();
    L.forEach((l, k) => { const m = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(l.text); if (m && !defs.has(m[1])) defs.set(m[1], k); });
    // The loop that binds name v around logical line k (for v in ITEMS: at the same function level), with ITEMS read as a
    // list of this file's functions: { items: [names] }, { items: null } when the loop is there but its items cannot be
    // known (not a literal list or tuple of names, a list changed after it is built, a name that is not a def of this
    // file, a registration under an if or after a continue/break/return/raise), or null when v is not a loop variable.
    const pyLoopOver = (k, v) => {
      const FOR = /^(?:async\s+)?for\s+([A-Za-z_]\w*)\s+in\s+([\s\S]+?)\s*:\s*([\s\S]*)$/;
      const fnScope = (q) => { // the def around logical line q: [first line, end) or [0, L.length) at module level
        let ind = L[q].indent; for (let r = q - 1; r >= 0; r--) { if (L[r].indent >= ind) continue; if (/^(?:async\s+)?(def|class)\s/.test(L[r].text.trim())) { let e = r + 1; while (e < L.length && L[e].indent > L[r].indent) e++; return [r + 1, e]; } ind = L[r].indent; }
        return [0, L.length];
      };
      const listOf = (expr, q) => {
        const ids = (txt) => { const m = /^[[(]([\s\S]*)[\])]$/.exec(txt.trim()); if (!m) return null; const parts = m[1].split(',').map((x) => x.trim()).filter(Boolean); return parts.length && parts.every((x) => /^[A-Za-z_]\w*$/.test(x)) ? parts : null; };
        let items = ids(expr);
        if (!items && /^[A-Za-z_]\w*$/.test(expr.trim())) {
          const name = expr.trim();
          const asg = new RegExp('^' + name + '\\s*(?::[^=]+)?=(?!=)\\s*([\\s\\S]+)$');
          const changed = new RegExp('(?:^|[^\\w.])' + name + '\\s*(?:\\.\\s*(?:append|extend|insert|remove|pop|clear|sort|reverse)\\s*\\(|\\[[^\\]]*\\]\\s*=(?!=)|[-+*|]=)|^del\\s+' + name + '\\b|^(?:global|nonlocal)\\s[^\\n]*\\b' + name + '\\b');
          // a change anywhere in the range (a function of the file appending to a module list included); assignments
          // only at the top level when topOnly
          const look = (a, b, topOnly) => { const hits = []; for (let r = a; r < b; r++) { const tx = L[r].text.trim(); if (changed.test(tx)) return null; if (topOnly && L[r].indent !== 0) continue; const m = asg.exec(tx); if (m) hits.push(m[1]); } return hits; };
          const [a, b] = fnScope(q);
          let hits = look(a, b, false); let moduleList = a === 0;
          if (hits && !hits.length && a > 0) { hits = look(0, L.length, true); moduleList = true; }
          if (!hits || hits.length !== 1) return null;
          // a module-level list another module of the repository may change (from server import tools; tools.append(f))
          if (moduleList && opts.pyChangedElsewhere && opts.pyChangedElsewhere(name)) return null;
          items = ids(hits[0]);
        }
        if (!items || items.some((x) => !defs.has(x))) return null;
        return items;
      };
      const here = FOR.exec(L[k].text.trim());
      if (here && here[1] === v && here[3]) return { items: listOf(here[2], k) }; // for v in X: mcp.add_tool(v)
      let ind = L[k].indent;
      for (let q = k - 1; q >= 0; q--) {
        const x = L[q]; if (x.indent >= ind) continue;
        const tx = x.text.trim(); const m = FOR.exec(tx);
        if (m && m[1] === v && !m[3]) {
          if (L[k].indent !== L[q + 1].indent) return { items: null }; // under an if or another block of the loop
          for (let r = q + 1; r < k; r++) if (/^(continue|break|return|raise)\b/.test(L[r].text.trim())) return { items: null };
          return { items: listOf(m[2], q) };
        }
        if (/^(?:async\s+)?(def|class)\s/.test(tx)) return null;
        ind = x.indent;
      }
      return null;
    };
    const exprVal = (text) => { const t = pyTokenize(text); const v = pyValue(t, 0, ctx); return v.value !== PY_SKIP && v.end >= t.length ? v : null; };
    // the name of a tool from its expression: a string, or a prefix variable + literal (namespace_prefix + "read" -> "read")
    const nameOf = (text) => {
      const v = exprVal(text);
      if (v && typeof v.value === 'string' && v.exact) return v.value;
      if (v && typeof v.value === 'string' && v.partial && /^…[^…]+$/.test(v.value) && v.unresolvedIds && /prefix|namespace|(^|_)ns$/i.test(v.unresolvedIds[v.unresolvedIds.length - 1])) return v.value.slice(1);
      return null;
    };
    // The class around logical line k, and what it passes as its name: super().__init__(X) or self.name = X.
    const classNameOf = (k) => {
      const ind = L[k].indent; let c = -1;
      for (let m = k - 1; m >= 0; m--) if (L[m].indent < ind && /^class\s+\w+/.test(L[m].text)) { c = m; break; } else if (L[m].indent === 0 && L[m].indent < ind && !/^class\b/.test(L[m].text)) break;
      if (c < 0) return null;
      for (let m = c + 1; m < L.length && L[m].indent > L[c].indent; m++) {
        const s1 = /^super\(\)\.__init__\(\s*([\s\S]*?)\s*(?:,[\s\S]*)?\)\s*$/.exec(L[m].text);
        const s2 = /^self\.(?:name|tool_name|_name)\s*(?::\s*\w+)?=\s*([\s\S]+)$/.exec(L[m].text);
        const e = s1 ? splitTop(s1[1], ',')[0] : s2 ? s2[1] : null;
        if (e) { const n = nameOf(e); if (n) return n; }
      }
      return null;
    };
    // A tool from a def (logical line index k) and what was given for it.
    const fromDef = (k, given) => {
      const head = L[k].text; const m = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(head); if (!m) return null;
      const open = head.indexOf('(', m[0].length - 1); let d = 0; let close = -1; let q = null;
      for (let x = open; x < head.length; x++) { const ch = head[x]; if (q) { if (ch === '\\') x++; else if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") q = ch; else if (ch === '(' || ch === '[' || ch === '{') d++; else if (ch === ')' || ch === ']' || ch === '}') { d--; if (!d) { close = x; break; } } }
      if (close < 0) return null;
      const fname = m[1]; const params = head.slice(open + 1, close);
      const rm = /^\s*(?:->\s*([\s\S]+?))?\s*:/.exec(head.slice(close + 1)); const ret = rm && rm[1] ? rm[1].trim() : null;
      // the docstring: the first statement of the body
      let doc = null; const nx = L[k + 1];
      const inline = head.slice(close + 1).replace(/^\s*(?:->[\s\S]+?)?:/, '').trim();
      const first = inline || (nx && nx.indent > L[k].indent ? nx.text : '');
      if (/^(?:[rRuU]{0,1})("""|'''|"|')/.test(first)) { const v = exprVal(first); if (v && typeof v.value === 'string') doc = dedent(v.value) + (/\n[ \t]*$/.test(v.value) ? '\n' : ''); }
      const props = {}; const required = []; let exact = true;
      splitTop(params, ',').forEach((p) => {
        if (!p || p === 'self' || p === 'cls' || p === '*' || p === '/' || /^\*\*?/.test(p)) { if (/^\*\*?\w/.test(p)) exact = false; return; }
        const eq = topLevelEq(p); const lhs = eq < 0 ? p : p.slice(0, eq); const def = eq < 0 ? undefined : p.slice(eq + 1).trim();
        const pm = /^(\w+)\s*(?::\s*([\s\S]+))?$/.exec(lhs.trim()); if (!pm) { exact = false; return; }
        const pn = pm[1]; const tp = pm[2];
        if (tp && CTX_TYPES.test(tp.trim())) return;
        if (!tp && /^(ctx|context)$/.test(pn)) return;
        const ty = tp ? pyType(tp) : { schema: {}, exact: false };
        if (tp && !ty.exact) lose(pyLiterals(tp)); // text in a type the reader cannot read (a model, a nested Literal)
        exact = exact && ty.exact;
        const sch = Object.assign({}, ty.schema); const ordered = {};
        if (ty.default !== undefined) ordered.default = ty.default;
        if (!fmcp) ordered.title = pyTitle(pn);
        const out = Object.assign({}, sch, ordered);
        let hasDefault = ty.default !== undefined;
        if (def !== undefined) {
          const field = /^(?:Field|pydantic\.Field)\(([\s\S]*)\)$/.exec(def.trim());
          if (!field) { const dv = pyLiteral(def); if (dv) out.default = dv.v; else { exact = false; lose(pyLiterals(def)); } hasDefault = true; } else {
            const fk = pyKwargs(field[1]); const pos = splitTop(field[1], ',')[0]; const posArg = pos && !/^\w+\s*=/.test(pos) ? pos : null;
            hasDefault = false;
            if (posArg !== null) { if (posArg !== '...') { hasDefault = true; const dv = pyLiteral(posArg); if (dv) out.default = dv.v; else exact = false; } }
            else if (fk.default !== undefined) { hasDefault = true; const dv = pyLiteral(fk.default); if (dv) out.default = dv.v; else exact = false; }
            else if (fk.default_factory !== undefined) { hasDefault = true; exact = false; }
            if (fk.description) { const dd = exprVal(fk.description); if (dd && typeof dd.value === 'string') out.description = dd.value; else { exact = false; lose(pyLiterals(fk.description)); } }
            if (fk.title && !fmcp) { const tt = pyLiteral(fk.title); if (tt) out.title = tt.v; }
            pyConstraints(out, fk);
          }
        }
        props[pn] = out; if (!hasDefault) required.push(pn);
      });
      const name = given.name !== undefined ? given.name : fname;
      if (typeof name !== 'string') return null;
      const tool = { name }; const un = [];
      if (typeof given.title === 'string') tool.title = given.title;
      const ds = fmcp && doc ? pyDocSections(doc) : null;
      if (given.description !== undefined) { if (typeof given.description === 'string') tool.description = given.description; else if (given.descriptionLiterals) tool.description = given.descriptionLiterals.slice(0, MAX_STR); if (given.descriptionPartial || given.description === null) un.push('description'); }
      else if (doc) tool.description = ds ? ds.description : doc;
      if (ds) Object.keys(props).forEach((pn) => { if (props[pn].description === undefined && ds.params[pn]) props[pn].description = ds.params[pn]; });
      tool.inputSchema = fmcp ? { properties: props, required: required.length ? required : undefined, type: 'object', additionalProperties: false } : { properties: props, required: required.length ? required : undefined, title: fname + 'Arguments', type: 'object' };
      if (!required.length) delete tool.inputSchema.required;
      if (ret && !/^None$/.test(ret) && given.structured !== false) {
        const rt = pyType(ret.replace(/^(?:Awaitable|Coroutine)\[[\s\S]*,\s*([\s\S]+)\]$/, '$1'));
        if (fmcp) {
          if (rt.exact && rt.schema.type === 'object') tool.outputSchema = { additionalProperties: true, type: 'object' };
          else if (rt.exact) tool.outputSchema = { properties: { result: rt.schema }, required: ['result'], type: 'object', 'x-fastmcp-wrap-result': true };
          else exact = false;
        } else if (rt.exact && !(rt.schema.type === 'object')) tool.outputSchema = { properties: { result: Object.assign({}, rt.schema, { title: 'Result' }) }, required: ['result'], title: fname + 'Output', type: 'object' };
        else if (!rt.exact) exact = false;
      }
      if (given.annotations !== undefined) { if (given.annotations) tool.annotations = given.annotations; else { exact = false; un.push('annotations'); } }
      else if (given.annotationsUnknown) un.push('annotations');
      if (fmcp && given.fastmcpTags !== false) { if (given.fastmcpTags === undefined) tool._meta = { fastmcp: { tags: [] } }; else exact = false; }
      tool._unreadable = un;
      return { tool, exactTypes: exact, fname };
    };
    // what a decorator or call gave: name=, description=, title=, annotations=, structured_output=, tags=
    const givenOf = (kw) => {
      const g = {};
      if (kw.name !== undefined) { const n = nameOf(kw.name); g.name = n; if (!n) g.nameUnknown = true; }
      if (kw.title !== undefined) { const v = exprVal(kw.title); if (v && typeof v.value === 'string') g.title = v.value; }
      if (kw.description !== undefined) { const v = exprVal(kw.description); if (v && typeof v.value === 'string') { g.description = v.value; if (v.partial) g.descriptionPartial = true; } else { g.description = null; g.descriptionLiterals = pyLiterals(kw.description); lose(g.descriptionLiterals); } }
      if (kw.annotations !== undefined) { const a = pyAnnotationsValue(kw.annotations); g.annotations = a; }
      else if (['read_only_hint', 'destructive_hint', 'idempotent_hint', 'open_world_hint'].some((k) => kw[k] !== undefined)) g.annotationsUnknown = true;
      if (kw.structured_output !== undefined && /^False$/.test(kw.structured_output.trim())) g.structured = false;
      if (kw.tags !== undefined) g.fastmcpTags = null;
      return g;
    };
    // keys as written under SDK 1.x, which keeps snake_case kwargs as extra fields; SDK 2.x lists them in camelCase
    const camel = opts.sdk && opts.sdk.pyMajor >= 2;
    const unresolvedText = (line, g) => { const o = { line }; const d = typeof g.description === 'string' ? g.description : g.descriptionLiterals; if (d) o.description = d; if (typeof g.title === 'string') o.title = g.title; return o; };
    const pyAnnotationsValue = (text) => {
      const v = exprVal(text);
      let a = v && v.value && typeof v.value === 'object' && !Array.isArray(v.value) ? v.value : pyAnnotations(text);
      if (a && camel) { const o = {}; Object.keys(a).forEach((k) => { o[/^(read_only|destructive|idempotent|open_world)_hint$/.test(k) ? k.replace(/_(\w)/g, (x, c) => c.toUpperCase()) : k] = a[k]; }); a = o; }
      return a || null;
    };
    // Tool dicts in one logical line (R-RD-01): a dict whose own keys include "name" (a string the reader can work out) and
    // "inputSchema" is a tool as a hand-rolled server lists it, wherever it stands (a TOOLS list, a return value, a
    // constant). "input_schema" is also the key of the Anthropic API's tool tables, so it counts only in a hand-rolled
    // server's file: one that answers "tools/list" and registers nothing through an SDK (a FastMCP file that also calls
    // the Anthropic API has such dicts too). A name the reader cannot work out (a parameter, an attribute, a name a
    // def's parameter or local shadows) is not a tool here: the dict is a template filled elsewhere. A file that uses an
    // MCP client (ClientSession, mcp.client, fastmcp's Client) is not read for dicts: its tool dicts describe another
    // server's tools (a gateway's or a test's copies).
    const handRolled = /["']tools\/list["']/.test(clean) && !/\b(?:FastMCP|MCPServer)\b|@[\w.]*\.tool\b|\.add_tool\s*\(|\bTool\s*\(/.test(clean);
    const mcpClient = /^[ \t]*(?:from\s+mcp(?:\.client[\w.]*)?\s+import\s+[^\n]*\b(?:ClientSession|Client|stdio_client|sse_client|streamablehttp_client)\b|from\s+fastmcp(?:\.client[\w.]*)?\s+import\s+[^\n]*\bClient\b|import\s+mcp\.client\b)/m.test(clean);
    // the names a def around logical line k binds (its parameters and the names its body assigns): they shadow constants
    // Each def's names are found once and each line's enclosing lines come from one pass, so a def with many dict
    // lines is read in linear time (R-RD-23).
    let encl = null; const defNames = new Map();
    const namesOfDef = (m) => {
      if (defNames.has(m)) return defNames.get(m);
      let out = null;
      const d = /^(?:async\s+)?def\s+\w+\s*\(([\s\S]*?)\)\s*(?:->[\s\S]*?)?:/.exec(L[m].text);
      if (d) {
        out = new Set();
        splitTop(d[1], ',').forEach((x) => { const pm = /^\**\s*(\w+)/.exec(x.trim()); if (pm) out.add(pm[1]); });
        for (let q = m + 1; q < L.length && L[q].indent > L[m].indent; q++) { const a = /^([A-Za-z_]\w*)\s*(?::[^=]+?)?=(?!=)/.exec(L[q].text) || /^for\s+([A-Za-z_]\w*)\b/.exec(L[q].text); if (a) out.add(a[1]); }
      }
      defNames.set(m, out); return out;
    };
    const shadowMemo = new Map(); const shadowCtx = new Map();
    const shadowAt = (k) => {
      if (!encl) { encl = new Int32Array(L.length).fill(-1); const st = []; L.forEach((l, q) => { while (st.length && L[st[st.length - 1]].indent >= l.indent) st.pop(); encl[q] = st.length ? st[st.length - 1] : -1; st.push(q); }); }
      const key = encl[k]; if (shadowMemo.has(key)) return shadowMemo.get(key); // lines in one block share their names
      const out = new Set();
      for (let m = key; m >= 0; m = encl[m]) { const ns = namesOfDef(m); if (ns) ns.forEach((x) => out.add(x)); }
      shadowMemo.set(key, out); return out;
    };
    const dictTools = (l, k) => {
      if (mcpClient) return;
      let t; try { t = pyTokenize(l.text); } catch (e) { return; }
      let nls = null;
      const lineOf = (pos) => { if (!nls) { nls = []; for (let q = 0; q < l.text.length; q++) if (l.text.charCodeAt(q) === 10) nls.push(q); } let lo = 0; let hi = nls.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (nls[mid] < pos) lo = mid + 1; else hi = mid; } return l.line + lo; };
      const shadow = l.indent > 0 ? shadowAt(k) : null;
      let dctx = ctx;
      if (shadow && shadow.size) { if (!shadowCtx.has(shadow)) { const c2 = Object.assign({}, ctx.consts); shadow.forEach((n) => { delete c2[n]; }); shadowCtx.set(shadow, Object.assign({}, ctx, { consts: c2 })); } dctx = shadowCtx.get(shadow); }
      const bm = l.indent === 0 ? /^([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*\{/.exec(l.text) : null;
      for (let i = 0; i < t.length; i++) {
        if (!isP(t[i], '{')) continue;
        const close = pyMatch(t, i); if (close >= t.length) continue;
        // the dict's own keys (depth 1): key token -> index of its value
        const keys = {}; let j = i + 1;
        while (j < close) {
          if (t[j].type === 'str' && isP(t[j + 1], ':') && (isP(t[j - 1], '{') || isP(t[j - 1], ','))) { if (!hasOwn(keys, t[j].value)) keys[t[j].value] = j + 2; }
          if (isP(t[j], '(') || isP(t[j], '[') || isP(t[j], '{')) { j = pyMatch(t, j) + 1; continue; }
          j++;
        }
        const sk = keys.inputSchema !== undefined ? 'inputSchema' : keys.input_schema !== undefined && handRolled ? 'input_schema' : null;
        if (keys.name === undefined || !sk) continue;
        const nv = pyValue(t, keys.name, dctx);
        if (typeof nv.value !== 'string' || nv.exact === false || !nv.value || !(isP(t[nv.end], ',') || isP(t[nv.end], '}'))) continue;
        const tool = { name: nv.value }; const un = [];
        const val = (key) => (keys[key] === undefined ? undefined : pyValue(t, keys[key], dctx));
        const tv = val('title'); if (tv && typeof tv.value === 'string') tool.title = tv.value;
        const dv = val('description');
        if (dv) {
          if (typeof dv.value === 'string') { tool.description = dv.value; if (dv.partial) un.push('description'); }
          else { const e2 = pySkip(t, keys.description); const lits = literalsArr(t, keys.description, e2); lose(lits); if (lits.length) tool.description = lits.join(' … ').slice(0, MAX_STR); un.push('description'); }
        }
        const sv = val(sk);
        let exact = !un.length;
        if (sv && sv.value !== PY_SKIP && sv.value && typeof sv.value === 'object' && !Array.isArray(sv.value)) { tool.inputSchema = sv.value; exact = exact && sv.exact !== false; }
        else if (dv) { tool.inputSchema = { type: 'object' }; un.push('inputSchema'); lose(literalsArr(t, keys[sk], pySkip(t, keys[sk]))); exact = false; }
        else continue;
        const av = val('annotations');
        if (av) { if (av.value && av.value !== PY_SKIP && typeof av.value === 'object' && !Array.isArray(av.value)) tool.annotations = av.value; else un.push('annotations'); }
        ['outputSchema', '_meta', 'icons', 'execution'].forEach((key) => { const v = val(key); if (v && v.value && v.value !== PY_SKIP && typeof v.value === 'object') tool[key] = v.value; });
        tool._unreadable = un;
        add(tool, lineOf(t[i].s), { lowLevel: true, literal: true, binding: bm && i === t.findIndex((x) => isP(x, '{')) ? bm[1] : null, exactTypes: exact && !un.length });
        i = close;
      }
    };
    // One use of a tool-dict factory (pyToolTemplates): its arguments bound to the factory's parameters (defaults when
    // not given), the dict evaluated with them. A name that cannot be worked out is unresolved; a part that cannot be
    // read (a schema built in the factory's body) is marked not readable, the arguments' other text kept for the scan.
    const fromTemplate = (tpl, argsText, line) => {
      let ct; try { ct = pyTokenize(argsText); } catch (e) { return; }
      if (!isP(ct[0], '(')) return;
      const a = pyCallArgs(ct, 0);
      const consts = Object.assign({}, ctx.consts); const bound = {};
      tpl.locals.forEach((n) => { delete consts[n]; });
      tpl.params.forEach((pp, ix) => {
        const at = a.kw[pp.name] !== undefined ? a.kw[pp.name] : a.pos[ix];
        let v = null;
        if (at !== undefined) { const r = pyValue(ct, at, ctx); if (r.value !== PY_SKIP && !(typeof r.value === 'string' && r.exact === false)) v = r; }
        else if (pp.def !== undefined) v = exprVal(pp.def);
        if (v) { consts[pp.name] = v.value; bound[pp.name] = true; } else delete consts[pp.name];
      });
      let tt; try { tt = pyTokenize(tpl.text); } catch (e) { return; }
      const keys = pyDictKeys(tt, tpl.at);
      const tctx = { consts, partialNames: ctx.partialNames, lostOf: ctx.lostOf };
      const val = (key) => (keys[key] === undefined ? undefined : pyValue(tt, keys[key], tctx));
      const argText = literalsArr(ct, 0, ct.length);
      // the arguments that become the name, title or description (the dict's value there is the parameter itself)
      const shownParams = new Set(['name', 'title', 'description'].map((key) => keys[key]).filter((at) => at !== undefined && tt[at] && tt[at].type === 'id' && (isP(tt[at + 1], ',') || isP(tt[at + 1], '}'))).map((at) => tt[at].value));
      const otherText = () => { const out = []; tpl.params.forEach((pp, ix) => { if (shownParams.has(pp.name)) return; const at = a.kw[pp.name] !== undefined ? a.kw[pp.name] : a.pos[ix]; if (at !== undefined) out.push(...literalsArr(ct, at, pySkip(ct, at))); }); return out; };
      const nv = val('name');
      if (!nv || typeof nv.value !== 'string' || !nv.value || nv.exact === false) { lose(argText); unresolved.push(Object.assign({ line }, argText.length ? { description: argText.join(' … ').slice(0, MAX_STR) } : {})); return; }
      const tool = { name: nv.value }; const un = [];
      const tv = val('title'); if (tv && typeof tv.value === 'string' && tv.exact !== false) tool.title = tv.value;
      const dv = val('description');
      if (dv) { if (typeof dv.value === 'string') { tool.description = dv.value; if (dv.partial) un.push('description'); } else un.push('description'); }
      const sk = keys.inputSchema !== undefined ? 'inputSchema' : 'input_schema';
      const sv = val(sk);
      if (sv && sv.value && sv.value !== PY_SKIP && typeof sv.value === 'object' && !Array.isArray(sv.value)) tool.inputSchema = sv.value; else { tool.inputSchema = { type: 'object' }; un.push('inputSchema'); }
      if (keys.annotations !== undefined) { const av = val('annotations'); if (av && av.value && av.value !== PY_SKIP && typeof av.value === 'object' && !Array.isArray(av.value)) tool.annotations = av.value; else un.push('annotations'); }
      ['outputSchema', '_meta', 'icons', 'execution'].forEach((key) => { const v = val(key); if (v && v.value && v.value !== PY_SKIP && typeof v.value === 'object') tool[key] = v.value; });
      // text of the arguments that is not the name, title or description: kept for the scan when a part is not readable
      if (un.length) lose(otherText());
      tool._unreadable = un;
      add(tool, line, { fn: tpl.name, exactTypes: !un.length && !!(sv && sv.exact) });
    };
    let topDef = null; // the top-level def of each logical line (or -1), from one pass
    for (let k = 0; k < L.length; k++) {
      const l = L[k];
      const lineLost = []; LOST.cur = lineLost; const toolsBefore = tools.length; const unresBefore = unresolved.length;
      try { // one registration that cannot be read never drops the others: it is counted instead
      // decorators, then the def they decorate
      if (l.text[0] === '@') {
        const decos = []; let e = k;
        while (e < L.length && L[e].text[0] === '@') decos.push(L[e++]);
        if (e >= L.length || !/^(?:async\s+)?def\s/.test(L[e].text)) { k = e - 1; continue; }
        for (const d of decos) {
          const m = /^@\s*([\w.]+)\s*(\(([\s\S]*)\))?\s*$/.exec(d.text); if (!m) continue;
          const chain = m[1].split('.'); const last = chain[chain.length - 1];
          const kw = m[3] !== undefined ? pyKwargs(m[3]) : {};
          const isSdk = chain.length > 1 && last === 'tool';
          const isBare = chain.length === 1 && last === 'tool' && usesMcp;
          const isNamed = /^[a-z]\w*_tool$/.test(last) && m[2] !== undefined && (kw.description !== undefined || kw.name !== undefined || kw.title !== undefined);
          // a repository's own factory that builds the tool dict (@tool("name", "Title", "…", properties=…), R-RD-02)
          if (chain.length === 1 && m[2] !== undefined && templates.has(last)) { fromTemplate(templates.get(last), '(' + m[3] + ')', d.line); break; }
          // a repository's own registrar used bare (@create_tool("x", "X") whose body calls add_tool(fn), R-RD-02): the
          // function's name, unless the registrar passes one of its parameters on as the name
          const bareReg = chain.length === 1 && !isBare && !isNamed && registrars.bare && registrars.bare.has(last) ? registrars.bare.get(last) : null;
          if (bareReg) {
            const args = m[3] !== undefined ? splitTop(m[3], ',') : []; const pos = args.filter((x) => !/^\w+\s*=/.test(x));
            const argOf = (pn) => { if (!pn) return undefined; if (kw[pn] !== undefined) return kw[pn]; const ix = bareReg.params.findIndex((x) => x.name === pn); return ix >= 0 ? pos[ix] : undefined; };
            Object.keys(kw).forEach((key) => { if (!['name', 'description', 'title', 'annotations'].includes(key) || (key !== bareReg.nameParam && key !== bareReg.descriptionParam && bareReg.params.some((x) => x.name === key))) delete kw[key]; });
            if (bareReg.nameParam && argOf(bareReg.nameParam) !== undefined) kw.name = argOf(bareReg.nameParam);
            if (bareReg.descriptionParam && argOf(bareReg.descriptionParam) !== undefined) kw.description = argOf(bareReg.descriptionParam);
          }
          const isReg = (chain.length > 1 && registrars.has(last)) || !!bareReg;
          if (!(isSdk || isBare || isNamed || isReg)) continue;
          // @mcp.tool("name") (the standalone fastmcp's positional name)
          const pos0 = m[3] !== undefined ? splitTop(m[3], ',')[0] : null;
          if (isSdk && pos0 && !/^\w+\s*=/.test(pos0) && kw.name === undefined) kw.name = pos0;
          const given = givenOf(kw);
          if (given.nameUnknown) { unresolved.push(unresolvedText(d.line, given)); break; }
          if (isReg || isNamed) { given.annotationsUnknown = given.annotations === undefined && !(bareReg && bareReg.noAnnotations); if (isReg) given.fastmcpTags = false; }
          const r = fromDef(e, given);
          if (r) add(r.tool, d.line, { exactTypes: r.exactTypes, server: chain.length > 1 ? chain[0] : null, fn: r.fname });
          break;
        }
        k = e; continue;
      }
      // tools written out as dicts: {"name": …, "description": …, "inputSchema": {…}} (a hand-written tools/list answer)
      if (/["'](?:inputSchema|input_schema)["']\s*:/.test(l.text)) dictTools(l, k);
      // calls of a repository function that builds the tool dict: TOOLS = [tool("a", "…", {…}), …] (R-RD-02)
      if (tplCall && tplCall.test(l.text)) {
        let t; try { t = pyTokenize(l.text); } catch (e) { t = []; }
        let nls = null;
        for (let i = 0; i < t.length; i++) {
          if (t[i].type !== 'id' || !templates.has(t[i].value) || !isP(t[i + 1], '(') || isP(t[i - 1], '.') || (t[i - 1] && t[i - 1].type === 'id' && t[i - 1].value === 'def')) continue;
          const close = pyMatch(t, i + 1); if (close >= t.length) continue;
          if (!nls) { nls = []; for (let q = 0; q < l.text.length; q++) if (l.text.charCodeAt(q) === 10) nls.push(q); }
          let lo = 0; let hi = nls.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (nls[mid] < t[i].s) lo = mid + 1; else hi = mid; }
          fromTemplate(templates.get(t[i].value), l.text.slice(t[i + 1].s, t[close].e), l.line + lo);
          i = close;
        }
      }
      // calls inside the line: Tool(...), x.tool(fn, ...), x.add_tool(fn, ...), Tool.from_function(...), *ToolDefinition(fn=...)
      if (!/\bTool\s*\(|\.tool\s*\(|add_tool\s*\(|from_function\s*\(|ToolDefinition\s*\(/.test(l.text)) continue;
      const t = pyTokenize(l.text);
      for (let i = 0; i < t.length; i++) {
        if (t[i].type !== 'id' || !isP(t[i + 1], '(')) continue;
        const fn = t[i].value; const dotted = isP(t[i - 1], '.'); const owner = dotted && t[i - 2] && t[i - 2].type === 'id' ? t[i - 2].value : null;
        const a = pyCallArgs(t, i + 1);
        const kwText = (key) => (a.kw[key] !== undefined ? tokText(l.text, t, a.kw[key], pySkip(t, a.kw[key])) : undefined);
        const kwAll = {}; Object.keys(a.kw).forEach((key) => { kwAll[key] = kwText(key); });
        if (fn === 'Tool' && (!dotted || /^(types|mcp)$/.test(owner)) && a.kw.name !== undefined && (a.kw.inputSchema !== undefined || a.kw.description !== undefined || a.kw.input_schema !== undefined)) {
          // the low-level server: Tool(name=..., description=..., inputSchema={...}, annotations=...)
          let name = /^self\.(name|tool_name|_name)$/.test(kwAll.name.trim()) ? classNameOf(k) : nameOf(kwAll.name);
          const g = givenOf(Object.assign({}, kwAll, { name: undefined }));
          if (!name) { unresolved.push(unresolvedText(l.line, g)); continue; }
          const tool = { name }; const un = [];
          if (g.title) tool.title = g.title;
          if (g.description !== undefined) { if (typeof g.description === 'string') tool.description = g.description; else if (g.descriptionLiterals) tool.description = g.descriptionLiterals.slice(0, MAX_STR); if (g.description === null || g.descriptionPartial) un.push('description'); }
          const sk = a.kw.inputSchema !== undefined ? 'inputSchema' : 'input_schema';
          const sv = a.kw[sk] !== undefined ? pyValue(t, a.kw[sk], ctx) : null;
          if (sv && sv.value !== PY_SKIP && sv.value && typeof sv.value === 'object' && !Array.isArray(sv.value)) tool.inputSchema = sv.value;
          else { tool.inputSchema = { type: 'object' }; un.push('inputSchema'); }
          if (a.kw.outputSchema !== undefined) { const ov = pyValue(t, a.kw.outputSchema, ctx); if (ov.value && ov.value !== PY_SKIP && typeof ov.value === 'object') tool.outputSchema = ov.value; }
          if (g.annotations !== undefined) { if (g.annotations) tool.annotations = g.annotations; else un.push('annotations'); }
          tool._unreadable = un;
          // NAME = Tool(...) at module level is a declaration: kept when something refers to NAME (markConditionals)
          const bm = l.indent === 0 ? /^([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?:[\w.]+\.)?Tool\s*\(/.exec(l.text) : null;
          add(tool, l.line, { lowLevel: true, literal: true, binding: bm ? bm[1] : null, exactTypes: !un.length && !!(sv && sv.exact) });
          i = a.close; continue;
        }
        // a function made a tool: x.tool(fn, name=...), x.add_tool(fn, ...), Tool.from_function(fn, ...), ToolDefinition(fn=...)
        let fnArg = a.kw.fn !== undefined ? a.kw.fn : a.pos[0];
        // fn, self.fn, or one wrapper around it: call_with_client(fn)
        if (fnArg !== undefined && t[fnArg] && t[fnArg].type === 'id' && isP(t[fnArg + 1], '(')) { const w = pyCallArgs(t, fnArg + 1); fnArg = w.pos.length === 1 && !Object.keys(w.kw).length && t[w.pos[0]] && t[w.pos[0]].type === 'id' && (isP(t[w.pos[0] + 1], ')')) ? w.pos[0] : undefined; }
        const plain = (k) => isP(t[k + 1], ',') || isP(t[k + 1], ')');
        const fnRef = fnArg !== undefined && t[fnArg] && t[fnArg].type === 'id' ? (t[fnArg].value === 'self' && isP(t[fnArg + 1], '.') && t[fnArg + 2] && plain(fnArg + 2) ? t[fnArg + 2].value : plain(fnArg) ? t[fnArg].value : null) : null;
        const isMake = (dotted && owner && (fn === 'tool' || fn === 'add_tool') && a.pos.length >= 1) || (fn === 'from_function' && owner && /Tool$/.test(owner)) || (/ToolDefinition$/.test(fn) && a.kw.fn !== undefined);
        if (!isMake || !fnRef) continue;
        const given = givenOf(kwAll);
        // the registration inside a bare registrar (def create_tool(name, …): mcp.tool(fn, name=name)) is named at each
        // use of the registrar, where it is read: not an unresolved registration of its own (R-RD-20)
        if (given.nameUnknown && registrars.bare && registrars.bare.size) {
          if (!topDef) { topDef = new Int32Array(L.length).fill(-1); let cur = -1; L.forEach((x, q) => { if (x.indent === 0) cur = /^(?:async\s+)?def\s+\w+/.test(x.text) ? q : -1; topDef[q] = cur; }); }
          const dq = topDef[k]; const dn = dq >= 0 ? /^(?:async\s+)?def\s+(\w+)/.exec(L[dq].text)[1] : null; const br = dn ? registrars.bare.get(dn) : null;
          const nameKw = a.kw.name !== undefined && t[a.kw.name] && t[a.kw.name].type === 'id' && (isP(t[a.kw.name + 1], ',') || isP(t[a.kw.name + 1], ')')) ? t[a.kw.name].value : null;
          if (br && br.decoratorOnly && nameKw && br.nameParam === nameKw) continue;
        }
        if (given.nameUnknown) { unresolved.push(unresolvedText(l.line, given)); continue; }
        const dk = defs.get(fnRef);
        if (dk === undefined && given.name === undefined) {
          // for tool in tools: mcp.add_tool(tool), over a list of this file's functions, is read once per function
          // (R-RD-34); a loop over anything else is counted as unresolved, never guessed
          const loop = pyLoopOver(k, fnRef);
          if (loop === null) continue; // a parameter or a function from elsewhere, named nowhere here
          if (!loop.items) { unresolved.push(unresolvedText(l.line, given)); i = a.close; continue; }
          loop.items.forEach((nm) => { const r = fromDef(defs.get(nm), Object.assign({}, given)); if (r) add(r.tool, l.line, { exactTypes: r.exactTypes, server: dotted && fn !== 'from_function' ? owner : null, fn: nm, unrolled: true }); });
          i = a.close; continue;
        }
        if (dk !== undefined) {
          if (/ToolDefinition$/.test(fn)) { given.annotationsUnknown = given.annotations === undefined; given.fastmcpTags = false; }
          const r = fromDef(dk, given);
          if (r) add(r.tool, l.line, { exactTypes: r.exactTypes, server: dotted && fn !== 'from_function' ? owner : null, fn: fnRef });
        } else {
          const name = given.name || fnRef;
          const tool = { name, inputSchema: { type: 'object' } }; const un = ['inputSchema'];
          if (typeof given.description === 'string') tool.description = given.description; else { if (given.descriptionLiterals) tool.description = given.descriptionLiterals.slice(0, MAX_STR); un.push('description'); }
          if (given.annotations) tool.annotations = given.annotations; else un.push('annotations');
          tool._unreadable = un;
          add(tool, l.line, { server: dotted && fn !== 'from_function' ? owner : null, fn: fnRef });
        }
        i = a.close;
      }
      } catch (e) { if (/\btool\b|Tool\s*\(|_tool\b/.test(l.text)) overBudget.push({ line: l.line, why: 'error' }); } finally {
        LOST.cur = null;
        if (lineLost.length) { for (let x = toolsBefore; x < tools.length; x++) tools[x].tool._lost = lineLost; for (let x = unresBefore; x < unresolved.length; x++) unresolved[x].lost = lineLost; }
      }
    }
    tools.unresolved = unresolved; tools.overBudget = overBudget;
    return tools;
  }
  // The string literals of a Python expression (the readable parts of one that cannot be read as a whole), or null.
  function pyLiterals(text) {
    let t; try { t = pyTokenize(String(text)); } catch (e) { return null; }
    const out = []; let n = 0;
    t.forEach((x) => { (x.type === 'str' ? [x.value] : x.type === 'tpl' ? x.parts : []).forEach((p) => { const q = String(p).trim(); if (q) { out.push(q); n += q.length; } }); });
    return out.length ? out.join(' … ') : null;
  }
  function tokText(text, t, a, b) { return a < b && t[a] && t[b - 1] ? text.slice(t[a].s, t[b - 1].e) : ''; }
  // Methods and functions of the repository that register a tool (their body calls .tool(, add_tool(, Tool.from_function(
  // or another of them): used as decorators, @registry.reader("…") makes the function under it a tool.
  // The names part of `from X import …` (one logical line): brackets and spaces stripped in code, not by a regex that
  // backtracks over a long run of spaces (R-RD-21).
  // `a as b` -> ['a', 'b'], `a` -> ['a']: split on whitespace in code (a regex /\s+as\s+/ is quadratic on long space runs)
  function asParts(x) { const w = String(x).trim().split(/\s+/); return w[1] === 'as' && w.length >= 3 ? [w[0], w[2]] : [w[0]]; }
  function importNames(rest) { let r = rest.trim(); if (r[0] === '(') { r = r.slice(1); const c = r.lastIndexOf(')'); if (c >= 0) r = r.slice(0, c); } return r; }
  function pyRegistrars(files) {
    const bodies = new Map(); const top = new Map(); const dupTop = new Set();
    const serversOf = new Map(); const importsOf = []; // path -> its server objects; [path, servers, [{ mod, names }]]
    files.forEach(([p, text]) => {
      if (!/\.py$/.test(p) || typeof text !== 'string') return;
      const clean = pyStripComments(text); const L = pyLogicalLines(clean);
      // the MCP server objects of the file: x = FastMCP(…) / MCPServer(…) / Server(…) (the SDK's, in a file that imports it)
      const sdkFile = /^[ \t]*(?:from|import)\s+(?:mcp|fastmcp)\b/m.test(clean);
      const servers = new Set(); let sm; const sre = /^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*(?:[\w.]+\.)?(FastMCP|MCPServer|Server)\s*\(/gm;
      while ((sm = sre.exec(clean))) if (sm[2] !== 'Server' || sdkFile) servers.add(sm[1]);
      serversOf.set(p, new Set(servers));
      // from app.server import mcp / from .server import mcp as srv: an MCP server object of another module (R-RD-20)
      const imps = []; L.forEach((l) => { if (l.indent !== 0) return; const im = /^from\s+(\.*[\w.]*)\s+import\b([\s\S]*)$/.exec(l.text); if (im && !/^(?:mcp|fastmcp)(?:\.|$)/.test(im[1])) imps.push({ mod: im[1], names: importNames(im[2]).split(',').map((x) => asParts(x)).filter((q) => /^\w+$/.test(q[0])).map((q) => [q[0], (q[1] || q[0]).trim()]) }); });
      if (imps.length) importsOf.push([p, servers, imps]);
      L.forEach((l, k) => {
        const m = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(l.text); if (!m || /^(__\w+__|main|run|register|setup|create_app|create_server|serve)$/.test(m[1])) return;
        let body = ''; for (let j = k + 1; j < L.length && L[j].indent > l.indent; j++) body += L[j].text + '\n';
        bodies.set(m[1], (bodies.get(m[1]) || '') + body);
        if (l.indent === 0) { if (top.has(m[1])) dupTop.add(m[1]); else top.set(m[1], { params: pyParams(l.text), body, servers, sdkFile }); }
      });
    });
    // the imported server objects join the importing file's own (a module path, absolute by its last segments or relative)
    if (importsOf.length) {
      const withServers = Array.from(serversOf.entries()).filter(([, sv]) => sv.size);
      const moduleFiles = (from, mod) => {
        const dots = /^\.*/.exec(mod)[0].length; const rest = mod.slice(dots).split('.').filter(Boolean).join('/');
        if (dots) { let dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''; for (let q = 1; q < dots; q++) dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : ''; const b = [dir, rest].filter(Boolean).join('/'); return (p) => p === b + '.py' || p === b + '/__init__.py'; }
        return (p) => !!rest && (p === rest + '.py' || p === rest + '/__init__.py' || p.endsWith('/' + rest + '.py') || p.endsWith('/' + rest + '/__init__.py'));
      };
      importsOf.forEach(([p, servers, imps]) => imps.forEach((im) => {
        const match = moduleFiles(p, im.mod); const hit = withServers.filter(([q]) => match(q));
        if (hit.length === 1) im.names.forEach(([orig, alias]) => { if (hit[0][1].has(orig)) servers.add(alias); });
      }));
    }
    const out = new Set();
    bodies.forEach((b, n) => { if (/\.tool\s*\(|\badd_tool\s*\(|Tool\.from_function\s*\(/.test(b)) out.add(n); });
    for (let round = 0; round < 4; round++) {
      let grew = false;
      bodies.forEach((b, n) => { if (out.has(n)) return; for (const r of out) { if (new RegExp('(?:self|cls)\\.' + r + '\\s*\\(').test(b)) { out.add(n); grew = true; break; } } });
      if (!grew) break;
    }
    // Module-level registrars, usable as a bare decorator (@create_tool("x", "X") over a def, R-RD-02): the parameter
    // the registration takes its name (description) from, when the body passes one on (add_tool(fn, name=tool_name));
    // otherwise the SDK names the tool after the function.
    const bare = new Map();
    top.forEach((info, n) => {
      if (!out.has(n) || dupTop.has(n)) return;
      // only a registration on an MCP server object of the registrar's file (mcp.tool(fn), mcp.local_provider.add_tool(fn)),
      // or Tool.from_function in a file that imports the SDK: agent.tool(fn) (pydantic-ai) or tracer.tool(span) is not one
      const target = /(?:^|[^\w.])([A-Za-z_]\w*)(?:\.[A-Za-z_]\w*)*\.(?:tool|add_tool)\s*\(/g; let tm; let onServer = false;
      while ((tm = target.exec(info.body))) if (info.servers.has(tm[1])) { onServer = true; break; }
      if (!onServer && !(info.sdkFile && /\bTool\.from_function\s*\(/.test(info.body))) return;
      const call = /(?:\.tool|\badd_tool|Tool\.from_function)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/.exec(info.body);
      const kwOf = (key) => { const m = call && new RegExp('\\b' + key + '\\s*=\\s*(\\w+)\\s*(?:,|$)').exec(call[1]); return m && info.params.some((x) => x.name === m[1]) ? m[1] : null; };
      // annotations are known to be none only when the registration is a statement of its own (its tool object is not
      // kept, so nothing can set them later) and passes neither annotations nor **kwargs (R-RD-20)
      const stmt = !!call && /(?:^|\n)[ \t]*[A-Za-z_][\w.]*\.(?:tool|add_tool)[ \t]*\(/.test(info.body);
      const noAnnotations = !!stmt && !/\*\*|_hint\s*=/.test(call[1]) && !/\bannotations\b/.test(info.body) && !/=[ \t]*[A-Za-z_][\w.]*\.(?:tool|add_tool)\s*\(|return[ \t]+[A-Za-z_][\w.]*\.(?:tool|add_tool)\s*\(/.test(info.body);
      bare.set(n, { params: info.params, nameParam: kwOf('name'), descriptionParam: kwOf('description'), noAnnotations, decoratorOnly: true });
    });
    // a registrar used anywhere other than as a decorator (create_tool(n, "D.")(f) in a loop) is not read there: its own
    // registration then still counts as unresolved (R-RD-20). One pass over each file for all registrar names.
    if (bare.size) {
      const re = /(@?)\b([A-Za-z_]\w*)[ \t]*\(/g;
      files.forEach(([p, text]) => {
        if (!/\.py$/.test(p) || typeof text !== 'string') return;
        re.lastIndex = 0; let m;
        while ((m = re.exec(text))) { const b0 = bare.get(m[2]); if (!b0 || m[1]) continue; const before = text.slice(Math.max(0, m.index - 8), m.index); if (/def[ \t]+$/.test(before) || /\.$/.test(before)) continue; b0.decoratorOnly = false; }
      });
    }
    Object.defineProperty(out, 'bare', { value: bare, enumerable: false });
    return out;
  }
  // The parameters of a def line: [{ name, def (the default's text) }], self/cls, *args and **kwargs left out.
  function pyParams(head) {
    const m = /^(?:async\s+)?def\s+\w+\s*\(/.exec(head); if (!m) return [];
    const open = m[0].length - 1; let d = 0; let close = -1; let q = null;
    for (let x = open; x < head.length; x++) { const ch = head[x]; if (q) { if (ch === '\\') x++; else if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") q = ch; else if (ch === '(' || ch === '[' || ch === '{') d++; else if (ch === ')' || ch === ']' || ch === '}') { d--; if (!d) { close = x; break; } } }
    if (close < 0) return [];
    const out = [];
    splitTop(head.slice(open + 1, close), ',').forEach((p) => {
      if (!p || p === '*' || p === '/' || /^\*/.test(p)) return;
      const eq = topLevelEq(p); const lhs = (eq < 0 ? p : p.slice(0, eq)).trim(); const nm = /^(\w+)/.exec(lhs);
      if (!nm || nm[1] === 'self' || nm[1] === 'cls') return;
      out.push({ name: nm[1], def: eq < 0 ? undefined : p.slice(eq + 1).trim() });
    });
    return out;
  }
  // Repository functions that build a tool dict from their own parameters (R-RD-02): a module-level def whose body holds
  // a dict with the keys "name" (one of the def's parameters) and "inputSchema" ("input_schema" in a file that speaks
  // MCP), such as a hand-rolled server's tool(name, title, description, properties, …) decorator factory, or a helper
  // that returns the dict. Each use (@tool("x", …) over a def, or a call tool("x", …)) is a tool, the dict evaluated with
  // the use's arguments. Map(fn -> { params, text (the dict's logical line), at (its token) }); names defined twice
  // in the repository are left out.
  function pyToolTemplates(files) {
    const out = new Map(); const dup = new Set(); const defs = new Map(); // every module-level def name -> how many
    files.forEach(([p, text]) => {
      if (!/\.py$/.test(p) || typeof text !== 'string') return;
      const re = /^(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/gm; let d; while ((d = re.exec(text))) defs.set(d[1], (defs.get(d[1]) || 0) + 1);
      if (!/["'](?:inputSchema|input_schema)["']\s*:/.test(text)) return;
      const clean = pyStripComments(text); const L = pyLogicalLines(clean);
      const speaks = /^[ \t]*(?:from|import)\s+(?:mcp|fastmcp)\b/m.test(clean) || /["']tools\/list["']/.test(clean);
      L.forEach((l, k) => {
        if (l.indent !== 0) return;
        const m = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(l.text); if (!m) return;
        const params = pyParams(l.text); if (!params.length) return;
        for (let j = k + 1; j < L.length && L[j].indent > 0; j++) {
          if (!/["'](?:inputSchema|input_schema)["']\s*:/.test(L[j].text)) continue;
          let t; try { t = pyTokenize(L[j].text); } catch (e) { continue; }
          for (let i = 0; i < t.length; i++) {
            if (!isP(t[i], '{')) continue;
            const keys = pyDictKeys(t, i);
            const sk = keys.inputSchema !== undefined ? 'inputSchema' : keys.input_schema !== undefined && speaks ? 'input_schema' : null;
            const nk = keys.name;
            if (!sk || nk === undefined || !t[nk] || t[nk].type !== 'id' || !(isP(t[nk + 1], ',') || isP(t[nk + 1], '}')) || !params.some((x) => x.name === t[nk].value)) continue;
            // names the def assigns in its body: never taken from constants of the same name where the dict is evaluated
            const locals = new Set(); for (let q = k + 1; q < L.length && L[q].indent > 0; q++) { const a = /^([A-Za-z_]\w*)\s*(?::[^=]+?)?=(?!=)/.exec(L[q].text) || /^(?:for|with)\s+[\s\S]*?\b(?:as\s+)?([A-Za-z_]\w*)\s*(?:in\b|:)/.exec(L[q].text) || /^(?:async\s+)?def\s+(\w+)/.exec(L[q].text); if (a) locals.add(a[1]); }
            if (out.has(m[1])) dup.add(m[1]); else out.set(m[1], { name: m[1], params, locals, text: L[j].text, at: i, path: p });
            return;
          }
        }
      });
    });
    dup.forEach((n) => out.delete(n));
    // a name defined more than once at module level (another file's own tool(), say): which one a call means is not known
    out.forEach((v, n) => { if ((defs.get(n) || 0) > 1) out.delete(n); });
    return out;
  }
  // The own keys of the dict whose "{" is token i: { key: index of its value's first token } (first of each key).
  function pyDictKeys(t, i) {
    const close = pyMatch(t, i); const keys = {}; let j = i + 1;
    while (j < close) {
      if (t[j].type === 'str' && isP(t[j + 1], ':') && (isP(t[j - 1], '{') || isP(t[j - 1], ',')) && !hasOwn(keys, t[j].value)) keys[t[j].value] = j + 2;
      if (isP(t[j], '(') || isP(t[j], '[') || isP(t[j], '{')) { j = pyMatch(t, j) + 1; continue; }
      j++;
    }
    return keys;
  }
  // Module-level constants defined once across the repository's Python files (for names imported from another module).
  function pyGlobalConsts(files) {
    const table = {}; const dup = new Set();
    files.forEach(([p, text]) => {
      if (!/\.py$/.test(p) || typeof text !== 'string') return;
      let fc; try { fc = pyFileConsts(pyLogicalLines(pyStripComments(text)), null); } catch (e) { return; }
      Object.keys(fc.consts).forEach((k) => { if (fc.partialNames.has(k)) return; if (hasOwn(table, k)) dup.add(k); else table[k] = fc.consts[k]; });
    });
    dup.forEach((k) => { delete table[k]; });
    return table;
  }
  // FastMCP composition: parent.mount(child, namespace="ns" | prefix="ns"), parent.mount("ns", child),
  // parent.import_server(child, prefix="ns") / import_server("ns", child). Returns Map(child variable -> prefix).
  function pyMounts(files) {
    const out = new Map();
    files.forEach(([p, text]) => {
      if (!/\.py$/.test(p) || typeof text !== 'string' || !/\.(mount|import_server)\s*\(/.test(text)) return;
      const re = /\.(mount|import_server)\s*\(([^()]*)\)/g; let m;
      while ((m = re.exec(pyStripComments(text)))) {
        const args = splitTop(m[2], ','); const kw = pyKwargs(m[2]); let child = null; let prefix = null;
        const pos = args.filter((a) => !/^\w+\s*=/.test(a));
        if (kw.namespace || kw.prefix) { const v = pyLiteral(kw.namespace || kw.prefix); prefix = v && typeof v.v === 'string' ? v.v : null; child = pos[0] || (kw.server || null); }
        else if (pos.length >= 2) { const a0 = pyLiteral(pos[0]); const a1 = pyLiteral(pos[1]); if (a0 && typeof a0.v === 'string') { prefix = a0.v; child = pos[1]; } else if (a1 && typeof a1.v === 'string') { prefix = a1.v; child = pos[0]; } }
        if (prefix && child && /^\w+$/.test(child.trim())) out.set(child.trim(), prefix);
      }
    });
    return out;
  }
  function pyAnnotations(s) {
    s = s.trim(); let m;
    if ((m = /^ToolAnnotations\(([\s\S]*)\)$/.exec(s))) { const kw = pyKwargs(m[1]); const o = {}; Object.keys(kw).forEach((k) => { const v = pyLiteral(kw[k]); if (v) o[k] = v.v; }); return o; } // keys as written: the v1 SDK keeps snake_case kwargs as extra fields
    if ((m = /^\{([\s\S]*)\}$/.exec(s))) { const o = {}; splitTop(m[1], ',').forEach((p) => { const kv = splitTop(p, ':'); if (kv.length === 2) { const k = pyLiteral(kv[0]); const v = pyLiteral(kv[1]); if (k && v) o[k.v] = v.v; } }); return o; }
    return null;
  }
  function dedent(s) {
    const ls = s.replace(/^\n/, '').split('\n'); const ind = Math.min(...ls.slice(1).filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length).concat([1e9]));
    return [ls[0].trim()].concat(ls.slice(1).map((l) => (ind < 1e9 ? l.slice(ind) : l))).join('\n').trim();
  }

  // ------------------------------------------------------------ committed lists and manifests
  // A snapshot written by mcp-catalog-snap (.mcp-catalog/<server>.json): { capturedWith | format: "mcp-catalog-snap/…",
  // catalog: { tools, prompts, resourceTemplates }, server, sha256 }. The tools are the server's tools/list, canonical JSON.
  function fromCatalogSnap(text) {
    let d; try { d = JSON.parse(text); } catch (e) { return null; }
    if (!d || typeof d !== 'object' || !d.catalog || !Array.isArray(d.catalog.tools)) return null;
    if (!/^mcp-catalog-snap\//.test(String(d.capturedWith || '')) && !/^mcp-catalog-snap\//.test(String(d.format || ''))) return null;
    const tools = d.catalog.tools.filter((x) => x && typeof x.name === 'string');
    return tools.length ? { tools, server: d.server && typeof d.server.name === 'string' ? d.server.name : null, capturedAt: typeof d.capturedAt === 'string' ? d.capturedAt : null } : null;
  }
  function toolsFromJson(text) {
    let d; try { d = JSON.parse(text); } catch (e) { return null; }
    // A list of tools, bare or as { tools: [...] }: every entry an object with a name, at least one with a schema
    // (inputSchema, or input_schema in either form, which the checks then name). An entry without a schema is kept and
    // graded (spec-input-schema-missing), so one bad entry never hides the list (R-RD-09).
    const toolList = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.name === 'string') && a.some((x) => x.inputSchema || x.input_schema);
    if (toolList(d)) return d;
    if (d && toolList(d.tools)) return d.tools;
    if (d && d.result && Array.isArray(d.result.tools)) return d.result.tools;
    if (d && typeof d.name === 'string' && d.inputSchema) return [d]; // a single-tool snapshot file (a __toolsnaps__ folder)
    return null;
  }
  function fromMcpbManifest(text) {
    let d; try { d = JSON.parse(text); } catch (e) { return null; }
    if (!d || typeof d !== 'object' || !d.server || !d.manifest_version && !d.dxt_version) return null;
    const metas = d._meta && typeof d._meta === 'object' ? Object.values(d._meta) : [];
    for (const m of metas) { const tl = m && m.static_responses && m.static_responses['tools/list']; if (tl && Array.isArray(tl.tools)) return { fidelity: 'exact', tools: tl.tools, generated: !!d.tools_generated }; }
    if (Array.isArray(d.tools) && d.tools.length) return { fidelity: 'names', tools: d.tools.filter((x) => x && x.name).map((x) => ({ name: x.name, description: x.description })), generated: !!d.tools_generated };
    return null;
  }

  // Classify every file of a repo listing; returns the paths worth fetching, best first.
  // Folders whose files are never read: dependencies and build output, and folders that hold examples, docs, tests,
  // evaluation harnesses, benchmarks, mocks, playgrounds and web sites rather than a server (their tool literals are not
  // the server's tools).
  const NOT_SERVER = 'examples?|docs?|fixtures?|tests?|__tests__|evals?|bench|benches|benchmarks?|e2e|__mocks__|mocks|playground|website' +
    // a folder whose name has "evals" as a word of its own (mcp-server-evals, evals-runner): an eval suite, not the server (R-RD-24)
    '|[\\w.-]*[-_.]evals(?:[-_.][\\w.-]*)?|evals[-_.][\\w.-]*';
  const SKIP_DIR = new RegExp('(^|\\/)(node_modules|dist|build|out|\\.next|vendor|coverage|__pycache__|\\.venv|venv|site-packages|' + NOT_SERVER + ')\\/', 'i');
  const SKIP_DIR_SRC_ONLY = new RegExp('(^|\\/)(node_modules|\\.next|coverage|__pycache__|\\.venv|venv|site-packages|' + NOT_SERVER + ')\\/', 'i'); // build output and vendor allowed
  const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.py$/i;
  function planFiles(paths, popts) {
    const exact = []; const manifests = []; const serverJson = []; const src = [];
    const srcSkip = popts && popts.allowBuilt ? SKIP_DIR_SRC_ONLY : SKIP_DIR;
    paths.forEach((p) => {
      const q = p.replace(/^\//, '');
      if (/(^|\/)__toolsnaps__\/[^/]+\.snap$/.test(q)) exact.push(q);
      else if (!SKIP_DIR.test(q) && /(^|\/)\.mcp-catalog\/[^/]+\.json$/.test(q)) exact.push(q); // mcp-catalog-snap snapshots
      else if (!SKIP_DIR.test(q) && /(^|\/)(tools(-list|_list)?|mcp-tools|tool-list)\.json$/i.test(q)) exact.push(q);
      else if (!SKIP_DIR.test(q) && /(^|\/)manifest\.json$/.test(q)) manifests.push(q);
      else if (/(^|\/)server\.json$/.test(q) && !SKIP_DIR.test(q)) serverJson.push(q);
      else if (!srcSkip.test(q) && !TEST_FILE.test(q) && /\.(ts|mts|cts|js|mjs|cjs|py)$/.test(q) && !/\.d\.ts$/.test(q) && !/\.min\.js$/.test(q)) src.push(q);
    });
    // likely tool files first
    const score = (p) => (/(^|\/)(tools?|server|index|main|mcp|handlers?)[^/]*\.(ts|js|py|mjs)$/i.test(p) ? 0 : /tool/i.test(p) ? 1 : 2) + p.split('/').length * 0.01;
    src.sort((a, b) => score(a) - score(b) || (a < b ? -1 : a > b ? 1 : 0)); // then by path, so every listing order reads the same files
    return { exact, manifests, serverJson, src };
  }

  // opts: { sdk: { kind, version, zod, py }, consts } as detectSdk and collectGlobalConsts return them.
  function extractFromFile(path, text, opts) {
    if (/\.py$/.test(path)) return extractPy(text, opts);
    if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(path)) return extractJs(text, opts);
    return [];
  }

  // ------------------------------------------------------------ SDK detection, shared constants, whole-repository analysis
  const META_FILE = /(^|\/)(package\.json|package-lock\.json|pyproject\.toml|requirements[^/]*\.txt|uv\.lock)$/;
  // Which SDK a repository builds on, from its manifests. Imports in a file win over this (see tsFlavour, pyFlavour).
  // Returns { kind: 'v1' | 'v2' | null, version, zod, py: 'sdk' | 'fastmcp' | null }. A lock file's exact version beats a range.
  function detectSdk(files) {
    const entries = files instanceof Map ? Array.from(files.entries()) : Object.keys(files || {}).map((k) => [k, files[k]]);
    const depth = (p) => p.split('/').length;
    const out = { kind: null, version: null, zod: null, py: null };
    const pick = (name, dep, lock) => lock || dep || null;
    const rank = (a, b) => depth(a[0]) - depth(b[0]);
    const pkgs = entries.filter(([p]) => /(^|\/)package\.json$/.test(p) && !/node_modules/.test(p)).sort(rank);
    const locks = entries.filter(([p]) => /(^|\/)package-lock\.json$/.test(p) && !/node_modules/.test(p)).sort(rank);
    let server = null; let sdk = null; let zod = null;
    pkgs.forEach(([, text]) => {
      let j; try { j = JSON.parse(text); } catch (e) { return; }
      const deps = Object.assign({}, j.devDependencies, j.peerDependencies, j.dependencies);
      if (!server && deps['@modelcontextprotocol/server']) server = deps['@modelcontextprotocol/server'];
      if (!sdk && deps['@modelcontextprotocol/sdk']) sdk = deps['@modelcontextprotocol/sdk'];
      if (!zod && deps.zod) zod = deps.zod;
    });
    let lock = {};
    locks.forEach(([, text]) => {
      let j; try { j = JSON.parse(text); } catch (e) { return; }
      const pk = j.packages || {};
      ['@modelcontextprotocol/server', '@modelcontextprotocol/sdk', 'zod'].forEach((n) => { const e = pk['node_modules/' + n]; if (e && e.version && !lock[n]) lock[n] = e.version; });
    });
    const sv = pick('server', server, lock['@modelcontextprotocol/server']); const kv = pick('sdk', sdk, lock['@modelcontextprotocol/sdk']); const zv = pick('zod', zod, lock.zod);
    if (sv) { out.kind = 'v2'; out.version = semver(sv) ? semver(sv).join('.') : null; } else if (kv) { const v = semver(kv); out.kind = v && v[0] >= 2 ? 'v2' : 'v1'; out.version = v ? v.join('.') : null; }
    const zm = semver(zv); if (zm) { out.zod = zm[0]; out.zodVersion = zm.join('.'); }
    // Python: the standalone fastmcp package, or the SDK's own FastMCP.
    let fast = false; let mcp = false;
    entries.forEach(([p, text]) => {
      if (!/(^|\/)(pyproject\.toml|requirements[^/]*\.txt)$/.test(p) || /(^|\/)(node_modules|\.venv|venv)\//.test(p)) return;
      if (/^[ \t]*["']?fastmcp\b/im.test(text) || /["']fastmcp[\s>=<~!;\[]/i.test(text)) fast = true;
      if (/^[ \t]*["']?mcp\b/im.test(text) || /["']mcp[\s>=<~!;\[]/i.test(text)) mcp = true;
    });
    out.py = fast && !mcp ? 'fastmcp' : fast || mcp ? 'sdk' : null;
    // The Python SDK's major version (2.x serialises snake_case ToolAnnotations fields in camelCase): uv.lock, then requirements.
    entries.forEach(([p, text]) => {
      if (out.pyMajor || typeof text !== 'string' || /(^|\/)(node_modules|\.venv|venv)\//.test(p)) return;
      let m = null;
      if (/(^|\/)uv\.lock$/.test(p)) m = /\[\[package\]\]\s*\nname\s*=\s*"mcp"\s*\nversion\s*=\s*"(\d+)/.exec(text);
      else if (/(^|\/)(pyproject\.toml|requirements[^/]*\.txt)$/.test(p)) m = /["'\s]mcp(?:\[[^\]]*\])?\s*(?:>=|==|~=|>)\s*(\d+)/.exec('\n' + text);
      if (m) out.pyMajor = Number(m[1]);
    });
    return out;
  }

  // Top-level constants shared across files (a name defined once), so {...SHARED} and Schema.shape resolve across an import.
  function collectGlobalConsts(srcFiles) {
    const seen = {}; const dup = new Set();
    const toks = new Map();
    const run = (seed) => {
      const table = {};
      srcFiles.forEach(([p, text]) => {
        if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(p) || typeof text !== 'string') return;
        let t = toks.get(p); if (!t) { try { t = tokenize(text); } catch (e) { return; } toks.set(p, t); }
        const zn = zodNamesIn(text); const ctx = { zodNames: zn, zod: zn.size > 0, fl: tsFlavour(text, null), globalConsts: seed };
        let cs; try { cs = collectConsts(t, ctx); } catch (e) { return; }
        Object.keys(cs).forEach((k) => {
          if (seed && Object.prototype.hasOwnProperty.call(seed, k) && cs[k] === seed[k]) return;
          const c = cs[k]; if (!c.top || c.partial || c.value === null || c.value === undefined || Array.isArray(c.value) || !(typeof c.value === 'object' || typeof c.value === 'string' || typeof c.value === 'number')) return;
          if (Object.prototype.hasOwnProperty.call(table, k)) { dup.add(k); return; }
          table[k] = c;
        });
      });
      dup.forEach((k) => { delete table[k]; });
      return table;
    };
    const first = run(null);
    const second = run(first);
    Object.keys(first).forEach((k) => { if (!second[k]) second[k] = first[k]; });
    void seen;
    return second;
  }

  // Blocks of a JS/TS token stream: { open, close, kind: 'if' | 'else' | 'fn' | 'other', cond, name }.
  function jsBlocks(src, t) {
    const blocks = []; const stack = [];
    const back = (i) => { let d = 0; for (let k = i; k >= 0; k--) { if (isP(t[k], ')')) d++; else if (isP(t[k], '(')) { d--; if (d === 0) return k; } } return -1; };
    const typeish = (x) => x && (x.type === 'id' || (x.type === 'p' && ['.', '<', '>', '|', '&', '[', ']', ',', '?'].includes(x.value)));
    // the ")" that closes a parameter list ending just before token k, allowing a ": ReturnType" between
    const sigClose = (k) => {
      if (k >= 0 && isP(t[k], ')')) return k;
      for (let m = k, n = 0; m >= 1 && n < 40; m--, n++) { if (isP(t[m], ':') && isP(t[m - 1], ')')) return m - 1; if (!typeish(t[m])) break; }
      return -1;
    };
    for (let i = 0; i < t.length; i++) {
      if (isP(t[i], '{')) {
        let kind = 'other'; let cond = null; let name = null; const pv = t[i - 1]; let po; let pc;
        const arrow = pv && isP(pv, '=>');
        const c = sigClose(arrow ? i - 2 : i - 1);
        if (arrow || c >= 0) {
          if (c >= 0) {
            const m = back(c); const kw = m > 0 ? t[m - 1] : null;
            if (!arrow && kw && kw.type === 'id' && kw.value === 'if') { kind = 'if'; cond = src.slice(t[m].start + 1, t[c].start).trim(); }
            else if (!arrow && kw && kw.type === 'id' && /^(while|for|switch|catch|with)$/.test(kw.value)) kind = 'other';
            else if (arrow) { kind = 'fn'; po = m; pc = c; let k = m - 1; while (k >= 0 && t[k].type === 'id' && t[k].value === 'async') k--; if (k >= 1 && isP(t[k], '=') && t[k - 1].type === 'id') name = t[k - 1].value; }
            else if (kw && kw.type === 'id') { kind = 'fn'; name = kw.value; po = m; pc = c; }
          } else if (arrow) { kind = 'fn'; let k = i - 2; if (t[k] && t[k].type === 'id') { po = k - 1; pc = k + 1; k--; } while (k >= 0 && t[k].type === 'id' && t[k].value === 'async') k--; if (k >= 1 && isP(t[k], '=') && t[k - 1].type === 'id') name = t[k - 1].value; }
        } else if (pv && pv.type === 'id' && pv.value === 'else') { kind = 'else'; cond = 'else'; }
        stack.push(po !== undefined ? { open: i, kind, cond, name, paramOpen: po, paramClose: pc } : { open: i, kind, cond, name });
      } else if (isP(t[i], '}')) {
        const b = stack.pop(); if (b) { b.close = i; blocks.push(b); }
      }
    }
    stack.forEach((b) => { b.close = t.length - 1; blocks.push(b); });
    return blocks;
  }
  function enclosing(blocks, t, offset) {
    return blocks.filter((b) => t[b.open].start < offset && (t[b.close] ? t[b.close].start : Infinity) > offset).sort((a, b) => a.open - b.open);
  }
  // Conditions around an offset, inside its innermost function: [{ kind, cond }] outermost first, plus that function's name.
  function guardsAt(blocks, t, offset) {
    const encl = enclosing(blocks, t, offset);
    let fnIdx = -1; encl.forEach((b, i) => { if (b.kind === 'fn') fnIdx = i; });
    const fn = fnIdx >= 0 ? encl[fnIdx] : null;
    return { fn: fn ? fn.name : null, guards: encl.slice(fnIdx + 1).filter((b) => b.kind === 'if' || b.kind === 'else').map((b) => ({ kind: b.kind, cond: b.cond })) };
  }
  // lines: the file's lines, with `up` (the nearest earlier code line with less indentation, from one pass, R-RD-23)
  // Whether a Python file other than `path` may change the module-level name `name` of `path` (R-RD-34): it imports
  // the name (from server import tools [as t], from server import *) or the module (import pkg.server [as s], from pkg
  // import server [as s]) and then appends to it, changes an item, extends it in place, deletes it, rebinds the module
  // attribute (server.tools = …), or hands it to a call. The module is matched by its dotted path, or by its last part
  // when the import is relative or names a shorter path; a match that is not the same module only makes the list
  // unknown, never invents a tool.
  function pyListChangedElsewhere(files, path, name) {
    const dotted = path.replace(/\.py$/, '').split('/').filter(Boolean);
    if (dotted[dotted.length - 1] === '__init__') dotted.pop();
    if (!dotted.length) return false;
    const stem = dotted[dotted.length - 1];
    const isMod = (m) => { const parts = m.replace(/^\.+/, '').split('.').filter(Boolean); if (!parts.length) return false; const tail = dotted.slice(-parts.length); return parts.join('.') === tail.join('.') || parts[parts.length - 1] === stem; };
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const MUT = '\\s*(?:\\.\\s*(?:append|extend|insert|remove|pop|clear|sort|reverse)\\s*\\(|\\[[^\\]]*\\]\\s*=(?!=)|[-+*|]=)';
    for (const [q, text] of files) {
      if (q === path || !/\.py$/.test(q) || typeof text !== 'string' || !text.includes(name)) continue;
      const L = pyLogicalLines(pyStripComments(text));
      const locals = new Set(); const prefixes = new Set();
      L.forEach((l) => {
        const tx = l.text.trim();
        let m = /^from\s+([.\w]+)\s+import\s+\(?([\s\S]*?)\)?\s*$/.exec(tx);
        if (m) {
          const items = m[2].split(',').map((x) => x.trim()).filter(Boolean);
          if (isMod(m[1])) items.forEach((it) => { const a = /^(\*|\w+)(?:\s+as\s+(\w+))?$/.exec(it); if (a && (a[1] === name || a[1] === '*')) locals.add(a[1] === '*' ? name : a[2] || a[1]); });
          items.forEach((it) => { const a = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(it); if (a && isMod((m[1].replace(/\.$/, '') + '.' + a[1]).replace(/^\.+/, ''))) prefixes.add(a[2] || a[1]); });
          return;
        }
        m = /^import\s+([\s\S]+)$/.exec(tx);
        if (m) m[1].split(',').forEach((it) => { const a = /^([\w.]+)(?:\s+as\s+(\w+))?$/.exec(it.trim()); if (a && isMod(a[1])) prefixes.add(a[2] || a[1]); });
      });
      if (!locals.size && !prefixes.size) continue;
      const refs = Array.from(locals).map(esc).concat(Array.from(prefixes).map((x) => esc(x).replace(/\\\./g, '\\s*\\.\\s*') + '\\s*\\.\\s*' + esc(name)));
      const ref = '(?:' + refs.join('|') + ')';
      const changed = new RegExp('(?:^|[^\\w.])' + ref + '(?:' + MUT + '|\\s*[,)])|^del\\s+' + ref + '\\b' + (prefixes.size ? '|(?:^|[^\\w.])(?:' + Array.from(prefixes).map((x) => esc(x).replace(/\\\./g, '\\s*\\.\\s*')).join('|') + ')\\s*\\.\\s*' + esc(name) + '\\s*=(?!=)' : ''));
      if (L.some((l) => { const tx = l.text.trim(); return !/^(from|import)\s/.test(tx) && changed.test(tx); })) return true;
    }
    return false;
  }
  function pyLinesOf(text) {
    const lines = text.split('\n'); const up = new Int32Array(lines.length).fill(-1); const ind = new Int32Array(lines.length); const st = [];
    lines.forEach((l, q) => {
      ind[q] = l.search(/\S/);
      if (ind[q] < 0 || /^[ \t]*#/.test(l)) return; // blank lines and comments enclose nothing
      while (st.length && ind[st[st.length - 1]] >= ind[q]) st.pop();
      up[q] = st.length ? st[st.length - 1] : -1;
      st.push(q);
    });
    return { lines, up, ind };
  }
  function pyGuards(pl, line) {
    // indentation walk upwards from the decorator: the if/elif/else lines that enclose it
    const guards = []; const { lines, up, ind } = pl;
    if (!lines[line - 1] || ind[line - 1] <= 0) return guards;
    for (let k = up[line - 1]; k >= 0; k = up[k]) {
      const l = lines[k];
      const m = /^\s*(if|elif|else)\b\s*(.*?):?\s*$/.exec(l);
      if (m && /:\s*(#.*)?$/.test(l)) guards.unshift({ kind: m[1] === 'else' ? 'else' : 'if', cond: m[1] === 'else' ? 'else' : m[2].replace(/:$/, '') });
      if (ind[k] <= 0) break;
    }
    return guards;
  }
  const DISABLED_KEYS = [['enabled', false], ['defaultEnabled', false], ['enabledByDefault', false], ['disabled', true], ['hidden', true]];
  const IDENT_RE = (n) => new RegExp('(^|[^\\w$.])' + n.replace(/[$]/g, '\\$') + '(?![\\w$])', 'g');

  // Decorate and filter the tools found in a repository. Reasons that remove a tool from the list the server would send:
  //   disabled-by-default    a literal table keyed by the tool's name says enabled: false (or disabled: true)
  //   declares-conditions    the tool carries a non-empty conditions list (it is registered only when those flags are set)
  //   alternate-server       the tool is only in one of several server modules that register overlapping tools (one is chosen by configuration)
  //   unreferenced-declaration  a { name, description, inputSchema } constant that nothing else in the server mentions
  // Reasons that only mark a tool (the reader cannot know which way the condition goes):
  //   conditional-branch     the registration sits inside an if / else of its own function
  //   conditional-caller     every call of the function that registers it sits inside an if / else
  //   deprecated             the title or description starts by saying so
  function markConditionals(found, files, dupes, allFiles) {
    const marks = new Map(found.map((f) => [f, []]));
    const add = (f, reason, detail, exclude) => marks.get(f).push({ reason, detail: detail || null, exclude: !!exclude });
    const srcs = new Map(); (allFiles || files).forEach(([p, text]) => srcs.set(p, text));
    const tokCache = new Map(); const blkCache = new Map(); const pyLineCache = new Map();
    const tk = (p) => { if (!tokCache.has(p)) { try { tokCache.set(p, tokenize(srcs.get(p))); } catch (e) { tokCache.set(p, []); } } return tokCache.get(p); };
    const bl = (p) => { if (!blkCache.has(p)) blkCache.set(p, jsBlocks(srcs.get(p), tk(p))); return blkCache.get(p); };
    const isJs = (p) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(p);
    const names = new Set(found.map((f) => f.tool.name));
    // options declared with default: true ({ javascriptEvaluation: { type: 'boolean', default: true } })
    let on = null;
    const defaultOn = () => {
      if (on) return on; on = new Set();
      (allFiles || files).forEach(([, text]) => { if (typeof text !== 'string' || text.indexOf('default') < 0) return; const re = /([A-Za-z_$][\w$]*)['"]?\s*:\s*\{[^{}]{0,400}?\bdefault\s*:\s*true\b/g; let m; while ((m = re.exec(text))) on.add(m[1]); });
      return on;
    };

    // branch / caller conditions
    const callSites = new Map();
    const callersOf = (fname) => {
      if (callSites.has(fname)) return callSites.get(fname);
      const out = [];
      srcs.forEach((text, p) => {
        if (!isJs(p) || text.indexOf(fname) < 0) return;
        const t = tk(p);
        for (let i = 0; i < t.length - 1; i++) {
          if (t[i].type === 'id' && t[i].value === fname && isP(t[i + 1], '(') && !(t[i - 1] && t[i - 1].type === 'id' && /^(function|async)$/.test(t[i - 1].value))) {
            // a declaration "NAME(args) {" of a method is not a call
            const close = matchClose(t, i + 1);
            if (isP(t[close + 1], '{') ) continue;
            out.push({ p, guards: guardsAt(bl(p), t, t[i].start).guards });
          }
        }
      });
      callSites.set(fname, out); return out;
    };
    found.forEach((f) => {
      if (isJs(f.path) && f.offset !== undefined) {
        const t = tk(f.path); const g = guardsAt(bl(f.path), t, f.offset);
        if (g.guards.length) add(f, 'conditional-branch', g.guards.map((x) => x.cond).join(' && ').slice(0, 120));
        else if (g.fn) { const calls = callersOf(g.fn); if (calls.length && calls.every((c) => c.guards.length)) add(f, 'conditional-caller', calls[0].guards.map((x) => x.cond).join(' && ').slice(0, 120)); }
      } else if (/\.py$/.test(f.path) && f.line) {
        if (!pyLineCache.has(f.path)) pyLineCache.set(f.path, pyLinesOf(srcs.get(f.path)));
        const gs = pyGuards(pyLineCache.get(f.path), f.line);
        if (gs.length) add(f, 'conditional-branch', gs.map((x) => x.cond).join(' and ').slice(0, 120));
      }
      const a = f.tool.annotations; const conds = (a && Array.isArray(a.conditions) ? a.conditions : null) || (Array.isArray(f.tool.conditions) ? f.tool.conditions : null);
      // a condition that names an option whose declared default is true is met by default: marked, not removed
      if (conds && conds.length) add(f, 'declares-conditions', conds.join(', ').slice(0, 120), !conds.every((c) => defaultOn().has(String(c))));
      if (f.tool._deprecated) add(f, 'deprecated-flag', 'deprecated in its definition', true);
      const text = String(f.tool.title || '') + ' ' + String(f.tool.description || '').slice(0, 80);
      if (/\bdeprecated\b/i.test(String(f.tool.title || '')) || /^\s*(\(?deprecated\b|\[deprecated\])/i.test(String(f.tool.description || '')) || /\bis deprecated\b/i.test(String(f.tool.description || '').slice(0, 120))) add(f, 'deprecated', null); void text;
    });

    // a literal table keyed by tool names that switches tools off
    srcs.forEach((text, p) => {
      if (!isJs(p) || !/\b(enabled|defaultEnabled|enabledByDefault|disabled|hidden)\b/.test(text)) return;
      const t = tk(p); const ctx = { consts: {}, zodNames: new Set() };
      for (let i = 0; i < t.length - 2; i++) {
        if (!(t[i].type === 'id' || t[i].type === 'str') || !names.has(String(t[i].value)) || !isP(t[i + 1], ':') || !isP(t[i + 2], '{')) continue;
        let o; try { o = parseObject(t, i + 2, ctx); } catch (e) { continue; }
        if (!o.value || o.value === SKIP) continue;
        const hit = DISABLED_KEYS.find(([k, v]) => o.value[k] === v);
        if (hit) found.forEach((f) => { if (f.tool.name === String(t[i].value)) add(f, 'disabled-by-default', hit[0] + ': ' + hit[1] + ' in ' + p, true); });
      }
    });

    // Several modules registering the same tool names are alternatives (one is chosen by configuration at start): keep the
    // module with the most tools, drop the tools only the others have. dupes: the registrations that lost the name to an earlier file.
    const reg = found.map((f) => ({ f, path: f.path, name: f.tool.name })).concat((dupes || []).map((d) => ({ f: null, path: d.path, name: d.name })));
    const filesOf = new Map(); const namesIn = new Map();
    reg.forEach((r) => { if (!filesOf.has(r.name)) filesOf.set(r.name, new Set()); filesOf.get(r.name).add(r.path); if (!namesIn.has(r.path)) namesIn.set(r.path, new Set()); namesIn.get(r.path).add(r.name); });
    const parent = new Map(); const find = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    filesOf.forEach((set) => { const a = Array.from(set); a.slice(1).forEach((x) => parent.set(find(x), find(a[0]))); });
    const comps = new Map(); namesIn.forEach((_, p) => { const r = find(p); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(p); });
    comps.forEach((paths) => {
      if (paths.length < 2) return;
      paths.sort((x, y) => namesIn.get(y).size - namesIn.get(x).size || x.length - y.length || (x < y ? -1 : 1));
      const keep = namesIn.get(paths[0]);
      // An alternative repeats most of the kept module's tools (at least half of its own names are there too); a module
      // that shares a name or two is a second module of the same server (both registered or mounted), not an alternative.
      const alt = new Set(paths.slice(1).filter((p) => { const ns = Array.from(namesIn.get(p)); return ns.filter((n) => keep.has(n)).length * 2 >= ns.length; }));
      found.forEach((f) => { if (alt.has(f.path) && !keep.has(f.tool.name)) add(f, 'alternate-server', f.path + ' is an alternative to ' + paths[0], true); });
    });

    // a literal declaration that no other file or line mentions
    found.forEach((f) => {
      if (!f.literal || !f.binding) return;
      let uses = 0;
      srcs.forEach((text) => { const m = text.match(IDENT_RE(f.binding)); if (m) uses += m.length; });
      if (uses <= 1) add(f, 'unreferenced-declaration', f.binding, true);
    });
    return marks;
  }

  // Everything the reader does with a repository's files: SDK and constants, extraction, marking, exclusion.
  // files: Map(path -> text) or [[path, text]]. Returns { found, tools, excluded, sdk }.
  // Files that may define a tool (a cheap test of their text); the others are read only for the constants they hold.
  const TOOL_HINT = /registerTool|\.tool\s*\(|@[\w.]*tool\b|@\w+\.\w+\(|inputSchema|input_schema|\bTool\s*\(|[a-z]Tool\s*\(|\btool\s*\(|add_tool|from_function|ToolDefinition|ListToolsRequestSchema|list_tools|\.mount\s*\(|import_server|_tool\s*\(|extends\s+[\w.]*Tool/;
  const MAX_TOOL_FILES = 400;   // files that may define a tool, read for tools
  const MAX_SOURCE_READ = 1500; // source files read in all (the others lend constants to them)
  // Classes that register tools through `this` (server.registerTool(this.name, …)), and every class extending one.
  function toolBases(files) {
    const bases = new Set(); const ext = []; const root = new Map();
    files.forEach(([p, text]) => {
      if (!/\.(ts|mts|cts|js|mjs|cjs)$/.test(p) || typeof text !== 'string' || text.indexOf('class') < 0) return;
      let m; const re = /\bclass\s+(\w+)(?:\s*<[^{]*?>)?\s+extends\s+([\w$.]+)/g;
      while ((m = re.exec(text))) ext.push([m[1], m[2].split('.').pop()]);
      if (/(?:registerTool|\.tool|addTool)\b[\s\S]{0,4000}?\bthis\.(?:name|toolName)\b/.test(text) && /\bthis\.(?:name|toolName)\b[\s\S]{0,400}?(?:description|inputSchema|this\.)/.test(text)) {
        const cre = /\bclass\s+(\w+)/g; let c; while ((c = cre.exec(text))) { bases.add(c[1]); root.set(c[1], p); }
      }
    });
    for (let round = 0; round < 6; round++) { let grew = false; ext.forEach(([a, b]) => { if (bases.has(b) && !bases.has(a)) { bases.add(a); root.set(a, root.get(b)); grew = true; } }); if (!grew) break; }
    bases.root = root; // class -> the file that registers it (a class tool belongs with that code when tools are grouped by package)
    return bases;
  }

  // Everything the reader does with a repository's files: SDK and constants, extraction, marking, exclusion.
  // ---- tools of another agent host's plugin API, not of an MCP server
  // A JavaScript or TypeScript file that imports another agent host's tool API (an OpenCode or OpenClaw plugin, the
  // Vercel AI SDK, OpenAI Agents, LangChain, Mastra, LlamaIndex) and no MCP module may define that host's tools:
  // `tool({ … })` and `api.registerTool({ … })`, a call whose first argument is the tool object, look like MCP
  // registrations but are not. Only those host-shaped calls are dropped (and named in hints.hostPlugins); SDK-shaped
  // ones, `x.registerTool('name', …)` and `x.tool('name', …)`, stay: an MCP tool that calls an LLM through such a
  // library is common. Any module whose name mentions MCP (the SDK, FastMCP, mcp-handler, xmcp, …) or the Claude Agent
  // SDK (its in-process MCP servers) keeps all of a file's tools.
  const HOST_PLUGIN_MODULE = /^(?:@opencode-ai\/plugin|openclaw|ai|@ai-sdk\/[^/]+|@openai\/agents(?:-[\w-]+)?|@langchain\/[^/]+|langchain|@mastra\/core|llamaindex|@llamaindex\/[^/]+)(?:\/.*)?$/;
  const MCP_MODULE = /mcp|modelcontextprotocol|claude-agent-sdk/i;
  const HOST_SHAPED = /^\.?\s*(?:registerTool|tool)\s*\(\s*\{/;
  const HOST_SHAPED_LINE = /(?:^|[^\w$])(?:registerTool|tool)\s*\(\s*\{/;
  function hostPluginModule(src) {
    if (typeof src !== 'string') return null;
    const re = /\bfrom\s*(['"])([^'"\n]{1,200})\1|\bimport\s*(['"])([^'"\n]{1,200})\3|\b(?:require|import)\s*\(\s*(['"])([^'"\n]{1,200})\5\s*\)/g;
    let m; let host = null;
    while ((m = re.exec(src))) {
      const spec = m[2] || m[4] || m[6];
      if (MCP_MODULE.test(spec)) return null;
      if (!host && HOST_PLUGIN_MODULE.test(spec)) host = spec.split('/').slice(0, spec[0] === '@' ? 2 : 1).join('/');
    }
    return host;
  }
  // files: Map(path -> text) or [[path, text]]. Returns { found, tools, excluded, sdk, unresolved }.
  // opts.maxSourceFiles: at most this many files that may define a tool are read for tools (default 400).
  // ------------------------------------------------------------ Python: FastMCP.from_fastapi (tools from FastAPI routes)
  // FastMCP.from_fastapi(app, route_maps=…, route_map_fn=…) turns the app's OpenAPI operations into tools: name = the
  // operation_id cut at "__", slugified, at most 56 characters; description = the operation description (FastAPI: the
  // endpoint's cleaned docstring, cut at \f) or else its summary; inputSchema = the path, query, header and cookie
  // parameters with the JSON body's properties merged in (flat_param_schema), schemas dumped without None values.
  // Route maps pick which routes are tools: the first RouteMap whose methods, pattern and tags match decides; no match
  // is a tool. The app's routes are read from its include_router calls before from_fastapi (routers defined in the
  // repository, a loop over an imported list of them included), with their prefixes and tags. What cannot be worked out
  // is never guessed: a route whose map cannot be decided, or a router that cannot be found, is left out and the
  // reason is given in the notes; a parameter or body the reader cannot type marks that tool's input schema unreadable.
  const FA_METHODS = /^(get|post|put|delete|patch|options|head|trace)$/;
  const FA_SKIP_TYPES = /^(?:fastapi\.|starlette\.(?:requests\.|responses\.)?)?(Request|Response|BackgroundTasks|WebSocket|HTTPConnection|SecurityScopes)$/;
  function faStr(s) { // one Python string literal (any quotes, r/u prefix); f-strings and bytes are not read
    const m = /^([rRuU]{0,1})("""|'''|"|')([\s\S]*)$/.exec(s.trim());
    if (!m || !m[3].endsWith(m[2]) || m[3].length < m[2].length) return undefined;
    const body = m[3].slice(0, m[3].length - m[2].length);
    if (m[2].length === 1 && body.includes('\n')) return undefined;
    return /r/i.test(m[1]) ? body : pyUnescape(body);
  }
  // A literal Python value: strings (adjacent ones joined), numbers, True/False/None, lists, tuples and sets of them,
  // names of constants; MCPType.X as { mcpType }. undefined when not a literal.
  function faVal(src, consts, depth) {
    let s = String(src).trim(); depth = depth || 0;
    if (!s || depth > 8 || s.length > 20000) return undefined;
    if (/^\(([\s\S]*)\)$/.test(s) && splitTop(s.slice(1, -1), ',').length <= 1 && !/,\s*\)$/.test(s)) return faVal(s.slice(1, -1), consts, depth + 1);
    // adjacent string literals
    const parts = []; let i = 0;
    while (i < s.length) {
      while (/\s/.test(s[i] || '')) i++;
      if (i >= s.length) break;
      const m = /^[rRuU]?("""|'''|"|')/.exec(s.slice(i)); if (!m) { parts.length = 0; break; }
      const q = m[1]; let j = i + m[0].length;
      while (j < s.length) { if (s[j] === '\\') { j += 2; continue; } if (s.startsWith(q, j)) break; j++; }
      if (j >= s.length) { parts.length = 0; break; }
      parts.push(s.slice(i, j + q.length)); i = j + q.length;
    }
    if (parts.length) { const vs = parts.map(faStr); return vs.every((x) => typeof x === 'string') ? vs.join('') : undefined; }
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d*\.\d+(e-?\d+)?$/i.test(s)) return parseFloat(s);
    if (s === 'True' || s === 'False') return s === 'True';
    if (s === 'None') return null;
    let m;
    if ((m = /^(?:fastmcp\.server\.openapi\.)?MCPType\.(\w+)$/.exec(s))) return { mcpType: m[1] };
    if (/^[A-Za-z_]\w*$/.test(s)) return consts && Object.prototype.hasOwnProperty.call(consts, s) ? consts[s] : undefined;
    if (/^[[({][\s\S]*[\])}]$/.test(s) && !/^\{[\s\S]*:/.test(s.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""'))) {
      const xs = splitTop(s.slice(1, -1), ',').filter((x) => x.trim()).map((x) => faVal(x, consts, depth + 1));
      return xs.every((x) => x !== undefined) ? xs : undefined;
    }
    return undefined;
  }
  // inspect.cleandoc, then FastAPI's cut at \f and strip
  function faCleandoc(doc) {
    const lines = String(doc).replace(/\t/g, '        ').split('\n');
    let margin = Infinity;
    lines.slice(1).forEach((l) => { const c = l.replace(/^\s+/, ''); if (c) margin = Math.min(margin, l.length - c.length); });
    const out = [lines[0].replace(/^\s+/, '')].concat(lines.slice(1).map((l) => (margin < Infinity ? l.slice(margin) : l)));
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join('\n').split('\f')[0].trim();
  }
  const faPyTitle = (s) => s.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()); // str.title()
  function faSlug(s) { return s.replace(/[\s\-.]+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').replace(/_+/g, '_').replace(/^_+|_+$/g, ''); }
  // One Python file, read once: logical lines, module constants, imports, top-level assignments, defs and decorators.
  const F_top = (lines, k) => lines[k].indent === 0;
  function faFile(path, text) {
    const lines = pyLogicalLines(pyStripComments(text));
    const consts = {}; const imports = {}; const assigns = {}; const defs = {};
    lines.forEach((l, k) => {
      if (l.indent === 0) {
        let m;
        if ((m = /^from\s+(\.*[\w.]*)\s+import\s+([\s\S]+)$/.exec(l.text))) {
          m[2].replace(/^\(|\)\s*$/g, '').split(',').forEach((x) => { const q = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(x); if (q) imports[q[2] || q[1]] = { mod: m[1], name: q[1] }; });
        } else if ((m = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(l.text))) imports[m[2] || m[1].split('.')[0]] = { mod: m[2] ? m[1] : m[1].split('.')[0], name: null };
        else if ((m = /^([A-Za-z_]\w*)\s*(?::\s*[^=]+?)?\s*=\s*([\s\S]+)$/.exec(l.text)) && topLevelEq(l.text) > 0) { assigns[m[1]] = { text: m[2].trim(), k }; const v = faVal(m[2], consts); if (v !== undefined) consts[m[1]] = v; }
      }
      const d = /^(?:async\s+)?def\s+(\w+)\s*\(/.exec(l.text);
      if (d && (defs[d[1]] === undefined || (l.indent === 0 && F_top(lines, defs[d[1]])))) defs[d[1]] = k; // the last top-level def wins (@overload stubs come first)
    });
    return { path, text, lines, consts, imports, assigns, defs };
  }
  // The body lines of the logical line at k (deeper indent, up to the next line at its indent or less).
  function faBody(F, k) { const ind = F.lines[k].indent; let e = k + 1; while (e < F.lines.length && F.lines[e].indent > ind) e++; return [k + 1, e]; }
  function faCall(text) { // NAME(args) -> { fn, args } (args: positional and keyword texts)
    const m = /^([\w.]+)\s*\(([\s\S]*)\)\s*$/.exec(text.trim()); if (!m) return null;
    const pos = []; const kw = {};
    splitTop(m[2], ',').forEach((p) => { const eq = topLevelEq(p); if (eq > 0 && /^\w+$/.test(p.slice(0, eq).trim())) kw[p.slice(0, eq).trim()] = p.slice(eq + 1).trim(); else if (p) pos.push(p); });
    return { fn: m[1], pos, kw };
  }
  function faParams(head) { // def f(a: T = d, …) -> [{ name, ann, def }]
    const o = head.indexOf('('); if (o < 0) return null;
    let d = 0; let c = -1; let q = null;
    for (let x = o; x < head.length; x++) { const ch = head[x]; if (q) { if (ch === '\\') x++; else if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") q = ch; else if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) { d--; if (d === 0) { c = x; break; } } }
    if (c < 0) return null;
    const out = [];
    for (const p of splitTop(head.slice(o + 1, c), ',')) {
      if (!p || p === '/' || p === '*') continue;
      if (/^\*/.test(p)) return null; // *args / **kwargs: FastAPI reads them as query params; not read here
      const eq = topLevelEq(p); const lhs = eq < 0 ? p : p.slice(0, eq); const colon = lhs.indexOf(':');
      const name = (colon < 0 ? lhs : lhs.slice(0, colon)).trim(); if (!/^\w+$/.test(name)) return null;
      if (name === 'self' || name === 'cls') continue;
      out.push({ name, ann: colon < 0 ? null : lhs.slice(colon + 1).trim(), def: eq < 0 ? undefined : p.slice(eq + 1).trim() });
    }
    return out;
  }
  // The FastMCP versions the fixtures of R-RD-37 were checked against: tool names (operation id cut at "__", slugified,
  // 56 characters) are listed as these versions write them; for any other version, or none pinned, the names are marked
  // as not certain. Unmatched routes default to TOOL from FastMCP 2.8.0 (before it, DEFAULT_ROUTE_MAPPINGS made GET
  // routes resources and resource templates, src/fastmcp/server/openapi.py at v2.7.1); a dependency range whose lowest
  // version is older leaves out GET routes no route map decides.
  const FA_VERIFIED = ['2.14.5', '4.1.6', '4.1.7'];
  const FA_TOOL_DEFAULT_FROM = [2, 8, 0];
  const verCmp = (a, b) => { for (let i = 0; i < 3; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
  // The fastmcp version of a package: { pinned: 'x.y.z' | null, lowest: [x, y, z] | null } from uv.lock (exact), then an
  // exact pin (==) or the lowest version of a range (>=, ~=, >, ^) in requirements or pyproject.
  function faVersion(entries) {
    let pinned = null; let lowest = null;
    entries.forEach(([p, t]) => {
      if (typeof t !== 'string') return;
      let m;
      if (/(^|\/)uv\.lock$/.test(p) && (m = /\[\[package\]\]\s*\nname\s*=\s*"fastmcp(?:-slim)?"\s*\nversion\s*=\s*"(\d+)\.(\d+)\.(\d+)[^"]*"/.exec(t))) { pinned = m[1] + '.' + m[2] + '.' + m[3]; lowest = [+m[1], +m[2], +m[3]]; }
    });
    if (pinned) return { pinned, lowest };
    entries.forEach(([p, t]) => {
      if (typeof t !== 'string' || lowest || !/(^|\/)(requirements[^/]*\.txt|pyproject\.toml)$/.test(p)) return;
      const m = /\bfastmcp(?:-slim)?\s*(?:\[[^\]]*\])?\s*(===?|~=|>=|>|\^)\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(t);
      if (!m) return;
      lowest = [+m[2], +(m[3] || 0), +(m[4] || 0)];
      if (/^==/.test(m[1]) && m[3] !== undefined && m[4] !== undefined) pinned = lowest.join('.');
    });
    return { pinned, lowest };
  }
  // A route map pattern (Python re, searched in the path) as a JavaScript RegExp, or null when JavaScript would read it
  // differently or it may backtrack without end: escapes other than \d \D \w \W \s \S \b \B \n \r \t \f \v and
  // punctuation (\A, \Z, \z, \u…, backreferences), groups other than (?:…) (?=…) (?!…) (?<=…) (?<!…) (?<name>…) and
  // (?P<name>…) (inline flags, (?P=name), comments, conditionals), possessive quantifiers, {,n}, and a quantified group
  // holding a quantifier ((a+)+). Longer than FA_MAX_PATTERN characters is not read.
  const FA_MAX_PATTERN = 200;
  function faPattern(src) {
    if (typeof src !== 'string' || src.length > FA_MAX_PATTERN) return null;
    let out = ''; const groups = []; let inClass = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch === '\\') {
        const nx = src[i + 1]; if (nx === undefined) return null;
        if (/[A-Za-z0-9]/.test(nx) && !/[dDwWsSbBnrtfv]/.test(nx)) return null;
        out += ch + nx; i++; continue;
      }
      if (inClass) { if (ch === ']') inClass = false; out += ch; continue; }
      if (ch === '[') { inClass = true; out += ch; if (src[i + 1] === '^') { out += '^'; i++; } if (src[i + 1] === ']') { out += '\\]'; i++; } continue; }
      if (ch === '(') {
        if (src[i + 1] === '?') {
          const rest = src.slice(i + 2);
          if (/^P<[A-Za-z_]\w*>/.test(rest)) { out += '(?<'; i += 3; groups.push(false); continue; }
          if (!/^(?::|=|!|<=|<!|<[A-Za-z_]\w*>)/.test(rest)) return null;
        }
        groups.push(false); out += ch; continue;
      }
      if (ch === ')') {
        if (!groups.length) return null;
        const quantInside = groups.pop();
        const q = src[i + 1];
        if (quantInside && (q === '+' || q === '*' || (q === '{' && /^\{\d*,/.test(src.slice(i + 1))))) return null;
        if (groups.length && (quantInside || q === '+' || q === '*' || q === '{')) groups[groups.length - 1] = true;
        out += ch; continue;
      }
      if (ch === '*' || ch === '+' || ch === '?' || ch === '}') {
        if (src[i + 1] === '+') return null; // possessive (Python 3.11+)
        if (groups.length && ch !== '?') groups[groups.length - 1] = true;
      }
      if (ch === '{' && /^\{,/.test(src.slice(i))) return null; // {,n}: Python's {0,n}, a literal to JavaScript
      out += ch;
    }
    if (inClass || groups.length) return null;
    try { return new RegExp(out); } catch (e) { return null; }
  }
  function pyFastapiTools(readable, allText) {
    const out = { found: [], notes: [] };
    const pyFiles = readable.filter(([p]) => /\.py$/.test(p));
    const servers = pyFiles.filter(([, t]) => /\bfrom_fastapi\s*\(/.test(t));
    if (!servers.length) return out;
    const files = new Map(); const fileOf = (p) => { if (!files.has(p)) { const e = pyFiles.find(([q]) => q === p); files.set(p, e ? faFile(p, e[1]) : null); } return files.get(p); };
    // module name -> file: every dotted suffix of a .py path (src layouts, packages read from a subfolder)
    const mods = new Map();
    pyFiles.forEach(([p]) => { const segs = p.replace(/\.py$/, '').split('/'); if (segs[segs.length - 1] === '__init__') segs.pop(); for (let i = 0; i < segs.length; i++) { const k = segs.slice(i).join('.'); if (!mods.has(k)) mods.set(k, []); mods.get(k).push(p); } });
    // Imports resolve only to modules under the server file's package root (the nearest folder above it with a
    // pyproject.toml, setup.py or setup.cfg; the repository when there is none), so a module of another package of a
    // monorepo with the same dotted name is never taken for the server's.
    const all = allText instanceof Map ? Array.from(allText.entries()) : readable;
    const pkgDirs = all.map(([p]) => p).filter((p) => /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg)$/.test(p)).map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''));
    const rootOf = (p) => { let best = ''; pkgDirs.forEach((d) => { if ((d === '' || p.startsWith(d + '/')) && d.length > best.length) best = d; }); return best; };
    const under = (root, p) => root === '' || p.startsWith(root + '/');
    let pkgRoot = '';
    const modFile = (F, mod) => {
      if (/^\./.test(mod)) { const dots = /^\.+/.exec(mod)[0].length; const base = F.path.split('/').slice(0, -dots); const rest = mod.slice(dots); const stem = base.concat(rest ? rest.split('.') : []).join('/'); return [stem + '.py', stem + '/__init__.py'].find((x) => under(pkgRoot, x) && fileOf(x)) || null; }
      const c = (mods.get(mod) || []).filter((p) => under(pkgRoot, p)); return c.length === 1 ? c[0] : null;
    };
    // the fastmcp version of the server's package (set per server below)
    let ver = { pinned: null, lowest: null }; let major = null;
    // a decorator below the route decorator: kept only when it is a repository function that uses functools.wraps
    const wrapsOk = new Map();
    const decoratorKeeps = (name) => {
      if (wrapsOk.has(name)) return wrapsOk.get(name);
      let ok = false;
      for (const [p] of pyFiles) { const F = fileOf(p); const k = F.defs[name]; if (k === undefined || F.lines[k].indent !== 0) continue; const [a, b] = faBody(F, k); ok = F.lines.slice(a, b).some((l) => /(^|[^\w])(functools\.)?wraps\s*\(/.test(l.text)); break; }
      wrapsOk.set(name, ok); return ok;
    };
    // a Depends(f): adds nothing when f is a repository function without parameters (or only a Request)
    const depKeeps = (expr, F) => {
      const c = faCall(expr); if (!c || !/^(?:fastapi\.)?(Depends|Security)$/.test(c.fn) || c.pos.length !== 1 || Object.keys(c.kw).length) return false;
      const fn = c.pos[0].trim(); if (!/^\w+$/.test(fn)) return false;
      let D = null; let k;
      if (F.defs[fn] !== undefined) { D = F; k = F.defs[fn]; }
      else if (F.imports[fn]) { const p = modFile(F, F.imports[fn].mod); const G = p && fileOf(p); const nm = F.imports[fn].name || fn; if (G && G.defs[nm] !== undefined) { D = G; k = G.defs[nm]; } }
      if (!D) return false;
      const ps = faParams(D.lines[k].text); return !!ps && ps.every((p) => p.ann && FA_SKIP_TYPES.test(p.ann.trim()));
    };
    // a Pydantic model of the repository as Pydantic writes its JSON schema: { schema, ok }
    const modelCache = new Map();
    const modelOf = (F, name, depth) => {
      if (depth > 4) return null;
      let G = F; let nm = name;
      if (!G.lines.some((l) => l.indent === 0 && new RegExp('^class\\s+' + nm + '\\b').test(l.text))) {
        const im = F.imports[name]; if (!im) return null; const p = modFile(F, im.mod); G = p && fileOf(p); nm = im.name || name; if (!G) return null;
        if (!G.lines.some((l) => l.indent === 0 && new RegExp('^class\\s+' + nm + '\\b').test(l.text))) return G.imports[nm] ? modelOf(G, nm, depth + 1) : null;
      }
      const key = G.path + ':' + nm; if (modelCache.has(key)) return modelCache.get(key);
      const k = G.lines.findIndex((l) => l.indent === 0 && new RegExp('^class\\s+' + nm + '\\b').test(l.text));
      const head = /^class\s+\w+\s*(?:\(([^)]*)\))?\s*:/.exec(G.lines[k].text);
      const bases = head && head[1] ? splitTop(head[1], ',') : [];
      if (!(bases.length === 1 && /^(?:pydantic\.)?BaseModel$/.test(bases[0]))) { modelCache.set(key, null); return null; }
      const props = {}; const required = []; let ok = true;
      const [a, b] = faBody(G, k); const ind = a < b ? G.lines[a].indent : 0;
      G.lines.slice(a, b).forEach((l, i) => {
        if (l.indent !== ind) return;
        if (i === 0 && /^[rRuU]?["']/.test(l.text)) return; // the class docstring
        if (/^(?:async\s+)?def\s|^@|^class\s|^pass$|^\.\.\.$/.test(l.text)) { if (/^class\s+Config\b/.test(l.text)) ok = false; return; }
        const m = /^(\w+)\s*:\s*([\s\S]+?)(?:\s*=\s*([\s\S]+))?$/.exec(l.text);
        if (!m) { if (/^model_config\b/.test(l.text)) ok = false; return; }
        if (/^ClassVar\b/.test(m[2])) return;
        if (m[1] === 'model_config') { ok = false; return; }
        let ann = m[2]; let def = m[3]; const s = { title: faPyTitle(m[1].replace(/_/g, ' ')) }; let kw = {}; let name = m[1];
        const ann2 = /^Annotated\[([\s\S]+)\]$/.exec(ann);
        if (ann2) { const ps = splitTop(ann2[1], ','); ann = ps[0]; const fc = ps.slice(1).map(faCall).find((c) => c && /^(?:pydantic\.)?Field$/.test(c.fn)); if (fc) { kw = fc.kw; if (fc.pos.length) def = fc.pos[0]; } }
        const fcall = def !== undefined ? faCall(def) : null;
        if (fcall && /^(?:pydantic\.)?Field$/.test(fcall.fn)) { kw = Object.assign({}, kw, fcall.kw); def = fcall.pos.length ? fcall.pos[0] : kw.default; }
        if (kw.alias !== undefined) { const v = faVal(kw.alias, G.consts); if (typeof v !== 'string') ok = false; else { name = v; s.title = faPyTitle(v.replace(/_/g, ' ')); } }
        if (kw.default_factory !== undefined) def = undefined;
        const t = pyType(ann);
        if (!t.exact) ok = false;
        Object.assign(s, t.schema);
        const tgt = s.anyOf && s.anyOf.length === 2 && s.anyOf.some((x) => x.type === 'null') ? s.anyOf.find((x) => x.type !== 'null') : s;
        const kwv = {}; Object.keys(kw).forEach((x) => { if (['ge', 'le', 'gt', 'lt', 'min_length', 'max_length', 'multiple_of', 'pattern'].includes(x)) { const v = faVal(kw[x], G.consts); if (v === undefined) ok = false; else kwv[x] = typeof v === 'string' ? JSON.stringify(v) : String(v); } else if (!['description', 'default', 'alias', 'title', 'examples', 'default_factory'].includes(x)) ok = false; });
        pyConstraints(tgt, kwv);
        if (kw.description !== undefined) { const v = faVal(kw.description, G.consts); if (typeof v === 'string') s.description = v; else ok = false; }
        if (kw.title !== undefined) { const v = faVal(kw.title, G.consts); if (typeof v === 'string') s.title = v; else ok = false; }
        if (kw.examples !== undefined) ok = false;
        if (def === undefined || def.trim() === '...') { if (kw.default_factory === undefined) required.push(name); }
        else { const v = faVal(def, G.consts); if (v === undefined || (v && typeof v === 'object' && !Array.isArray(v))) ok = false; else if (v !== null) s.default = v; }
        props[name] = s;
      });
      const r = { schema: { type: 'object', properties: props, required }, ok };
      modelCache.set(key, r); return r;
    };
    // routes of a router (or the app) named `name` in file F: [{ F, k (def line), method, path, opts, tags, deps }]
    const routesOf = (F, name, prefix, tags, depth, why, deps, isApp) => {
      if (depth > 6) { why.push('included routers nested deeper than the reader follows'); return []; }
      const res = [];
      if (isApp) return decorated(F, name, prefix, tags, deps, why);
      // the router variable: assigned here, or imported
      if (!F.assigns[name] && F.imports[name]) {
        const im = F.imports[name]; const p = modFile(F, im.mod); const G = p && fileOf(p);
        if (!G) { why.push('router ' + name + ' imported from ' + im.mod + ', not found in the repository'); return res; }
        return routesOf(G, im.name || name, prefix, tags, depth + 1, why, deps);
      }
      const as = F.assigns[name];
      if (!as) { why.push('router ' + name + ' not found in ' + F.path); return res; }
      const c = faCall(as.text);
      let rprefix = ''; let rtags = []; let rdeps = deps;
      if (c && /^(?:fastapi\.)?APIRouter$/.test(c.fn)) {
        if (c.kw.prefix !== undefined) { const v = faVal(c.kw.prefix, F.consts); if (typeof v !== 'string') { why.push('the prefix of router ' + name + ' in ' + F.path); return res; } rprefix = v; }
        if (c.kw.tags !== undefined) { const v = faVal(c.kw.tags, F.consts); if (!Array.isArray(v)) { why.push('the tags of router ' + name + ' in ' + F.path); return res; } rtags = v; }
        if (c.kw.dependencies !== undefined) rdeps = true;
        if (c.kw.generate_unique_id_function !== undefined || c.kw.route_class !== undefined) { why.push('router ' + name + ' in ' + F.path + ' sets its own operation ids or route class'); return res; }
      } else if (!(c && /^(?:fastapi\.)?FastAPI$/.test(c.fn))) { why.push(name + ' in ' + F.path + ' is not an APIRouter the reader can read'); return res; }
      const pre = prefix + rprefix; const tg = tags.concat(rtags);
      res.push(...decorated(F, name, pre, tg, rdeps, why));
      // routers included into this one
      F.lines.forEach((l) => {
        const m = new RegExp('^' + name + '\\.include_router\\s*\\(').exec(l.text); if (!m) return;
        res.push(...includeInto(F, l, pre, tg, depth + 1, why, rdeps));
      });
      return res;
    };
    // the routes decorated @name.<method>(…) in F
    const decorated = (F, name, pre, tg, rdeps, why) => {
      const res = [];
      F.lines.forEach((l, k) => {
        const dm = new RegExp('^@' + name + '\\.(\\w+)\\s*\\(').exec(l.text);
        if (!dm) return;
        const dc = faCall(l.text.slice(1));
        if (!FA_METHODS.test(dm[1])) { if (/^(api_route|websocket|route)$/.test(dm[1])) why.push('a ' + dm[1] + ' route at ' + F.path + ':' + l.line + ' (its methods are not read)'); return; }
        // the def it decorates, and the decorators between them
        let j = k + 1; const below = [];
        while (j < F.lines.length && /^@/.test(F.lines[j].text)) { below.push(F.lines[j].text.slice(1)); j++; }
        if (j >= F.lines.length || !/^(?:async\s+)?def\s/.test(F.lines[j].text)) return;
        res.push({ F, k: j, deco: l, method: dm[1], call: dc, prefix: pre, tags: tg, below, deps: rdeps });
      });
      return res;
    };
    const includeInto = (F, l, prefix, tags, depth, why, deps) => {
      const c = faCall(l.text.replace(/^\w+\./, '')); if (!c || !c.pos.length) { why.push('an include_router call at ' + F.path + ':' + l.line); return []; }
      let p2 = ''; let t2 = [];
      if (c.kw.include_in_schema !== undefined && faVal(c.kw.include_in_schema, F.consts) === false) return [];
      if (c.kw.prefix !== undefined) { const v = faVal(c.kw.prefix, F.consts); if (typeof v !== 'string') { why.push('the prefix at ' + F.path + ':' + l.line); return []; } p2 = v; }
      if (c.kw.tags !== undefined) { const v = faVal(c.kw.tags, F.consts); if (!Array.isArray(v)) { why.push('the tags at ' + F.path + ':' + l.line); return []; } t2 = v; }
      const d2 = deps || c.kw.dependencies !== undefined;
      const r = c.pos[0].trim();
      if (/^\w+$/.test(r)) return routesOf(F, r, prefix + p2, tags.concat(t2), depth, why, d2);
      const am = /^(\w+)\.(\w+)$/.exec(r); // module.router
      if (am && F.imports[am[1]]) { const im = F.imports[am[1]]; const p = modFile(F, im.name ? (im.mod.replace(/\.$/, '') + (im.mod.endsWith('.') ? '' : '.') + im.name) : im.mod); const G = p && fileOf(p); if (G) return routesOf(G, am[2], prefix + p2, tags.concat(t2), depth, why, d2); }
      why.push('router ' + r + ' included at ' + F.path + ':' + l.line);
      return [];
    };
    for (const [sp] of servers) {
      const S = fileOf(sp); if (!S) continue;
      pkgRoot = rootOf(sp);
      ver = faVersion(all.filter(([p]) => under(pkgRoot, p)));
      major = ver.lowest ? ver.lowest[0] : null;
      const namesSure = !!ver.pinned && FA_VERIFIED.includes(ver.pinned);
      const oldDefault = !!ver.lowest && verCmp(ver.lowest, FA_TOOL_DEFAULT_FROM) < 0;
      S.lines.forEach((l, k) => {
        const at = l.text.search(/\bFastMCP\.from_fastapi\s*\(/); if (at < 0) return;
        const where = sp + ':' + l.line;
        const callText = l.text.slice(at); const open = callText.indexOf('(');
        let d = 0; let close = -1; let q = null;
        for (let x = open; x < callText.length; x++) { const ch = callText[x]; if (q) { if (ch === '\\') x++; else if (ch === q) q = null; continue; } if (ch === '"' || ch === "'") q = ch; else if ('([{'.includes(ch)) d++; else if (')]}'.includes(ch)) { d--; if (d === 0) { close = x; break; } } }
        const c = close > 0 ? faCall(callText.slice(0, close + 1).replace(/^FastMCP\./, '')) : null;
        const appExpr = c && (c.kw.app || c.pos[0]);
        if (!c || !appExpr || !/^\w+$/.test(appExpr.trim())) { out.notes.push('FastMCP.from_fastapi at ' + where + ': the app is not a name the reader can follow, so its routes are not listed'); return; }
        const app = appExpr.trim();
        for (const bad of ['mcp_names', 'component_fn', 'mcp_component_fn']) if (c.kw[bad] !== undefined) { out.notes.push('FastMCP.from_fastapi at ' + where + ' passes ' + bad + ', which the reader does not apply, so its routes are not listed'); return; }
        // route maps
        let maps = []; let mapFn = null;
        if (c.kw.route_maps !== undefined) {
          const items = /^\[([\s\S]*)\]$/.exec(c.kw.route_maps.trim());
          const parsed = items ? splitTop(items[1], ',').filter(Boolean).map((x) => {
            const rc = faCall(x); if (!rc || !/^(?:\w+\.)*RouteMap$/.test(rc.fn) || rc.pos.length) return null;
            const o = { methods: '*', pattern: null, tags: [], type: null };
            for (const kn of Object.keys(rc.kw)) {
              const v = faVal(rc.kw[kn], S.consts);
              if (kn === 'methods') { if (v === '*' || (Array.isArray(v) && v.every((y) => typeof y === 'string'))) o.methods = v === '*' ? '*' : v.map((y) => y.toUpperCase()); else return null; }
              else if (kn === 'pattern') { if (typeof v !== 'string') return null; o.pattern = faPattern(v); if (!o.pattern) return null; }
              else if (kn === 'tags') { if (!Array.isArray(v)) return null; o.tags = v; }
              else if (kn === 'mcp_type') { if (!v || !v.mcpType) return null; o.type = v.mcpType; }
              else if (kn === 'mcp_tags') { /* tags given to the component: not part of the tool list */ }
              else return null;
            }
            return o.type ? o : null;
          }) : null;
          if (!parsed || parsed.some((x) => !x)) { out.notes.push('FastMCP.from_fastapi at ' + where + ': route_maps not read, so which routes are tools is not known; none listed'); return; }
          maps = parsed;
        }
        if (c.kw.route_map_fn !== undefined) {
          // def f(route, mcp_type): return MCPType.A if route.operation_id [not] in NAMES else MCPType.B
          const fn = c.kw.route_map_fn.trim(); const k2 = /^\w+$/.test(fn) ? S.defs[fn] : undefined;
          const ps = k2 !== undefined ? faParams(S.lines[k2].text) : null;
          let ok = false;
          if (ps && ps.length === 2) {
            const [a, b] = faBody(S, k2); const body = S.lines.slice(a, b).filter((x, i) => !(i === 0 && /^[rRuU]?["']/.test(x.text)));
            const m = body.length === 1 && new RegExp('^return\\s+([\\w.]+)\\s+if\\s+' + ps[0].name + '\\.operation_id\\s+(not\\s+in|in)\\s+(\\w+)\\s+else\\s+([\\w.]+)$').exec(body[0].text);
            const names = m && faVal(m[3], S.consts);
            const side = (x) => (x === ps[1].name ? { keep: true } : faVal(x, S.consts));
            const yes = m && side(m[1]); const no = m && side(m[4]);
            if (m && Array.isArray(names) && names.every((x) => typeof x === 'string') && yes && no && (yes.keep || yes.mcpType) && (no.keep || no.mcpType)) {
              const inside = /not/.test(m[2]) ? no : yes; const outside = /not/.test(m[2]) ? yes : no;
              mapFn = (route, t) => { const r = names.includes(route.operationId) ? inside : outside; return r.keep ? t : r.mcpType; };
              ok = true;
            }
          }
          if (!ok) { out.notes.push('FastMCP.from_fastapi at ' + where + ': route_map_fn ' + fn + ' not read, so which routes are tools is not known; none listed'); return; }
        }
        // the app: its last `app = FastAPI(...)` before the call, at the call's indent or less, and its include_router
        // calls and routes between the two
        let start = -1;
        for (let j = k - 1; j >= 0; j--) { const m = new RegExp('^' + app + '\\s*(?::[^=]+)?=\\s*([\\s\\S]+)$').exec(S.lines[j].text); if (m && S.lines[j].indent <= l.indent) { const ac = faCall(m[1]); if (ac && /^(?:fastapi\.)?FastAPI$/.test(ac.fn)) { start = j; if (ac.kw.dependencies !== undefined || ac.kw.generate_unique_id_function !== undefined || ac.kw.openapi_prefix !== undefined || ac.kw.root_path !== undefined) start = -2; } break; } }
        if (start === -1 && S.imports[app]) { out.notes.push('FastMCP.from_fastapi at ' + where + ': the app is imported, and the reader reads only an app built in the same file; its routes are not listed'); return; }
        if (start < 0) { out.notes.push('FastMCP.from_fastapi at ' + where + ': the FastAPI app ' + app + ' ' + (start === -2 ? 'sets dependencies, operation ids or a root path the reader does not apply' : 'was not found') + '; its routes are not listed'); return; }
        const why = []; const routes = [];
        for (let j = start + 1; j < k; j++) {
          const t = S.lines[j].text;
          if (new RegExp('^' + app + '\\.include_router\\s*\\(').test(t)) routes.push(...includeInto(S, S.lines[j], '', [], 0, why, false));
          const lm = /^for\s+(\w+)\s+in\s+(\w+)\s*:\s*$/.exec(t);
          if (lm) {
            const [a, b] = faBody(S, j);
            const inc = S.lines.slice(a, b).filter((x) => new RegExp('^' + app + '\\.include_router\\s*\\(\\s*' + lm[1] + '\\b').test(x.text));
            if (!inc.length) continue;
            // the list: here, or imported (a module-level list of router names)
            let G = S; let ln = lm[2];
            if (!G.assigns[ln] && G.imports[ln]) { const p = modFile(G, G.imports[ln].mod); const H = p && fileOf(p); if (H) { ln = G.imports[ln].name || ln; G = H; } }
            const lt = G.assigns[ln] && /^[[(]([\s\S]*)[\])]$/.exec(G.assigns[ln].text);
            const names = lt ? splitTop(lt[1], ',').filter(Boolean) : null;
            if (!names || !names.every((x) => /^\w+$/.test(x))) { why.push('the routers of the loop at ' + S.path + ':' + S.lines[j].line); continue; }
            names.forEach((nm) => { inc.forEach((x) => { const fake = Object.assign({}, x, { text: x.text.replace(new RegExp('\\(\\s*' + lm[1] + '\\b'), '(' + nm) }); routes.push(...includeInto(G, fake, '', [], 0, why, false)); }); });
            j = b - 1;
          }
        }
        routes.push(...routesOf(S, app, '', [], 0, why, false, true).filter((r) => r.k > start && r.k < k));
        if (why.length) out.notes.push('FastMCP.from_fastapi at ' + where + ': routes not listed because the reader could not resolve ' + Array.from(new Set(why)).slice(0, 4).join('; ') + (why.length > 4 ? ' and more' : ''));
        const seen = new Set(); let unsure = 0; let oldGets = 0;
        routes.forEach((r) => {
          const F = r.F; const dl = F.lines[r.k]; const dc = r.call || { pos: [], kw: {} };
          const un = [];
          const v = (x) => faVal(x, F.consts);
          if (dc.kw.include_in_schema !== undefined && v(dc.kw.include_in_schema) === false) return;
          const pathV = v(dc.pos[0] !== undefined ? dc.pos[0] : dc.kw.path); if (typeof pathV !== 'string') { out.notes.push('a route at ' + F.path + ':' + r.deco.line + ' whose path is not a literal; not listed'); return; }
          const full = r.prefix + pathV;
          const rtags = dc.kw.tags !== undefined ? v(dc.kw.tags) : [];
          if (!Array.isArray(rtags)) { out.notes.push('the route at ' + F.path + ':' + r.deco.line + ' has tags the reader cannot read; not listed'); return; }
          const allTags = r.tags.concat(rtags);
          const fname = /def\s+(\w+)/.exec(dl.text)[1];
          let opId = dc.kw.operation_id !== undefined ? v(dc.kw.operation_id) : undefined;
          if (dc.kw.operation_id !== undefined && typeof opId !== 'string') { out.notes.push('the route at ' + F.path + ':' + r.deco.line + ' has an operation_id the reader cannot read; not listed'); return; }
          if (opId === undefined) { const rn = dc.kw.name !== undefined ? v(dc.kw.name) : fname; if (typeof rn !== 'string') { out.notes.push('the route at ' + F.path + ':' + r.deco.line + ' has a name the reader cannot read; not listed'); return; } opId = (rn + full).replace(/\W/g, '_') + '_' + r.method; }
          // the route map
          const method = r.method.toUpperCase();
          const hit = maps.find((m) => (m.methods === '*' || m.methods.includes(method)) && (!m.pattern || m.pattern.test(full)) && m.tags.every((t) => allTags.includes(t)));
          // before FastMCP 2.8.0 a GET route no map decides is a resource (template), from 2.8.0 a tool
          if (!hit && !mapFn && oldDefault && method === 'GET') { oldGets++; return; }
          let type = hit ? hit.type : 'TOOL';
          if (mapFn) { if (!hit && oldDefault && method === 'GET') { oldGets++; return; } type = mapFn({ operationId: opId, path: full, method }, type); }
          if (type !== 'TOOL') return;
          const name = faSlug(opId.split('__')[0]).slice(0, 56);
          if (seen.has(name)) { out.notes.push('a second route named ' + name + ' at ' + F.path + ':' + r.deco.line + ' (FastMCP renames it); not listed'); return; }
          seen.add(name);
          // description: the decorator's, else the docstring, else the summary
          let description; let doc;
          const bl = F.lines[r.k + 1]; if (bl && bl.indent > dl.indent && /^[rRuU]?["']/.test(bl.text)) { const s = faVal(bl.text, {}); if (typeof s === 'string') doc = s; }
          if (dc.kw.description !== undefined) { const s = v(dc.kw.description); if (typeof s === 'string') description = s; else un.push('description'); }
          else if (doc !== undefined && faCleandoc(doc)) description = faCleandoc(doc);
          else if (dc.kw.summary !== undefined) { const s = v(dc.kw.summary); if (typeof s === 'string') description = s; else un.push('description'); }
          else description = faPyTitle((dc.kw.name !== undefined && typeof v(dc.kw.name) === 'string' ? v(dc.kw.name) : fname).replace(/_/g, ' '));
          // the endpoint's parameters
          const props = {}; const req = { path: [], query: [], header: [], cookie: [] }; const order = { path: [], query: [], header: [], cookie: [] };
          let body = null; let bodyReq = false;
          const below = r.below.filter((x) => !decoratorKeeps(/^([\w.]+)/.exec(x)[1].split('.').pop()));
          if (below.length || r.deps || dc.kw.dependencies !== undefined) un.push('inputSchema');
          if (below.length) un.push('description');
          const ps = faParams(dl.text); if (!ps) un.push('inputSchema');
          const pathNames = (full.match(/\{(\w+)(?::\w+)?\}/g) || []).map((x) => /\{(\w+)/.exec(x)[1]);
          (ps || []).forEach((p) => {
            let ann = p.ann || ''; let marker = p.def !== undefined ? faCall(p.def) : null; let def = p.def;
            const an = /^Annotated\[([\s\S]+)\]$/.exec(ann);
            if (an) { const xs = splitTop(an[1], ','); ann = xs[0]; const mk = xs.slice(1).map(faCall).find((x) => x && /^(?:fastapi\.)?(Query|Path|Header|Cookie|Body|Depends|Security|Form|File)$/.test(x.fn)); if (mk) { marker = mk; } }
            if (ann && FA_SKIP_TYPES.test(ann.trim())) return;
            const kind = marker && /^(?:fastapi\.)?(Query|Path|Header|Cookie|Body|Depends|Security|Form|File)$/.exec(marker.fn);
            if (kind && /^(Depends|Security)$/.test(kind[1])) { if (!depKeeps((an ? marker.fn + '(' + marker.pos.concat(Object.keys(marker.kw).map((x) => x + '=' + marker.kw[x])).join(', ') + ')' : p.def), F)) un.push('inputSchema'); return; }
            if (kind && /^(Form|File|Body)$/.test(kind[1])) { un.push('inputSchema'); return; }
            let loc = kind ? kind[1].toLowerCase() : null; const kw = kind ? marker.kw : {};
            if (kind) def = an ? def : (marker.pos.length ? marker.pos[0] : kw.default);
            if (!loc && pathNames.includes(p.name)) loc = 'path';
            const model = !loc && /^\w+$/.test(ann.trim()) ? modelOf(F, ann.trim(), 0) : null;
            if (model) { if (body) { un.push('inputSchema'); return; } body = model; bodyReq = def === undefined; if (!model.ok) un.push('inputSchema'); return; }
            if (!loc) loc = 'query';
            const t = pyType(ann || 'Any'); if (!ann || !t.exact) un.push('inputSchema');
            let pname = p.name;
            if (kw.alias !== undefined) { const a = v(kw.alias); if (typeof a === 'string') pname = a; else un.push('inputSchema'); }
            else if (loc === 'header' && !(kw.convert_underscores !== undefined && v(kw.convert_underscores) === false)) pname = p.name.replace(/_/g, '-');
            const s = Object.assign({}, t.schema);
            const tgt = s.anyOf && s.anyOf.length === 2 && s.anyOf.some((x) => x.type === 'null') ? s.anyOf.find((x) => x.type !== 'null') : s;
            const kwv = {}; Object.keys(kw).forEach((x) => { if (['ge', 'le', 'gt', 'lt', 'min_length', 'max_length', 'multiple_of', 'pattern'].includes(x)) { const y = v(kw[x]); if (y === undefined) un.push('inputSchema'); else kwv[x] = typeof y === 'string' ? JSON.stringify(y) : String(y); } else if (x === 'regex') un.push('inputSchema'); });
            pyConstraints(tgt, kwv);
            s.title = kw.alias !== undefined ? pname : faPyTitle(p.name.replace(/_/g, ' '));
            if (kw.description !== undefined) { const y = v(kw.description); if (typeof y === 'string') s.description = y; else un.push('inputSchema'); }
            if (loc === 'path' && kw.description !== undefined && (major === null || major < 3)) un.push('description'); // 2.x lists described path parameters in the description; with no version known, either may hold
            const required = loc === 'path' || def === undefined || def.trim() === '...';
            if (!required) { const y = v(def); if (y === undefined || (y && typeof y === 'object')) un.push('inputSchema'); else if (y !== null) s.default = y; }
            if (props[pname]) un.push('inputSchema');
            props[pname] = s; order[loc].push(pname); if (required) req[loc].push(pname);
          });
          const required = req.path.concat(req.query, req.header, req.cookie);
          if (body) {
            Object.keys(body.schema.properties).forEach((n) => { if (props[n]) un.push('inputSchema'); props[n] = body.schema.properties[n]; });
            if (bodyReq) required.push(...body.schema.required);
          }
          if (!namesSure) { un.push('name'); unsure++; }
          const tool = { name };
          if (description) tool.description = description;
          tool.inputSchema = { type: 'object', properties: props, required };
          if (un.length) tool._unreadable = Array.from(new Set(un));
          out.found.push({ path: F.path, line: dl.line, tool, fidelity: 'derived', marks: [] });
        });
        const vtext = ver.pinned ? 'pins fastmcp ' + ver.pinned : ver.lowest ? 'allows fastmcp from ' + ver.lowest.join('.') : 'pins no fastmcp version';
        if (unsure) out.notes.push('FastMCP.from_fastapi at ' + where + ': tool names are written as FastMCP ' + FA_VERIFIED.join(', ') + ' write them; the package ' + vtext + ', so ' + unsure + ' tool name' + (unsure === 1 ? '' : 's') + ' may differ');
        if (oldGets) out.notes.push('FastMCP.from_fastapi at ' + where + ': ' + oldGets + ' GET route' + (oldGets === 1 ? '' : 's') + ' no route map decides not listed: the package ' + vtext + ', and before 2.8.0 FastMCP made those resources, not tools');
      });
    }
    return out;
  }
  function analyseRepo(files, opts) {
    opts = opts || {};
    const all = files instanceof Map ? Array.from(files.entries()) : files;
    const paths = all.map(([p]) => p);
    const plan = planFiles(paths, opts.allowBuilt ? { allowBuilt: true } : null);
    const text = new Map(all);
    const sdk = Object.assign({}, detectSdk(text), opts.sdk || {});
    const readable = plan.src.map((p) => [p, text.get(p)]).filter(([, x]) => typeof x === 'string' && x.length <= 600000);
    // a tools/list handler of the server's own applies to its package (the nearest folder with a package.json), not to
    // other servers of the repository (R-RD-04)
    const pkgDirs = paths.filter((p) => /(^|\/)package\.json$/.test(p) && !SKIP_DIR.test(p)).map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''));
    const pkgOf = (p) => { let best = null; pkgDirs.forEach((d) => { if ((d === '' || p.startsWith(d + '/')) && (best === null || d.length > best.length)) best = d; }); return best === null ? '' : best; };
    const customBy = new Map();
    readable.forEach(([p, x]) => { const c = customListHandler(p, x); if (!c) return; const r = pkgOf(p); if (customBy.get(r) !== 'replace') customBy.set(r, c); });
    const sdkMemo = new Map();
    const sdkFor = (p) => { if (!customBy.size) return sdk; const r = pkgOf(p); if (!customBy.has(r)) return sdk; if (!sdkMemo.has(r)) sdkMemo.set(r, Object.assign({}, sdk, { customList: customBy.get(r) })); return sdkMemo.get(r); };
    const candidates = readable.filter(([, x]) => TOOL_HINT.test(x));
    const srcList = candidates.slice(0, opts.maxSourceFiles || MAX_TOOL_FILES);
    const consts = collectGlobalConsts(readable);
    const mods = moduleConsts(readable, consts, sdkFor);
    const pyConsts = pyGlobalConsts(readable); const pyRegs = pyRegistrars(readable); const mounts = pyMounts(readable); const pyTpl = pyToolTemplates(readable);
    const bases = toolBases(readable);
    const pyChangedMemo = new Map();
    const pyChanged = (p, name) => { const k = p + '\u0000' + name; if (!pyChangedMemo.has(k)) pyChangedMemo.set(k, pyListChangedElsewhere(readable, p, name)); return pyChangedMemo.get(k); };
    const found = []; const byName = new Set(); const firstPath = new Map();
    const dupes = []; const unresolved = []; const overBudget = [];
    const hostPlugins = [];
    srcList.forEach(([p, t]) => {
      let ts = [];
      const js = /\.(ts|mts|cts|js|mjs|cjs)$/.test(p);
      try {
        ts = extractFromFile(p, t, js ? { sdk: sdkFor(p), consts: mods.seedFor(p), tokens: mods.tokens(p), wrappers: mods.importedWrappers(p), frozenImport: (name) => mods.frozenImport(p, name), classTools: bases, workBudget: opts.workBudget } : { sdk, pyConsts, pyRegistrars: pyRegs, pyTemplates: pyTpl, pyChangedElsewhere: (name) => pyChanged(p, name) });
      } catch (e) { ts = []; ts.unresolved = [{ line: null }]; } // a file the reader fails on counts as one unread registration
      // another agent host's plugin: named, never listed (R-RD-05)
      const host = js ? hostPluginModule(t) : null;
      if (host) {
        const lines = t.split('\n');
        const kept = ts.filter((x) => typeof x.offset !== 'number' || !HOST_SHAPED.test(t.slice(x.offset, x.offset + 200)));
        const unres = (ts.unresolved || []).filter((u) => !(u.line && HOST_SHAPED_LINE.test(lines[u.line - 1] || '')));
        const n = ts.length - kept.length + (ts.unresolved || []).length - unres.length;
        if (n) hostPlugins.push({ path: p, module: host, tools: n });
        const keep = kept; keep.unresolved = unres; keep.overBudget = ts.overBudget; ts = keep;
      }
      (ts.unresolved || []).forEach((u) => unresolved.push(Object.assign({ path: p }, u)));
      (ts.overBudget || []).forEach((u) => overBudget.push(Object.assign({ path: p }, u)));
      ts.forEach((x) => {
        // a FastMCP server mounted under a prefix lists its tools as <prefix>_<name>
        if (x.server && mounts.has(x.server)) { x.tool = Object.assign({}, x.tool, { name: mounts.get(x.server) + '_' + x.tool.name }); x.prefix = mounts.get(x.server); }
        // a class tool belongs with the code that registers it, unless it sits in test, mock or example code
        if (x.groupPath && notServerFolder(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', true)) delete x.groupPath;
        // a duplicate of one literal list is kept only when the name's first tool came from that same file's list (R-RD-08)
        if (!byName.has(x.tool.name) || (x.listDup && firstPath.get(x.tool.name) === p)) { if (!byName.has(x.tool.name)) firstPath.set(x.tool.name, p); byName.add(x.tool.name); found.push(Object.assign({ path: p }, x)); } else dupes.push({ path: p, name: x.tool.name });
      });
    });
    // FastMCP.from_fastapi: tools from the FastAPI app's routes (R-RD-37)
    let fastapiNotes = [];
    try { const fa = pyFastapiTools(readable, text); fastapiNotes = fa.notes; fa.found.forEach((x) => { if (!byName.has(x.tool.name)) { byName.add(x.tool.name); found.push(x); } else dupes.push({ path: x.path, name: x.tool.name }); }); } catch (e) { if (e && e.name === 'RangeError') throw e; fastapiNotes = ['FastMCP.from_fastapi: the reader failed on the FastAPI app, so its routes are not listed']; }
    const marks = markConditionals(found, srcList, dupes, readable);
    found.forEach((f) => { f.marks = marks.get(f); f.excluded = f.marks.some((m) => m.exclude); });
    // Never return an empty list because of exclusions: the marks stay, the exclusion does not apply.
    if (found.length && found.every((f) => f.excluded)) found.forEach((f) => { f.excluded = false; f.marks.forEach((m) => { m.exclude = false; }); });
    return { found, notes: fastapiNotes, tools: found.filter((f) => !f.excluded), excluded: found.filter((f) => f.excluded), sdk, plan, files: srcList.length, candidates: candidates.length, read: readable.length, unresolved: unresolved.length, unresolvedList: unresolved, overBudget, hostPlugins };
  }

  // ------------------------------------------------------------ network
  function parseRepoRef(input) {
    const s = String(input || '').trim().replace(/\.git$/, '');
    let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+)(\/.*)?)?\/?$/.exec(s);
    if (!m) m = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
    if (!m) return null;
    return { owner: m[1], repo: m[2], ref: m[3] || null, subdir: m[4] ? m[4].replace(/^\/|\/$/g, '') : null };
  }

  const MAX_FILE = 1536 * 1024;      // a source file or committed list
  const MAX_JSON = 16 * 1024 * 1024; // an API answer (a recursive tree listing of a large repository)
  const MAX_TOTAL = 64 * 1024 * 1024; // all files of one scan
  // The body as text, at most `cap` bytes; a longer body is refused, not cut.
  async function readCapped(r, cap, url) {
    const len = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-length') : 0);
    const big = () => { const e = new Error('Answer over ' + Math.round(cap / 1024) + ' KiB for ' + url); e.code = 'too_large'; return e; };
    if (len && len > cap) throw big();
    if (r.body && typeof r.body.getReader === 'function') {
      const reader = r.body.getReader(); const dec = new TextDecoder(); let n = 0; let t = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > cap) { try { await reader.cancel(); } catch (e) { /* ignore */ } throw big(); }
        t += dec.decode(value, { stream: true });
      }
      return t + dec.decode();
    }
    const t = await r.text();
    if (t.length > cap) throw big();
    return t;
  }
  async function getJson(f, url, headers) { const r = await f(url, { headers: headers || {}, credentials: 'omit', redirect: 'follow' }); if (!r.ok) { const e = new Error('HTTP ' + r.status + ' for ' + url); e.status = r.status; throw e; } return JSON.parse(await readCapped(r, MAX_JSON, url)); }
  async function getText(f, url) { const r = await f(url, { credentials: 'omit' }); if (!r.ok) { const e = new Error('HTTP ' + r.status + ' for ' + url); e.status = r.status; throw e; } return readCapped(r, MAX_FILE, url); }

  async function listRepo(f, ref, opts) {
    const gh = { Accept: 'application/vnd.github+json' };
    if (opts.githubToken) gh.Authorization = 'Bearer ' + opts.githubToken;
    try {
      const info = ref.ref ? null : await getJson(f, 'https://api.github.com/repos/' + ref.owner + '/' + ref.repo, gh);
      const branch = ref.ref || info.default_branch;
      const api = 'https://api.github.com/repos/' + ref.owner + '/' + ref.repo + '/git/trees/';
      const raw = (sha) => (p) => 'https://raw.githubusercontent.com/' + ref.owner + '/' + ref.repo + '/' + sha + '/' + p.split('/').map(encodeURIComponent).join('/');
      const blobs = (tree, prefix) => tree.filter((x) => x.type === 'blob' && (!x.size || x.size < 1500000)).map((x) => prefix + x.path);
      if (ref.subdir) {
        // A folder: its own tree, listed recursively, so a large repository's listing limit does not hide it. The
        // root's files are kept for the manifests (SDK versions); the walk is one request per folder level.
        const root = await getJson(f, api + encodeURIComponent(branch), gh);
        let cur = root; let found = true;
        for (const seg of ref.subdir.split('/')) {
          const e = (cur.tree || []).find((x) => x.path === seg && x.type === 'tree');
          if (!e) { found = false; break; }
          cur = await getJson(f, api + e.sha, gh);
        }
        if (found) {
          const sub = await getJson(f, api + cur.sha + '?recursive=1', gh);
          return { via: 'github', sha: root.sha, paths: blobs(root.tree || [], '').concat(blobs(sub.tree || [], ref.subdir + '/')), truncated: !!sub.truncated, raw: raw(root.sha) };
        }
      }
      const tree = await getJson(f, api + encodeURIComponent(branch) + '?recursive=1', gh);
      const sha = tree.sha;
      return { via: 'github', sha, paths: tree.tree.filter((x) => x.type === 'blob' && (!x.size || x.size < 1500000)).map((x) => x.path), truncated: !!tree.truncated, raw: (p) => 'https://raw.githubusercontent.com/' + ref.owner + '/' + ref.repo + '/' + sha + '/' + p.split('/').map(encodeURIComponent).join('/') };
    } catch (e) {
      if (opts.noFallback) throw e;
      // rate limited (403/429) or blocked: jsDelivr (no per-user limit; may lag a branch by hours)
      const v = ref.ref || 'HEAD';
      const d = await getJson(f, 'https://data.jsdelivr.com/v1/packages/gh/' + ref.owner + '/' + ref.repo + '@' + encodeURIComponent(v) + '?structure=flat');
      const ver = d.version || v;
      return { via: 'jsdelivr', sha: ver, paths: d.files.map((x) => x.name.replace(/^\//, '')), truncated: false, raw: (p) => 'https://cdn.jsdelivr.net/gh/' + ref.owner + '/' + ref.repo + '@' + ver + '/' + p };
    }
  }

  async function fromGitHub(input, opts) {
    opts = opts || {};
    const f = opts.fetch || fetch;
    const ref = parseRepoRef(input);
    if (!ref) throw new Error('Not a GitHub repository URL.');
    const listing = await listRepo(f, ref, opts);
    // Every file read counts: a refused or failed read (a rate limit, a server error) stops the reading, and the scan
    // fails rather than grade a list with files missing. A file over the per-file cap is skipped (sizes come with the
    // listing), and reading stops at MAX_TOTAL bytes in all (the scan says so).
    const state = { bytes: 0, budgetHit: false, failed: [] };
    const fetchMany = async (ps, n) => {
      const out = []; let k = 0;
      const worker = async () => {
        while (k < ps.length) {
          const p = ps[k++];
          if (state.failed.length) { out.push([p, null]); continue; }
          if (state.bytes >= MAX_TOTAL) { state.budgetHit = true; out.push([p, null]); continue; }
          try { const x = await getText(f, listing.raw(p)); state.bytes += x.length; out.push([p, x]); } catch (e) {
            if (e && e.code === 'too_large') { out.push([p, null]); continue; }
            state.failed.push({ path: p, status: e && e.status, message: e && e.message }); out.push([p, null]);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(n, ps.length) }, worker));
      return out;
    };
    const scan = await scanFiles({ all: listing.paths, subdir: ref.subdir, readMany: fetchMany, maxSourceFiles: opts.maxSourceFiles, state, servers: !!opts.servers, serversDeadline: opts.serversDeadline, effects: !!opts.effects, effectsDepth: opts.effectsDepth });
    if (state.failed.length) {
      const st = state.failed.map((x) => x.status).filter(Boolean);
      const limited = st.some((x) => x === 403 || x === 429);
      const e = new Error((limited ? 'GitHub rate limit: ' : 'GitHub did not answer: ') + state.failed.length + ' file read' + (state.failed.length === 1 ? '' : 's') + ' failed (' + (st.length ? 'HTTP ' + Array.from(new Set(st)).join(', ') : 'network error') + ', first ' + state.failed[0].path + '), so the list would be incomplete and nothing was graded. Retry later, pass a token (--github-token-env), or read a checkout with --repo-dir.');
      e.code = limited ? 'rate_limited' : 'incomplete'; e.status = st[0];
      throw e;
    }
    return Object.assign({ repo: ref.owner + '/' + ref.repo, ref: ref.ref, sha: listing.sha, via: listing.via, truncated: listing.truncated }, scan);
  }

  // The reading shared by fromGitHub and fromDirectory. all: every file path of the repository (relative, "/"-separated);
  // subdir: the folder to read, or null; readMany(paths, concurrency) -> [[path, text | null]].
  // o.builtFallback: when the sources find nothing, read build output and vendor folders (dist, build, out, vendor) too.
  // o.servers: when the folder holds several servers (hints.servers), also read each server's folder on its own, from
  // the same listing and the files already read (no more listing requests): serverScans, one per server in the order
  // of hints.servers, { path, declared, scan } with the reading of that folder alone, or { path, skipped } (a code) for
  // a folder not read: the folder read itself ('multiple_servers'), past MAX_SERVER_SCANS ('reader_limit'), or past
  // o.serversDeadline, a Date.now() value ('timeout'). declared: a server.json of the repository names that folder as
  // its repository.subfolder.
  const MAX_SERVER_SCANS = 24;
  async function scanFiles(o) {
    if (!o.servers) return scanOne(o);
    const memo = new Map();
    const readMany = async (ps, n) => {
      const need = Array.from(new Set(ps.filter((p) => !memo.has(p))));
      if (need.length) for (const [p, t] of await o.readMany(need, n)) memo.set(p, t);
      return ps.map((p) => [p, memo.has(p) ? memo.get(p) : null]);
    };
    const base = Object.assign({}, o, { readMany, servers: false });
    const r = await scanOne(base);
    const list = (r.hints && r.hints.servers) || null;
    if (!list || !list.length) return r;
    const declared = new Set(((r.hints && r.hints.serverJson) || []).map((x) => (typeof x.subfolder === 'string' ? x.subfolder.replace(/^\.?\/+|\/+$/g, '') : null)).filter(Boolean));
    r.serverScans = [];
    for (let k = 0; k < list.length; k++) {
      const path = list[k].path || '';
      const one = { path, declared: declared.has(path) };
      if (!path || path === (o.subdir || '')) one.skipped = 'multiple_servers';
      else if (k >= MAX_SERVER_SCANS) one.skipped = 'reader_limit';
      else if (o.serversDeadline && Date.now() > o.serversDeadline) one.skipped = 'timeout';
      else one.scan = await scanOne(Object.assign({}, base, { subdir: path }));
      r.serverScans.push(one);
    }
    return r;
  }
  async function scanOne(o) {
    let paths = o.all;
    if (o.subdir) paths = paths.filter((p) => p === o.subdir || p.startsWith(o.subdir + '/'));
    let plan = planFiles(paths);
    const maxSrc = o.maxSourceFiles || MAX_TOOL_FILES; // files that may define a tool, read for tools
    const maxRead = Math.max(maxSrc, o.maxRead || MAX_SOURCE_READ); // source files read in all
    const candidates = []; const hints = { serverJson: [] };
    const readMany = o.readMany;
    // exact lists
    const exactFiles = await readMany(plan.exact.slice(0, 400), 8);
    const snaps = exactFiles.filter(([p, t]) => t && /__toolsnaps__/.test(p));
    if (snaps.length) {
      const tools = []; const seen = new Set();
      // shortest path first, ties by path: every listing order gives one list (and one catalog hash)
      snaps.sort((a, b) => a[0].length - b[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).forEach(([p, t]) => { const ts = toolsFromJson(t); (ts || []).forEach((x) => { if (!seen.has(x.name)) { seen.add(x.name); tools.push(x); } }); });
      if (tools.length) candidates.push({ kind: 'snapshots', fidelity: 'exact', path: snaps[0][0].replace(/[^/]+$/, ''), tools });
    }
    const catalogs = []; // mcp-catalog-snap snapshots: placed after the source is read, once the repository's own server name is known
    const committed = [];
    exactFiles.filter(([p, t]) => t && !/__toolsnaps__/.test(p)).forEach(([p, t]) => {
      if (/(^|\/)\.mcp-catalog\//.test(p)) { const c = fromCatalogSnap(t); if (c) catalogs.push({ kind: 'catalog', fidelity: 'exact', path: p, tools: c.tools, server: c.server, capturedAt: c.capturedAt }); return; }
      const ts = toolsFromJson(t); if (ts && ts.length) committed.push({ kind: 'committed', fidelity: 'exact', path: p, tools: ts });
    });
    // Several committed lists are placed after the source is read (see pickList below).
    for (const [p, t] of await readMany(plan.manifests.slice(0, 10), 4)) { const m = t && fromMcpbManifest(t); if (m) candidates.push({ kind: 'mcpb', fidelity: m.fidelity, path: p, tools: m.tools, generated: m.generated }); }
    for (const [p, t] of await readMany(plan.serverJson.slice(0, 5), 4)) { try { const d = JSON.parse(t); if (d && d.name) hints.serverJson.push(Object.assign({ path: p, name: d.name, remotes: d.remotes || [], packages: d.packages || [] }, d.repository && typeof d.repository.subfolder === 'string' ? { subfolder: d.repository.subfolder.slice(0, 300) } : {})); } catch (e) { /* ignore */ } }
    // source extraction: the manifests (SDK and zod versions), then the sources, then one analysis over all of them
    const metaPaths = paths.filter((p) => META_FILE.test(p) && !SKIP_DIR.test(p) && p.split('/').length <= (o.subdir ? o.subdir.split('/').length : 0) + 2).slice(0, 8);
    const rootMeta = o.all.filter((p) => /^(package\.json|package-lock\.json|pyproject\.toml)$/.test(p) && !paths.includes(p));
    const metaFiles = await readMany(metaPaths.concat(rootMeta).slice(0, 10), 4);
    let readFiles = new Map();
    const analyse = async (pl, allowBuilt) => {
      const srcFiles = await readMany(pl.src.slice(0, maxRead), 16);
      const repoFiles = new Map(); metaFiles.concat(srcFiles).forEach(([p, t]) => { if (t) repoFiles.set(p, t); });
      readFiles = repoFiles;
      return analyseRepo(repoFiles, { maxSourceFiles: maxSrc, allowBuilt });
    };
    let an = await analyse(plan);
    let built = false;
    if (!an.tools.length && !candidates.length && o.builtFallback) {
      // Only build output (a repository that commits dist/ and no sources, or a checkout after its build step)
      const bp = planFiles(paths, { allowBuilt: true });
      if (bp.src.length > plan.src.length) { const b = await analyse(bp, true); if (b.tools.length) { an = b; plan = bp; built = true; } }
    }
    // Go and Rust: read when the reader of TypeScript, JavaScript and Python found no tool, or when the repository holds
    // at least as many Go (Rust) source files as TypeScript, JavaScript and Python ones. Their tools join the others
    // (grouped by go.mod / Cargo.toml folder), so several servers are still refused and never merged.
    const extraManifests = []; const serverDirs = new Set();
    let langRead = null;
    // paths relative to the folder read, so a server pointed at inside an examples/ or docs/ folder is read
    const sub = o.subdir ? o.subdir + '/' : '';
    const relPaths = sub ? paths.map((p) => (p.startsWith(sub) ? p.slice(sub.length) : p)) : paths;
    const absOf = (p) => sub + p;
    const jsPy = relPaths.filter((p) => /\.(ts|mts|cts|js|mjs|cjs|py)$/.test(p) && !SKIP_DIR.test(p) && !TEST_FILE.test(p) && !/\.d\.ts$/.test(p)).length;
    for (const L of SYSTEM_LANGS) {
      const planned = L.mod ? L.plan(relPaths) : [];
      if (!planned.length) continue;
      if (an.tools.length && !(planned.length >= jsPy)) continue;
      const srcPaths = planned.slice(0, maxRead).map(absOf);
      const mans = relPaths.filter((p) => L.manifest.test(p) && !L.skip(p, relPaths)).sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0)).slice(0, 200).map(absOf)
        .concat(o.all.filter((p) => L.manifest.test(p) && !p.startsWith(sub) && sub.startsWith(p.replace(/[^/]*$/, '')))); // and the ones above the folder (the module path)
      // in plan order, whatever order the reads finish in (so --repo and --repo-dir give one list and one catalog hash)
      const inOrder = (ps, got) => { const m = new Map(got); return ps.filter((p) => typeof m.get(p) === 'string').map((p) => [p, m.get(p)]); };
      const mfiles = inOrder(mans, await readMany(mans, 8));
      const sfiles = inOrder(srcPaths, await readMany(srcPaths, 16));
      mfiles.forEach(([p, t]) => readFiles.set(p, t)); sfiles.forEach(([p, t]) => readFiles.set(p, t));
      extraManifests.push(L.manifest);
      // a Go main package or a Rust module that constructs a server is a server of its own, even inside one go.mod or
      // Cargo.toml (a repository of several servers in one module): its folder groups the tools like a package
      sfiles.forEach(([p, t]) => { if (L.serverRoot(t)) serverDirs.add(L.rootDir(p, paths)); });
      // tool definitions in folders not read (tests, examples, testdata, benches): named, not graded
      const skipped = L.skippedFolders(relPaths).slice(0, 200);
      if (skipped.length) {
        const hits = new Map();
        for (const [p, t] of await readMany(skipped.map(absOf), 8)) {
          if (typeof t !== 'string') continue;
          const n = (t.match(L.toolHint) || []).length; if (!n) continue;
          const dir = L.skippedFolderOf(p); const h = hits.get(dir) || { path: dir, tools: 0, constructor: false };
          h.tools += n; if (L.serverRoot(t)) h.constructor = true; hits.set(dir, h);
        }
        if (hits.size) hints.ignoredFolders = (hints.ignoredFolders || []).concat(Array.from(hits.values()));
      }
      let got;
      try { got = L.analyse(sfiles, mfiles); } catch (e) { got = { found: [], unresolved: [], overBudget: [{ path: (sfiles[0] || ['?'])[0], line: null }] }; }
      langRead = langRead || { name: L.name, files: 0, total: 0 };
      if (langRead.name !== L.name) langRead.name += ' and ' + L.name;
      langRead.files += sfiles.length; langRead.total += planned.length;
      // Rust: two modules of one crate folder that each implement ServerHandler for their own type and each hold tools
      // are two servers (R-RD-10): each module file is its own group, so they are refused, never merged
      if (L.name === 'Rust') {
        const handlers = new Map(); // folder -> Map(file -> handler types)
        const HANDLER = /\bimpl(?:[ \t]*<[^<>{};]{0,200}>)?[ \t\n]+(?:[\w]+::){0,6}ServerHandler[ \t\n]+for[ \t\n]+([A-Za-z_]\w*)/g;
        sfiles.forEach(([p, t]) => { if (t.indexOf('ServerHandler') < 0) return; HANDLER.lastIndex = 0; const types = new Set(); let m; while ((m = HANDLER.exec(t))) types.add(m[1]); if (!types.size) return; const dir = L.rootDir(p, paths); if (!handlers.has(dir)) handlers.set(dir, new Map()); handlers.get(dir).set(p, types); });
        const withTools = new Set(got.found.map((x) => x.path));
        handlers.forEach((files) => {
          const own = Array.from(files.entries()).filter(([p]) => withTools.has(p));
          const types = new Set(own.flatMap(([, ts]) => Array.from(ts)));
          if (own.length >= 2 && types.size >= 2) own.forEach(([p]) => serverDirs.add(p));
        });
      }
      mergeLanguage(an, got, readFiles);
    }
    if (langRead) hints.languageRead = langRead;
    if (an.hostPlugins && an.hostPlugins.length) hints.hostPlugins = an.hostPlugins.slice(0, 50);
    // One server or several: the tools (and server constructors) grouped by package (serverPackages). With more than one
    // server, nothing is merged or picked: hints.servers lists them and no source candidate is made.
    const servers = serverPackages(paths, o.subdir || '', an.tools, readFiles, extraManifests, serverDirs);
    let found = [];
    const setAside = [];
    if (servers.multiple) hints.servers = servers.multiple.map((x) => ({ path: x.path, tools: x.tools, constructor: x.constructor }));
    else if (servers.keep) {
      found = an.tools.filter((x) => servers.keep.has(servers.rootOf(x.groupPath || x.path)));
      an.tools.filter((x) => !servers.keep.has(servers.rootOf(x.groupPath || x.path))).forEach((x) => { const r = servers.rootOf(x.groupPath || x.path); setAside.push({ name: x.tool.name, path: x.path, line: x.line, reasons: [(servers.reason.get(r) || 'not-server-package') + ' (' + r + ')'] }); });
    }
    if (servers.serverWithoutTools !== null) hints.serverWithoutTools = servers.serverWithoutTools;
    if (servers.ignored.length) hints.ignoredFolders = servers.ignored.map((x) => ({ path: x.path, tools: x.tools, constructor: x.constructor }));
    // Committed lists: one is used as it is. Of several, the one nearest the root is used when it is the only one at that
    // depth, else the only one inside the server's package; otherwise none is (hints.lists). Never picked silently: the
    // others are named in the candidate (notUsed).
    const depth = (p) => p.split('/').length;
    const pickList = () => {
      if (committed.length < 2) return committed[0] || null;
      const min = Math.min(...committed.map((c) => depth(c.path)));
      const top = committed.filter((c) => depth(c.path) === min);
      if (top.length === 1) return top[0];
      if (servers.keep && servers.keep.size === 1) {
        const root = Array.from(servers.keep)[0];
        const inside = committed.filter((c) => root === '' ? false : c.path.startsWith(root + '/'));
        if (inside.length === 1) return inside[0];
      }
      return null;
    };
    const list = pickList();
    if (list) { if (committed.length > 1) list.notUsed = committed.filter((c) => c !== list).map((c) => c.path); candidates.push(list); }
    else if (committed.length > 1) hints.lists = committed.map((c) => ({ path: c.path, tools: c.tools.length }));
    if (found.length) {
      const allLiteral = found.every((x) => x.fidelity === 'literal');
      const marked = an.found.filter((x) => x.marks.length && found.some((f) => servers.rootOf(f.groupPath || f.path) === servers.rootOf(x.groupPath || x.path))).map((x) => ({ name: x.tool.name, reasons: x.marks.map((m) => m.reason), excluded: x.excluded }));
      const out = publicTools(found.map((x) => x.tool));
      // registrations without a readable name in the graded package(s): not listed, but their text is scanned
      const unres = (an.unresolvedList || []).filter((u) => servers.keep && servers.keep.has(servers.rootOf(u.path))).map((u) => {
        if (!u.lost) return u;
        const lt = lostText(u.lost); const v = Object.assign({}, u); delete v.lost;
        if (lt.over) out.over.push('(unnamed registration at ' + u.path + ')'); else if (lt.text) v.text = lt.text;
        return v;
      });
      if (out.over.length) hints.incomplete = { candidates: out.over.length, files: Array.from(new Set(found.filter((x) => out.over.includes(x.tool.name)).map((x) => x.path))).concat(out.over.filter((n) => /^\(unnamed/.test(n))), why: 'text' };
      const langs2 = Array.from(new Set(found.map((x) => x.language || null)));
      const language = langs2.length === 1 && langs2[0] ? langs2[0] : null;
      candidates.push({ kind: 'source', fidelity: allLiteral && !Object.keys(out.unreadable).length && !language ? 'literal' : 'derived', language, path: null, built, files: Array.from(new Set(found.map((x) => x.path))), tools: out.tools, unreadable: out.unreadable, unresolved: unres, unresolvedNames: unres.length, where: found.map((x) => ({ name: x.tool.name, path: x.path, line: x.line, fidelity: x.fidelity })), excluded: an.excluded.filter((x) => found.some((f) => servers.rootOf(f.groupPath || f.path) === servers.rootOf(x.groupPath || x.path))).map((x) => ({ name: x.tool.name, path: x.path, line: x.line, reasons: x.marks.filter((m) => m.exclude).map((m) => m.reason + (m.detail ? ' (' + m.detail + ')' : '')) })).concat(setAside), marked, sdk: an.sdk });
      // opt-in (o.effects): what each tool's handler touches, read from the same files (repo-effects.cjs); never changes the list or its grades
      if (o.effects && RepoEffects) { try { candidates[candidates.length - 1].effects = RepoEffects.analyse(readFiles, found, { depth: o.effectsDepth }); } catch (e) { candidates[candidates.length - 1].effects = { version: 0, tools: {}, summary: { error: 'reader_error' } }; } }
      // several Go main packages (or Rust modules) construct a server and none of them holds tools: they share the
      // tools read, and each may register only part of them; the list is their union, and the report says so
      const ctorOnly = Array.from(serverDirs).filter((d) => d && !found.some((x) => x.path === d || x.path.startsWith(d + '/')));
      if (language && ctorOnly.length >= 2) candidates[candidates.length - 1].notes = [ctorOnly.length + ' ' + language + ' servers are started from ' + ctorOnly.slice(0, 4).map((d) => d || '.').join(', ') + (ctorOnly.length > 4 ? ' and more' : '') + ' and share these tools; each may register only part of them (this list is their union)'];
      if (an.notes && an.notes.length) { const cand = candidates[candidates.length - 1]; cand.notes = (cand.notes || []).concat(an.notes.slice(0, 8)); }
    }
    // A snapshot counts as this repository's exact list only when it names this repository's server. A snapshot of
    // another server (one this repository uses or tests against) is never chosen over tools read from source; with
    // no such tools, a single one is used and marked foreign; several are not used at all.
    const own = ownServerNames(readFiles);
    const mine = catalogs.filter((c) => c.server && own.has(normName(c.server)));
    const foreign = catalogs.filter((c) => !mine.includes(c));
    mine.forEach((c) => candidates.push(c));
    if (foreign.length) hints.foreignSnapshots = foreign.map((c) => ({ path: c.path, server: c.server }));
    if (!found.length && foreign.length === 1) candidates.push(Object.assign(foreign[0], { foreign: true }));
    hints.ownNames = Array.from(own);
    const rank = { exact: 0, literal: 1, derived: 2, names: 3 };
    candidates.sort((a, b) => (a.foreign ? 1 : 0) - (b.foreign ? 1 : 0) || rank[a.fidelity] - rank[b.fidelity] || b.tools.length - a.tools.length);
    const langs = otherLanguages(paths);
    if (langs.length) hints.otherLanguages = langs;
    if (an.unresolved) hints.unresolvedNames = an.unresolved;
    // Candidates the reader had to skip at its work limit: the list would be incomplete, so nothing is graded.
    if (an.overBudget && an.overBudget.length) { const prev = hints.incomplete || { candidates: 0, files: [] }; hints.incomplete = { candidates: prev.candidates + an.overBudget.length, files: Array.from(new Set(prev.files.concat(an.overBudget.map((x) => x.path)))) }; const why = Array.from(new Set(an.overBudget.map((x) => x.why).filter(Boolean))); if (why.length) hints.incomplete.reasons = why; }
    const lr = hints.languageRead || { files: 0, total: 0 };
    return { scanned: { exact: plan.exact.length, manifests: plan.manifests.length, source: an.files + lr.files, candidates: an.candidates + lr.files, read: an.read + lr.files, sourceTotal: plan.src.length + lr.total, capped: plan.src.length > maxRead || an.candidates > an.files, budgetHit: !!(o.state && o.state.budgetHit) }, candidates, best: candidates[0] || null, hints };
  }

  // The tools as they are graded: what could not be read is taken out of each tool and listed per part
  // ({ inputSchema: [names], description: [names], annotations: [names] }); an unreadable inputSchema is
  // { "type": "object", "x-mcp-check-unknown": true }, so a saved list says so too. Checks of those parts are skipped.
  const UNKNOWN_MARK = 'x-mcp-check-unknown';
  // Text the reader could not place in a tool (see LOST) is listed per tool in unreadable.text, for the poisoning checks;
  // a tool whose text runs over MAX_LOST is named in `over`, and the scan refuses the list.
  function publicTools(tools) {
    const unreadable = {}; const over = [];
    const out = tools.map((t) => {
      if (t._lost) {
        const lt = lostText(t._lost);
        if (lt.over) over.push(t.name); else if (lt.text) (unreadable.text = unreadable.text || {})[t.name] = lt.text;
        t = Object.assign({}, t); delete t._lost;
      }
      const u = t._unreadable;
      if (t._deprecated) { t = Object.assign({}, t); delete t._deprecated; }
      if (!u || !u.length) { if (t._unreadable) { t = Object.assign({}, t); delete t._unreadable; } return t; }
      const c = Object.assign({}, t); delete c._unreadable;
      u.forEach((part) => { (unreadable[part] = unreadable[part] || []).push(t.name); });
      if (u.includes('inputSchema')) c.inputSchema = { type: 'object', [UNKNOWN_MARK]: true };
      return c;
    });
    return { tools: out, unreadable, over };
  }

  // ------------------------------------------------------------ one server or several
  // A repository can hold several servers: a monorepo of packages, or a collection of servers. Tools are grouped by their
  // package, the nearest folder (at or below the folder read) holding a package.json, pyproject.toml or setup.py. A package
  // that constructs a server (new McpServer, new Server from the SDK, FastMCP(...)) counts even when none of its tools could
  // be read. Packages in folders whose name says they are not the server (admin, console, docs, evals, examples, fixtures,
  // tests, bench, website, ...) are set aside (`ignored`) and never graded from a parent folder: point the reader at one
  // of them to grade it.
  const PKG_MANIFEST = /(^|\/)(package\.json|pyproject\.toml|setup\.py)$/;
  const NOT_SERVER_WORD = /^(admin|console|docs?|evals?|examples?|fixtures?|tests?|bench|benches|benchmarks?|e2e|playground|demos?|samples?|mocks?|website|site)$/i;
  // A folder named exactly like one of the words (docs, examples, admin, site, ...) is never the server when read from a
  // parent folder. With `words`, a folder with one of them inside its name (docs-mcp, admin-mcp) counts too.
  function notServerFolder(rel, words) { return String(rel).split('/').some((seg) => NOT_SERVER_WORD.test(seg) || (!!words && seg.split(/[-_.]+/).some((w) => NOT_SERVER_WORD.test(w)))); }
  function constructsServer(p, text) {
    if (typeof text !== 'string') return false;
    if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(p)) return /\bnew\s+(?:McpServer|FastMCP)\s*[(<]/.test(text) || (/\bnew\s+Server\s*\(/.test(text) && /@modelcontextprotocol\//.test(text));
    if (/\.py$/.test(p)) return /\b(?:FastMCP|MCPServer)\s*\(/.test(text) || (/\bServer\s*\(\s*['"]/.test(text) && /\b(?:from|import)\s+mcp\b/.test(text));
    if (/\.go$/.test(p)) return !!RepoGo && RepoGo.constructsServer(text);
    if (/\.rs$/.test(p)) return !!RepoRust && RepoRust.constructsServer(text);
    if (/\.cs$/.test(p)) return !!RepoCSharp && RepoCSharp.constructsServer(text);
    return false;
  }
  // Which package(s) a repository's tools belong to. paths: the listing (inside `base`); found: the tools read ({ path, literal });
  // files: Map(path -> text) of the files read. Packages are the folders with a package.json, pyproject.toml or setup.py.
  //   1. Folders that are not the server are set aside (`ignored`): a folder named docs, examples, admin, site, ...; and one
  //      with such a word in its name (docs-mcp, admin-mcp) when another package constructs a server.
  //   2. When some package has tools, packages with none (a constructor only, such as a test stub) are dropped.
  //   3. Two or more packages that each construct a server and have tools: several servers (`multiple`), nothing is graded.
  //   4. One package constructs a server: it is graded, with at most one package that only holds SDK registrations
  //      (registerTool, server.tool, @mcp.tool), its tool library; with two or more such packages it is `multiple` (they
  //      may be servers whose constructor was not read). Packages with only bare tool literals (a client's tool table)
  //      are set aside.
  //   5. No package constructs a server: one package is graded; of several, the only one with SDK registrations; else multiple.
  // Returns { rootOf, keep: Set(root) | null, multiple: [group] | null, reason: Map(root -> why set aside), ignored: [group],
  // serverWithoutTools: root | null }; a group is { path, tools, sdk, literal, constructor }.
  function serverPackages(paths, base, found, files, extraManifests, extraDirs) {
    const up = (d) => (d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '');
    const dirs = new Set();
    const isManifest = (p) => PKG_MANIFEST.test(p) || (extraManifests || []).some((re) => re.test(p));
    paths.forEach((p) => { if (isManifest(p) && !SKIP_DIR.test(p)) dirs.add(up(p)); });
    (extraDirs || []).forEach((d) => { if (d === base || !base || d.startsWith(base + '/')) dirs.add(d); });
    const rootOf = (p) => { if (dirs.has(p)) return p; for (let d = up(p); ; d = up(d)) { if (dirs.has(d)) return d; if (d === base || d === '' || (base && !d.startsWith(base + '/'))) return base; } };
    const groups = new Map();
    const g = (r) => { if (!groups.has(r)) groups.set(r, { path: r, tools: 0, sdk: 0, literal: 0, constructor: false }); return groups.get(r); };
    found.forEach((x) => { const y = g(rootOf(x.groupPath || x.path)); y.tools++; if (x.literal) y.literal++; else y.sdk++; });
    (files instanceof Map ? files : new Map(files || [])).forEach((text, p) => { if (constructsServer(p, text)) g(rootOf(p)).constructor = true; });
    const rel = (r) => (base && r.startsWith(base + '/') ? r.slice(base.length + 1) : r === base ? '' : r);
    const order = (a, b) => (b.constructor ? 1 : 0) - (a.constructor ? 1 : 0) || b.tools - a.tools || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const all = Array.from(groups.values()).sort(order);
    const whole = all.filter((x) => rel(x.path) !== '' && notServerFolder(rel(x.path), false));
    const ctorOutside = (x) => all.some((y) => y !== x && y.constructor && !whole.includes(y) && !(rel(y.path) !== '' && notServerFolder(rel(y.path), true)));
    const ignored = all.filter((x) => whole.includes(x) || (rel(x.path) !== '' && notServerFolder(rel(x.path), true) && ctorOutside(x)));
    const reason = new Map(ignored.map((x) => [x.path, 'not-server-folder']));
    let rest = all.filter((x) => !ignored.includes(x));
    const out = { rootOf, keep: null, multiple: null, reason, ignored, serverWithoutTools: null };
    const withTools = rest.filter((x) => x.tools > 0);
    if (!withTools.length) { const c = rest.filter((x) => x.constructor); if (c.length === 1) out.serverWithoutTools = c[0].path; return out; }
    rest = withTools;
    const ctors = rest.filter((x) => x.constructor);
    let keep;
    if (ctors.length >= 2) { out.multiple = rest; return out; }
    if (ctors.length === 1) {
      // One package of registrations beside the server is its tool library; several may be other servers whose
      // constructor was not read, so they are not attached.
      const regs = rest.filter((x) => !x.constructor && x.sdk > 0);
      if (regs.length > 1) { out.multiple = rest; return out; }
      keep = [ctors[0]].concat(regs);
    }
    else if (rest.length === 1) keep = rest;
    else { const sdk = rest.filter((x) => x.sdk > 0); if (sdk.length !== 1) { out.multiple = rest; return out; } keep = sdk; }
    rest.filter((x) => !keep.includes(x)).forEach((x) => reason.set(x.path, 'not-server-package'));
    out.keep = new Set(keep.map((x) => x.path));
    return out;
  }

  // ------------------------------------------------------------ Go and Rust (repo-go.cjs, repo-rust.cjs)
  // Which files of a listing are read: source files outside dependency, build, test, example and fixture folders, likely
  // tool files first, then by path (so every listing order reads the same files).
  // Their own folders not read (not the TypeScript list: a Go or Rust crate may keep tools in docs/, spec/ or build/):
  // Go: node_modules, vendor, testdata, and examples at a module's root; Rust: target, tests, benches, examples.
  const GO_DEP = /(^|\/)(node_modules|vendor|\.git)\//;
  const GO_NOT_READ = /(^|\/)(testdata)\//;
  const RUST_DEP = /(^|\/)(node_modules|target|\.git)\//;
  const RUST_NOT_READ = /(^|\/)(tests|benches|examples)\//;
  const goModRoots = (paths) => { const k = paths.__goRoots; if (k) return k; const s = new Set(paths.filter((p) => /(^|\/)go\.mod$/.test(p)).map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''))); Object.defineProperty(paths, '__goRoots', { value: s, enumerable: false }); return s; };
  // the examples/ (or example/) folder right under a module root, or null
  const goExamplesOf = (p, paths) => { const segs = p.split('/'); for (let k = 0; k < segs.length - 1; k++) { if (/^examples?$/.test(segs[k]) && goModRoots(paths).has(segs.slice(0, k).join('/'))) return segs.slice(0, k + 1).join('/'); } return null; };
  const langScore = (p) => (/(^|\/)(tools?|server|mcp|handlers?)[^/]*$/i.test(p) || /(^|\/)(tools?|mcp|server)\//i.test(p) ? 0 : /tool/i.test(p) ? 1 : 2) + p.split('/').length * 0.01;
  const byScore = (a, b) => langScore(a) - langScore(b) || (a < b ? -1 : a > b ? 1 : 0);
  const CS_DEP = /(^|\/)(node_modules|bin|obj|\.git|\.vs|packages)\//i;
  const CS_NOT_READ = /(^|\/)(tests?|benchmarks?|[^/]*\.(?:Unit|Integration|Functional|E2E|Acceptance)?Tests?|[^/]*Tests|[^/]*\.Benchmarks?)\//i;
  const CS_NOT_READ_DIR = /^(.*?(?:^|\/)(?:tests?|benchmarks?|[^/]*\.(?:Unit|Integration|Functional|E2E|Acceptance)?Tests?|[^/]*Tests|[^/]*\.Benchmarks?))\//i;
  const SYSTEM_LANGS = [
    { name: 'Go', mod: RepoGo, manifest: /(^|\/)go\.mod$/,
      skip: (p, paths) => GO_DEP.test(p) || GO_NOT_READ.test(p) || !!goExamplesOf(p, paths),
      plan: (paths) => paths.filter((p) => /\.go$/.test(p) && !/_test\.go$/.test(p) && !GO_DEP.test(p) && !GO_NOT_READ.test(p) && !goExamplesOf(p, paths)).sort(byScore),
      skippedFolders: (paths) => paths.filter((p) => /\.go$/.test(p) && !/_test\.go$/.test(p) && !GO_DEP.test(p) && (GO_NOT_READ.test(p) || !!goExamplesOf(p, paths))).sort(),
      skippedFolderOf: (p) => { const m = /^(.*?(?:^|\/)(?:testdata|examples?))\//.exec(p); return m ? m[1] : p.replace(/\/[^/]*$/, ''); },
      toolHint: /\bNewTool\s*\(|\bAddTool\s*\(|\bRegisterTool\s*\(|\bmcp\.Tool\s*\{/g,
      serverRoot: (t) => /^[ \t]*package\s+main\b/m.test(t) && RepoGo.constructsServer(t),
      rootDir: (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''),
      analyse: (src, man) => RepoGo.analyse(src, { goMods: man }) },
    { name: 'Rust', mod: RepoRust, manifest: /(^|\/)Cargo\.toml$/,
      skip: (p) => RUST_DEP.test(p) || RUST_NOT_READ.test(p),
      plan: (paths) => paths.filter((p) => /\.rs$/.test(p) && !RUST_DEP.test(p) && !RUST_NOT_READ.test(p) && !/(^|\/)build\.rs$/.test(p)).sort(byScore),
      skippedFolders: (paths) => paths.filter((p) => /\.rs$/.test(p) && !RUST_DEP.test(p) && RUST_NOT_READ.test(p)).sort(),
      skippedFolderOf: (p) => { const m = /^(.*?(?:^|\/)(?:tests|benches|examples))\//.exec(p); return m ? m[1] : p.replace(/\/[^/]*$/, ''); },
      toolHint: /#\[\s*(?:rmcp::)?tool\b|#\[\s*(?:[\w:]*::)?mcp_tool\s*\(|\bTool::new\s*\(/g,
      serverRoot: (t) => RepoRust.constructsServer(t),
      // a server in the crate's own src/ is the crate (suggest ws/a, not ws/a/src); one in a submodule is that module
      rootDir: (p, paths) => { const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''; const m = /^(.*?)(?:^|\/)src$/.exec(dir); if (m) { const crate = dir === 'src' ? '' : dir.slice(0, -4); if (paths.includes((crate ? crate + '/' : '') + 'Cargo.toml')) return crate; } return dir; },
      analyse: (src, man) => RepoRust.analyse(src, { cargo: man }) },
    // C#: projects (.csproj folders) group the tools like packages; Directory.Packages.props and Directory.Build.props
    // give the SDK version and the nullable setting. bin, obj and test projects are not read.
    { name: 'C#', mod: RepoCSharp, manifest: /(^|\/)([^/]+\.csproj|Directory\.Packages\.props|Directory\.Build\.props)$/,
      skip: (p) => CS_DEP.test(p) || CS_NOT_READ.test(p),
      plan: (paths) => paths.filter((p) => /\.cs$/.test(p) && !/\.(g|designer|generated)\.cs$/i.test(p) && !CS_DEP.test(p) && !CS_NOT_READ.test(p)).sort(byScore),
      skippedFolders: (paths) => paths.filter((p) => /\.cs$/.test(p) && !CS_DEP.test(p) && CS_NOT_READ.test(p)).sort(),
      skippedFolderOf: (p) => { const m = CS_NOT_READ_DIR.exec(p); return m ? m[1] : p.replace(/\/[^/]*$/, ''); },
      toolHint: /\[\s*(?:[\w.]*\.)?McpServerTool(?:Attribute)?\s*[\](,]/g,
      serverRoot: () => false,
      rootDir: (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''),
      analyse: (src, man) => RepoCSharp.analyse(src, { manifests: man }) },
  ];
  // Adds the tools a Go or Rust reading found to the analysis `an` (as analyseRepo returns it): names already found are
  // duplicates (several modules with the same names are alternatives, as for the other languages), marks applied.
  function mergeLanguage(an, got, readFiles) {
    const byName = new Set(an.found.map((x) => x.tool.name));
    const fresh = []; const dupes = [];
    got.found.forEach((x) => {
      if (byName.has(x.tool.name)) { dupes.push({ path: x.path, name: x.tool.name }); return; }
      byName.add(x.tool.name);
      fresh.push({ path: x.path, line: x.line, tool: x.tool, fidelity: x.fidelity, literal: !!x.literal, language: x.language, own: x.marks || [] });
    });
    const marks = markConditionals(fresh, [], dupes, Array.from(readFiles.entries()));
    fresh.forEach((x) => { x.marks = x.own.concat(marks.get(x) || []); delete x.own; x.excluded = x.marks.some((m) => m.exclude); });
    // never an empty list because of exclusions
    if (!an.tools.length && fresh.length && fresh.every((x) => x.excluded)) fresh.forEach((x) => { x.excluded = false; x.marks.forEach((m) => { m.exclude = false; }); });
    fresh.forEach((x) => { an.found.push(x); if (x.excluded) an.excluded.push(x); else an.tools.push(x); });
    (got.unresolved || []).forEach((u) => an.unresolvedList.push(Object.assign({}, u)));
    an.unresolved = an.unresolvedList.length;
    (got.overBudget || []).forEach((u) => an.overBudget.push(u));
  }

  // Server source in languages the reader does not read yet, by file count (only when there are some).
  const OTHER_LANGS = [['Go', /\.go$/], ['Rust', /\.rs$/], ['C#', /\.cs$/], ['Java', /\.java$/], ['Kotlin', /\.kts?$/], ['Ruby', /\.rb$/], ['PHP', /\.php$/], ['Swift', /\.swift$/]];
  function otherLanguages(paths) {
    const read = paths.filter((p) => /\.(ts|mts|cts|js|mjs|cjs|py)$/.test(p) && !SKIP_DIR.test(p) && !TEST_FILE.test(p) && !/\.d\.ts$/.test(p)).length;
    return OTHER_LANGS.map(([name, re]) => ({ name, files: paths.filter((p) => re.test(p) && !SKIP_DIR.test(p) && !/(_test\.go|Tests?\.cs)$/.test(p) && !TEST_FILE.test(p)).length }))
      .filter((x) => x.files > 0).sort((a, b) => b.files - a.files).map((x) => Object.assign(x, { readFiles: read }));
  }

  // ------------------------------------------------------------ the repository's own server name
  // Compared without case, an npm scope, or an "mcp-" / "-mcp" affix: "@acme/Notes-MCP" and "notes" are one name.
  function normName(n) {
    let s = String(n || '').trim().toLowerCase().replace(/^@[^/]+\//, '').replace(/[\s_.]+/g, '-');
    for (let k = 0; k < 3; k++) s = s.replace(/^mcp-/, '').replace(/-mcp$/, '');
    return s;
  }
  // The names this repository gives its own server: McpServer({ name }) / Server({ name }) / FastMCP({ name }) in
  // TypeScript and JavaScript, FastMCP("name") / MCPServer("name") in Python, and the package.json or pyproject.toml name.
  function ownServerNames(files) {
    const out = new Set(); const add = (n) => { const x = normName(n); if (x) out.add(x); };
    const entries = files instanceof Map ? Array.from(files.entries()) : files;
    entries.forEach(([p, text]) => {
      if (typeof text !== 'string') return;
      let m;
      if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(p)) {
        const re = /new\s+(?:McpServer|Server|FastMCP)\s*\(\s*\{[^{}]*?\bname\s*:\s*(['"`])([^'"`\n]{1,100})\1/g;
        while ((m = re.exec(text))) add(m[2]);
      } else if (/\.py$/.test(p)) {
        const re = /\b(?:FastMCP|MCPServer)\s*\(\s*(?:name\s*=\s*)?(['"])([^'"\n]{1,100})\1/g;
        while ((m = re.exec(text))) add(m[2]);
      } else if (/(^|\/)package\.json$/.test(p)) {
        try { const j = JSON.parse(text); if (j && typeof j.name === 'string') add(j.name); } catch (e) { /* ignore */ }
      } else if (/(^|\/)pyproject\.toml$/.test(p)) {
        const sec = /^\[(?:project|tool\.poetry)\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text);
        const nm = sec && /^[ \t]*name\s*=\s*["']([^"'\n]+)["']/m.exec(sec[1]);
        if (nm) add(nm[1]);
      }
    });
    return out;
  }

  // ------------------------------------------------------------ a local checkout (Node only)
  // Folders never entered: installed dependencies, caches and version control. Build output (dist, build, out) and vendor
  // are listed but skipped by planFiles, and read only when nothing else holds a tool (builtFallback).
  const WALK_SKIP = /^(node_modules|\.git|\.hg|\.svn|\.venv|venv|__pycache__|site-packages|\.next|\.nuxt|\.turbo|\.cache|\.tox|\.mypy_cache|\.pytest_cache|coverage|bower_components|jspm_packages)$/;
  const MAX_LIST = 20000; // paths listed from a directory (GitHub's recursive tree answer stops near 100,000 entries)
  const MAX_WALK_DEPTH = 16;
  const LIKELY_SRC = /^(src|lib|server|servers|app|packages|mcp|\.mcp-catalog)$/i;
  /**
   * The same reading as fromGitHub, over a folder on this machine: no network, nothing executed. Symlinks are not
   * followed (a link could lead outside the folder); files over MAX_FILE are not read, as on GitHub.
   * opts: { rootDir } a parent folder whose package.json / package-lock.json / pyproject.toml also count (a monorepo
   * package read from its own folder); { maxSourceFiles } as fromGitHub (default 400 files that may define a tool, of up to 1,500 read; the same as --repo, so the two agree);
   * { exclude } folders and files (relative paths) not to read, such as a baseline list; { skipIfContains } a file name
   * that marks a folder not to read; { maxList } the listing limit (default MAX_LIST). The answer's `truncated` says
   * the folder held more files than the limit (the deepest and least likely ones were not listed).
   */
  async function fromDirectory(dir, opts) {
    opts = opts || {};
    const fs = require('node:fs'); const pathMod = require('node:path');
    const base = pathMod.resolve(String(dir));
    let st; try { st = fs.statSync(base); } catch (e) { const err = new Error('Folder not found: ' + dir); err.code = 'not_found'; throw err; }
    if (!st.isDirectory()) { const err = new Error('Not a folder: ' + dir); err.code = 'not_found'; throw err; }
    const all = []; let truncated = false;
    const maxList = opts.maxList || MAX_LIST;
    const exclude = new Set((opts.exclude || []).map((x) => String(x).replace(/\\/g, '/').replace(/^\.\/|\/+$/g, '')));
    // Breadth first, and the folders that usually hold a server's source (and everything in them) first, so a folder
    // over the listing limit loses its deepest and least likely files, not src/.
    // Two queues: folders inside a likely source folder (src, lib, ...) are listed before every other folder.
    const rank = (n) => (LIKELY_SRC.test(n) ? 0 : 1);
    const likely = []; const other = [[base, '', 0, false]];
    while ((likely.length || other.length) && !truncated) {
      const [abs, rel, depth, inLikely] = likely.length ? likely.shift() : other.shift();
      let ents; try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { continue; }
      ents.sort((a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of ents) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isSymbolicLink() || exclude.has(r)) continue;
        if (e.isDirectory()) {
          if (WALK_SKIP.test(e.name) || depth >= MAX_WALK_DEPTH) continue;
          const sub = pathMod.join(abs, e.name);
          if (opts.skipIfContains) { let marked = false; try { marked = fs.lstatSync(pathMod.join(sub, opts.skipIfContains)).isFile(); } catch (x) { marked = false; } if (marked) continue; }
          const l = inLikely || LIKELY_SRC.test(e.name);
          (l ? likely : other).push([sub, r, depth + 1, l]); continue;
        }
        if (!e.isFile()) continue;
        if (all.length >= maxList) { truncated = true; break; }
        all.push(r);
      }
    }
    const extra = new Map(); // root manifests of the parent folder, under a name that cannot clash with a file of the folder
    if (opts.rootDir && pathMod.resolve(String(opts.rootDir)) !== base) {
      const root = pathMod.resolve(String(opts.rootDir));
      ['package.json', 'package-lock.json', 'pyproject.toml'].forEach((n) => { if (!all.includes(n)) extra.set(n, pathMod.join(root, n)); });
    }
    const state = { bytes: 0, budgetHit: false, failed: [] };
    const readOne = (p) => {
      const abs = extra.has(p) ? extra.get(p) : pathMod.join(base, p);
      try {
        const s = fs.lstatSync(abs);
        if (!s.isFile() || s.size > MAX_FILE) return null;
        if (state.bytes + s.size > MAX_TOTAL) { state.budgetHit = true; return null; }
        const x = fs.readFileSync(abs, 'utf8'); state.bytes += x.length; return x;
      } catch (e) { return null; }
    };
    const readMany = async (ps) => ps.map((p) => [p, readOne(p)]);
    all.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // the walk order only decides what a truncated listing keeps
    const scan = await scanFiles({ all: all.concat(Array.from(extra.keys())), subdir: null, readMany, maxSourceFiles: opts.maxSourceFiles, builtFallback: true, state, servers: !!opts.servers, serversDeadline: opts.serversDeadline, effects: !!opts.effects, effectsDepth: opts.effectsDepth });
    return Object.assign({ repo: String(dir), ref: null, sha: null, via: 'directory', truncated }, scan);
  }

  // Registry: name -> latest server.json. The registry's search is a substring match on the name.
  async function fromRegistry(name, opts) {
    opts = opts || {};
    const f = opts.fetch || fetch;
    const base = opts.registry || 'https://registry.modelcontextprotocol.io';
    const d = await getJson(f, base + '/v0/servers?search=' + encodeURIComponent(name) + '&version=latest&limit=30');
    const hit = (d.servers || []).map((x) => x.server).find((s) => s && s.name === name);
    if (!hit) return { name, found: false, similar: (d.servers || []).map((x) => x.server && x.server.name).filter(Boolean).slice(0, 10) };
    const remotes = (hit.remotes || []).filter((r) => r && r.url).map((r) => ({ type: r.type, url: r.url, templated: /\{/.test(r.url), needsHeaders: Array.isArray(r.headers) && r.headers.some((h) => h.isRequired) }));
    const packages = (hit.packages || []).map((p) => ({ registryType: p.registryType, identifier: p.identifier, version: p.version, transport: p.transport && p.transport.type, command: commandFor(p) }));
    return { name, found: true, title: hit.title || null, description: hit.description || null, version: hit.version, repository: hit.repository && hit.repository.url ? hit.repository : null, remotes, packages };
  }
  function commandFor(p) {
    const v = p.version ? p.version : null;
    if (p.registryType === 'npm') return 'npx -y ' + p.identifier + (v ? '@' + v : '');
    if (p.registryType === 'pypi') return 'uvx ' + p.identifier + (v ? '==' + v : '');
    if (p.registryType === 'oci') return 'docker run -i --rm ' + p.identifier + (v && !/:/.test(p.identifier) ? ':' + v : '');
    if (p.registryType === 'nuget') return 'dnx ' + p.identifier + (v ? '@' + v : '') + ' --yes';
    if (p.registryType === 'cargo') return null;
    return null;
  }

  return { customListHandler, publicTools, fromGitHub, fromDirectory, fromCatalogSnap, serverPackages, notServerFolder, constructsServer, ownServerNames, normName, fromRegistry, extractFromFile, extractJs, extractPy, planFiles, detectSdk, collectGlobalConsts, analyseRepo, markConditionals, parseRepoRef, toolsFromJson, fromMcpbManifest, tokenize, commandFor };
});
