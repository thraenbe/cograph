// PURE sweep analysis: ranking, per-parameter sensitivity (Spearman) and the
// recommendation text. Consumed by the report builder; unit-tested.
import type { LayoutMetrics } from '../metrics/types';
import { estimateFitNodePx, layoutScore, QUALITY_WEIGHTS } from '../metrics/score';

export interface SweepSample {
  repo: string; engine: string; index: number; baseline: boolean;
  values: Record<string, number>;          // actual slider values
  dropped: string[];                       // params absent/hidden in this UI
  settleMs: number | null; settled: boolean;
  /** Nodes displaced > 0.5 px by applying the sample's forces, and the largest displacement (absent in old runs). */
  movedNodes?: number; maxMovePx?: number;
  /** Largest |x| or |y| of any node in the end state — a runaway integrator shows up as 1e6+ (F12). */
  maxAbsCoord?: number;
  /** Set for explicit regression tuples; they are reported but never ranked or used for sensitivity. */
  label?: string;
  metrics: LayoutMetrics; score: number; screenshot: string;
}

export function ranks(xs: number[]): number[] {
  const order = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) { j++; }
    const r = (i + j) / 2 + 1; // average rank for ties
    for (let k = i; k <= j; k++) { out[order[k].i] = r; }
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation in [-1, 1]; 0 when either side is constant or n < 3. */
export function spearman(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 3) { return 0; }
  const ra = ranks(a), rb = ranks(b);
  const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da === 0 || db === 0 ? 0 : +(num / Math.sqrt(da * db)).toFixed(3);
}

export interface Sensitivity { param: string; vsScore: number; vsOverlap: number; vsCrossings: number; vsSettle: number }

export function sensitivity(samples: SweepSample[]): Sensitivity[] {
  const swept = samples.filter(s => !s.baseline);
  const params = [...new Set(swept.flatMap(s => Object.keys(s.values)))];
  return params.map((param) => {
    const rows = swept.filter(s => param in s.values);
    const x = rows.map(s => s.values[param]);
    return { param,
      vsScore: spearman(x, rows.map(s => s.score)),
      vsOverlap: spearman(x, rows.map(s => s.metrics.nodeOverlapRatio)),
      vsCrossings: spearman(x, rows.map(s => s.metrics.edgeCrossingsPerEdge)),
      vsSettle: spearman(x, rows.map(s => s.settleMs ?? 1e9)) };
  }).sort((a, b) => Math.abs(b.vsScore) - Math.abs(a.vsScore));
}

export interface GroupResult {
  repo: string; engine: string; baseline: SweepSample | null; ranked: SweepSample[];
  best: SweepSample | null; improvementPct: number | null; sensitivity: Sensitivity[];
  extras: SweepSample[];
}

export function analyzeGroup(all: SweepSample[]): GroupResult {
  const samples = all.filter(s => !s.label); // explicit regression tuples are not part of the design
  const ranked = [...samples].sort((a, b) => a.score - b.score);
  const baseline = samples.find(s => s.baseline) ?? null;
  // A sample that never came to rest cannot be a recommendation, however good its last frame scored.
  const best = ranked.find(s => !s.baseline && s.settled) ?? ranked.find(s => !s.baseline) ?? null;
  const improvementPct = baseline && best && baseline.score > 0 ? +(((baseline.score - best.score) / baseline.score) * 100).toFixed(1) : null;
  return { repo: all[0]?.repo ?? '', engine: all[0]?.engine ?? '', baseline, ranked, best, improvementPct, sensitivity: sensitivity(samples),
    extras: all.filter(s => !!s.label) };
}

/** Re-score from the stored metrics so old runs are ranked by the current (quality-only) formula. */
export function rescore(samples: SweepSample[]): SweepSample[] {
  return samples.map(s => ({ ...s, score: layoutScore(s.metrics, 0, QUALITY_WEIGHTS) }));
}

/** A swept sample whose forces did not change the picture: judged by measured node displacement. Runs recorded
 *  before `movedNodes` existed fall back to "the detector saw no motion", which is unreliable for fast worker sims. */
export const noEffect = (s: SweepSample): boolean => !s.baseline
  && (s.movedNodes !== undefined ? s.movedNodes === 0 : s.settled && (s.settleMs ?? 0) === 0);

export function groupSamples(samples: SweepSample[]): GroupResult[] {
  const groups = new Map<string, SweepSample[]>();
  for (const s of samples) { const k = `${s.engine}|${s.repo}`; const g = groups.get(k); if (g) { g.push(s); } else { groups.set(k, [s]); } }
  return [...groups.values()].map(analyzeGroup).sort((a, b) => (a.engine + a.repo).localeCompare(b.engine + b.repo));
}

/** Per engine: median of the top-3 values of every repo — robust against one repo's optimum. */
export function consensus(groups: GroupResult[], engine: string, topN = 3): Record<string, number> {
  const pool: Record<string, number[]> = {};
  for (const g of groups.filter(x => x.engine === engine)) {
    for (const s of g.ranked.filter(x => !x.baseline).slice(0, topN)) {
      for (const [p, v] of Object.entries(s.values)) { (pool[p] ??= []).push(v); }
    }
  }
  const out: Record<string, number> = {};
  for (const [p, vs] of Object.entries(pool)) { const s = [...vs].sort((a, b) => a - b); out[p] = +s[Math.floor((s.length - 1) / 2)].toFixed(4); }
  return out;
}

/** Below this gain a "better" sample is noise (headless settle-time jitter alone moves the score ~1 %). */
export const MIN_GAIN_PCT = 3;

export function verdictLine(g: GroupResult): string {
  const pct = g.improvementPct;
  if (pct === null || !g.best || !g.baseline) { return 'No baseline or no swept sample in this group.'; }
  if (pct > MIN_GAIN_PCT) { return `Defaults score ${g.baseline.score}; sample ${g.best.index} scores ${g.best.score} — **${pct} % better**.`; }
  if (pct >= 0) { return `Defaults score ${g.baseline.score}; best swept sample ${g.best.index} scores ${g.best.score} (${pct} % — within noise). **Keep the defaults.**`; }
  return `**Defaults win** (score ${g.baseline.score}); the best swept sample ${g.best.index} is ${Math.abs(pct)} % worse (${g.best.score}).`;
}

/** On-screen node radius at fit; `~` marks a value reconstructed for a run recorded before the metric existed. */
export const fitPx = (s: SweepSample): string => (s.metrics.nodePxMedian !== undefined ? String(s.metrics.nodePxMedian) : `~${estimateFitNodePx(s.metrics).toFixed(2)}`);

const fmt = (v: number | null | undefined): string => (v === null || v === undefined ? '–' : String(v));

export function recommendationsMarkdown(groups: GroupResult[]): string {
  const lines: string[] = ['# Force recommendations (draft, generated by uxtest sweep)', '',
    'Lower score = better. The score rates the END PICTURE only (overlap, crossings, clutter, containment, whitespace and\nlegibility at fit-to-view: a layout that spreads wide shrinks to specks when fitted —',
    '`QUALITY_WEIGHTS` in `metrics/score.ts`); settle time is listed next to it because it depends on the start state.',
    'Sample 0 of every group is the shipped defaults.',
    'This is evidence for a human/Claude decision, not the decision: look at the contact sheet before changing defaults.', ''];
  for (const engine of [...new Set(groups.map(g => g.engine))]) {
    const mine = groups.filter(x => x.engine === engine);
    const wins = mine.filter(g => (g.improvementPct ?? 0) <= MIN_GAIN_PCT).length;
    lines.push(`## Engine: ${engine}`, '',
      `**Shipped defaults are best or within ${MIN_GAIN_PCT} % of the best on ${wins} of ${mine.length} repos.**`
        + (wins === mine.length ? ' No change is supported by this sweep; the candidate below is for reference only.' : ''), '',
      '### Consensus candidate (median of each repo\'s top 3 swept samples)', '', '| force | value |', '|---|---|');
    for (const [p, v] of Object.entries(consensus(groups, engine))) { lines.push(`| ${p} | ${v} |`); }
    lines.push('');
    for (const g of groups.filter(x => x.engine === engine)) {
      lines.push(`### ${g.repo}`, '', verdictLine(g), '',
        '| rank | sample | score | settle ms | overlap | crossings/edge | label overlap | node px at fit | pinned | values |', '|---|---|---|---|---|---|---|---|---|---|');
      g.ranked.slice(0, 5).forEach((s, i) => lines.push(`| ${i + 1} | ${s.baseline ? '0 (defaults)' : s.index} | ${s.score} | ${fmt(s.settleMs)}${s.settled ? '' : ' ✗'} | ${s.metrics.nodeOverlapRatio} | ${s.metrics.edgeCrossingsPerEdge} | ${s.metrics.labelOverlapRatio} | ${fitPx(s)} | ${s.metrics.nodesPinnedToWall} | ${Object.entries(s.values).map(([k, v]) => `${k}=${v}`).join(' ')} |`));
      lines.push('', 'Sensitivity (Spearman ρ of the force value against …; |ρ| > 0.5 matters, sign + means "more force → worse"):', '',
        '| force | score | overlap | crossings | settle time |', '|---|---|---|---|---|');
      for (const s of g.sensitivity) { lines.push(`| ${s.param} | ${s.vsScore} | ${s.vsOverlap} | ${s.vsCrossings} | ${s.vsSettle} |`); }
      const inert = g.ranked.filter(noEffect).length, unsettled = g.ranked.filter(s => !s.settled).length;
      if (inert) {
        const measured = g.ranked.some(x => x.movedNodes !== undefined);
        lines.push('', measured
          ? `${inert} of ${g.ranked.length - 1} swept samples displaced no node by more than 0.5 px — for them the forces do not change the picture.`
          : `${inert} of ${g.ranked.length - 1} swept samples showed no motion to the settle detector. This run predates displacement measurement; fast worker sims can finish before the detector samples, so this is NOT evidence that nothing moved.`);
      }
      if (unsettled) { lines.push('', `${unsettled} sample(s) were still moving at the timeout (marked ✗) — a layout that never comes to rest is itself a finding.`); }
      for (const x of g.extras) {
        lines.push('', `Regression tuple "${x.label}": ${x.settled ? `settled after ${fmt(x.settleMs)} ms` : 'did NOT settle inside the window'}, max |coordinate| ${fmt(x.maxAbsCoord)} px, score ${x.score}, ${fmt(x.movedNodes)} nodes moved — values ${Object.entries(x.values).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      }
      const dropped = [...new Set(g.ranked.flatMap(s => s.dropped))];
      if (dropped.length) { lines.push('', `Not available in this UI (skipped): ${dropped.join(', ')}`); }
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function toCsv(samples: SweepSample[]): string {
  const params = [...new Set(samples.flatMap(s => Object.keys(s.values)))].sort();
  const metricKeys: Array<keyof LayoutMetrics> = ['nodes', 'nodeOverlapRatio', 'nodesOutsideSlot', 'nodesPinnedToWall', 'edgeLenMean', 'edgeLenCv', 'edgeCrossingsPerEdge', 'labelOverlapRatio', 'bboxAspect', 'inkRatio', 'nodePxMedian', 'labelPxMedian', 'smallBoxShare'];
  const head = ['repo', 'engine', 'sample', 'baseline', 'score', 'settleMs', 'settled', ...params, ...metricKeys];
  const rows = samples.map(s => [s.repo, s.engine, s.index, s.baseline, s.score, s.settleMs ?? '', s.settled, ...params.map(p => s.values[p] ?? ''), ...metricKeys.map(k => s.metrics[k] ?? '')].join(','));
  return [head.join(','), ...rows].join('\n') + '\n';
}
