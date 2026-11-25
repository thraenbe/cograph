import { test, expect } from '@playwright/test';
import { loadRepo } from '../lib/corpus';
import { annotationsFixture, gitFixture, prFixture, timelineEntries, v1Payload } from '../lib/fixtures';
import type { AnalyzedRepo } from '../lib/analyze';

test('fixtures derive deterministic host data from a repo', async () => {
  const repo = await loadRepo('synthetic-1k');
  const ann = annotationsFixture(repo);
  expect(ann.aiEnabled).toBe(false);
  expect(ann.folderRel).not.toBe('.');
  expect(ann.folderRel.startsWith('/')).toBe(false);
  expect(Object.keys(ann.folders)).toEqual([ann.folderRel]);
  expect(ann.fileRel.startsWith(ann.folderRel + '/')).toBe(true);
  expect(ann.stale).toEqual([ann.staleRel]);
  expect(Object.keys(ann.files).sort()).toEqual([ann.fileRel, ann.staleRel].sort());

  const tl = timelineEntries(repo, 5);
  expect(tl).toHaveLength(5);
  expect(tl[1].ts - tl[0].ts).toBe(86400);
  expect(v1Payload([{ id: 'a', x: 1, y: 2 }])).toMatchObject({ nodePositions: { a: { x: 1, y: 2 } }, settings: { layoutMode: 'static' } });
  expect(v1Payload([])).not.toHaveProperty('frames');
  const git = gitFixture(repo);
  expect(git.gitAvailable).toBe(true);
  expect(Object.keys(git.fileGitStatus)).toHaveLength(4);
});

test('prFixture opens the folders under the keys the tree has: native separators on Windows', () => {
  const files = ['C:\\r\\src\\a.ts', 'C:\\r\\src\\b.ts', 'C:\\r\\lib\\c.ts'];
  const repo = {
    root: 'C:\\r',
    graph: { nodes: files.map((file, i) => ({ id: String(i), file, line: 1 })), edges: [] },
    structure: { root: 'C:\\r', folders: { 'C:\\r': {}, 'C:\\r\\src': {}, 'C:\\r\\lib': {} }, files: [], totalFiles: 3 },
  } as unknown as AnalyzedRepo;
  expect(prFixture(repo).expand).toEqual(['C:\\r', 'C:\\r\\lib', 'C:\\r\\src']);
});
