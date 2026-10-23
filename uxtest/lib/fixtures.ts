// Deterministic host-side fixtures derived from an analyzed repo: timeline
// history, annotations, and a legacy (v1) saved layout.
import type { AnalyzedRepo } from './analyze';
import type { AnnotationsFixture, GraphNodeLite, PullRequestFixture } from '../harness/fakeHost';

const fns = (repo: AnalyzedRepo): GraphNodeLite[] => repo.graph.nodes.filter(n => !n.isLibrary && n.file);

/** `timeline-data` entries: one function introduced per simulated day, in graph order. */
export function timelineEntries(repo: AnalyzedRepo, max = 400): Array<{ id: string; ts: number }> {
  const t0 = Date.UTC(2024, 0, 1) / 1000;
  return fns(repo).slice(0, max).map((n, i) => ({ id: n.id, ts: t0 + i * 86400 }));
}

/** A v1 saved layout (positions + settings only; no frames / expandedFolders / detailDepth). */
export function v1Payload(positions: Array<{ id: string; x: number; y: number }>): Record<string, unknown> {
  const nodePositions: Record<string, { x: number; y: number }> = {};
  for (const p of positions) { nodePositions[p.id] = { x: p.x, y: p.y }; }
  return {
    settings: { complexityLevel: 1, clusterGroupBy: 'file', layoutMode: 'static', gitMode: true, languageMode: true, folderMode: true, classMode: true },
    nodePositions,
  };
}

/** A few files marked modified/added so the git colours have something to show. */
export function gitFixture(repo: AnalyzedRepo): { gitAvailable: boolean; fileGitStatus: Record<string, unknown> } {
  const files = [...new Set(fns(repo).map(n => n.file as string))].slice(0, 4);
  const fileGitStatus: Record<string, unknown> = {};
  files.forEach((f, i) => { fileGitStatus[f] = { unstaged: i % 2 === 0 ? 'modified' : 'added', staged: null }; });
  return { gitAvailable: true, fileGitStatus };
}

const posix = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
const relTo = (root: string, abs: string): string => (posix(abs) === posix(root) ? '.' : posix(abs).startsWith(posix(root) + '/') ? posix(abs).slice(posix(root).length + 1) : posix(abs));

/** What the real host answers to `get-annotations`: summaries for the biggest folder and two
 *  of its files, one of them stale. AI stays OFF — these are canned strings, nothing is generated. */
export function annotationsFixture(repo: AnalyzedRepo): AnnotationsFixture & { folderRel: string; fileRel: string; staleRel: string } {
  const byDir = new Map<string, string[]>();
  for (const n of fns(repo)) {
    const file = posix(n.file as string), dir = file.slice(0, file.lastIndexOf('/'));
    const list = byDir.get(dir) ?? [];
    if (!list.includes(file)) { list.push(file); }
    byDir.set(dir, list);
  }
  // The root frame has no grabbable header, so annotate the biggest folder below it.
  const [dir, files] = [...byDir.entries()].filter(([d]) => d !== posix(repo.root))
    .sort((a, b) => b[1].length - a[1].length || b[0].split('/').length - a[0].split('/').length)[0] ?? ['', []]; // ties → deepest (leaf headers are never covered)
  const folderRel = relTo(repo.root, dir), fileRel = relTo(repo.root, files[0] ?? ''), staleRel = relTo(repo.root, files[1] ?? files[0] ?? '');
  return {
    root: repo.root, aiEnabled: false, folderRel, fileRel, staleRel,
    folders: { [folderRel]: { summary: 'uxtest: canned folder summary.', role: 'core' } },
    files: { [fileRel]: { summary: 'uxtest: canned file summary.', role: 'module' }, [staleRel]: { summary: 'uxtest: canned but outdated summary.' } },
    stale: [staleRel],
  };
}

/** round3 W4: a scope that includes the biggest top-level folder (by function count) and nothing else. */
export function scopeFixture(repo: AnalyzedRepo): { name: string | null; root: string; include: string[]; exclude: string[]; excludedTop: string[] } {
  const root = posix(repo.root);
  const byTop = new Map<string, number>();
  for (const n of fns(repo)) {
    const rel = relTo(root, n.file as string);
    const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '.';
    byTop.set(top, (byTop.get(top) ?? 0) + 1);
  }
  const tops = [...byTop.entries()].filter(([t]) => t !== '.').sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const include = tops.length ? [tops[0]] : ['.'];
  return { name: 'uxtest-scope', root, include, exclude: [], excludedTop: tops.slice(1) };
}

/** A pull request shown in the graph (src/vcs): three changed files in two folders, the PR's own commit,
 *  read-only. The `pr-view` message is shaped like PrController.graphView's, so prView.js runs as in VS Code. */
export function prFixture(repo: AnalyzedRepo): { message: PullRequestFixture['message']; files: string[]; expand: string[]; scope: { name: string; root: string; include: string[]; exclude: string[] } } {
  const root = posix(repo.root);
  const byDir = new Map<string, string[]>();
  for (const n of fns(repo)) {
    const file = posix(n.file as string), dir = file.slice(0, file.lastIndexOf('/'));
    const list = byDir.get(dir) ?? [];
    if (!list.includes(file)) { list.push(file); }
    byDir.set(dir, list);
  }
  const dirs = [...byDir.entries()].filter(([d]) => d !== root).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const files = [...(dirs[0]?.[1].slice(0, 2) ?? []), ...(dirs[1]?.[1].slice(0, 1) ?? [])].slice(0, 3);
  const kinds: Array<'modified' | 'added'> = ['modified', 'added', 'modified'];
  const fileGitStatus: Record<string, { unstaged: string | null; staged: string | null }> = {};
  files.forEach((f, i) => { fileGitStatus[f] = { unstaged: kinds[i], staged: null }; });
  // Every folder on a path to a changed file, as buildPrView opens them (the root always).
  const open = new Set<string>([posix(repo.structure.root)]);
  for (const f of files) {
    for (let d = f.slice(0, f.lastIndexOf('/')); d.length >= root.length; d = d.slice(0, d.lastIndexOf('/'))) {
      if (repo.structure.folders[d]) { open.add(d); }
      if (d === root) { break; }
    }
  }
  const expand = [...open].filter(d => repo.structure.folders[d]).sort();
  const sha = 'abc1234def5678abc1234def5678abc1234def56';
  const name = `PR #4242 · head ${sha.slice(0, 7)}`;
  return {
    files, expand,
    // The transient 'pr' scope of showPullRequest: the whole project (unchangedFolders 'collapse'), named after the tree.
    scope: { name, root, include: ['.'], exclude: [] },
    message: {
      type: 'pr-view', active: true, number: 4242, name, title: 'uxtest: a fixture pull request',
      headRef: 'uxtest/pr', baseRef: 'main', tree: { kind: 'head', sha, base: '0123456789abcdef0123456789abcdef01234567' },
      diff: { added: 1, changed: 2, removed: 0, moved: 0, edgesAdded: 2, edgesRemoved: 0, callersAffected: 3 },
      expand, fileGitStatus, counts: { total: files.length, inGraph: files.length, exact: files.length, missing: 0, other: 0, fileLevel: 0 },
      readOnly: true,
    },
  };
}
