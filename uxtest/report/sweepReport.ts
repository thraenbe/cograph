// Sweep aggregation: sample.json files → sweep.json, sweep.csv, contact sheet, recommendation draft.
import * as fs from 'fs';
import * as path from 'path';
import { fitPx, groupSamples, recommendationsMarkdown, rescore, toCsv, verdictLine, type GroupResult, type SweepSample } from '../sweep/analyze';
import { esc, page } from './html';

export function findSamples(runDir: string): SweepSample[] {
  const out: SweepSample[] = [];
  if (!fs.existsSync(runDir)) { return out; }
  for (const repo of fs.readdirSync(runDir)) {
    const repoDir = path.join(runDir, repo);
    if (!fs.statSync(repoDir).isDirectory()) { continue; }
    for (const sc of fs.readdirSync(repoDir)) {
      const f = path.join(repoDir, sc, 'sample.json');
      if (fs.existsSync(f)) { out.push(JSON.parse(fs.readFileSync(f, 'utf8')) as SweepSample); }
    }
  }
  return out.sort((a, b) => (a.engine + a.repo).localeCompare(b.engine + b.repo) || a.index - b.index);
}

function figure(s: SweepSample, rank: number): string {
  const cls = s.baseline ? 'base' : rank === 0 ? 'best' : '';
  const values = Object.entries(s.values).map(([k, v]) => `${k.replace(/^force/, '')}=${v}`).join(' ');
  return `<figure class="${cls}">
<a href="${esc(s.screenshot)}"><img loading="lazy" src="${esc(s.screenshot)}" alt="sample ${s.index}"></a>
<figcaption><b>#${rank + 1}</b> · sample ${s.index}${s.baseline ? ' (defaults)' : ''} · score <b>${s.score}</b> · settle ${s.settleMs ?? '–'} ms${s.settled ? '' : ' (not settled)'}<br>
<span class="dim">overlap ${s.metrics.nodeOverlapRatio} · cross ${s.metrics.edgeCrossingsPerEdge} · labels ${s.metrics.labelOverlapRatio} · node ${fitPx(s)} px · pinned ${s.metrics.nodesPinnedToWall}</span><br>
<code>${esc(values)}</code></figcaption></figure>`;
}

export function contactSheetHtml(groups: GroupResult[]): string {
  const sections = groups.map(g =>
    `<h2>${esc(g.engine)} · ${esc(g.repo)} <span class="dim">— ${esc(verdictLine(g).split('**').join(''))}</span></h2>
<div class="grid">${g.ranked.map((s, i) => figure(s, i)).join('')}</div>`).join('');
  return page('CoGraph force sweep — contact sheet',
    `<h1>Force sweep — end states ranked by layout score</h1>
<p class="dim">Green outline = best sample, blue = shipped defaults. Lower score is better.
See <a href="force-recommendations.md">force-recommendations.md</a> and <a href="sweep.csv">sweep.csv</a>.</p>${sections}`);
}

/** Returns the files written (empty when the run holds no sweep samples). */
export function writeSweepReport(runDir: string): string[] {
  const samples = rescore(findSamples(runDir));
  if (!samples.length) { return []; }
  const groups = groupSamples(samples);
  const summary = groups.map(g => ({ repo: g.repo, engine: g.engine, best: g.best?.index ?? null, improvementPct: g.improvementPct, sensitivity: g.sensitivity }));
  const files: Array<[string, string]> = [
    ['sweep.json', JSON.stringify({ samples, groups: summary }, null, 2)],
    ['sweep.csv', toCsv(samples)],
    ['contact-sheet.html', contactSheetHtml(groups)],
    ['force-recommendations.md', recommendationsMarkdown(groups)],
  ];
  for (const [name, body] of files) { fs.writeFileSync(path.join(runDir, name), body); }
  return files.map(([name]) => path.join(runDir, name));
}
