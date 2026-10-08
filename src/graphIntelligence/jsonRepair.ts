import type { ProgressEvent } from './progressParser';

/**
 * Pull one JSON object out of a provider result for the narrow `runJson` call:
 * the structured output when present, else the first balanced object in the text
 * that satisfies `predicate`. Tolerates plain JSON with trailing garbage, JSON inside a markdown
 * fence, and JSON whose string values contain ``` (the walker respects string quoting).
 */
export function extractJsonObject(
  ev: ProgressEvent & { kind: 'result' },
  providerName: string,
  predicate: (obj: unknown) => boolean = isPlainObject,
): unknown {
  if (ev.structured !== undefined && ev.structured !== null && predicate(ev.structured)) {
    return ev.structured;
  }
  const text = ev.text ?? '';
  const found = findFirstValidBalancedObject(text, predicate);
  if (found) { return found; }
  throw new Error(
    `Unable to extract a JSON object from ${providerName} response. First 300 chars: ${text.slice(0, 300)}`,
  );
}

function isPlainObject(obj: unknown): boolean {
  return typeof obj === 'object' && obj !== null && !Array.isArray(obj);
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
