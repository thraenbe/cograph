import * as path from 'path';
import type { TourPrepared, TourTarget } from '../tour/tourApi';
import type { PrGraphView } from './prController';

/**
 * The pull-request view a tour's stage shows: the head copy the private host
 * prepared, coloured with its statuses, opened at its changed folders. The
 * same message a pull-request click sends (Q11: the PR panel opens in VS Code
 * and the browser tab mirrors it). No vscode import.
 */

/** The copy directory is named by its commit: `<storage>/<repo key>/<sha>`. */
export function headShaOf(headDir: string): string {
  return path.basename(path.resolve(headDir));
}

/**
 * Absolute folder paths under the copy (the host may hand them relative to it), the copy's root
 * first: like buildPrView, the root is always open, or nothing under it shows.
 */
function absFolders(headDir: string, folders: string[]): string[] {
  const out = [headDir, ...folders.map(f => (path.isAbsolute(f) ? f : path.join(headDir, ...f.split('/').filter(s => s && s !== '.'))))];
  return [...new Set(out)];
}

export function tourGraphView(prepared: TourPrepared, target: TourTarget): PrGraphView {
  const sha = headShaOf(prepared.headDir);
  const files = new Map(prepared.statuses.files.map(([p, s]) => [p, { unstaged: s.unstaged, staged: null }] as const));
  const hunks = new Map(prepared.statuses.hunks);
  const v = prepared.view;
  const number = target.kind === 'pr' && target.number ? target.number : 0;
  return {
    number,
    name: v.name,
    spec: { include: ['.'], exclude: [] },
    override: { files, hunks },
    message: {
      type: 'pr-view', active: true, number, name: v.name, title: v.title, headRef: v.headRef, baseRef: v.baseRef,
      tree: { kind: 'head', sha }, expand: absFolders(prepared.headDir, v.expand), fileGitStatus: Object.fromEntries(files),
      counts: { total: v.counts.total, inGraph: v.counts.inGraph, exact: v.counts.inGraph, fileLevel: 0, missing: 0, other: v.counts.other },
    },
  };
}
