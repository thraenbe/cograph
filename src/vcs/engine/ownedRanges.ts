/**
 * Which lines of a file belong to which definition (engine-n1 assessment C2 and F3). A
 * definition spans [startLine ?? line, endLine]: startLine is where its decorators begin (Python),
 * endLine its closing token. A line belongs to the innermost definition whose span holds it, so a
 * parent owns its lines before and after a nested definition, and the nested one owns its own.
 * A definition without endLine keeps the old rule: from its line to the line before the next
 * definition in the file (the last one to the end of the file). One file comes from one analyzer,
 * so its definitions use one rule; a mixed file still gets an answer, just not a meaningful one.
 * Shared by graphDiff (a function's text) and GitService (which nodes a hunk marks).
 */

export interface RangeNode {
  line: number;
  endLine?: number;
  startLine?: number;
}

/** Owned line intervals, 1-based and inclusive, in line order. */
export type Owned = Array<[number, number]>;

/** The end of a file whose length is not known here. */
export const OPEN_END = Number.MAX_SAFE_INTEGER;

/** True when a node carries the analyzer's end line (and so its start line, if any). */
export function hasEnd(n: RangeNode): boolean {
  return typeof n.endLine === 'number' && n.endLine >= n.line;
}

function spanOf(n: RangeNode, nextLine: number | null): [number, number] {
  if (hasEnd(n)) {
    const start = typeof n.startLine === 'number' && n.startLine <= n.line ? n.startLine : n.line;
    return [start, n.endLine!];
  }
  return [n.line, nextLine === null ? OPEN_END : nextLine - 1];
}

/** `span` minus the given holes (each inside it), as intervals in order. */
function subtract(span: [number, number], holes: Array<[number, number]>): Owned {
  const out: Owned = [];
  let from = span[0];
  for (const [s, e] of [...holes].sort((x, y) => x[0] - y[0] || y[1] - x[1])) {
    if (e < from) { continue; }
    if (s > from) { out.push([from, Math.min(s - 1, span[1])]); }
    from = Math.max(from, e + 1);
    if (from > span[1]) { break; }
  }
  if (from <= span[1]) { out.push([from, span[1]]); }
  return out;
}

/**
 * Each node's owned lines. A node B is inside A when A's span holds B's span and they differ
 * (equal spans: the later one in line order is inside). The callers pass the nodes of one file.
 */
export function ownedRanges<T extends RangeNode>(nodes: T[]): Map<T, Owned> {
  const sorted = [...nodes].sort((a, b) => a.line - b.line);
  const spans = sorted.map((n, i) => {
    const next = sorted.slice(i + 1).find(o => o.line > n.line);
    return spanOf(n, next ? next.line : null);
  });
  const out = new Map<T, Owned>();
  sorted.forEach((n, i) => {
    const [s, e] = spans[i];
    const holes: Array<[number, number]> = [];
    spans.forEach(([s2, e2], j) => {
      if (j === i || s2 < s || e2 > e) { return; }
      const same = s2 === s && e2 === e;
      if (!same || j > i) { holes.push([s2, e2]); }
    });
    out.set(n, subtract([s, e], holes));
  });
  return out;
}

/** The nodes' fields without the analyzer's range: the old rule, for a pair where one side lacks it (C1). */
export function withoutEnd<T extends RangeNode>(n: T): RangeNode {
  return { line: n.line };
}
