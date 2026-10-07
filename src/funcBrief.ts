// funcBrief.ts — a function's signature, leading doc and a capped source slice.
//
// Shared by the webview hover card (8-line peek, via the extension host) and the
// MCP server's get_symbol (80-line slices, in a standalone Node process), so it is
// vscode-free AND fs-free: callers hand in the file text, or a readText function
// for a path THEY have already confined to the workspace. Nothing here joins,
// resolves or follows a path, and nothing throws for I/O: failures come back as
// { ok: false, error }.
//
// End detection is funcEnd.ts (the same scanner the source popup and its guarded
// save use). The caller's start line and, optionally, a fallback end come from its
// own symbol index; the fallback is used ONLY when detection runs into EOF without
// closing (a next-symbol bound would truncate functions with nested functions).

import { FuncLang, funcLangOf, scanFuncEnd } from './funcEnd';

export type EndReason = 'detected' | 'maxLines' | 'fallback' | 'eof';

export interface FuncSliceOptions {
  /** 1-based line the function starts at (its def / signature / decorator line). */
  startLine: number;
  /** Hard cap on `source` and `body` lines. 8 for the hover peek, 80 for get_symbol. */
  maxLines: number;
  /** Language; derived from `file` when omitted, else brace rules. */
  lang?: FuncLang;
  file?: string;
  /** 1-based last line to use when detection reaches EOF unclosed. */
  fallbackEndLine?: number | null;
  /** Convenience for indexes: the next symbol's start line; fallback = nextStartLine - 1. */
  nextStartLine?: number | null;
}

export interface FuncBrief {
  ok: true;
  /** One line, whitespace collapsed, at most 300 characters. */
  signature: string;
  /** Leading docstring / doc comment, markers stripped, '' when there is none. */
  doc: string;
  /** Lines startLine..endLine (at most maxLines), '\n'-joined. */
  source: string;
  /** Code after the signature and docstring, at most maxLines lines ('' for a one-liner). */
  body: string;
  startLine: number;
  /** 1-based last line included in `source`. */
  endLine: number;
  /** Length of the whole function (before the maxLines cap). */
  totalLines: number;
  endReason: EndReason;
}

export interface FuncBriefError { ok: false; error: string }
export type FuncBriefResult = FuncBrief | FuncBriefError;

export const SIGNATURE_MAX_CHARS = 300;
export const DOC_MAX_CHARS = 1200;

/** Slice the function starting at `opts.startLine` out of `text`. */
export function funcSlice(text: string, opts: FuncSliceOptions): FuncBriefResult {
  if (!Number.isInteger(opts.maxLines) || opts.maxLines < 1) { return { ok: false, error: `maxLines must be a positive integer (got ${opts.maxLines})` }; }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const startIdx = opts.startLine - 1;
  if (!Number.isInteger(opts.startLine) || startIdx < 0 || startIdx >= lines.length) {
    return { ok: false, error: `line ${opts.startLine} is out of range (the file has ${lines.length} lines)` };
  }
  const lang = opts.lang ?? (opts.file ? funcLangOf(opts.file) : 'brace');
  const { endIdx, reason } = resolveEnd(lines, startIdx, lang, opts);
  const totalLines = endIdx - startIdx + 1;
  const capIdx = Math.min(endIdx, startIdx + opts.maxLines - 1);
  const header = lang === 'python' ? pythonHeader(lines, startIdx, endIdx) : braceHeader(lines, startIdx, endIdx);
  const bodyFrom = Math.min(header.bodyIdx, endIdx + 1);
  const bodyTo = Math.min(endIdx, bodyFrom + opts.maxLines - 1);
  return {
    ok: true,
    signature: header.signature,
    doc: header.doc,
    source: lines.slice(startIdx, capIdx + 1).join('\n'),
    body: bodyFrom <= bodyTo ? lines.slice(bodyFrom, bodyTo + 1).join('\n') : '',
    startLine: opts.startLine,
    endLine: capIdx + 1,
    totalLines,
    endReason: capIdx < endIdx ? 'maxLines' : reason,
  };
}

/** Read `filePath` with the caller's `readText` (path already confined by the caller) and slice. */
export function readFuncSlice(filePath: string, readText: (p: string) => string, opts: Omit<FuncSliceOptions, 'file'>): FuncBriefResult {
  let text: string;
  try {
    text = readText(filePath);
  } catch (err) {
    return { ok: false, error: `could not read ${filePath}: ${(err as Error)?.message ?? String(err)}` };
  }
  if (typeof text !== 'string') { return { ok: false, error: `could not read ${filePath}: readText returned no text` }; }
  return funcSlice(text, { ...opts, file: filePath });
}

function resolveEnd(lines: string[], startIdx: number, lang: FuncLang, opts: FuncSliceOptions): { endIdx: number; reason: EndReason } {
  const r = scanFuncEnd(lines, startIdx, lang);
  if (r.closed) { return { endIdx: r.end, reason: 'detected' }; }
  const fb = opts.fallbackEndLine ?? (opts.nextStartLine != null ? opts.nextStartLine - 1 : null);
  if (fb != null && Number.isFinite(fb)) {
    const idx = Math.min(lines.length - 1, Math.max(startIdx, Math.floor(fb) - 1));
    return { endIdx: idx, reason: 'fallback' };
  }
  return { endIdx: lines.length - 1, reason: 'eof' };
}

const oneLine = (parts: string[], max: number): string => {
  const s = parts.join(' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};

const capDoc = (s: string): string => (s.length > DOC_MAX_CHARS ? s.slice(0, DOC_MAX_CHARS - 1) + '…' : s);

/** Strip comment markers from a doc block and drop blank edges. */
function cleanDoc(raw: string[]): string {
  const out = raw.map(l => l
    .replace(/^\s*\/\*\*?/, '').replace(/\*\/\s*$/, '')
    .replace(/^\s*\*(?!\/)\s?/, '').replace(/^\s*\/\/\/?\s?/, '').replace(/^\s*#\s?/, '')
    .replace(/\s+$/, ''));
  // PEP 257 (inspect.cleandoc): the first line follows the opening marker, so the
  // common indent is measured on the remaining lines only.
  if (out.length) { out[0] = out[0].trim(); }
  const indent = Math.min(...out.slice(1).filter(l => l.trim()).map(l => l.match(/^\s*/)![0].length), 1e9);
  const dedented = out.map((l, i) => (i === 0 ? l : l.slice(Math.min(indent, l.match(/^\s*/)![0].length))));
  while (dedented.length && !dedented[0].trim()) { dedented.shift(); }
  while (dedented.length && !dedented[dedented.length - 1].trim()) { dedented.pop(); }
  return capDoc(dedented.join('\n'));
}

// ── Python: def … : then an optional docstring as the first statement ──────────

function pythonHeader(lines: string[], startIdx: number, endIdx: number): { signature: string; doc: string; bodyIdx: number } {
  // Skip decorators to the def/class line, then to the ':' that closes the signature.
  let i = startIdx;
  while (i < endIdx && /^\s*@/.test(lines[i])) { i++; }
  const defIdx = i;
  let depth = 0;
  let sigEnd = defIdx;
  for (let k = defIdx; k <= endIdx; k++) {
    const code = lines[k].replace(/#.*$/, '');
    for (const c of code) { if ('([{'.includes(c)) { depth++; } else if (')]}'.includes(c)) { depth--; } }
    sigEnd = k;
    if (depth <= 0 && /:\s*(\S.*)?$/.test(code)) { break; }
  }
  const signature = oneLine(lines.slice(defIdx, sigEnd + 1).map(l => l.replace(/#.*$/, '')), SIGNATURE_MAX_CHARS).replace(/:\s*$/, '');
  // One-liner `def f(): return 1` has no body block and no docstring.
  let j = sigEnd + 1;
  while (j <= endIdx && !lines[j].trim()) { j++; }
  const m = j <= endIdx ? /^\s*[rRuUbBfF]{0,2}("""|'''|"|')/.exec(lines[j]) : null;
  if (!m) { return { signature, doc: '', bodyIdx: j }; }
  const q = m[1];
  const first = lines[j].slice(lines[j].indexOf(q) + q.length);
  const closeAt = first.indexOf(q);
  if (closeAt >= 0) { return { signature, doc: capDoc(first.slice(0, closeAt).trim()), bodyIdx: j + 1 }; }
  if (q.length === 1) { return { signature, doc: '', bodyIdx: j }; }   // an unterminated '…' is not a docstring
  const docLines = [first];
  let k = j + 1;
  for (; k <= endIdx; k++) {
    const at = lines[k].indexOf(q);
    if (at >= 0) { docLines.push(lines[k].slice(0, at)); break; }
    docLines.push(lines[k]);
  }
  return { signature, doc: cleanDoc(docLines), bodyIdx: k + 1 };
}

// ── Brace languages: doc comment ABOVE the start, signature up to the body '{' ─

function braceHeader(lines: string[], startIdx: number, endIdx: number): { signature: string; doc: string; bodyIdx: number } {
  // Signature: from the first non-annotation line to the body brace (or ';' / '=>' expression).
  let s = startIdx;
  while (s < endIdx && /^\s*@\w/.test(lines[s]) && !/\)\s*\{/.test(lines[s])) { s++; }
  const sig: string[] = [];
  let paren = 0, bodyIdx = endIdx + 1;
  for (let k = s; k <= endIdx && sig.length < 12; k++) {
    const code = lines[k].replace(/\/\/.*$/, '');
    let cut = -1;
    for (let c = 0; c < code.length; c++) {
      const ch = code[c];
      if (ch === '(') { paren++; } else if (ch === ')') { paren--; } else if (paren <= 0 && (ch === '{' || ch === ';')) { cut = c; break; }
    }
    if (cut >= 0) {
      sig.push(code.slice(0, cut));
      bodyIdx = code.slice(cut + 1).trim() && !/^\}?\s*$/.test(code.slice(cut + 1).trim()) ? k : k + 1;
      break;
    }
    sig.push(code);
    const arrow = code.indexOf('=>');
    if (arrow >= 0 && paren <= 0 && code.slice(arrow + 2).trim() && !code.slice(arrow + 2).trim().startsWith('{')) { bodyIdx = k; break; }
  }
  const signature = oneLine(sig, SIGNATURE_MAX_CHARS);
  return { signature, doc: braceDocAbove(lines, startIdx), bodyIdx };
}

/** The comment block directly above the function (and above its annotations), or ''. */
function braceDocAbove(lines: string[], startIdx: number): string {
  let k = startIdx - 1;
  while (k >= 0 && /^\s*@\w/.test(lines[k])) { k--; }   // annotations / decorators between doc and def
  if (k < 0) { return ''; }
  if (/\*\/\s*$/.test(lines[k])) {
    const end = k;
    while (k >= 0 && !/\/\*/.test(lines[k])) { k--; }
    if (k < 0) { return ''; }
    return LICENCE.test(lines.slice(k, end + 1).join(' ')) ? '' : cleanDoc(lines.slice(k, end + 1));
  }
  const block: string[] = [];
  while (k >= 0 && /^\s*\/\//.test(lines[k])) { block.unshift(lines[k]); k--; }
  return block.length ? cleanDoc(block) : '';
}

const LICENCE = /copyright|licen[sc]e|spdx|all rights reserved/i;
