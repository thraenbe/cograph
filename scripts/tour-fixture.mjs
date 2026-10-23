#!/usr/bin/env node
// tour-fixture.mjs — record a TourTrees fixture (docs/tour-protocol.md section 8) without VS Code.
//
// Usage: npm run compile && node scripts/tour-fixture.mjs <pr-number|branch> <outDir>
//
// Runs the extension's own engine (compiled to out/) on the repository in the
// current directory: materialise head and base, analyse both with the analyzer
// scripts, diff, list commits and changed paths. Writes <outDir>/<name>.json and
// copies the two source trees to <outDir>/<name>/head and <outDir>/<name>/base.
// Every absolute path into a copy is rewritten to fixtures/trees/<name>/head|base,
// and repoRoot to fixtures/trees/<name>, so a fixture names nothing of this machine.
//
// A merged pull request is diffed against the base as it was when it merged (the
// merge commit's first parent), as GitHub shows it; the live merge base of a merged
// head is the head itself.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'out');
if (!fs.existsSync(path.join(out, 'vcs', 'tourTrees.js'))) {
  console.error('tour-fixture: out/ is missing; run "npm run compile" first.');
  process.exit(2);
}
const { prepareTourTrees, materializeHeadWithGit, materializeBaseWithGit } = require(path.join(out, 'vcs', 'tourTrees.js'));
const { defaultExec, GhCliSource } = require(path.join(out, 'vcs', 'ghCliSource.js'));
const { spawnAnalyzers } = require(path.join(out, 'analyzerSpawn.js'));
const { HeadTreeError, branchRefs, dropTreeRefs, fetchBranch, githubRemote, listTrees, materializeCommit, mergeBase } = require(path.join(out, 'vcs', 'engine', 'headTree.js'));

const [targetArg, outDirArg] = process.argv.slice(2);
if (!targetArg || !outDirArg) {
  console.error('Usage: node scripts/tour-fixture.mjs <pr-number|branch> <outDir>');
  process.exit(2);
}
const outDir = path.resolve(outDirArg);
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const isPr = /^\d+$/.test(targetArg);
const name = isPr ? `pr-${targetArg}` : `branch-${targetArg.replace(/[^\w.-]+/g, '-')}`;
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-tour-fixture-'));
const log = (line) => console.error(line);
const refsBefore = new Map(execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/cograph/'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n').filter(Boolean).map(l => l.split(' ')));

function pythonBin() {
  for (const bin of ['python3', 'python']) {
    try { execFileSync(bin, ['--version'], { stdio: 'ignore' }); return bin; } catch { /* next */ }
  }
  return null;
}

const python = pythonBin();
async function analyzer(dir, signal) {
  const { graph, statuses } = await spawnAnalyzers(dir, { scriptsDir: path.join(here), pythonBin: python, log, signal });
  const failed = statuses.filter(s => s.status !== 'ok' && s.status !== 'empty');
  for (const s of failed) { log(`[fixture] analyzer ${s.lang} ${s.status}${s.detail ? `: ${s.detail}` : ''}`); }
  if (graph.nodes.length === 0 && failed.length) { throw new Error(`Analysis failed in ${dir}`); }
  return graph;
}

/** For a merged pull request: the base as it was at the merge, not the live merge base. */
function mergedBase(pr) {
  if (!isPr) { return materializeBaseWithGit; }
  const view = JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--json', 'state,mergeCommit'], { cwd: repoRoot, encoding: 'utf8' }));
  if (view.state !== 'MERGED' || !view.mergeCommit?.oid) { return materializeBaseWithGit; }
  return async ({ repoRoot: root, storageDir: storage, baseRef, headSha, exec, log: say, report, signal }) => {
    const deps = { repoRoot: root, storageDir: storage, exec, log: say, signal };
    report('fetching its base…');
    const tip = await fetchBranch(deps, baseRef, await githubRemote(deps));
    const parent = execFileSync('git', ['rev-parse', `${view.mergeCommit.oid}^1`], { cwd: root, encoding: 'utf8' }).trim();
    const sha = await mergeBase(deps, headSha, parent);
    say(`[fixture] #${pr} merged in ${view.mergeCommit.oid.slice(0, 7)}: base ${sha.slice(0, 7)} (merge base with its first parent)`);
    const copied = await materializeCommit(deps, sha, branchRefs(baseRef, tip));
    return { sha, dir: copied.dir };
  };
}

/** Copy a tree's source files (not the marker, lock or analysis cache). */
function copyTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => !['.cograph', '.cograph-tree.json', '.cograph-tree.lock'].includes(path.basename(src)) || path.dirname(src) !== from,
  });
}

/** Rewrite every string that starts with one of the absolute prefixes. */
function rewrite(value, pairs) {
  if (typeof value === 'string') {
    for (const [abs, rel] of pairs) {
      if (value === abs) { return rel; }
      if (value.startsWith(abs + path.sep) || value.startsWith(abs + '/')) { return rel + value.slice(abs.length).split(path.sep).join('/'); }
    }
    return value;
  }
  if (Array.isArray(value)) { return value.map(v => rewrite(v, pairs)); }
  if (value && typeof value === 'object') { return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, pairs)])); }
  return value;
}

async function main() {
  const target = isPr ? { kind: 'pr', number: Number(targetArg) } : { kind: 'branch', branch: targetArg };
  if (!isPr) {
    const current = execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    if (current !== targetArg) { throw new Error(`Check out ${targetArg} first (the branch tour runs on HEAD; HEAD is ${current || 'detached'}).`); }
  }
  const common = { repoRoot, storageDir, exec: defaultExec, log, report: (m) => log(`[fixture] ${m}`), signal: new AbortController().signal };
  const deps = {
    workspaceRoot: repoRoot, analyzer, source: new GhCliSource(),
    materializeHead: materializeHeadWithGit, materializeBase: mergedBase(targetArg),
  };
  const trees = await prepareTourTrees(target, common, deps);
  const rel = `fixtures/trees/${name}`;
  fs.mkdirSync(path.join(outDir, name), { recursive: true });
  copyTree(trees.head.dir, path.join(outDir, name, 'head'));
  if (trees.base) { copyTree(trees.base.dir, path.join(outDir, name, 'base')); }
  const pairs = [[trees.head.dir, `${rel}/head`], ...(trees.base ? [[trees.base.dir, `${rel}/base`]] : []), [repoRoot, rel]];
  const json = rewrite(trees, pairs);
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(json, null, 2) + '\n');
  const d = trees.diff?.summary;
  console.log(`${name}: head ${trees.head.sha.slice(0, 7)} base ${trees.base?.sha.slice(0, 7) ?? 'none'} · ${trees.commits.length} commits · ${trees.changedPaths.length} paths`
    + (d ? ` · +${d.added} ~${d.changed} -${d.removed} functions, +${d.edgesAdded} -${d.edgesRemoved} edges` : ' · no diff'));
}

main()
  .catch((err) => {
    console.error(`tour-fixture: ${err instanceof HeadTreeError ? `${err.message}${err.detail ? ` (${err.detail})` : ''}` : err.stack || err}`);
    process.exitCode = 1;
  })
  // The fetches moved or made refs/cograph/* refs: each one is put back as it was before the run
  // (the extension's own trees may be kept alive by them), the new ones go with the copies.
  .finally(async () => {
    for (const t of listTrees(storageDir)) {
      for (const ref of t.marker.refs ?? []) {
        const old = refsBefore.get(ref.name);
        if (old) { execFileSync('git', ['update-ref', ref.name, old], { cwd: repoRoot }); }
      }
      await dropTreeRefs({ ...t.marker, refs: (t.marker.refs ?? []).filter(r => !refsBefore.has(r.name)) }, defaultExec, log);
    }
    fs.rmSync(storageDir, { recursive: true, force: true });
  });
