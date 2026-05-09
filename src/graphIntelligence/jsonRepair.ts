import type { GraphIntelligenceResult } from './provider';
import type { ProgressEvent } from './progressParser';

export function extractCographResult(ev: ProgressEvent & { kind: 'result' }): GraphIntelligenceResult {
  if (ev.structured && isGraphIntelligenceResult(ev.structured)) {
    return ev.structured;
  }

  const text = ev.text ?? '';

  // Walk the text for the first balanced top-level {...} that parses as a valid
  // GraphIntelligenceResult. This handles three shapes in one pass:
  //   - plain JSON (with or without trailing whitespace/garbage)
  //   - JSON wrapped in a markdown fence (the fence chars are outside `{...}`)
  //   - JSON that CONTAINS nested ``` inside its string values (the walker
  //     respects string quoting so nested fences don't trip depth tracking)
  const found = findFirstValidBalancedObject(text, isGraphIntelligenceResult);
  if (found) { return found as GraphIntelligenceResult; }

  const preview = text.slice(0, 300);
  throw new Error(
    `Unable to extract graph/text from Claude response. First 300 chars: ${preview}`,
  );
}

function findFirstValidBalancedObject(
  raw: string,
  predicate: (obj: unknown) => boolean,
): unknown | null {
  let i = 0;
  while (i < raw.length) {
    const openIdx = raw.indexOf('{', i);
    if (openIdx < 0) { return null; }
    const slice = sliceAtBalancedBrace(raw.slice(openIdx));
    if (!slice) { return null; }
    try {
      const parsed = JSON.parse(slice);
      if (predicate(parsed)) { return parsed; }
    } catch { /* skip — this open brace was not a real object */ }
    i = openIdx + slice.length;
  }
  return null;
}

export function tryParseWithRepair(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    /* try repair */
  }
  const balanced = sliceAtBalancedBrace(raw);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Walk `raw` tracking `{`/`}` depth while respecting string literals and escape
 * sequences. Return the substring spanning the first top-level object, or null
 * if no balanced object is found. Trailing garbage, second objects, and stray
 * markdown fences are all discarded.
 */
export function sliceAtBalancedBrace(raw: string): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\' && inStr) {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) { continue; }
    if (c === '{') {
      if (depth === 0) { start = i; }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        return raw.slice(start, i + 1);
      }
      if (depth < 0) { depth = 0; }
    }
  }
  return null;
}

/**
 * Find the LAST fenced block matching any of `labels`. Empty string matches
 * unlabelled ``` blocks. Uses string scanning (not a non-greedy regex) so that
 * backticks inside a JSON string value cannot prematurely terminate a capture.
 */
export function extractLastFencedBlock(text: string, labels: string[]): string | null {
  if (!text) { return null; }
  const fenceRe = /```([a-zA-Z0-9_-]*)\s*\n/g;
  const opens: Array<{ label: string; contentStart: number; fenceEnd: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    opens.push({ label: m[1] ?? '', contentStart: m.index + m[0].length, fenceEnd: m.index });
  }
  if (opens.length === 0) { return null; }

  // Pair opens with the next ``` after them. Scan once.
  const closes: number[] = [];
  const closeRe = /```/g;
  while ((m = closeRe.exec(text)) !== null) {
    closes.push(m.index);
  }

  type Block = { label: string; content: string };
  const blocks: Block[] = [];
  let ci = 0;
  for (const open of opens) {
    while (ci < closes.length && closes[ci] <= open.contentStart) { ci++; }
    if (ci >= closes.length) { break; }
    const closeIdx = closes[ci];
    ci++;
    blocks.push({ label: open.label, content: text.slice(open.contentStart, closeIdx).replace(/\n$/, '') });
  }

  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (labels.includes(b.label)) { return b.content; }
  }
  return null;
}

function isGraphIntelligenceResult(x: unknown): x is GraphIntelligenceResult {
  const r = x as { text?: unknown; graph?: { nodes?: unknown; edges?: unknown } } | null;
  return (
    !!r &&
    typeof r.text === 'string' &&
    !!r.graph &&
    Array.isArray(r.graph.nodes) &&
    Array.isArray(r.graph.edges)
  );
}
