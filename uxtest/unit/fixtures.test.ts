import { test, expect } from '@playwright/test';
import { loadRepo } from '../lib/corpus';
import { annotationsFixture, gitFixture, timelineEntries, v1Payload, workflowGraph } from '../lib/fixtures';

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

  const wf = workflowGraph(repo, 30);
  expect(wf.nodes).toHaveLength(30);
  expect((wf.nodes[0] as unknown as { workflow: { isEntry: boolean; stage: number } }).workflow).toMatchObject({ isEntry: true, stage: 0 });
  expect((wf.workflow as { stageCount: number }).stageCount).toBe(6);
  expect(wf.edges.every(e => wf.nodes.some(n => n.id === e.source) && wf.nodes.some(n => n.id === e.target))).toBe(true);

  const tl = timelineEntries(repo, 5);
  expect(tl).toHaveLength(5);
  expect(tl[1].ts - tl[0].ts).toBe(86400);
  expect(v1Payload([{ id: 'a', x: 1, y: 2 }])).toMatchObject({ nodePositions: { a: { x: 1, y: 2 } }, settings: { layoutMode: 'static' } });
  expect(v1Payload([])).not.toHaveProperty('frames');
  const git = gitFixture(repo);
  expect(git.gitAvailable).toBe(true);
  expect(Object.keys(git.fileGitStatus)).toHaveLength(4);
});
