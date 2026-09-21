import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { esc, page, plain } from '../report/html';
import { flattenFindings, loadRuns, reportHtml, writeRunReport } from '../report/build';
import { contactSheetHtml, findSamples, writeSweepReport } from '../report/sweepReport';
import { groupSamples, type SweepSample } from '../sweep/analyze';
import { newestRun } from '../report/report.spec';
import { computeMetrics } from '../metrics/compute';
import type { RunRecord } from '../lib/lab';
import { snapshot } from './fixtures';

const metrics = computeMetrics(snapshot());
function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    repo: 'click', functions: 1773, sizeClass: 'small', scenario: 'smoke', engine: 'shelf', motion: 'static', hostMode: 'eager',
    startedAt: '2026-09-21T00:00:00.000Z', durationMs: 42000, video: 'video.webm', perfReport: { nodes: 1 }, blockedRequests: [],
    consoleErrors: ['console.error: <line> attribute x1: Expected length, "NaN".'],
    hostLog: [{ atMs: 5, message: { type: 'dirty-state' } }],
    steps: [
      { index: 1, name: 'Overview <C1>', status: 'ok', videoAtMs: 1500, durationMs: 900, still: { settled: true, ms: 480, frames: 41, movingFrames: 0, peakPx: 0 },
        fps: { frames: 60, avgMs: 16.7, p95Ms: 18, maxMs: 40, longFrames: 0, minFps: 25 }, metrics: { ...metrics, nodeOverlapPairs: 503 },
        screenshot: 'steps/01-overview.png', snapshot: 'steps/01-overview.snapshot.json', consoleErrors: [],
        findings: [{ rule: 'static-grid-overlap', severity: 'high', ref: 'B1/R2', message: '503 overlapping node pair(s)' }] },
      { index: 2, name: 'Optional thing', status: 'skipped', note: 'selector absent: hoverCard', videoAtMs: 65000, durationMs: 10, still: null, fps: null,
        metrics: null, screenshot: null, snapshot: null, consoleErrors: [], findings: [{ rule: 'label-clutter', severity: 'low', message: 'x' }] },
    ],
    ...over,
  };
}

function writeRun(root: string, rel: string, r: RunRecord): void {
  fs.mkdirSync(path.join(root, rel), { recursive: true });
  fs.writeFileSync(path.join(root, rel, 'run.json'), JSON.stringify(r));
}

test('html helpers escape and strip ANSI', () => {
  expect(esc('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  expect(esc(null)).toBe('');
  expect(plain(String.fromCharCode(27) + '[31mred' + String.fromCharCode(27) + '[39m')).toBe('red');
  expect(page('T<', '<p>b</p>', 'var a=1;')).toContain('<title>T&lt;</title>');
  expect(page('T', 'b')).not.toContain('<script>');
});

test('run report: findings, matrix, seekable steps, baseline deltas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-rep-'));
  const runDir = path.join(root, 'run-b'), baseDir = path.join(root, 'run-a');
  writeRun(runDir, 'click/smoke-shelf-static', run());
  writeRun(runDir, 'click/sweep-01-shelf-dynamic', run({ scenario: 'sweep-01' }));
  writeRun(baseDir, 'click/smoke-shelf-static', run({ steps: [{ ...run().steps[0], metrics: { ...metrics, nodeOverlapPairs: 0 }, still: { settled: true, ms: 900, frames: 1, movingFrames: 0, peakPx: 0 } }] }));
  fs.mkdirSync(path.join(runDir, 'not-a-run'));
  fs.writeFileSync(path.join(runDir, 'stray.txt'), 'x');

  const runs = loadRuns(runDir);
  expect(runs.map(r => r.rel)).toEqual(['click/smoke-shelf-static', 'click/sweep-01-shelf-dynamic']);
  expect(loadRuns(path.join(root, 'missing'))).toEqual([]);
  const flat = flattenFindings(runs.slice(0, 1));
  expect(flat.map(f => f.rule)).toEqual(['static-grid-overlap', 'label-clutter']);
  expect(flat[0]).toMatchObject({ repo: 'click', step: 1, videoAtMs: 1500, screenshot: 'click/smoke-shelf-static/steps/01-overview.png' });

  const files = writeRunReport(runDir, baseDir, ['contact-sheet.html']);
  expect(files.map(f => path.basename(f))).toEqual(['index.html', 'findings.json']);
  const html = fs.readFileSync(files[0], 'utf8');
  expect(html).toContain('Overview &lt;C1&gt;');
  expect(html).toContain('data-t="1.50"');
  expect(html).toContain('1:05');
  expect(html).toContain('poster="click/smoke-shelf-static/steps/01-overview.png"');
  expect(html).toContain('static-grid-overlap');
  expect(html).toContain('(+503)');                 // worse than the baseline run
  expect(html).toContain('(-420)');                 // settles faster than the baseline run
  expect(html).toContain('1 console / page error(s)');
  expect(html).toContain('contact-sheet.html');
  expect(html).not.toContain('sweep-01');           // sweep samples live on the contact sheet
  expect(JSON.parse(fs.readFileSync(files[1], 'utf8'))).toHaveLength(2);
  expect(reportHtml('empty', [])).toContain('No findings.');
  expect(writeRunReport(path.join(root, 'missing'))).toEqual([]);
  expect(newestRun(root)).toBeTruthy();
  expect(newestRun(path.join(root, 'missing'))).toBeNull();
});

test('sweep report writes csv, json, contact sheet and recommendations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-sweep-'));
  const mk = (index: number, score: number, baseline = false): SweepSample => ({ repo: 'click', engine: 'shelf', index, baseline, values: { forceRepel: 100 * (index + 1) }, dropped: [],
    settleMs: 1000 + index, settled: index !== 2, metrics, score, screenshot: `click/sweep-0${index}-shelf-dynamic/steps/03-end.png` });
  [mk(0, 3, true), mk(1, 1), mk(2, 2)].forEach((s) => {
    const dir = path.join(root, 'click', `sweep-0${s.index}-shelf-dynamic`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sample.json'), JSON.stringify(s));
  });
  fs.writeFileSync(path.join(root, 'stray.txt'), 'x');
  expect(findSamples(root).map(s => s.index)).toEqual([0, 1, 2]);
  expect(findSamples(path.join(root, 'missing'))).toEqual([]);
  expect(writeSweepReport(path.join(root, 'click', 'sweep-00-shelf-dynamic'))).toEqual([]);
  const files = writeSweepReport(root).map(f => path.basename(f));
  expect(files).toEqual(['sweep.json', 'sweep.csv', 'contact-sheet.html', 'force-recommendations.md']);
  const sheet = contactSheetHtml(groupSamples(findSamples(root)));
  expect(sheet).toContain('class="best"');
  expect(sheet).toContain('class="base"');
  expect(sheet).toContain('(not settled)');
  expect(sheet).toContain('Repel=200');
  expect(JSON.parse(fs.readFileSync(path.join(root, 'sweep.json'), 'utf8')).groups[0]).toMatchObject({ best: 1, improvementPct: 66.7 });
});
