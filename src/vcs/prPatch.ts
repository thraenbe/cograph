import type { PrHunk } from './types';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * A unified-diff patch of ONE file (the `patch` field of GitHub's pull-request
 * files endpoint, context lines included) → the changed stretches in line numbers
 * of the new file. Pure.
 *
 * Context lines are walked, not reported, so a stretch covers exactly the lines
 * that were added or replaced. Removed lines have no line of their own in the new
 * file: a pure removal is reported as a one-line stretch at the line that follows
 * it, which is where a function that lost code still overlaps.
 */
export function parsePatchHunks(patch: string): PrHunk[] {
  const hunks: PrHunk[] = [];
  let newLine = 0;
  let inHunk = false;
  let runStart = 0;      // first added line of the open run; 0 = no added line yet
  let runRemoved = false;

  const flush = () => {
    if (runStart > 0) {
      hunks.push({ start: runStart, end: newLine - 1, isNew: !runRemoved });
    } else if (runRemoved) {
      const at = Math.max(1, newLine);
      hunks.push({ start: at, end: at, isNew: false });
    }
    runStart = 0;
    runRemoved = false;
  };

  for (const line of String(patch ?? '').split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      flush();
      newLine = parseInt(header[3], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) { continue; }
    const tag = line[0];
    if (tag === '+') {
      if (runStart === 0) { runStart = newLine; }
      newLine++;
    } else if (tag === '-') {
      runRemoved = true;
    } else if (tag === '\\') {
      // "\ No newline at end of file" belongs to the line before it.
    } else {
      flush();
      newLine++;
    }
  }
  flush();
  return hunks;
}
