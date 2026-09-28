import * as fs from 'fs';
import { funcLangOf, scanFuncEnd, scanPythonFuncEnd, scanBraceFuncEnd } from './funcEnd';

/** Lines shown when the end of a function cannot be found (read path only). */
export const UNCLOSED_READ_CAP = 200;

function readLines(file: string): { lines: string[]; crlf: boolean } {
  const raw = fs.readFileSync(file, 'utf8');
  return { lines: raw.replace(/\r\n/g, '\n').split('\n'), crlf: raw.includes('\r\n') };
}

function checkLine(lines: string[], line: number): number {
  const startIdx = line - 1;
  if (startIdx < 0 || startIdx >= lines.length) { throw new Error(`Line ${line} out of range`); }
  return startIdx;
}

/** Source of the function starting at `line` (1-based). Best effort: an end that
 *  cannot be found is capped instead of returning the rest of the file. */
export function getFuncSource(file: string, line: number): string {
  const { lines } = readLines(file);
  const startIdx = checkLine(lines, line);
  const r = scanFuncEnd(lines, startIdx, funcLangOf(file));
  const endIdx = r.closed ? r.end : Math.min(r.end, startIdx + UNCLOSED_READ_CAP - 1);
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

/** Kept for callers of the 1.3.0 API: last line index of a Python function. */
export function findPythonFuncEnd(lines: string[], startIdx: number): number {
  return scanPythonFuncEnd(lines, startIdx).end;
}

/** Kept for callers of the 1.3.0 API: last line index of a brace-language function. */
export function findJsFuncEnd(lines: string[], startIdx: number): number {
  return scanBraceFuncEnd(lines, startIdx, 'js').end;
}

/**
 * Replace the function starting at `line` with `newSource` — only if the region
 * it would overwrite is exactly the text the user was shown (`expectedOriginal`,
 * as returned by getFuncSource). Any doubt refuses and writes nothing:
 *   - no original sent,
 *   - the end of the function cannot be found (never "to the end of the file"),
 *   - the file changed since the popup read it, or the region does not match.
 * The round trip, not the parser, is what makes the write safe.
 */
export function saveFuncSource(file: string, line: number, newSource: string, expectedOriginal?: string | null): void {
  if (typeof expectedOriginal !== 'string') {
    throw new Error('the original text of the function was not sent, so nothing was saved.');
  }
  const { lines, crlf } = readLines(file);
  const startIdx = checkLine(lines, line);
  const r = scanFuncEnd(lines, startIdx, funcLangOf(file));
  if (!r.closed) {
    throw new Error(`could not find where the function at line ${line} ends, so nothing was saved. Edit it in the editor instead.`);
  }
  const current = lines.slice(startIdx, r.end + 1).join('\n');
  if (current !== expectedOriginal.replace(/\r\n/g, '\n')) {
    throw new Error('the file changed since this popup was opened (or the function could not be matched), so nothing was saved.');
  }
  lines.splice(startIdx, r.end - startIdx + 1, ...newSource.replace(/\r\n/g, '\n').split('\n'));
  fs.writeFileSync(file, lines.join(crlf ? '\r\n' : '\n'), 'utf8');
}

/**
 * After a refused save: where is the popup's function now? Looks for its first
 * line (the signature the user was shown) nearest to the old start line, so a
 * function that moved because lines were added above is found again. Null when
 * the signature is gone. Read-only; the caller offers the result as "Reload".
 */
export function relocateFuncSource(file: string, line: number, shownOriginal: string): { line: number; source: string } | null {
  const first = shownOriginal.replace(/\r\n/g, '\n').split('\n')[0];
  if (!first.trim()) { return null; }
  const { lines } = readLines(file);
  let best = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === first && (best < 0 || Math.abs(i - (line - 1)) < Math.abs(best - (line - 1)))) { best = i; }
  }
  return best < 0 ? null : { line: best + 1, source: getFuncSource(file, best + 1) };
}
