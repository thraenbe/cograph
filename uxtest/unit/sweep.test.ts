import { test, expect } from '@playwright/test';
import { buildSamples, grid, latinHypercube, toSliderValue } from '../sweep/sampler';
import { analyzeGroup, consensus, groupSamples, ranks, recommendationsMarkdown, sensitivity, spearman, toCsv, type SweepSample } from '../sweep/analyze';
import { computeMetrics } from '../metrics/compute';
import { snapshot } from './fixtures';

const base = computeMetrics(snapshot());
function sample(over: Partial<SweepSample>): SweepSample {
  return { repo: 'r', engine: 'shelf', index: 1, baseline: false, values: {}, dropped: [], settleMs: 1000, settled: true, metrics: base, score: 1, screenshot: 'r/s/steps/x.png', ...over };
}

test.describe('sampler', () => {
  test('latin hypercube hits every stratum exactly once and is seeded', () => {
    const n = 8, rows = latinHypercube(['a', 'b', 'c'], n, 7);
    expect(rows).toHaveLength(n);
    for (const p of ['a', 'b', 'c']) {
      expect(rows.map(r => Math.floor(r[p] * n)).sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    }
    expect(latinHypercube(['a', 'b', 'c'], n, 7)).toEqual(rows);
    expect(latinHypercube(['a', 'b', 'c'], n, 8)).not.toEqual(rows);
  });

  test('grid is the full factorial', () => {
    expect(grid(['a', 'b'], 3)).toHaveLength(9);
    expect(grid(['a'], 3).map(r => r.a)).toEqual([0, 0.5, 1]);
    expect(grid(['a'], 1)).toEqual([{ a: 0.5 }]);
    expect(grid([], 3)).toEqual([{}]);
  });

  test('buildSamples always starts with the defaults baseline', () => {
    const s = buildSamples(['a', 'b'], 5, 1);
    expect(s[0]).toEqual({ index: 0, unit: null });
    expect(s.map(x => x.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(buildSamples(['a', 'b'], 9, 1, 'grid')).toHaveLength(10);
  });

  test('toSliderValue maps, narrows, snaps and clamps', () => {
    expect(toSliderValue(0.5, 0, 1000, 1)).toBe(500);
    expect(toSliderValue(0.5, 0, 1000, 1, [0, 600])).toBe(300);
    expect(toSliderValue(0.333, 0, 1, 0.01)).toBe(0.33);
    expect(toSliderValue(1, 0, 10, 0.1, [0, 50])).toBe(10);
    expect(toSliderValue(0.5, 0, 1, 0)).toBe(0.5);
  });
});

test.describe('analysis', () => {
  test('ranks with ties and spearman', () => {
    expect(ranks([10, 30, 20, 30])).toEqual([1, 3.5, 2, 3.5]);
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearman([1, 2, 3, 4], [9, 7, 5, 1])).toBe(-1);
    expect(spearman([1, 2, 3, 4], [5, 5, 5, 5])).toBe(0);
    expect(spearman([1, 2], [1, 2])).toBe(0);
    expect(spearman([1, 2, 3], [1, 2])).toBe(0);
  });

  const samples = [
    sample({ index: 0, baseline: true, values: { repel: 250, link: 1 }, score: 3 }),
    sample({ index: 1, values: { repel: 100, link: 4 }, score: 1, metrics: { ...base, nodeOverlapRatio: 0.01 } }),
    sample({ index: 2, values: { repel: 400, link: 2 }, score: 2, metrics: { ...base, nodeOverlapRatio: 0.05 } }),
    sample({ index: 3, values: { repel: 900, link: 3 }, score: 4, settleMs: null, settled: false, metrics: { ...base, nodeOverlapRatio: 0.2 }, dropped: ['slotPad'] }),
  ];

  test('analyzeGroup ranks, finds the best non-baseline sample and the improvement', () => {
    const g = analyzeGroup(samples);
    expect(g.ranked.map(s => s.index)).toEqual([1, 2, 0, 3]);
    expect(g.best?.index).toBe(1);
    expect(g.improvementPct).toBe(66.7);
    expect(analyzeGroup([samples[1]]).improvementPct).toBeNull();
  });

  test('sensitivity excludes the baseline and sorts by |rho|', () => {
    const s = sensitivity(samples);
    expect(s[0]).toMatchObject({ param: 'repel', vsScore: 1, vsOverlap: 1, vsSettle: 0.866 }); // two tied settle times
    expect(s.map(x => x.param)).toEqual(['repel', 'link']);
  });

  test('grouping, consensus, markdown and csv', () => {
    const other = samples.map(s => ({ ...s, repo: 'q' }));
    const glob = samples.map(s => ({ ...s, engine: 'global' }));
    const groups = groupSamples([...samples, ...other, ...glob]);
    expect(groups.map(g => `${g.engine}/${g.repo}`)).toEqual(['global/r', 'shelf/q', 'shelf/r']);
    expect(consensus(groups, 'shelf', 2)).toEqual({ repel: 100, link: 2 });
    const md = recommendationsMarkdown(groups);
    expect(md).toContain('## Engine: shelf');
    expect(md).toContain('0 (defaults)');
    expect(md).toContain('66.7 % better');
    expect(md).toContain('Not available in this UI (skipped): slotPad');
    const csv = toCsv(samples).trim().split('\n');
    expect(csv).toHaveLength(5);
    expect(csv[0].startsWith('repo,engine,sample,baseline,score,settleMs,settled,link,repel,nodes')).toBe(true);
    expect(csv[4]).toContain('r,shelf,3,false,4,,false,3,900');
  });
});
