import { test, expect } from '@playwright/test';
import * as os from 'os';
import * as path from 'path';
import { summarizeFrames } from '../lib/fps';
import { slug, SkipStep } from '../lib/step';
import { expandHome, loadConfig, loadRepo, selectedRepos, sizeClass } from '../lib/corpus';
import { engines, matrix, motions, strict } from '../lib/matrix';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) { delete process.env[k]; } else { process.env[k] = vars[k]; } }
  try { fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) { delete process.env[k]; } else { process.env[k] = old[k]; } } }
}

test('summarizeFrames', () => {
  expect(summarizeFrames([])).toEqual({ frames: 0, avgMs: 0, p95Ms: 0, maxMs: 0, longFrames: 0, minFps: 0 });
  const w = summarizeFrames([16, 16, 16, 100]);
  expect(w).toMatchObject({ frames: 4, avgMs: 37, maxMs: 100, longFrames: 1, minFps: 10 });
  expect(w.p95Ms).toBe(100);
});

test('slug + SkipStep', () => {
  expect(slug('Expand the largest folder (C2)')).toBe('expand-the-largest-folder-c2');
  expect(slug('???')).toBe('step');
  expect(slug('x'.repeat(80))).toHaveLength(48);
  expect(new SkipStep('gone')).toBeInstanceOf(Error);
});

test('corpus helpers', () => {
  expect(expandHome('~/a')).toBe(path.join(os.homedir(), 'a'));
  expect(expandHome('/abs')).toBe('/abs');
  expect([sizeClass(10), sizeClass(2000), sizeClass(8000)]).toEqual(['small', 'medium', 'large']);
  const cfg = loadConfig();
  expect(cfg.defaultRepos.length).toBeGreaterThan(0);
  expect(path.isAbsolute(cfg.corpusDir)).toBe(true);
  withEnv({ UXTEST_REPOS: 'a, b', UXTEST_CORPUS: '/tmp/corpus' }, () => {
    expect(selectedRepos(cfg)).toEqual(['a', 'b']);
    expect(loadConfig().corpusDir).toBe('/tmp/corpus');
  });
  withEnv({ UXTEST_REPOS: undefined }, () => { expect(selectedRepos(cfg)).toEqual(cfg.defaultRepos); });
});

test('loadRepo: synthetic fixture and a clear error for unknown repos', async () => {
  const repo = await loadRepo('synthetic-1k');
  expect(repo.functions).toBe(1008);
  expect(repo.graph.edges.length).toBeGreaterThan(0);
  expect(repo.structure.root).toBe('/synthetic-1k');
  await expect(loadRepo('/definitely/not/here')).rejects.toThrow(/not found/);
});

test('matrix narrowing', () => {
  withEnv({ UXTEST_REPOS: 'r1,r2', UXTEST_ENGINES: undefined, UXTEST_MOTIONS: undefined, UXTEST_STRICT: undefined }, () => {
    expect(engines()).toEqual(['shelf', 'global']);
    expect(motions()).toEqual(['static', 'dynamic']);
    expect(matrix()).toHaveLength(8);
    expect(matrix({ perEngine: false, perMotion: false })).toEqual([
      { repo: 'r1', engine: 'shelf', motion: 'static' }, { repo: 'r2', engine: 'shelf', motion: 'static' }]);
    expect(strict()).toBe(false);
  });
  withEnv({ UXTEST_REPOS: 'r1', UXTEST_ENGINES: 'global', UXTEST_MOTIONS: 'dynamic,bogus', UXTEST_STRICT: '1' }, () => {
    expect(matrix()).toEqual([{ repo: 'r1', engine: 'global', motion: 'dynamic' }]);
    expect(strict()).toBe(true);
  });
});
