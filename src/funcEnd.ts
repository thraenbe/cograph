// funcEnd.ts — where does the function that starts at a given line end?
//
// Pure (no fs, no vscode): shared by the source popup (sourceEditor.ts) and,
// later, by funcBrief / the MCP server. The result says whether the end was
// really found (`closed`) or the scan ran into the end of the file; a caller
// that WRITES must refuse an unclosed result instead of taking "the rest of
// the file".
//
// Brace languages: strings, char literals, template literals, comments and
// (JS/TS) regex literals are skipped, so a '}' inside them no longer ends or
// unbalances the body. Braces inside the parameter list (TS type literals,
// destructuring, Java annotations) are not the body. A ';' before any body
// brace ends a body-less declaration (Java abstract/interface method, C++
// prototype). Python: bracket and triple-quote aware, and a comment at a
// lower indent inside the body does not end the function.

export interface FuncEnd {
  /** 0-based index of the last line of the function. */
  end: number;
  /** false = no end was found before EOF; `end` is then the last line. */
  closed: boolean;
}

export type FuncLang = 'python' | 'js' | 'java' | 'cpp' | 'brace';

export function funcLangOf(file: string): FuncLang {
  const ext = (file.split('.').pop() ?? '').toLowerCase();
  if (ext === 'py' || ext === 'pyi') { return 'python'; }
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'].includes(ext)) { return 'js'; }
  if (ext === 'java') { return 'java'; }
  if (['c', 'cc', 'cpp', 'cxx', 'c++', 'h', 'hh', 'hpp', 'hxx', 'h++'].includes(ext)) { return 'cpp'; }
  return 'brace';
}

export function scanFuncEnd(lines: string[], startIdx: number, lang: FuncLang): FuncEnd {
  return lang === 'python' ? scanPythonFuncEnd(lines, startIdx) : scanBraceFuncEnd(lines, startIdx, lang);
}

// ── Python ───────────────────────────────────────────────────────────────────

interface PyState { bracket: number; triple: string; single: string; }

/** Advance the string/bracket state over one line. */
function pyScanLine(s: string, st: PyState): void {
  let j = 0;
  if (st.single) {   // a '…' / "…" string continued with a trailing backslash
    for (; j < s.length && s[j] !== st.single; j++) { if (s[j] === '\\') { j++; } }
    if (j >= s.length) { if (!/\\$/.test(s)) { st.single = ''; } return; }
    st.single = ''; j++;
  }
  for (; j < s.length; j++) {
    if (st.triple) {
      if (s[j] === '\\') { j++; continue; }
      if (s.startsWith(st.triple, j)) { j += 2; st.triple = ''; }
      continue;
    }
    const c = s[j];
    if (c === '#') { return; }
    if (c === '"' || c === "'") {
      const q3 = c + c + c;
      if (s.startsWith(q3, j)) { st.triple = q3; j += 2; continue; }
      for (j++; j < s.length && s[j] !== c; j++) { if (s[j] === '\\') { j++; } }
      if (j >= s.length && /\\$/.test(s)) { st.single = c; return; }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') { st.bracket++; } else if (c === ')' || c === ']' || c === '}') { st.bracket = Math.max(0, st.bracket - 1); }
  }
}

const indentOf = (s: string): number => s.match(/^(\s*)/)?.[1].length ?? 0;

export function scanPythonFuncEnd(lines: string[], startIdx: number): FuncEnd {
  const base = indentOf(lines[startIdx]);
  const st: PyState = { bracket: 0, triple: '', single: '' };
  let last = startIdx;
  let i = startIdx;
  for (; i < lines.length; i++) {
    const s = lines[i];
    const continued = st.bracket > 0 || st.triple !== '' || st.single !== '' || (i > startIdx && /\\$/.test(lines[i - 1]));
    if (i > startIdx && !continued) {
      const t = s.trim();
      if (t === '') { continue; }
      if (indentOf(s) <= base) {
        if (t.startsWith('#')) { continue; }   // a comment at a lower indent does not end the body
        break;
      }
    }
    pyScanLine(s, st);
    last = i;
  }
  // Keep the trailing blank lines up to the next statement, as the popup always did.
  let end = last;
  while (end + 1 < lines.length && end + 1 < i && lines[end + 1].trim() === '') { end++; }
  return { end, closed: st.triple === '' && st.single === '' && st.bracket === 0 };
}

// ── Brace languages ──────────────────────────────────────────────────────────

const isIdent = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_$]/.test(c);

/** A '/' starts a regex literal (not a division) after these tokens. */
function regexAllowed(prev: string, prevWord: string): boolean {
  if (!prev) { return true; }
  if (/[(,=:[!&|?{};+\-*%<>~^]/.test(prev)) { return true; }
  return ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await'].includes(prevWord);
}

/** Index of the closing '/' of a regex literal starting at j, or -1. */
function regexEnd(s: string, j: number): number {
  let cls = false;
  for (let k = j + 1; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') { k++; continue; }
    if (cls) { if (c === ']') { cls = false; } continue; }
    if (c === '[') { cls = true; continue; }
    if (c === '/') { return k; }
  }
  return -1;
}

interface BraceState {
  depth: number; paren: number; body: boolean;
  inBlock: boolean; quote: string; raw: boolean;
  prev: string; prevWord: string; arrowExpr: boolean;
}

/** Scan one line. Returns 'semi' when a body-less declaration ended on it. */
function braceScanLine(s: string, st: BraceState, lang: FuncLang): 'semi' | null {
  for (let j = 0; j < s.length; j++) {
    const c = s[j], n = s[j + 1];
    if (st.inBlock) { if (c === '*' && n === '/') { st.inBlock = false; j++; } continue; }
    if (st.quote) {
      if (c === '\\' && !st.raw) { j++; continue; }
      if (s.startsWith(st.quote, j)) { j += st.quote.length - 1; st.quote = ''; st.prev = 'a'; st.prevWord = ''; }
      continue;
    }
    if (c === '/' && n === '/') { return null; }
    if (c === '/' && n === '*') { st.inBlock = true; j++; continue; }
    if (lang === 'java' && s.startsWith('"""', j)) { st.quote = '"""'; st.raw = false; j += 2; continue; }
    if (lang === 'cpp' && c === 'R' && n === '"' && !isIdent(s[j - 1])) {
      const open = s.indexOf('(', j + 2);
      if (open >= 0) { st.quote = ')' + s.slice(j + 2, open) + '"'; st.raw = true; j = open; continue; }
    }
    if (c === '"' || c === "'" || (c === '`' && lang === 'js')) { st.quote = c; st.raw = false; continue; }
    if (c === '/' && lang === 'js' && regexAllowed(st.prev, st.prevWord)) {
      const e = regexEnd(s, j);
      if (e > 0) { j = e; st.prev = 'a'; st.prevWord = ''; continue; }
    }
    if (c === '=' && n === '>' && !st.body && st.paren === 0 && lang === 'js') {
      const rest = s.slice(j + 2).trim();
      st.arrowExpr = rest !== '' && !rest.startsWith('{') && !rest.startsWith('//');
    }
    if (c === '(') { st.paren++; } else if (c === ')') { st.paren = Math.max(0, st.paren - 1); } else if (c === '{') {
      if (st.body) { st.depth++; } else if (st.paren === 0) { st.body = true; st.depth = 1; st.arrowExpr = false; }
    } else if (c === '}') {
      if (st.body) { st.depth--; }
    } else if (c === ';' && !st.body && st.paren === 0) {
      return 'semi';
    }
    if (!/\s/.test(c)) {
      st.prevWord = /[A-Za-z_$]/.test(c) ? (isIdent(s[j - 1]) ? st.prevWord + c : c) : '';
      st.prev = c;
    }
  }
  return null;
}

export function scanBraceFuncEnd(lines: string[], startIdx: number, lang: FuncLang): FuncEnd {
  const st: BraceState = { depth: 0, paren: 0, body: false, inBlock: false, quote: '', raw: false, prev: '', prevWord: '', arrowExpr: false };
  for (let i = startIdx; i < lines.length; i++) {
    const s = lines[i];
    if (braceScanLine(s, st, lang) === 'semi') { return { end: i, closed: true }; }
    // Plain '…' and "…" literals end at the line end (an unterminated one must not eat the file).
    if (st.quote.length === 1 && st.quote !== '`' && !/\\$/.test(s)) { st.quote = ''; }
    if (st.body && st.depth <= 0) { return { end: i, closed: true }; }
    // `const f = (x) => x + 1` without a semicolon: the expression ends with the line
    // unless the line obviously continues.
    if (st.arrowExpr && !st.body && st.paren === 0 && !st.quote && !st.inBlock
      && !/[,([{=+\-*/&|?:.]\s*$/.test(s.replace(/\/\/.*$/, ''))) {
      return { end: i, closed: true };
    }
  }
  return { end: lines.length - 1, closed: false };
}
