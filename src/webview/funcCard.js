// funcCard.js — the hover card's FUNCTION kind (U3 = B2 "peek", Bela 2026-10-06):
// signature, leading doc, who calls it / what it calls, and the first lines of the body.
//
// hoverCard.js owns the card element, the timers and the hide rules; this module
// supplies the pieces that are specific to functions. Graph facts (callers and
// callees) are local and instant; signature, doc and code come from the host's
// `get-func-source` with `maxLines` (funcBrief.ts), fetched ONCE per function, only
// when the dwell timer fires, and cached until the next graph / graph-patch.
//
// Everything from the repository is untrusted. Text goes in with textContent; the
// code peek is highlighted by highlightCode (which escapes) and then REBUILT here as
// fresh <span>s that carry only a colour and text, so no markup from the file or the
// highlighter reaches the DOM.

const HOVER_FN_DELAY_MS = 450;   // dwell before a function card opens
const HOVER_FN_DWELL_PX = 4;     // pointer movement that restarts the dwell
const FN_PEEK_LINES = 8;         // body lines in the peek
const FN_CALL_NAMES = 3;         // caller / callee names listed

/** A plain function node (not a glyph, library, synthetic or anchor). */
function fcIsFunctionNode(d) {
  return !!d && !d.isCluster && !d.isLibrary && !d.isSynthetic && !d.isFileAnchor
    && typeof d.file === 'string' && d.file !== '' && d.line > 0;
}

const fcIdOf = (e) => (e !== null && typeof e === 'object' ? e.id : e);

/** id → { callers:Set, callees:Set } over project calls (library edges excluded). */
function fcCallIndex(graphData) {
  const idx = new Map();
  const get = (id) => { let r = idx.get(id); if (!r) { r = { callers: new Set(), callees: new Set() }; idx.set(id, r); } return r; };
  for (const e of (graphData && graphData.edges) || []) {
    if (e.isLibraryEdge) { continue; }
    const s = fcIdOf(e.source), t = fcIdOf(e.target);
    if (s == null || t == null || s === t) { continue; }
    get(s).callees.add(t);
    get(t).callers.add(s);
  }
  return idx;
}

function fcNameOf(graphData) {
  const names = new Map();
  for (const n of (graphData && graphData.nodes) || []) { names.set(n.id, n.name || n.label || String(n.id)); }
  return (id) => names.get(id) || String(id).split('::')[1] || String(id);
}

/** "called by 3: a, b, c · calls 7: x, y, z …" — counts first, a few names after. */
function fcCallsText(id, idx, nameOf) {
  const r = idx.get(id) || { callers: new Set(), callees: new Set() };
  const part = (label, set) => {
    if (!set.size) { return label + ' 0'; }
    const names = [...set].slice(0, FN_CALL_NAMES).map(nameOf).join(', ');
    return label + ' ' + set.size + ': ' + names + (set.size > FN_CALL_NAMES ? ' …' : '');
  };
  return part('called by', r.callers) + ' · ' + part('calls', r.callees);
}

function fcLang(file) {
  const ext = String(file).split('.').pop().toLowerCase();
  if (ext === 'py' || ext === 'pyi') { return 'python'; }
  if (ext === 'java') { return 'java'; }
  if (['c', 'cc', 'cpp', 'cxx', 'c++', 'h', 'hh', 'hpp', 'hxx', 'h++'].includes(ext)) { return 'cpp'; }
  return 'typescript';
}

/** First `maxLines` lines and up to `maxChars` characters of the doc. */
function fcShortDoc(doc, maxLines = 3, maxChars = 280) {
  if (!doc) { return ''; }
  const lines = String(doc).split('\n').filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
  let s = lines.slice(0, maxLines).join('\n').trim();
  const cut = lines.length > maxLines || s.length > maxChars;
  if (s.length > maxChars) { s = s.slice(0, maxChars - 1); }
  return cut ? s.replace(/\s+$/, '') + '…' : s;
}

/**
 * Code peek as DOM: highlightCode's markup is parsed inertly (a <template>) and
 * rebuilt — only text and the colour of <span>s survive. Without a highlighter,
 * plain text.
 */
function fcCodeNodes(doc, code, file) {
  const frag = doc.createDocumentFragment();
  if (typeof highlightCode !== 'function') { frag.appendChild(doc.createTextNode(code)); return frag; }
  const tpl = doc.createElement('template');
  tpl.innerHTML = highlightCode(code, fcLang(file));   // inert: template content is never rendered or run
  const copy = (node, into) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) { into.appendChild(doc.createTextNode(ch.nodeValue)); continue; }
      if (ch.nodeType !== 1) { continue; }
      if (ch.tagName === 'SPAN') {
        const span = doc.createElement('span');
        const color = ch.style && ch.style.color;
        if (color) { span.style.color = color; }   // the style setter only accepts a valid colour
        copy(ch, span);
        into.appendChild(span);
      } else {
        copy(ch, into);
      }
    }
  };
  copy(tpl.content, frag);
  return frag;
}

/** Card content for a function node. `brief` = the host's func-source reply, or null while loading. */
function fcContent(d, brief, rel, idx, nameOf) {
  const name = d.name || d.label || String(d.id);
  const content = {
    name,
    path: rel + ':' + d.line,
    sig: name + '(…)',
    doc: '',
    code: '',
    more: '',
    calls: fcCallsText(d.id, idx, nameOf),
    loading: !brief,
    error: '',
  };
  if (!brief) { return content; }
  if (brief.error) { content.error = 'Source not available: ' + brief.error; return content; }
  if (brief.signature) { content.sig = brief.signature; }
  if (brief.totalLines) { content.path += ' · ' + brief.totalLines + (brief.totalLines === 1 ? ' line' : ' lines'); }
  content.doc = fcShortDoc(brief.doc);
  content.code = brief.body || '';
  const shown = content.code ? content.code.split('\n').length : 0;
  if (brief.totalLines && brief.totalLines > shown) {
    content.more = 'Whole function: ' + brief.totalLines + ' lines · click to open and edit';
  }
  return content;
}

if (typeof module !== 'undefined') {
  module.exports = {
    HOVER_FN_DELAY_MS, HOVER_FN_DWELL_PX, FN_PEEK_LINES, fcIsFunctionNode, fcCallIndex, fcNameOf,
    fcCallsText, fcShortDoc, fcCodeNodes, fcContent, fcLang,
  };
}
