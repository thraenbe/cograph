/**
 * CoGraph single-file-component (SFC) script extraction.
 *
 * Shared by analyze_ts.js and analyze_js.js: a `.vue` or `.svelte` file keeps its
 * logic in one or two `<script>` blocks (Vue: `<script>` and `<script setup>`;
 * Svelte: `<script context="module">` / `<script module>` and the instance
 * `<script>`). No new parser is needed — the blocks are TypeScript or JavaScript.
 *
 * Line numbers: instead of shifting every node position, the analyzers parse a
 * *virtual source* with exactly the SFC's line count in which every character
 * outside the script blocks is blanked (newlines and columns are kept). The
 * TypeScript parser then reports the original file's lines directly, so node
 * ids, jump-to-source and the source popup land on the right line, and a file
 * with two blocks is analyzed as one unit by construction.
 *
 * Routing: an SFC whose script carries `lang="ts"` / `lang="tsx"` belongs to the
 * TypeScript analyzer, every other SFC to the JavaScript analyzer, so component
 * calls resolve against the same analyzer's `.ts` or `.js` definitions.
 *
 * Out of scope: template expressions (`@click="save()"`, `{handler()}`),
 * `<script src="…">` (external script), script languages other than JS/TS (such a
 * block is dropped; a file with no other block is analyzed by neither), and a
 * `</script>` inside a JS string or comment (it ends the block early).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SFC_EXTENSIONS = new Set(['.vue', '.svelte']);
const TS_LANGS = new Set(['ts', 'tsx']);

/** Is this a `.vue` or `.svelte` file (case-insensitive extension)? */
function isSfcPath(filepath) {
  return SFC_EXTENSIONS.has(path.extname(filepath).toLowerCase());
}

// `lang` values the TS/JS analyzers parse, mapped to the analyzer flavour. Any
// other language (`coffee`, `livescript`, …) is not JavaScript: its block is dropped.
const SCRIPT_LANGS = new Map([
  ['', 'js'], ['js', 'js'], ['javascript', 'js'], ['jsx', 'js'],
  ['ts', 'ts'], ['typescript', 'ts'], ['tsx', 'tsx'],
]);

const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isQuote = (c) => c === '"' || c === "'";

/** Index just past the quoted run that opens at `i` (or the end when unclosed). */
function skipQuoted(text, i) {
  const close = text.indexOf(text[i], i + 1);
  return close === -1 ? text.length : close + 1;
}

/**
 * The attributes of a tag's attribute text as a Map of lower-cased name → value
 * ('' for a bare attribute). A linear scan, not a regex: a name is read only
 * between attributes, so `src` inside `generic="T extends { src: string }"` is
 * part of a quoted value, and `data-src` is one name, never `src`. Values may be
 * double-quoted, single-quoted or unquoted; the first occurrence of a name wins.
 */
function parseAttrs(text) {
  const attrs = new Map();
  let i = 0;
  while (i < text.length) {
    if (isSpace(text[i]) || text[i] === '/') { i++; continue; }
    if (isQuote(text[i])) { i = skipQuoted(text, i); continue; } // a stray quoted run is no name
    const nameStart = i;
    while (i < text.length && !isSpace(text[i]) && text[i] !== '/' && text[i] !== '=' && !isQuote(text[i])) { i++; }
    const name = text.slice(nameStart, i).toLowerCase();
    while (i < text.length && isSpace(text[i])) { i++; }
    let value = '';
    if (text[i] === '=') {
      i++;
      while (i < text.length && isSpace(text[i])) { i++; }
      if (isQuote(text[i])) {
        const close = text.indexOf(text[i], i + 1);
        value = text.slice(i + 1, close === -1 ? text.length : close);
        i = close === -1 ? text.length : close + 1;
      } else {
        const valueStart = i;
        while (i < text.length && !isSpace(text[i])) { i++; }
        value = text.slice(valueStart, i);
      }
    }
    if (name && !attrs.has(name)) { attrs.set(name, value.trim()); }
  }
  return attrs;
}

/** 'ts' | 'tsx' | 'js' for a `<script>` tag's attributes; null for an unsupported `lang`. */
function scriptLang(attrs) {
  const lang = (attrs.get('lang') ?? '').toLowerCase();
  return SCRIPT_LANGS.get(lang) ?? null;
}

/**
 * Index of the `>` that closes the tag starting at `tagStart`, honouring quoted
 * attribute values (`generic="T extends Foo<Bar>"`), or -1 when unterminated.
 */
function tagEnd(source, tagStart) {
  let quote = '';
  for (let i = tagStart; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (c === quote) { quote = ''; } continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') { return i; }
  }
  return -1;
}

/** 1-based line number of a character offset. */
function lineAt(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) { if (source.charCodeAt(i) === 10) { line++; } }
  return line;
}

/**
 * Every `<script …>…</script>` block of an SFC, in file order.
 * Each block: { code, lang, line, start, end, attrs } where `start`/`end` are the
 * code's character offsets in `source` and `line` is the 1-based line on which
 * the code starts (the opening tag's line; the code usually begins with the
 * newline right after the tag); `attrs` is the tag's attribute Map. Blocks with
 * a `src` attribute are external and are skipped, as are blocks in a language
 * the analyzers do not parse (`lang="coffee"`): they stay blank in the virtual
 * source. `<script>` tags inside HTML comments are ignored.
 */
function extractScriptBlocks(source) {
  const blocks = [];
  const open = /<!--|<script\b/gi;
  let m;
  while ((m = open.exec(source)) !== null) {
    if (m[0] === '<!--') {
      const close = source.indexOf('-->', m.index + 4);
      if (close === -1) { break; }
      open.lastIndex = close + 3;
      continue;
    }
    const gt = tagEnd(source, m.index + m[0].length);
    if (gt === -1) { break; }
    const attrs = parseAttrs(source.slice(m.index + m[0].length, gt));
    const start = gt + 1;
    const closeTag = /<\/script\s*>/gi;
    closeTag.lastIndex = start;
    const c = closeTag.exec(source);
    const end = c ? c.index : source.length;
    open.lastIndex = c ? c.index + c[0].length : source.length;
    const lang = scriptLang(attrs);
    if (attrs.has('src') || lang === null) { continue; }
    blocks.push({ code: source.slice(start, end), lang, line: lineAt(source, start), start, end, attrs });
  }
  return blocks;
}

/**
 * 'ts' | 'tsx' | 'js' for the SFC's script blocks (the TS flavour wins when any
 * block declares it), or null when the file has no supported script block.
 */
function sfcScriptLanguage(blocks) {
  if (blocks.length === 0) { return null; }
  if (blocks.some(b => b.lang === 'tsx')) { return 'tsx'; }
  if (blocks.some(b => b.lang === 'ts')) { return 'ts'; }
  return 'js';
}

/** Same string with every character except CR/LF replaced by a space. */
function blank(text) {
  return text.replace(/[^\r\n]/g, ' ');
}

/**
 * The SFC with everything outside its script blocks blanked: identical line
 * count and line starts, so positions reported on it are positions in the file.
 */
function sfcVirtualSource(source, blocks) {
  let out = '';
  let cursor = 0;
  for (const b of blocks) {
    out += blank(source.slice(cursor, b.start)) + b.code;
    cursor = b.end;
  }
  return out + blank(source.slice(cursor));
}

// Per-process cache: both analyzer passes (definitions, calls) and the routing
// decision read each SFC; extract once.
const sfcCache = new Map();

function loadSfc(filepath) {
  const hit = sfcCache.get(filepath);
  if (hit) { return hit; }
  let source;
  try { source = fs.readFileSync(filepath, 'utf8'); } catch { return null; }
  const blocks = extractScriptBlocks(source);
  const entry = { blocks, lang: sfcScriptLanguage(blocks), source: sfcVirtualSource(source, blocks) };
  sfcCache.set(filepath, entry);
  return entry;
}

/** Which analyzer parses this SFC: 'ts' | 'js', or null when it has no script block / is unreadable. */
function sfcAnalyzerFor(filepath) {
  const entry = loadSfc(filepath);
  if (!entry || entry.lang === null) { return null; }
  return TS_LANGS.has(entry.lang) ? 'ts' : 'js';
}

/** Does the given analyzer ('ts' | 'js') own this SFC? */
function ownsSfc(filepath, analyzer) {
  return sfcAnalyzerFor(filepath) === analyzer;
}

/**
 * Source text the analyzer should parse for `filepath`:
 *   - a plain file → { source: <file text>, lang: null } (the analyzer's default ScriptKind);
 *   - an SFC owned by `analyzer` → { source: <virtual source>, lang: 'ts' | 'tsx' | 'js' };
 *   - an SFC the other analyzer owns, an SFC without script, or an unreadable file → null.
 */
function readAnalyzerSource(filepath, analyzer) {
  if (!isSfcPath(filepath)) {
    try { return { source: fs.readFileSync(filepath, 'utf8'), lang: null }; } catch { return null; }
  }
  const entry = loadSfc(filepath);
  if (!entry || entry.lang === null || !ownsSfc(filepath, analyzer)) { return null; }
  return { source: entry.source, lang: entry.lang };
}

function clearSfcCache() {
  sfcCache.clear();
}

module.exports = {
  SFC_EXTENSIONS, isSfcPath, parseAttrs, extractScriptBlocks, sfcScriptLanguage, sfcVirtualSource,
  sfcAnalyzerFor, ownsSfc, readAnalyzerSource, clearSfcCache,
};
