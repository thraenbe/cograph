import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const OUT = path.join(__dirname, '..', '..');

/** Every module `src/ci/index.ts` loads at run time; type-only imports are erased and do not count. */
function runtimeImports(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const walk = (file: string) => {
    if (seen.has(file)) { return; }
    const text = fs.readFileSync(file, 'utf8');
    const specs = [...text.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map(m => m[1]);
    seen.set(file, specs);
    for (const spec of specs.filter(s => s.startsWith('.'))) {
      const resolved = [`${spec}.ts`, `${spec}/index.ts`].map(s => path.resolve(path.dirname(file), s)).find(f => fs.existsSync(f));
      assert.ok(resolved, `${spec} from ${file}`);
      walk(resolved);
    }
  };
  walk(entry);
  return seen;
}

suite('src/ci needs no VS Code', () => {
  test('nothing it loads, at any depth, imports vscode', () => {
    const modules = runtimeImports(path.join(SRC, 'ci', 'index.ts'));
    assert.ok(modules.size > 15, `only ${modules.size} modules walked: the walk found nothing`);
    for (const [file, specs] of modules) { assert.ok(!specs.includes('vscode'), `${file} imports vscode`); }
  });

  test('the walk would see one: a real import of vscode shows up, a type import does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-walk-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), "import type { X } from 'vscode';\nimport { b } from './b';\n");
      fs.writeFileSync(path.join(dir, 'b.ts'), "import * as vscode from 'vscode';\n");
      const modules = runtimeImports(path.join(dir, 'a.ts'));
      assert.deepStrictEqual(modules.get(path.join(dir, 'a.ts')), ['./b']);
      assert.deepStrictEqual(modules.get(path.join(dir, 'b.ts')), ['vscode']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('it loads in plain Node, where no vscode module exists', () => {
    const load = `const ci = require(${JSON.stringify(path.join(OUT, 'ci', 'index.js'))}); console.log(Object.keys(ci).sort().join(' '));`;
    const res = cp.spawnSync(process.execPath, ['-e', load], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    assert.strictEqual(res.status, 0, res.stderr);
    for (const name of ['createHeadlessApi', 'ensureCommits', 'prepareCiTrees', 'probePython', 'stageData']) { assert.ok(res.stdout.includes(name), res.stdout); }
  });
});
