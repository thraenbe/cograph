import * as fs from 'fs';
import { findJsFuncEnd, findPythonFuncEnd } from '../sourceEditor';

/**
 * Seam for get_symbol's source slice. Session-216's `src/funcBrief.ts` (`readFuncSlice`, commit
 * 44b9afb, on top of PR #69) replaces the body of `readSlice` once #69 lands; the result shape
 * below is the subset of its `FuncBriefResult` that get_symbol uses. Until then this adapts the
 * end-finders already shipped in `sourceEditor.ts` and adds no scanning logic of its own.
 *
 * Contract: language end detection gives the end and `maxLines` is a hard cap. A `detected` end
 * means "balanced parse", not "complete function" (a `}` in a string can end the brace scan
 * early), so callers present the slice as best-effort with its line range. `eof` means the scan
 * reached the last line: either the function really ends there or detection never closed; from
 * outside the scanner the two are indistinguishable. That is why this adapter applies no
 * next-symbol fallback: cutting at the next symbol would truncate every function that contains a
 * nested one (measured: 399 in click alone). Only the scanner can say "never closed".
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

  const lastIdx = lines.length - 1;
  let endIdx = absFile.endsWith('.py') ? findPythonFuncEnd(lines, startIdx) : findJsFuncEnd(lines, startIdx);
  let endReason: EndReason = endIdx === lastIdx ? 'eof' : 'detected';
  while (endIdx > startIdx && lines[endIdx].trim() === '') { endIdx--; } // trailing blank lines are noise
  const capIdx = startIdx + Math.max(1, opts.maxLines) - 1;
  if (endIdx > capIdx) {
    endIdx = capIdx;
    endReason = 'maxLines';
  }
  return { ok: true, source: lines.slice(startIdx, endIdx + 1).join('\n'), startLine, endLine: endIdx + 1, endReason };
}
