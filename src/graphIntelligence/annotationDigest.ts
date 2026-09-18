import * as fs from 'fs';
import type { GraphData, GraphNode } from '../graphProvider';
import { toRel } from './annotationStore';
import type { FileDigest } from './annotationTypes';

/**
 * Builds the per-file digest — the ONLY file content that leaves the machine in
 * the default mode. It holds names, the signature line of each function, import
 * names and the leading comment. It never holds function bodies, and string
 * literals inside signature lines are blanked. No vscode import.
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SIGNATURE_CHARS = 160;
const MAX_COMMENT_CHARS = 300;
const MAX_SYMBOLS = 40;
const MAX_LIST = 12;
const MAX_COMMENT_LINES = 40;
/** Upper bound for one rendered digest, so a batch of 40 stays a small prompt. */
export const MAX_DIGEST_CHARS = 1200;

export interface DigestIndex {
  nodesByFile: Map<string, GraphNode[]>;
  importsByFile: Map<string, Set<string>>;
  callsByFile: Map<string, Set<string>>;
}

/** One pass over the graph so each file's digest is a lookup, not a scan. */
export function buildDigestIndex(graph: GraphData): DigestIndex {
  const nodesByFile = new Map<string, GraphNode[]>();
  const importsByFile = new Map<string, Set<string>>();
  const callsByFile = new Map<string, Set<string>>();
  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    byId.set(n.id, n);
    if (n.isLibrary || !n.file) { continue; }
    const list = nodesByFile.get(n.file);
    if (list) { list.push(n); } else { nodesByFile.set(n.file, [n]); }
  }
  for (const e of graph.edges) {
    const src = byId.get(e.source);
    const dst = byId.get(e.target);
    if (!src?.file || src.isLibrary || !dst) { continue; }
    if (dst.isLibrary) {
      addTo(importsByFile, src.file, dst.libraryName ?? dst.name);
    } else if (dst.file && dst.file !== src.file) {
      addTo(callsByFile, src.file, dst.file);
    }
  }
  return { nodesByFile, importsByFile, callsByFile };
}

/** Digest for one file. Unreadable or oversized files still get a names-only digest. */
export function buildFileDigest(root: string, abs: string, language: string, index: DigestIndex): FileDigest {
  const lines = readLines(abs);
  const nodes = [...(index.nodesByFile.get(abs) ?? [])].sort((a, b) => a.line - b.line);
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const sig = signatureOf(n, lines);
    if (!seen.has(sig)) { seen.add(sig); symbols.push(sig); }
    if (symbols.length >= MAX_SYMBOLS) { break; }
  }
  return {
    path: toRel(root, abs),
    language,
    loc: lines ? lines.length : 0,
    symbols,
    imports: [...(index.importsByFile.get(abs) ?? [])].sort().slice(0, MAX_LIST),
    calls: [...(index.callsByFile.get(abs) ?? [])].map(f => toRel(root, f)).sort().slice(0, MAX_LIST),
    leadingComment: lines ? leadingComment(lines) : '',
  };
}

/** Plain-text form of a digest for the prompt, clamped to MAX_DIGEST_CHARS by dropping symbols. */
export function renderFileDigest(d: FileDigest): string {
  let symbols = d.symbols;
  let text = render(d, symbols);
  while (text.length > MAX_DIGEST_CHARS && symbols.length > 0) {
    symbols = symbols.slice(0, Math.max(0, symbols.length - 5));
    text = render(d, symbols, d.symbols.length - symbols.length);
  }
  return text.slice(0, MAX_DIGEST_CHARS);
}

function render(d: FileDigest, symbols: string[], omitted = 0): string {
  const out = [`### ${d.path} (${d.language}, ${d.loc} lines)`];
  if (d.leadingComment) { out.push(`comment: ${d.leadingComment}`); }
  if (symbols.length || omitted) {
    out.push(`symbols: ${symbols.join(' | ')}${omitted ? ` | (+${omitted} more)` : ''}`);
  }
  if (d.imports.length) { out.push(`imports: ${d.imports.join(', ')}`); }
  if (d.calls.length) { out.push(`calls into: ${d.calls.join(', ')}`); }
  return out.join('\n');
}

function readLines(abs: string): string[] | null {
  try {
    if (fs.statSync(abs).size > MAX_FILE_BYTES) { return null; }
    return fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

/** The declaration line of a function, with string literals blanked; falls back to its name. */
function signatureOf(n: GraphNode, lines: string[] | null): string {
  const raw = lines?.[n.line - 1]?.trim() ?? '';
  const named = raw.includes(n.name) ? raw : n.name;
  const owner = n.className && !named.includes(n.className) ? `${n.className}.` : '';
  return (owner + blankStrings(named)).replace(/\s+/g, ' ').replace(/\s*[{:]\s*$/, '').slice(0, MAX_SIGNATURE_CHARS);
}

/** Replace the contents of quoted literals so a default value can never leak a secret. */
export function blankStrings(line: string): string {
  return line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '$1…$1');
}

/** Lines of the comment block starting at `start`: a block comment, a docstring, or a run of line comments. */
function collectCommentBlock(lines: string[], start: number, first: string): string[] {
  const block: string[] = [];
  const quote = /^[rRuU]?("""|''')/.exec(first)?.[1];
  const opener: string | undefined = first.startsWith('/*') ? '/*' : quote;
  if (!opener) {
    for (let i = start; i < lines.length && block.length < MAX_COMMENT_LINES && /^\s*(\/\/|#)/.test(lines[i]); i++) {
      block.push(lines[i]);
    }
    return block;
  }
  const closer: string = opener === '/*' ? '*/' : opener;
  for (let j = start; j < lines.length && block.length < MAX_COMMENT_LINES; j++) {
    block.push(lines[j]);
    // On the opening line, look for the terminator only after the opener.
    const rest: string = j === start ? lines[j].slice(lines[j].indexOf(opener) + opener.length) : lines[j];
    if (rest.includes(closer)) { break; }
  }
  return block;
}

const LICENCE = /copyright|licen[sc]e|spdx|all rights reserved/i;

/** First comment block or docstring at the top of the file; '' for licence headers. */
export function leadingComment(lines: string[]): string {
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].startsWith('#!') || /^['"]use strict['"];?$/.test(lines[i].trim()))) { i++; }
  const first = lines[i]?.trim() ?? '';
  const block = collectCommentBlock(lines, i, first);
  const text = block.join(' ')
    .replace(/\/\*+|\*+\/|"""|'''/g, ' ')
    .replace(/(^|\s)(\*|\/\/+|#+)(?=\s)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return LICENCE.test(text) ? '' : text.slice(0, MAX_COMMENT_CHARS);
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) { set.add(value); } else { map.set(key, new Set([value])); }
}
