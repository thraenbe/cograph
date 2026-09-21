// Findings (invariant violations worth a human/Claude look) and the composite
// layout score the force sweep ranks by. Pure; thresholds + weights are data.
import type { LayoutMetrics } from './types';

export type Severity = 'high' | 'medium' | 'low';
export interface Finding { rule: string; severity: Severity; message: string; ref?: string }

export interface StepContext {
  engine: string; motion: string;
  settled: boolean | null;
  consoleErrors: number;
  longFrames: number;
}

export interface ScoreWeights {
  nodeOverlap: number; labelOverlap: number; crossings: number; edgeLenCv: number;
  settleSeconds: number; containment: number; whitespace: number; legibility: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  nodeOverlap: 4, labelOverlap: 2, crossings: 1.5, edgeLenCv: 0.5, settleSeconds: 0.15, containment: 6, whitespace: 1, legibility: 3,
};

type Rule = (m: LayoutMetrics, c: StepContext) => Finding | null;

const shelf = (c: StepContext): boolean => c.engine === 'shelf';

const RULES: Rule[] = [
  (m) => m.frameOverlapPairs > 0 ? { rule: 'frame-overlap', severity: 'high', ref: 'R2/H1', message: `${m.frameOverlapPairs} sibling folder frame pair(s) overlap` } : null,
  (m) => m.slotOverlapPairs > 0 ? { rule: 'slot-overlap', severity: 'high', ref: 'R2/H1', message: `${m.slotOverlapPairs} file slot pair(s) overlap inside a frame` } : null,
  (m, c) => shelf(c) && m.nodesOutsideSlot > 0 ? { rule: 'node-outside-slot', severity: 'high', ref: 'B1', message: `${m.nodesOutsideSlot} node(s) centred outside their file slot` } : null,
  (m, c) => shelf(c) && m.nodesOutsideFrame > 0 ? { rule: 'node-outside-frame', severity: 'high', ref: 'B1', message: `${m.nodesOutsideFrame} node(s) centred outside their folder frame` } : null,
  (m, c) => shelf(c) && m.nodesPinnedToWall > Math.max(3, 0.02 * m.nodes)
    ? { rule: 'nodes-pinned-to-wall', severity: 'medium', ref: 'B2', message: `${m.nodesPinnedToWall} node(s) resting on a slot wall` } : null,
  (m, c) => shelf(c) && c.motion === 'static' && m.nodeOverlapPairs > 0
    ? { rule: 'static-grid-overlap', severity: 'high', ref: 'B1/R2', message: `${m.nodeOverlapPairs} overlapping node pair(s) in Shelf+Static (grid placement should have none)` } : null,
  (m, c) => !(shelf(c) && c.motion === 'static') && m.nodeOverlapRatio > 0.05
    ? { rule: 'node-overlap', severity: 'medium', ref: 'R4', message: `${(m.nodeOverlapRatio * 100).toFixed(1)} % of nodes overlap another node` } : null,
  (m) => m.labels >= 10 && m.labelOverlapRatio > 0.3
    ? { rule: 'label-clutter', severity: m.labelOverlapRatio > 0.6 ? 'medium' : 'low', ref: 'B6/R4', message: `${(m.labelOverlapRatio * 100).toFixed(0)} % of visible labels overlap another label` } : null,
  (m) => m.offscreenNodeRatio > 0.15
    ? { rule: 'graph-overflows-viewport', severity: 'low', ref: 'R1', message: `${(m.offscreenNodeRatio * 100).toFixed(0)} % of nodes are outside the viewport` } : null,
  (_m, c) => c.settled === false ? { rule: 'did-not-settle', severity: 'medium', ref: 'P3/H2', message: 'layout still moving at the settle timeout' } : null,
  (_m, c) => c.consoleErrors > 0 ? { rule: 'console-error', severity: 'high', message: `${c.consoleErrors} console/page error(s) during the step` } : null,
  (_m, c) => c.longFrames > 10 ? { rule: 'long-frames', severity: 'low', ref: 'P4', message: `${c.longFrames} frames over 50 ms during the step` } : null,
];

export function findingsFor(m: LayoutMetrics, c: StepContext): Finding[] {
  const out: Finding[] = [];
  for (const rule of RULES) { const f = rule(m, c); if (f) { out.push(f); } }
  return out;
}

export const LEGIBLE_NODE_PX = 6;   // on-screen node radius from which a node reads comfortably
export const LEGIBLE_LABEL_PX = 9;  // label height from which text reads
const FIT_W = 1280 - 120, FIT_H = 800 - 120; // fitToView() pads 60 px per side in the lab viewport

/** Runs recorded before the legibility fields existed: reconstruct the fit zoom from ink + aspect
 *  (node area / bbox area) assuming the uniform function radius of 10 graph units. */
export function estimateFitNodePx(m: LayoutMetrics, nodeR = 10): number {
  if (!m.nodes || !m.inkRatio || !m.bboxAspect) { return 0; }
  const area = (m.nodes * Math.PI * nodeR * nodeR) / m.inkRatio;
  const w = Math.sqrt(area * m.bboxAspect), h = Math.sqrt(area / m.bboxAspect);
  return nodeR * Math.min(FIT_W / w, FIT_H / h, 4);
}

/** 0 = comfortably legible at the current zoom, 1 = specks. A wide-spread layout is small at fit. */
export function legibilityPenalty(m: LayoutMetrics): number {
  const nodePx = m.nodePxMedian ?? estimateFitNodePx(m);
  const nodeTerm = 1 - Math.min(1, nodePx / LEGIBLE_NODE_PX);
  if (m.nodePxMedian === undefined) { return nodeTerm; }
  const labelTerm = m.labels ? 1 - Math.min(1, (m.labelPxMedian ?? 0) / LEGIBLE_LABEL_PX) : 0;
  return 0.6 * nodeTerm + 0.2 * labelTerm + 0.2 * (m.smallBoxShare ?? 0);
}

/** Lower is better. Every term is dimensionless and roughly 0..1 for sane layouts. */
export function layoutScore(m: LayoutMetrics, settleMs: number | null, w: ScoreWeights = DEFAULT_WEIGHTS): number {
  const n = Math.max(1, m.nodes);
  const containment = (m.nodesOutsideSlot + m.nodesOutsideFrame + 0.25 * m.nodesPinnedToWall) / n;
  const whitespace = 1 - Math.min(1, m.inkRatio * 8); // ink 0.125+ counts as "full"
  const score = w.nodeOverlap * m.nodeOverlapRatio
    + w.labelOverlap * m.labelOverlapRatio
    + w.crossings * Math.min(1, m.edgeCrossingsPerEdge / 10)
    + w.edgeLenCv * Math.min(2, m.edgeLenCv)
    + w.settleSeconds * Math.min(30, (settleMs ?? 30000) / 1000)
    + w.containment * Math.min(1, containment)
    + w.whitespace * whitespace
    + w.legibility * legibilityPenalty(m);
  return +score.toFixed(4);
}

/** Sweeps rank on the PICTURE only: settle time depends on how far the start state was from the
 *  sample's equilibrium (the defaults start at theirs), so it is reported next to the score, not in it. */
export const QUALITY_WEIGHTS: ScoreWeights = { ...DEFAULT_WEIGHTS, settleSeconds: 0 };

export const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
