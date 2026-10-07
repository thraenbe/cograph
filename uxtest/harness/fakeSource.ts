// The function-popup source round trip as the real host does it (src/sourceEditor.ts),
// but over an in-memory copy of each file: the lab never writes to the repo under test.
//
// Where a function ends comes from the product's own scanner (out/funcEnd.js of the
// checkout under test), so the served text, the save guard and "Reload from file" match
// the host line for line. A checkout without funcEnd.js (before PR #69) gets the old
// fixed-size slice and saves without a guard, like its host did.
import * as fs from 'fs';
import * as path from 'path';
import { EXT_ROOT } from './vscodeStub';

export interface FuncEndLib {
  funcLangOf(file: string): string;
  scanFuncEnd(lines: string[], startIdx: number, lang: string): { end: number; closed: boolean };
}

/** Lines served when no end is found (sourceEditor.UNCLOSED_READ_CAP) / by pre-funcEnd hosts. */
const UNCLOSED_READ_CAP = 200;
export const MAX_SOURCE_LINES = 60;

// Refusal reasons, verbatim from sourceEditor.saveFuncSource (a unit test compares them with the real module).
export const REASON_NO_ORIGINAL = 'the original text of the function was not sent, so nothing was saved.';
export const reasonUnclosed = (line: number): string =>
  `could not find where the function at line ${line} ends, so nothing was saved. Edit it in the editor instead.`;
export const REASON_CHANGED = 'the file changed since this popup was opened (or the function could not be matched), so nothing was saved.';

export function loadFuncEnd(extRoot: string = EXT_ROOT): FuncEndLib | null {
  const p = path.join(extRoot, 'out', 'funcEnd.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return fs.existsSync(p) ? require(p) as FuncEndLib : null;
}

export type SaveResult = { ok: true } | { ok: false; reason: string; current?: string; line?: number };

export class VirtualSources {
  private readonly files = new Map<string, string[]>();

  constructor(private readonly funcEnd: FuncEndLib | null = loadFuncEnd()) {}

  /** True when the checkout under test ships the guarded save (out/funcEnd.js). */
  get guarded(): boolean { return this.funcEnd !== null; }

  private lines(file: string): string[] {
    let l = this.files.get(file);
    if (!l) { l = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n'); this.files.set(file, l); }
    return l;
  }

  /** 0-based [start, end] of the function at `line`, and whether its end was really found. */
  private region(file: string, line: number): { start: number; end: number; closed: boolean } {
    const lines = this.lines(file);
    const start = line - 1;
    if (start < 0 || start >= lines.length) { throw new Error(`Line ${line} out of range`); }
    if (!this.funcEnd) { return { start, end: Math.min(lines.length, start + MAX_SOURCE_LINES) - 1, closed: true }; }
    const r = this.funcEnd.scanFuncEnd(lines, start, this.funcEnd.funcLangOf(file));
    return { start, end: r.closed ? r.end : Math.min(r.end, start + UNCLOSED_READ_CAP - 1), closed: r.closed };
  }

  /** getFuncSource. */
  read(file: string, line: number): string {
    const r = this.region(file, line);
    return this.lines(file).slice(r.start, r.end + 1).join('\n');
  }

  /** saveFuncSource + the graphProvider reply. `original` undefined and unguarded = the pre-guard host (always writes). */
  save(file: string, line: number, newSource: string, original: unknown): SaveResult {
    const guard = this.guarded || original !== undefined;
    let reason: string | null = null;
    if (guard && typeof original !== 'string') { reason = REASON_NO_ORIGINAL; }
    let r: { start: number; end: number; closed: boolean } | null = null;
    if (!reason) {
      try { r = this.region(file, line); } catch (err) { reason = (err as Error).message; } // the host answers a throw as a refusal too
    }
    if (!reason && r && guard && !r.closed) { reason = reasonUnclosed(line); }
    const lines = this.lines(file);
    if (!reason && r && guard && lines.slice(r.start, r.end + 1).join('\n') !== String(original).replace(/\r\n/g, '\n')) { reason = REASON_CHANGED; }
    if (reason || !r) {
      reason = reason ?? REASON_CHANGED;
      const found = typeof original === 'string' ? this.relocate(file, line, original) : null;
      return found ? { ok: false, reason, current: found.source, line: found.line } : { ok: false, reason };
    }
    lines.splice(r.start, r.end - r.start + 1, ...newSource.replace(/\r\n/g, '\n').split('\n'));
    return { ok: true };
  }

  /** relocateFuncSource: the shown first line nearest the old start. */
  private relocate(file: string, line: number, shown: string): { line: number; source: string } | null {
    const first = shown.replace(/\r\n/g, '\n').split('\n')[0];
    if (!first.trim()) { return null; }
    const lines = this.lines(file);
    let best = -1;
    lines.forEach((l, i) => { if (l === first && (best < 0 || Math.abs(i - (line - 1)) < Math.abs(best - (line - 1)))) { best = i; } });
    return best < 0 ? null : { line: best + 1, source: this.read(file, best + 1) };
  }

  /** The whole in-memory file (saved edits included). */
  text(file: string): string { return this.lines(file).join('\n'); }

  /** Test hook: the file changes "on disk" behind the popup (another editor, git checkout). */
  externalEdit(file: string, edit: (lines: string[]) => string[]): void {
    this.files.set(file, edit([...this.lines(file)]));
  }
}
