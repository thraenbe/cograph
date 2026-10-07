import * as path from 'path';
import type { StructuralDiff } from './graphDiff';
import type { EngineFileStatus, EngineHunk, EngineStatusOverride } from './types';

/**
 * Project a structural diff onto the colours the graph already draws: the
 * GitStatusOverride that GitService annotates from. Keyed by the HEAD tree's
 * absolute forward-slash paths (the panel showing the head is the one coloured).
 *
 * A file the change added is 'added' as a whole. A file with added or changed
 * functions is 'modified', with one one-line hunk per touched function at its
 * definition line — exactly what annotateNodes needs to colour that function and
 * no other. Removed functions have no node in the head and are not here; the
 * diff lists them for the sidebar.
 */
export function statusesFromDiff(diff: StructuralDiff, headRoot: string): EngineStatusOverride {
  const abs = (rel: string) => path.join(headRoot, ...rel.split('/')).replace(/\\/g, '/');
  const files = new Map<string, EngineFileStatus>();
  const hunks = new Map<string, EngineHunk[]>();
  for (const f of diff.files.added) { files.set(abs(f), { unstaged: 'added', staged: null }); }
  for (const fn of diff.functions) {
    if ((fn.kind !== 'added' && fn.kind !== 'changed') || fn.headLine === undefined) { continue; }
    const key = abs(fn.file);
    if (!files.has(key)) { files.set(key, { unstaged: 'modified', staged: null }); }
    if (files.get(key)?.unstaged === 'added') { continue; } // a new file colours every function anyway
    let list = hunks.get(key);
    if (!list) { list = []; hunks.set(key, list); }
    list.push({ start: fn.headLine, end: fn.headLine, isNew: fn.kind === 'added' });
  }
  return { files, hunks };
}
