import { test, expect } from '@playwright/test';
import { DEFAULT_WEIGHTS, findingsFor, layoutScore, SEVERITY_RANK, type StepContext } from '../metrics/score';
import { computeMetrics } from '../metrics/compute';
import type { LayoutMetrics } from '../metrics/types';
import { snapshot } from './fixtures';

const clean: LayoutMetrics = { ...computeMetrics(snapshot()), nodes: 100, inkRatio: 0.2 };
const ctx = (over: Partial<StepContext> = {}): StepContext =>
  ({ engine: 'shelf', motion: 'static', settled: true, consoleErrors: 0, longFrames: 0, ...over });
const rules = (m: Partial<LayoutMetrics>, c?: Partial<StepContext>): string[] => findingsFor({ ...clean, ...m }, ctx(c)).map(f => f.rule);

test('clean layout has no findings', () => { expect(rules({})).toEqual([]); });

test('invariant rules fire with the right references', () => {
  expect(rules({ frameOverlapPairs: 1 })).toEqual(['frame-overlap']);
  expect(rules({ slotOverlapPairs: 2 })).toEqual(['slot-overlap']);
  expect(rules({ nodesOutsideSlot: 1 })).toEqual(['node-outside-slot']);
  expect(rules({ nodesOutsideFrame: 1 })).toEqual(['node-outside-frame']);
  expect(rules({ nodesPinnedToWall: 4 })).toEqual(['nodes-pinned-to-wall']);
  expect(rules({ nodesPinnedToWall: 3 })).toEqual([]);
  expect(findingsFor({ ...clean, nodesOutsideSlot: 1 }, ctx())[0]).toMatchObject({ severity: 'high', ref: 'B1' });
});

test('containment rules are shelf-only', () => {
  expect(rules({ nodesOutsideSlot: 5, nodesOutsideFrame: 5, nodesPinnedToWall: 50 }, { engine: 'global' })).toEqual([]);
});

test('overlap: any pair is a bug in Shelf+Static, a ratio elsewhere', () => {
  expect(rules({ nodeOverlapPairs: 1, nodeOverlapRatio: 0.01 })).toEqual(['static-grid-overlap']);
  expect(rules({ nodeOverlapPairs: 1, nodeOverlapRatio: 0.01 }, { motion: 'dynamic' })).toEqual([]);
  expect(rules({ nodeOverlapPairs: 9, nodeOverlapRatio: 0.2 }, { engine: 'global' })).toEqual(['node-overlap']);
});

test('label clutter needs enough labels and scales severity', () => {
  expect(rules({ labels: 5, labelOverlapRatio: 0.9 })).toEqual([]);
  expect(findingsFor({ ...clean, labels: 40, labelOverlapRatio: 0.4 }, ctx())[0].severity).toBe('low');
  expect(findingsFor({ ...clean, labels: 40, labelOverlapRatio: 0.7 }, ctx())[0].severity).toBe('medium');
});

test('context rules: overflow, settle, errors, long frames', () => {
  expect(rules({ offscreenNodeRatio: 0.5 })).toEqual(['graph-overflows-viewport']);
  expect(rules({}, { settled: false })).toEqual(['did-not-settle']);
  expect(rules({}, { settled: null })).toEqual([]);
  expect(rules({}, { consoleErrors: 2 })).toEqual(['console-error']);
  expect(rules({}, { longFrames: 11 })).toEqual(['long-frames']);
});

test('layoutScore: lower is better and each penalty is monotonic', () => {
  const base = layoutScore(clean, 1000);
  expect(base).toBeGreaterThanOrEqual(0);
  for (const worse of [{ nodeOverlapRatio: 0.3 }, { labelOverlapRatio: 0.5 }, { edgeCrossingsPerEdge: 4 }, { edgeLenCv: 1 }, { nodesOutsideSlot: 20 }, { inkRatio: 0.01 }]) {
    expect(layoutScore({ ...clean, ...worse }, 1000)).toBeGreaterThan(base);
  }
  expect(layoutScore(clean, 9000)).toBeGreaterThan(base);
  expect(layoutScore(clean, null)).toBeGreaterThan(layoutScore(clean, 9000)); // never settled = worst case
  expect(layoutScore(clean, 1000, { ...DEFAULT_WEIGHTS, settleSeconds: 0 })).toBeLessThan(base);
  expect(layoutScore({ ...clean, nodes: 0 }, 0)).toBeGreaterThanOrEqual(0);
});

test('severity ranks sort high first', () => {
  expect(['low', 'high', 'medium'].sort((a, b) => SEVERITY_RANK[a as 'low'] - SEVERITY_RANK[b as 'low'])).toEqual(['high', 'medium', 'low']);
});
