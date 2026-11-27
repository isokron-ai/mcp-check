// Grading a list this run read from source (--repo, --repo-dir, the zero-config Action) when parts of some tools could
// not be read statically (a schema built at run time, a description from a function call, annotations set by a base
// class). The reader's own result says which (`reader.unreadable`: { inputSchema: [names], description: [names],
// annotations: [names] }); nothing in the list itself is trusted for this, so a server or a committed file cannot mark
// its own schemas unreadable to avoid checks. The checks that need an unreadable part are skipped for that tool, never
// graded as if the part were empty, and the section grades are recomputed from the findings that remain with the
// engine's weights, bands and caps (the engine itself is not changed). A schema that still has properties is graded.
//
// Registrations whose name the reader could not resolve (`reader.unresolved`: [{ path, line, description, title }])
// are not listed, but their text is still scanned for poisoning: blocking findings count against the list.
import M from './engine.js';

export const UNKNOWN_MARK = 'x-mcp-check-unknown';
const PARTS = ['inputSchema', 'description', 'annotations'];

// Checks that read the input schema, the description, or the annotations.
export const NEEDS = {
  inputSchema: (f) => /^(spec-input-schema-|spec-schema-|spec-ref-remote|spec-composition-bounds|spec-x-mcp-header|anthropic-read-write-split|anthropic-api-docs|anthropic-conversation-data|openai-conversation-input|openai-restricted-input|openai-precise-location|openai-generic-executor|openai-retry|schema-|surface-)/.test(f.id) && f.id !== 'schema-output-schema', // openai-retry reads argument descriptions and retry-key arguments (rubric 2.2.0)
  description: (f) => /^(anthropic-description|openai-description|anthropic-api-docs|anthropic-unsupported-use|openai-retry|openai-precise-location|design-use-when|design-handle-lifetime)$/.test(f.id), // precise-location reads "near me" text (2.2.0)
  annotations: (f) => /^(anthropic-title|anthropic-hint|anthropic-hint-platforms-differ|openai-hints-explicit|openai-retry|openai-readonly-starts-job|openai-readonly-destructive|annot-delete-marked-safe|annot-write-marked-readonly|spec-annotation-key-case|schema-output-schema|surface-)/.test(f.id),
};

const hasProps = (s) => !!s && typeof s === 'object' && !!s.properties && typeof s.properties === 'object' && Object.keys(s.properties).length > 0;

/** Map(tool name -> Set(part)) from the reader's result. A schema part is dropped when the tool's schema has properties,
 *  unless the reader lists the schema as read in part (reader.unreadable.inputSchemaPaths). */
export function unreadableParts(tools, reader) {
  const out = new Map();
  const u = reader && reader.unreadable && typeof reader.unreadable === 'object' ? reader.unreadable : null;
  if (!u) return out;
  const byName = new Map((tools || []).filter((t) => t && typeof t.name === 'string').map((t) => [t.name, t]));
  PARTS.forEach((p) => {
    (Array.isArray(u[p]) ? u[p] : []).forEach((n) => {
      const t = byName.get(String(n)); if (!t) return;
      // a schema with properties is graded, unless the reader read it only in part (inputSchemaPaths: a property it kept by
      // name with an unknown schema, or a spread whose names it could not know)
      if (p === 'inputSchema' && hasProps(t.inputSchema) && !(u.inputSchemaPaths && typeof u.inputSchemaPaths === 'object' && Array.isArray(u.inputSchemaPaths[t.name]))) return;
      if (!out.has(t.name)) out.set(t.name, new Set());
      out.get(t.name).add(p);
    });
  });
  return out;
}

const GRADED = ['spec', 'anthropic', 'openai', 'security', 'quality'];
const ORDER = ['A', 'B', 'C', 'D', 'F'];
const capAt = (g, cap) => (ORDER.indexOf(g) < ORDER.indexOf(cap) ? cap : g);
const F_CAP = 'F: hidden or injected instructions found; both directories reject these.';

/** The section grades of the engine's rubric over per-tool and server findings (the engine's grade(), mirrored). */
export function gradeFindings(perTool, server) {
  const W = M.WEIGHTS;
  const sections = {};
  GRADED.forEach((sec) => {
    const toolScores = perTool.map((t) => Math.max(0, 100 - t.findings.filter((f) => f.affects.includes(sec)).reduce((s, f) => s + W.tool[f.severity], 0)));
    const mean = toolScores.length ? toolScores.reduce((a, b) => a + b, 0) / toolScores.length : 0;
    const sf = server.filter((f) => f.affects.includes(sec));
    const score = Math.max(0, Math.min(100, Math.round(mean - sf.reduce((s, f) => s + W.server[f.severity], 0))));
    const all = perTool.reduce((acc, t) => acc.concat(t.findings.filter((f) => f.affects.includes(sec))), []).concat(sf);
    const counts = { blocking: 0, attention: 0, advice: 0 };
    all.forEach((f) => { counts[f.severity] += 1; });
    const blockedTools = perTool.filter((t) => t.findings.some((f) => f.affects.includes(sec) && f.severity === 'blocking')).length;
    sections[sec] = { name: M.SECTION_NAMES[sec], score, grade: M.letter(score), counts, blockedTools, total: perTool.length, caps: [], ready: counts.blocking === 0 };
  });
  const any = (pred) => perTool.some((t) => t.findings.some(pred)) || server.some(pred);
  GRADED.forEach((sec) => { const s = sections[sec]; if (s.counts.blocking > 0 && ORDER.indexOf(s.grade) < ORDER.indexOf('B')) { s.grade = 'B'; s.caps.push('Capped at B: ' + s.counts.blocking + ' blocking item' + (s.counts.blocking === 1 ? '' : 's') + '.'); } });
  if (any((f) => f.section === 'spec' && f.severity === 'blocking')) ['spec', 'anthropic', 'openai'].forEach((sec) => { const s = sections[sec]; const g = capAt(s.grade, 'C'); if (g !== s.grade) { s.grade = g; s.caps.push('Capped at C: the list fails an MCP specification MUST.'); } });
  if (any((f) => f.section === 'security' && f.severity === 'blocking')) ['security', 'anthropic', 'openai'].forEach((sec) => { const s = sections[sec]; s.grade = 'F'; s.caps.push(F_CAP); });
  return sections;
}

const sameSection = (a, b) => a && b && a.grade === b.grade && a.score === b.score && JSON.stringify(a.counts) === JSON.stringify(b.counts) && JSON.stringify(a.caps) === JSON.stringify(b.caps);

// Poisoning findings in the text of registrations whose name could not be resolved, as list-level findings.
export function unresolvedFindings(unresolved) {
  const pseudo = (unresolved || []).filter((u) => u && (typeof u.description === 'string' || typeof u.title === 'string' || typeof u.text === 'string')).map((u, k) => {
    const t = { name: 'unresolved_' + (k + 1), inputSchema: { type: 'object' } };
    const d = [u.description, u.text].filter((x) => typeof x === 'string' && x).join(' … ');
    if (d) t.description = d;
    if (typeof u.title === 'string') t.title = u.title;
    return { t, u };
  });
  if (!pseudo.length) return [];
  const r = M.analyse(pseudo.map((x) => x.t));
  const out = [];
  r.tools.forEach((rt, k) => rt.findings.filter((f) => f.section === 'security').forEach((f) => {
    const u = pseudo[k].u; const where = u.path ? u.path + (u.line ? ':' + u.line : '') : 'the source';
    const g = Object.assign({}, f, { message: 'A registration at ' + where + ' whose name could not be read: ' + f.message });
    delete g.tool; out.push(g);
  }));
  return out;
}

// Poisoning findings in text the reader could not place in a tool (reader.unreadable.text: { name: text }), per tool.
export function unreadTextFindings(tools, text) {
  const names = Object.keys(text || {}).filter((n) => typeof text[n] === 'string' && text[n] && (tools || []).some((t) => t && t.name === n));
  const out = new Map(); if (!names.length) return out;
  const r = M.analyse(names.map((n, k) => ({ name: 'unread_' + (k + 1), description: text[n], inputSchema: { type: 'object' } })));
  r.tools.forEach((rt, k) => {
    const fs = rt.findings.filter((f) => f.section === 'security').map((f) => Object.assign({}, f, { tool: names[k], path: 'source (not readable as part of the tool)', message: 'In source text the reader could not read as part of this tool: ' + f.message }));
    if (fs.length) out.set(names[k], fs);
  });
  return out;
}

/**
 * M.analyse for a list, with the reader's notes when this run read it from source (`reader`: { unreadable, unresolved },
 * the reader's in-memory result, or null for any other input). Adds r.skipped_checks = { input_schemas, descriptions,
 * annotations, skipped, regraded, unresolved_scanned } when there was anything to note. When the mirrored grading does
 * not reproduce the engine's (a rubric change), nothing is skipped (regraded: false), but poisoning in unresolved
 * registrations still caps the grades. opts.gradeFindings replaces the mirror (tests).
 */
export function analyseList(parsed, reader, opts = {}) {
  const r = M.analyse(parsed);
  if (!reader) return r;
  const parts = unreadableParts(parsed.tools, reader);
  const extraServer = unresolvedFindings(reader.unresolved);
  const unresolvedCount = Array.isArray(reader.unresolved) ? reader.unresolved.length : 0;
  const text = reader.unreadable && reader.unreadable.text && typeof reader.unreadable.text === 'object' ? reader.unreadable.text : {};
  const textFindings = unreadTextFindings(parsed.tools, text);
  const textCount = Object.keys(text).filter((n) => parsed.tools.some((t) => t && t.name === n)).length;
  if (!parts.size && !extraServer.length && !unresolvedCount && !textCount) return r;
  const count = (p) => Array.from(parts.values()).filter((s) => s.has(p)).length;
  const note = { input_schemas: count('inputSchema'), descriptions: count('description'), annotations: count('annotations'), skipped: 0, regraded: false, unresolved_scanned: unresolvedCount, unread_text_scanned: textCount };
  r.skipped_checks = note;
  // The mirror is compared with the engine's grades on the engine's own findings, before any finding of unplaced text
  // is added (one poisoning hit there must not switch off the skipping for the whole list).
  const grade = opts.gradeFindings || gradeFindings;
  const before = grade(r.tools, r.server);
  // poisoning in text the reader could not place in a tool counts as that tool's finding
  const addText = () => r.tools.forEach((t) => { const f = textFindings.get(t.name); if (f) t.findings = t.findings.concat(f); });
  if (!GRADED.every((s) => sameSection(before[s], r.sections[s]))) {
    addText();
    // Cannot regrade: keep the engine's grades, but poisoning found in unresolved registrations still applies.
    const blockingText = Array.from(textFindings.values()).some((fs) => fs.some((f) => f.severity === 'blocking'));
    if (extraServer.length || blockingText) {
      r.server = r.server.concat(extraServer);
      if (extraServer.some((f) => f.severity === 'blocking') || blockingText) ['security', 'anthropic', 'openai'].forEach((sec) => { const s = r.sections[sec]; s.grade = 'F'; if (!s.caps.includes(F_CAP)) s.caps = s.caps.concat(F_CAP); s.ready = false; });
    }
    return r;
  }
  let skipped = 0;
  r.tools.forEach((t) => {
    const ps = parts.get(t.name); if (!ps) return;
    const keep = t.findings.filter((f) => !Array.from(ps).some((p) => NEEDS[p](f)));
    skipped += t.findings.length - keep.length; t.findings = keep;
  });
  addText();
  r.server = r.server.concat(extraServer);
  const after = gradeFindings(r.tools, r.server);
  GRADED.forEach((s) => { r.sections[s] = Object.assign({}, r.sections[s], after[s]); });
  // Write-surface: recounted without the tools whose schema could not be read.
  const surf = M._internal && M._internal.surface;
  const unknownSchema = new Set(Array.from(parts.entries()).filter(([, s]) => s.has('inputSchema')).map(([n]) => n));
  if (unknownSchema.size && typeof surf === 'function') {
    try {
      const keepIdx = parsed.tools.map((t, i) => (unknownSchema.has(t.name) ? -1 : i)).filter((i) => i >= 0);
      const tools = keepIdx.map((i) => parsed.tools[i]);
      const per = keepIdx.map((i) => Object.assign({}, r.tools[i], { findings: r.tools[i].findings.filter((f) => f.section !== 'surface') }));
      const sur = surf(tools, per);
      const fresh = new Map(keepIdx.map((i, k) => [i, per[k].findings.filter((f) => f.section === 'surface').map((f) => Object.assign(f, { tool: r.tools[i].name }))]));
      r.tools.forEach((t, i) => { t.findings = t.findings.filter((f) => f.section !== 'surface').concat(fresh.get(i) || []); });
      const next = Object.assign({}, r.sections.surface);
      Object.keys(sur || {}).forEach((k) => { if (k !== 'findings') next[k] = sur[k]; });
      // name the write tools left out, wherever the section is shown
      const left = parsed.tools.filter((t) => unknownSchema.has(t.name) && !(t.annotations && t.annotations.readOnlyHint === true) && M.kindOf(t.name) !== 'read').map((t) => t.name);
      if (left.length) {
        next.not_counted = left;
        const msg = left.length + ' write tool' + (left.length === 1 ? '' : 's') + ' with an unreadable schema not counted (' + left.slice(0, 5).join(', ') + (left.length > 5 ? ', …' : '') + ').';
        ['why', 'summary'].forEach((k) => { if (typeof next[k] === 'string' && next[k]) next[k] = next[k] + ' ' + msg; else if (k === 'why') next[k] = msg; });
      }
      r.sections.surface = next;
    } catch (e) { /* keep the engine's surface section */ }
  }
  note.skipped = skipped; note.regraded = true;
  return r;
}

/** The line every report of such a list carries (text, Markdown, job summary, PR comment), or null. */
export function skippedLine(r) {
  const n = r && r.skipped_checks; if (!n) return null;
  const parts = [[n.input_schemas, 'input schema'], [n.descriptions, 'description'], [n.annotations, 'annotations']].filter(([k]) => k > 0).map(([k, w]) => k + ' ' + w + (k === 1 || w === 'annotations' ? '' : 's'));
  const out = [];
  if (parts.length && n.regraded) out.push('Not readable from source: ' + parts.join(', ') + '; ' + n.skipped + ' check' + (n.skipped === 1 ? '' : 's') + ' of those parts skipped, and the grades use the rest.');
  if (parts.length && !n.regraded) out.push('Not readable from source: ' + parts.join(', ') + '; their checks could not be skipped under this rubric, so these grades include them as read.');
  if (n.unread_text_scanned) out.push(n.unread_text_scanned + ' tool' + (n.unread_text_scanned === 1 ? '' : 's') + ' with source the reader could not read in full (deeply nested or computed values): that text was scanned for hidden instructions.');
  if (n.unresolved_scanned) out.push(n.unresolved_scanned + ' registration' + (n.unresolved_scanned === 1 ? '' : 's') + ' with a name the reader could not resolve: not listed, but scanned for hidden instructions.');
  return out.length ? out.join(' ') : null;
}
