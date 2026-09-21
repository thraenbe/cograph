// Seeded samplers over the unit cube. Values are mapped onto the real slider
// ranges at run time (the DOM knows min/max/step), so the sampler never has to
// know what the ux session did to the panel.
import { mulberry32 } from '../metrics/compute';

export interface Sample { index: number; unit: Record<string, number> | null } // null = product defaults (baseline)

/** Latin hypercube: each parameter's n strata are each hit exactly once. */
export function latinHypercube(params: string[], n: number, seed: number): Array<Record<string, number>> {
  const rng = mulberry32(seed);
  const cols = params.map(() => {
    const strata = Array.from({ length: n }, (_, i) => (i + rng()) / n);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [strata[i], strata[j]] = [strata[j], strata[i]]; }
    return strata;
  });
  return Array.from({ length: n }, (_, row) => Object.fromEntries(params.map((p, c) => [p, +cols[c][row].toFixed(4)])));
}

/** Full factorial grid with `steps` points per parameter (use for <= 2 parameters). */
export function grid(params: string[], steps: number): Array<Record<string, number>> {
  let rows: Array<Record<string, number>> = [{}];
  for (const p of params) {
    const next: Array<Record<string, number>> = [];
    for (const r of rows) { for (let i = 0; i < steps; i++) { next.push({ ...r, [p]: steps === 1 ? 0.5 : +(i / (steps - 1)).toFixed(4) }); } }
    rows = next;
  }
  return rows;
}

/** Sample 0 is always the untouched defaults so every sweep carries its own baseline. */
export function buildSamples(params: string[], n: number, seed: number, mode: 'lhs' | 'grid' = 'lhs'): Sample[] {
  const units = mode === 'grid' ? grid(params, Math.max(2, Math.round(Math.pow(n, 1 / Math.max(1, params.length))))) : latinHypercube(params, n, seed);
  return [{ index: 0, unit: null }, ...units.map((unit, i) => ({ index: i + 1, unit }))];
}

/** Map a unit value onto [min, max], optionally narrowed and snapped to the slider step. */
export function toSliderValue(u: number, min: number, max: number, step: number, range?: [number, number]): number {
  const lo = range ? Math.max(min, range[0]) : min, hi = range ? Math.min(max, range[1]) : max;
  const raw = lo + u * (hi - lo);
  const snapped = step > 0 ? Math.round((raw - min) / step) * step + min : raw;
  return +Math.min(max, Math.max(min, snapped)).toFixed(6);
}

/** Sliders whose MAX position means "unlimited" (Repel range = ∞): the top `share` of the unit interval
 *  selects that position, the rest is stretched over the finite band. */
export function splitUnlimited(u: number, share: number): { unlimited: boolean; u: number } {
  if (share <= 0) { return { unlimited: false, u }; }
  if (u >= 1 - share) { return { unlimited: true, u: 1 }; }
  return { unlimited: false, u: +(u / (1 - share)).toFixed(4) };
}
