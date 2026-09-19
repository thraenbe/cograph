#!/usr/bin/env node
// Terminal summary of a run: one line per run.json + every non-ok step.
//   node uxtest/report/summary.mjs [runId]   (default: newest run)
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const artifacts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');
const runs = existsSync(artifacts) ? readdirSync(artifacts).filter(d => statSync(path.join(artifacts, d)).isDirectory()) : [];
const runId = process.argv[2] ?? runs.sort((a, b) => statSync(path.join(artifacts, a)).mtimeMs - statSync(path.join(artifacts, b)).mtimeMs).pop();
if (!runId || !existsSync(path.join(artifacts, runId))) { process.stderr.write('no such run\n'); process.exit(2); }

const count = (xs) => Object.entries(xs.reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {})).map(([k, v]) => `${k}×${v}`).join(' ');
const out = [];
for (const repo of readdirSync(path.join(artifacts, runId)).sort()) {
  const repoDir = path.join(artifacts, runId, repo);
  if (!statSync(repoDir).isDirectory()) { continue; }
  for (const sc of readdirSync(repoDir).sort()) {
    const file = path.join(repoDir, sc, 'run.json');
    if (!existsSync(file)) { continue; }
    const r = JSON.parse(readFileSync(file, 'utf8'));
    out.push(`${r.repo.padEnd(14)} ${sc.padEnd(34)} ${count(r.steps.map(s => s.status)).padEnd(24)} errs ${String(r.consoleErrors.length).padEnd(5)} ${count(r.steps.flatMap(s => s.findings.map(f => f.rule)))}`);
    for (const s of r.steps) {
      if (s.status !== 'ok') { out.push(`      ${s.status.padEnd(8)} ${s.index}. ${s.name} | ${(s.note ?? '').slice(0, 110)}`); }
    }
  }
}
process.stdout.write(`run ${runId}\n${out.join('\n')}\n`);
