// Run report: every run.json of a run → one static index.html (+ findings.json
// for a reviewing Claude session). Pure string building on plain data, so it is
// unit-testable; the only I/O is in loadRuns() / writeRunReport().
import * as fs from 'fs';
import * as path from 'path';
import type { RunRecord } from '../lib/lab';
import type { StepRecord } from '../lib/step';
import type { LayoutMetrics } from '../metrics/types';
import { SEVERITY_RANK, type Finding } from '../metrics/score';
import { esc, page, plain } from './html';

/** Newest run folder under uxtest/artifacts, or null on a clean checkout. */
export function newestRun(artifacts: string): string | null {
  if (!fs.existsSync(artifacts)) { return null; }
  const dirs = fs.readdirSync(artifacts).filter(d => fs.statSync(path.join(artifacts, d)).isDirectory());
  return dirs.sort((a, b) => fs.statSync(path.join(artifacts, a)).mtimeMs - fs.statSync(path.join(artifacts, b)).mtimeMs).pop() ?? null;
}

export interface LoadedRun { dir: string; rel: string; run: RunRecord }

const KEY_METRICS: Array<[keyof LayoutMetrics, string, boolean]> = [ // key, label, lowerIsBetter
  ['nodes', 'nodes', false], ['nodeOverlapPairs', 'overlap pairs', true], ['nodesOutsideSlot', 'outside slot', true],
  ['nodesPinnedToWall', 'pinned', true], ['frameOverlapPairs', 'frame overlaps', true], ['edgeCrossingsPerEdge', 'cross/edge', true],
  ['labelOverlapRatio', 'label overlap', true], ['offscreenNodeRatio', 'off-screen', true], ['domNodes', 'DOM', true],
];

export function loadRuns(runDir: string): LoadedRun[] {
  const out: LoadedRun[] = [];
  if (!fs.existsSync(runDir)) { return out; }
  for (const repo of fs.readdirSync(runDir).sort()) {
    const repoDir = path.join(runDir, repo);
    if (!fs.statSync(repoDir).isDirectory()) { continue; }
    for (const sc of fs.readdirSync(repoDir).sort()) {
      const f = path.join(repoDir, sc, 'run.json');
      if (!fs.existsSync(f)) { continue; }
      out.push({ dir: path.join(repoDir, sc), rel: `${repo}/${sc}`, run: JSON.parse(fs.readFileSync(f, 'utf8')) as RunRecord });
    }
  }
  return out;
}

export interface FlatFinding extends Finding { repo: string; scenario: string; engine: string; motion: string; step: number; stepName: string; videoAtMs: number; run: string; screenshot: string | null }

export function flattenFindings(runs: LoadedRun[]): FlatFinding[] {
  const out: FlatFinding[] = [];
  for (const { rel, run } of runs) {
    for (const s of run.steps) {
      for (const f of s.findings ?? []) {
        out.push({ ...f, repo: run.repo, scenario: run.scenario, engine: run.engine, motion: run.motion, step: s.index, stepName: s.name,
          videoAtMs: s.videoAtMs, run: rel, screenshot: s.screenshot ? `${rel}/${s.screenshot}` : null });
      }
    }
  }
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.rule.localeCompare(b.rule));
}

/** 'worker×4' | 'sync' | 'sync (fell back!)' — which simulation transport the recording really used. */
export function transportLabel(run: RunRecord): string {
  const t = run.simTransport;
  if (!t) { return 'sync (not recorded)'; }
  if (t.kind === 'worker') { return `worker×${t.poolSize}`; }
  return t.fallbacks && t.fallbacks.length ? 'sync (workers fell back!)' : t.requested === 'off' ? 'sync (workers off)' : 'sync';
}

function anchor(rel: string): string { return 'r-' + rel.replace(/[^a-zA-Z0-9]+/g, '-'); }
function clock(ms: number): string { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

export function findingsSummaryHtml(findings: FlatFinding[]): string {
  const byRule = new Map<string, FlatFinding[]>();
  for (const f of findings) { const g = byRule.get(f.rule); if (g) { g.push(f); } else { byRule.set(f.rule, [f]); } }
  if (!byRule.size) { return '<p class="ok">No findings.</p>'; }
  const rows = [...byRule.entries()].map(([rule, fs2]) => {
    const first = fs2[0];
    const repos = [...new Set(fs2.map(f => f.repo))].join(', ');
    return `<tr><td><span class="pill ${first.severity}">${first.severity}</span></td><td><code>${esc(rule)}</code></td><td>${esc(first.ref ?? '')}</td>
<td class="num">${fs2.length}</td><td>${esc(repos)}</td><td>${esc(first.message)} <a href="#${anchor(first.run)}">first seen: ${esc(first.run)} step ${first.step}</a></td></tr>`;
  }).join('');
  return `<div class="wrap"><table><tr><th>severity</th><th>rule</th><th>ref</th><th>steps</th><th>repos</th><th>example</th></tr>${rows}</table></div>`;
}

export function matrixHtml(runs: LoadedRun[]): string {
  const repos = [...new Set(runs.map(r => r.run.repo))];
  const cols = [...new Set(runs.map(r => `${r.run.scenario} ${r.run.engine}/${r.run.motion}`))].sort();
  const cell = (repo: string, col: string): string => {
    const hit = runs.find(r => r.run.repo === repo && `${r.run.scenario} ${r.run.engine}/${r.run.motion}` === col);
    if (!hit) { return '<td class="dim">·</td>'; }
    const failed = hit.run.steps.filter(s => s.status === 'failed').length, skipped = hit.run.steps.filter(s => s.status === 'skipped').length;
    const high = hit.run.steps.reduce((n, s) => n + (s.findings ?? []).filter(f => f.severity === 'high').length, 0);
    const cls = failed ? 'failed' : high ? 'high' : skipped ? 'skipped' : 'ok';
    return `<td><a class="${cls}" href="#${anchor(hit.rel)}">${failed ? `${failed} failed` : `${hit.run.steps.length - skipped} ok`}${skipped ? ` · ${skipped} skip` : ''}${high ? ` · ${high} high` : ''}</a></td>`;
  };
  return `<div class="wrap"><table><tr><th>repo</th>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>
${repos.map(r => `<tr><td><b>${esc(r)}</b></td>${cols.map(c => cell(r, c)).join('')}</tr>`).join('')}</table></div>`;
}

function delta(cur: number | null | undefined, base: number | null | undefined, lowerIsBetter: boolean): string {
  if (typeof cur !== 'number' || typeof base !== 'number' || cur === base) { return ''; }
  const better = lowerIsBetter ? cur < base : cur > base;
  const d = +(cur - base).toFixed(3);
  return ` <span class="${better ? 'ok' : 'failed'}">(${d > 0 ? '+' : ''}${d})</span>`;
}

function stepRow(rel: string, s: StepRecord, base: StepRecord | undefined): string {
  const m = s.metrics, bm = base?.metrics;
  const metricCells = KEY_METRICS.map(([k, , lower]) => `<td class="num">${m ? esc(m[k]) : ''}${m && bm ? delta(m[k] as number, bm[k] as number, lower) : ''}</td>`).join('');
  const pills = (s.findings ?? []).map(f => `<span class="pill ${f.severity}" title="${esc(f.message)}">${esc(f.rule)}</span>`).join('');
  const note = s.note ? `<div class="dim">${esc(plain(s.note).split('\n')[0].slice(0, 160))}</div>` : '';
  return `<tr data-t="${(s.videoAtMs / 1000).toFixed(2)}"><td class="num">${s.index}</td><td><span class="${s.status}">●</span> ${esc(s.name)}${note}${pills ? `<div>${pills}</div>` : ''}</td>
<td class="num">${clock(s.videoAtMs)}</td><td class="num">${s.still ? `${s.still.ms}${s.still.settled ? '' : '+'}` : ''}${delta(s.still?.ms, base?.still?.ms, true)}</td>
<td class="num">${s.fps ? `${s.fps.avgMs} / ${s.fps.longFrames}` : ''}</td>${metricCells}
<td>${s.screenshot ? `<a href="${esc(`${rel}/${s.screenshot}`)}">png</a>` : ''}${s.snapshot ? ` <a href="${esc(`${rel}/${s.snapshot}`)}">json</a>` : ''}</td></tr>`;
}

export function runSectionHtml(r: LoadedRun, base: LoadedRun | undefined): string {
  const { rel, run } = r;
  const baseStep = (s: StepRecord): StepRecord | undefined => base?.run.steps.find(b => b.index === s.index && b.name === s.name);
  const frames = run.steps.filter(s => s.screenshot).map(s =>
    `<a href="${esc(`${rel}/${s.screenshot}`)}"><img loading="lazy" src="${esc(`${rel}/${s.screenshot}`)}" alt="step ${s.index}"><span>${s.index}. ${esc(s.name)}</span></a>`).join('');
  const errors = run.consoleErrors.length
    ? `<details><summary class="failed">${run.consoleErrors.length} console / page error(s)</summary><pre>${esc(run.consoleErrors.slice(0, 8).map(plain).join('\n'))}${run.consoleErrors.length > 8 ? '\n…' : ''}</pre></details>` : '';
  const perf = run.perfReport ? `<details><summary>perfReport()</summary><pre>${esc(JSON.stringify(run.perfReport, null, 1))}</pre></details>` : '';
  const posted = [...new Set(run.hostLog.map(l => l.message.type))].join(', ');
  const poster = run.steps.find(st => st.screenshot)?.screenshot ?? null;
  return `<section class="card" id="${anchor(rel)}"><h3>${esc(run.repo)} · ${esc(run.scenario)} · ${esc(run.engine)}/${esc(run.motion)}
<span class="dim">— ${run.functions} fns (${esc(run.sizeClass)}), host ${esc(run.hostMode)}, sims ${esc(transportLabel(run))}, ${(run.durationMs / 1000).toFixed(0)} s${base ? ', deltas vs baseline' : ''}</span></h3>
<div class="run"><div>${run.video ? `<video controls preload="none"${poster ? ` poster="${esc(`${rel}/${poster}`)}"` : ''} src="${esc(`${rel}/${run.video}`)}"></video>` : '<p class="dim">no video</p>'}
<p class="dim">Click a step row to seek the video. Webview → host messages: ${esc(posted || 'none')}. <a href="${esc(`${rel}/run.json`)}">run.json</a></p>${errors}${perf}</div>
<div class="steps wrap"><table><tr><th>#</th><th>step</th><th>at</th><th>still ms</th><th>frame ms / long</th>${KEY_METRICS.map(([, l]) => `<th>${esc(l)}</th>`).join('')}<th></th></tr>
${run.steps.map(s => stepRow(rel, s, baseStep(s))).join('')}</table></div></div><div class="frames">${frames}</div></section>`;
}

const SEEK_SCRIPT = `document.querySelectorAll('section.card').forEach(function (sec) { var v = sec.querySelector('video'); if (!v) { return; }
sec.querySelectorAll('tr[data-t]').forEach(function (tr) { tr.addEventListener('click', function (e) { if (e.target.closest('a')) { return; }
v.currentTime = parseFloat(tr.getAttribute('data-t')); v.play(); }); }); });`;

export function reportHtml(runId: string, runs: LoadedRun[], baseline: LoadedRun[] = [], extraLinks: string[] = []): string {
  const findings = flattenFindings(runs);
  const steps = runs.reduce((n, r) => n + r.run.steps.length, 0);
  const failed = runs.reduce((n, r) => n + r.run.steps.filter(s => s.status === 'failed').length, 0);
  const baseOf = (r: LoadedRun): LoadedRun | undefined => baseline.find(b => b.rel === r.rel);
  const links = extraLinks.map(l => `<a href="${esc(l)}">${esc(l)}</a>`).join(' · ');
  const body = `<h1>CoGraph UX test run <code>${esc(runId)}</code></h1>
<p class="dim">${runs.length} recordings · ${steps} steps · <span class="${failed ? 'failed' : 'ok'}">${failed} failed</span> · ${findings.length} findings
(${findings.filter(f => f.severity === 'high').length} high). Reviewer guide: <a href="../../report/rubric.md">rubric.md</a>, <a href="../../report/review-prompt.md">review-prompt.md</a>.
${links ? `Sweep: ${links}.` : ''} Machine-readable: <a href="findings.json">findings.json</a>.</p>
<h2>Findings</h2>${findingsSummaryHtml(findings)}<h2>Matrix</h2>${matrixHtml(runs)}<h2>Recordings</h2>${runs.map(r => runSectionHtml(r, baseOf(r))).join('')}`;
  return page(`CoGraph uxtest ${runId}`, body, SEEK_SCRIPT);
}

/** Writes index.html + findings.json into the run dir; returns the files written. */
export function writeRunReport(runDir: string, baselineDir?: string, extraLinks: string[] = []): string[] {
  const runs = loadRuns(runDir).filter(r => !/^sweep-\d+/.test(r.run.scenario));
  if (!runs.length && !extraLinks.length) { return []; }
  const baseline = baselineDir ? loadRuns(baselineDir) : [];
  const index = path.join(runDir, 'index.html'), fjson = path.join(runDir, 'findings.json');
  fs.writeFileSync(index, reportHtml(path.basename(runDir), runs, baseline, extraLinks));
  fs.writeFileSync(fjson, JSON.stringify(flattenFindings(runs), null, 2));
  return [index, fjson];
}
