import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { walkProjectFiles, readGitTracked, isArtefactDir, isAlwaysSkippedDir } from '../../projectScope';
import { scanStructure } from '../../structureScanner';

// F30: the structure scanner and every analyzer must agree on which files make up the project.
// Fixture covers each branch of the rule: plain source, a TRACKED build/ script (kept with git),
// an UNTRACKED setuptools-style build/lib copy (always dropped), a tracked committed bundle in
// dist/ (always dropped), CMake and Maven output, __pycache__ and a dot-dir.

const SCRIPTS = path.resolve(__dirname, '../../../scripts');
const SOURCE: Record<string, string> = {
  'src/app.ts': 'export function app() { return helper(); }\nfunction helper() { return 1; }\n',
  'src/util.js': 'function util() { return 1; }\nmodule.exports = { util };\n',
  'pkg/core.py': 'def core():\n    return 1\n',
  'java/Main.java': 'class Main { void run() {} }\n',
  'native/lib.cpp': 'int add(int a, int b) { return a + b; }\n',
  'native/Legacy.CPP': 'int legacy() { return 1; }\n',
};
const TRACKED_BUILD = { 'build/gen.ts': 'export function gen() { return 1; }\n' };
const NEVER: Record<string, string> = {
  'build/lib/pkg/core.py': 'def core():\n    return 1\n',            // pip wheel / setuptools copy (untracked)
  'dist/bundle.js': 'function bundled() { return 1; }\n',            // committed bundle (tracked below)
  'cmake-build-debug/gen.cpp': 'int gen() { return 1; }\n',
  'CMakeFiles/probe.cpp': 'int probe() { return 1; }\n',
  'target/generated/Gen.java': 'class Gen { void g() {} }\n',
  'pkg/__pycache__/stale.py': 'def stale():\n    return 1\n',
  '.cache/hidden.ts': 'export function hidden() { return 1; }\n',
  'node_modules/dep/index.js': 'function dep() { return 1; }\n',
};

function write(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
}

const abs = (root: string, rels: string[]) => new Set(rels.map(r => path.resolve(root, r)));
const scannerFiles = (root: string) => new Set(scanStructure(root).files.map(f => path.resolve(f.path)));

function hasGit(): boolean {
  try { cp.execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
function hasPython(): boolean {
  try { cp.execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** Union of graph.files over every analyzer, run standalone or with a --files list. */
function analyzerFiles(root: string, listPath?: string): Set<string> {
  const runs: Array<[string, string]> = [
    [process.execPath, 'analyze_ts.js'], [process.execPath, 'analyze_js.js'],
    [process.execPath, 'analyze_java.js'], [process.execPath, 'analyze_cpp.js'],
  ];
  if (hasPython()) { runs.push(['python3', 'analyze.py']); }
  const out = new Set<string>();
  for (const [bin, script] of runs) {
    const args = [path.join(SCRIPTS, script), root, ...(listPath ? ['--files', listPath] : [])];
    const res = cp.spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(res.status, 0, `${script} failed: ${res.stderr}`);
    for (const f of JSON.parse(res.stdout).files ?? []) { out.add(path.resolve(f)); }
  }
  return out;
}

function withoutPython(set: Set<string>): Set<string> {
  return hasPython() ? set : new Set([...set].filter(f => !f.endsWith('.py')));
}

suite('projectScope: one rule for scanner and analyzers (F30)', function () {
  this.timeout(60_000);
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-scope-'));
    write(root, { ...SOURCE, ...TRACKED_BUILD, ...NEVER });
  });
  teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('name rules: artefact dirs vs always-skipped dirs', () => {
    for (const n of ['build', 'target', 'CMakeFiles', '__pycache__', 'cmake-build-release']) { assert.ok(isArtefactDir(n), n); }
    for (const n of ['node_modules', 'out', 'dist', '.git', '.venv']) { assert.ok(isAlwaysSkippedDir(n), n); }
    for (const n of ['src', 'builder', 'targets', 'distribution']) {
      assert.ok(!isArtefactDir(n) && !isAlwaysSkippedDir(n), n);
    }
  });

  test('no git: every artefact dir is skipped', () => {
    const seen: string[] = [];
    walkProjectFiles(root, f => { seen.push(path.resolve(f)); }, () => null);
    assert.deepStrictEqual(new Set(seen), abs(root, Object.keys(SOURCE)));
  });

  test('git: only tracked files inside artefact dirs count', () => {
    const tracked = [...Object.keys(SOURCE), ...Object.keys(TRACKED_BUILD), 'dist/bundle.js'];
    const seen: string[] = [];
    walkProjectFiles(root, f => { seen.push(path.resolve(f)); }, () => tracked);
    assert.deepStrictEqual(new Set(seen), abs(root, [...Object.keys(SOURCE), ...Object.keys(TRACKED_BUILD)]));
  });

  test('git is asked lazily: never for a project without artefact dirs', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-plain-'));
    try {
      write(plain, SOURCE);
      let asked = 0;
      walkProjectFiles(plain, () => undefined, () => { asked++; return []; });
      assert.strictEqual(asked, 0);
    } finally { fs.rmSync(plain, { recursive: true, force: true }); }
  });

  test('readGitTracked: every ancestor dir of a tracked file is marked', () => {
    const g = readGitTracked(root, () => ['build/deep/x.ts'])!;
    assert.ok(g.dirs.has(path.resolve(root, 'build')) && g.dirs.has(path.resolve(root, 'build/deep')));
    assert.ok(g.files.has(path.resolve(root, 'build/deep/x.ts')));
  });

  test('agreement, plain folder (no git): scanner = analyzers on their own = analyzers with the scanner list', () => {
    const expected = abs(root, Object.keys(SOURCE));
    assert.deepStrictEqual(scannerFiles(root), expected, 'scanner');
    assert.deepStrictEqual(analyzerFiles(root), withoutPython(expected), 'standalone analyzer walks');
    const list = path.join(os.tmpdir(), `cograph-scope-list-${process.pid}.txt`);
    try {
      fs.writeFileSync(list, [...scannerFiles(root)].join('\n'));
      assert.deepStrictEqual(analyzerFiles(root, list), withoutPython(expected), 'analyzers given the scanner list');
    } finally { fs.rmSync(list, { force: true }); }
  });

  test('agreement, git repository: tracked build/ script kept, untracked build/lib copy and tracked dist/ bundle dropped', function () {
    if (!hasGit()) { this.skip(); }
    cp.execFileSync('git', ['init', '-q'], { cwd: root });
    cp.execFileSync('git', ['add', ...Object.keys(SOURCE), ...Object.keys(TRACKED_BUILD), 'dist/bundle.js'], { cwd: root });
    const expected = abs(root, [...Object.keys(SOURCE), ...Object.keys(TRACKED_BUILD)]);
    assert.deepStrictEqual(scannerFiles(root), expected, 'scanner');
    const list = path.join(os.tmpdir(), `cograph-scope-list-git-${process.pid}.txt`);
    try {
      fs.writeFileSync(list, [...scannerFiles(root)].join('\n'));
      assert.deepStrictEqual(analyzerFiles(root, list), withoutPython(expected), 'analyzers given the scanner list');
    } finally { fs.rmSync(list, { force: true }); }
  });
});
