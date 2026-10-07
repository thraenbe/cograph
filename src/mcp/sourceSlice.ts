import * as fs from 'fs';
import { funcLangOf, scanFuncEnd } from '../funcEnd';

/**
 * Seam for get_symbol's source slice. Session-216's `src/funcBrief.ts` (`readFuncSlice`, commit
 * 44b9afb, on top of PR #69) replaces the body of `readSlice` once #69 lands; the result shape
 * below is the subset of its `FuncBriefResult` that get_symbol uses. Until then this calls
 * session-216's scanner `funcEnd.ts` (the one funcBrief builds on) and adds no scanning logic.
 *
 * Contract: the scanner gives the end and `maxLines` is a hard cap.
 * - `detected`: the scanner found the closing end. It skips strings, char literals, comments and
 *   regexes, so a `}` inside them no longer ends a slice early. It is still a heuristic (C++
 *   preprocessor branches with unbalanced braces, for one), so callers keep calling the slice
 *   best-effort and tell the agent to read the file at the range before editing.
 * - `eof`: the scanner found no end before the end of the file (`closed: false`).
 * - `maxLines`: cut at the cap, whichever of the above applied.
 * No next-symbol fallback here: cutting at the next symbol would truncate every function that
 * contains a nested one (measured: 399 in click alone). funcBrief applies it only to unclosed
 * scans; the swap to `readFuncSlice` passes `nextStartLine`.
 */
export type EndReason = 'detected' | 'maxLines' | 'fallback' | 'eof';

export interface SourceSlice {
  ok: true;
  source: string;
  startLine: number;
  endLine: number;
  endReason: EndReason;
}

export type SliceResult = SourceSlice | { ok: false; error: string };

export interface SliceOptions {
  maxLines: number;
}

/** Never throws: an unreadable or vanished file, or a line out of range, comes back as `{ ok: false }`. */
export function readSlice(absFile: string, startLine: number, opts: SliceOptions): SliceResult {
  let lines: string[];
  try {
    lines = fs.readFileSync(absFile, 'utf8').replace(/\r\n/g, '\n').split('\n');
  } catch (err) {
    return { ok: false, error: `cannot read file (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  const startIdx = startLine - 1;
  if (startIdx < 0 || startIdx >= lines.length) { return { ok: false, error: `line ${startLine} is past the end of the file` }; }

  const scan = scanFuncEnd(lines, startIdx, funcLangOf(absFile));
  let endIdx = scan.end;
  let endReason: EndReason = scan.closed ? 'detected' : 'eof';
  while (endIdx > startIdx && lines[endIdx].trim() === '') { endIdx--; } // trailing blank lines are noise
  const capIdx = startIdx + Math.max(1, opts.maxLines) - 1;
  if (endIdx > capIdx) {
    endIdx = capIdx;
    endReason = 'maxLines';
  }
  return { ok: true, source: lines.slice(startIdx, endIdx + 1).join('\n'), startLine, endLine: endIdx + 1, endReason };
}
