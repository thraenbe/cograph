import * as fs from 'fs';
import { funcSlice, type FuncBriefResult } from '../funcBrief';

/**
 * get_symbol's source slice: session-216's `funcBrief.ts`, the same module the hover card uses,
 * so an agent and the hover card show the same lines for every function (216 checked parity over
 * 348,176 functions). funcBrief is fs-free; this file only reads the text. The caller has already
 * confined `absFile` to the workspace. Errors are reported without the absolute path, which must
 * not reach an agent.
 *
 * `detected` means the scanner (`funcEnd.ts`) found the end; it skips strings, comments and
 * regexes, but it is still a heuristic, so callers keep calling the slice best-effort. `fallback`
 * means the scan reached EOF unclosed and stopped before the next symbol; `nextStartLine` is used
 * only in that case (a next-symbol bound in general would truncate functions with nested ones).
 */
export type { EndReason } from '../funcBrief';
export type SliceResult = FuncBriefResult;

export interface SliceOptions {
  maxLines: number;
  /** Start line of the next symbol in the same file, if any. */
  nextStartLine?: number | null;
}

/** Never throws: an unreadable or vanished file, or a line out of range, comes back as `{ ok: false }`. */
export function readSlice(absFile: string, startLine: number, opts: SliceOptions): SliceResult {
  let text: string;
  try {
    text = fs.readFileSync(absFile, 'utf8');
  } catch (err) {
    return { ok: false, error: `cannot read file (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  return funcSlice(text, { startLine, maxLines: opts.maxLines, file: absFile, nextStartLine: opts.nextStartLine ?? null });
}
