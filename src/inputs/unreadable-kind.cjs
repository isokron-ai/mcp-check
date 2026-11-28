// What kind of construct a value the source reader could not read is (R-RD-45): a fixed, code-free word per
// unreadable part, so a loop that sees many servers can say which construct to support next without quoting any of
// their code. Only the shape of the expression is looked at (its first token and its top-level operators); no
// name, string or number from it is kept.
//
//   call            the value is what a call returns: describe("x"), texts.get("x"), await load(), new X()
//   imported        a name imported from another module that the reader did not follow
//   identifier      a name of this file the reader could not work out (a parameter, a loop variable, a let)
//   member          a property of another value: TEXTS.echo, TEXTS["echo"], cfg.tools[0].description
//   template_expr   a template literal or f-string with expressions the reader could not work out
//   concat          text joined at run time: "a" + b, "a" % b, "a".format(b), "".join(parts)
//   conditional     a choice made at run time: a ? b : c, a || b, b if a else c, a or b
//   spread          an object or keyword spread: { ...base }, **kwargs
//   function        a function where a value was expected (a getter, a method, a lambda)
//   nested          an object or list whose own parts could not all be read
//   too_deep        nested past the reader's depth limit
//   other           anything else

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RepoUnreadableKind = factory(); // in a browser, load this before repo-source.cjs
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const UNREADABLE_KINDS = Object.freeze(['call', 'imported', 'identifier', 'member', 'template_expr', 'concat', 'conditional', 'spread', 'function', 'nested', 'too_deep', 'other']);

const isP = (tok, v) => !!tok && tok.type === 'p' && tok.value === v;
const isId = (tok, v) => !!tok && tok.type === 'id' && (v === undefined || tok.value === v);
const OPEN = { '(': ')', '[': ']', '{': '}' };

/** The index just past the expression that starts at i: at the first top-level `,`, `)`, `]`, `}` or `;`. */
function exprEnd(t, i, end) {
  let depth = 0;
  for (let k = i; k < end; k++) {
    const x = t[k];
    if (x && x.type === 'p') {
      if (OPEN[x.value]) depth++;
      else if (x.value === ')' || x.value === ']' || x.value === '}') { if (depth === 0) return k; depth--; }
      else if (depth === 0 && (x.value === ',' || x.value === ';')) return k;
    }
  }
  return end;
}

/** The local names a file's import statements bind (JS `import ... from`, Python `import` / `from ... import`). */
function importedNames(t) {
  const out = new Set();
  for (let k = 0; k < t.length; k++) {
    if (!isId(t[k], 'import')) continue;
    let j = k + 1;
    if (isP(t[j], '(')) j++;
    if (isP(t[j], '{')) {
      for (j++; j < t.length && !isP(t[j], '}'); j++) {
        if (isId(t[j]) && isId(t[j + 1], 'as') && isId(t[j + 2])) { out.add(t[j + 2].value); j += 2; } else if (isId(t[j]) && t[j].value !== 'type') out.add(t[j].value);
      }
      continue;
    }
    if (isP(t[j], '*') && isId(t[j + 1], 'as') && isId(t[j + 2])) { out.add(t[j + 2].value); continue; }
    // a default import (JS), or Python's comma-separated names, each maybe `as` another
    while (isId(t[j])) {
      let local = t[j].value; let k2 = j + 1;
      while (isP(t[k2], '.') && isId(t[k2 + 1])) k2 += 2; // Python's `import a.b` binds a
      if (isId(t[k2], 'as') && isId(t[k2 + 1])) { local = t[k2 + 1].value; k2 += 2; }
      out.add(local);
      if (isP(t[k2], ',')) { j = k2 + 1; continue; }
      break;
    }
  }
  return out;
}
const importCache = new WeakMap();
const importsOf = (t) => { let s = importCache.get(t); if (!s) { s = importedNames(t); importCache.set(t, s); } return s; };

const COND = new Set(['?', '||', '&&', '??']);
const PY_COND = new Set(['if', 'or', 'and']);

/**
 * The kind of the value expression at token i (up to `end`, or the expression's own end), as one of UNREADABLE_KINDS.
 * Tokens are the reader's own ({ type: 'str' | 'tpl' | 'id' | 'num' | 'p', value }), for JS/TS and Python alike.
 * @param {object[]} t
 * @param {number} i
 * @param {number} [end]
 * @param {{ imports?: Set<string>, tokens?: object[] }} [opts]  imports: names imported in the file; tokens: the file's
 *   tokens to read them from, when t is only a part of it
 */
function valueKind(t, i, end, opts) {
  const tok = t && t[i];
  if (!tok) return 'other';
  const stop = exprEnd(t, i, Math.min(end === undefined ? t.length : end, t.length));
  // top-level operators of the expression
  let depth = 0; let cond = false; let concat = false;
  for (let k = i; k < stop; k++) {
    const x = t[k];
    if (x.type === 'p' && OPEN[x.value]) { depth++; continue; }
    if (x.type === 'p' && (x.value === ')' || x.value === ']' || x.value === '}')) { depth--; continue; }
    if (depth !== 0) continue;
    if (k > i && x.type === 'p' && COND.has(x.value)) cond = true;
    if (k > i && x.type === 'id' && PY_COND.has(x.value)) cond = true;
    if (k > i && x.type === 'p' && (x.value === '+' || x.value === '%')) concat = true;
    if (x.type === 'p' && x.value === '.' && isId(t[k + 1]) && /^(join|format|concat)$/.test(t[k + 1].value) && isP(t[k + 2], '(')) concat = true;
  }
  if (isP(tok, '...') || isP(tok, '**')) return 'spread';
  if (cond) return 'conditional';
  if (concat) return 'concat';
  if (tok.type === 'tpl') return 'template_expr';
  if (tok.type === 'str') return 'other';
  if (isId(tok, 'await') || isId(tok, 'new')) return 'call';
  if (isId(tok, 'function') || isId(tok, 'async') || isId(tok, 'lambda')) return 'function';
  if (isP(tok, '(')) {
    // (a) => …, () => …: a function; (expr): look inside
    let d = 0; let k = i;
    for (; k < stop; k++) { if (isP(t[k], '(')) d++; else if (isP(t[k], ')')) { d--; if (d === 0) break; } }
    if (isP(t[k + 1], '=>')) return 'function';
    return valueKind(t, i + 1, k, opts);
  }
  if (isP(tok, '{') || isP(tok, '[')) return 'nested';
  if (tok.type === 'id') {
    if (isP(t[i + 1], '=>')) return 'function';
    let k = i + 1; let member = false;
    for (;;) {
      if ((isP(t[k], '.') || isP(t[k], '?.')) && isId(t[k + 1])) { member = true; k += 2; continue; }
      if (isP(t[k], '[')) { member = true; let d = 0; for (; k < stop; k++) { if (isP(t[k], '[')) d++; else if (isP(t[k], ']')) { d--; if (d === 0) break; } } k++; continue; }
      break;
    }
    if (isP(t[k], '(') || isP(t[k], '`')) return 'call';
    if (member) return 'member';
    const imports = (opts && opts.imports) || (opts && opts.tokens ? importsOf(opts.tokens) : importsOf(t));
    if (imports.has(tok.value)) return 'imported';
    return 'identifier';
  }
  return 'other';
}

/** A count of kinds, as kept in a candidate: { call: 2, member: 1 }, only UNREADABLE_KINDS as keys. */
function countKinds(list) {
  const out = {};
  for (const k of list) { const w = UNREADABLE_KINDS.includes(k) ? k : 'other'; out[w] = (out[w] || 0) + 1; }
  return out;
}

return { UNREADABLE_KINDS, valueKind, importedNames, countKinds, exprEnd };
});
