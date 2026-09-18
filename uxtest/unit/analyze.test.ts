import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyzeRepo, CACHE_DIR } from '../lib/analyze';

test('analyzeRepo runs the real analyzers on a tiny repo and caches the result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-repo-'));
  fs.mkdirSync(path.join(root, 'pkg'));
  fs.writeFileSync(path.join(root, 'pkg', 'a.py'), 'def helper():\n    return 1\n\ndef main():\n    return helper()\n');
  fs.writeFileSync(path.join(root, 'b.js'), 'function twice(x) { return x * 2; }\nfunction run() { return twice(2); }\nmodule.exports = { run };\n');
  const name = path.basename(root);
  const cacheFile = path.join(CACHE_DIR, `${name}-nogit.json`);
  try {
    const first = await analyzeRepo(name, root, 60000);
    expect(first.functions).toBeGreaterThanOrEqual(4);
    expect(first.structure.totalFiles).toBe(2);
    expect(first.analyzers.python).toMatchObject({ nodes: expect.any(Number) });
    expect(first.graph.nodes.some(n => String(n.id).includes('helper'))).toBe(true);
    expect(fs.existsSync(cacheFile)).toBe(true);

    fs.writeFileSync(cacheFile, JSON.stringify({ ...first, functions: -1 }));
    expect((await analyzeRepo(name, root, 60000)).functions).toBe(-1);          // served from cache
    expect((await analyzeRepo(name, root, 60000, true)).functions).toBe(first.functions); // forced re-analysis
  } finally {
    fs.rmSync(cacheFile, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('analyzer failures are reported per language, not thrown', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-repo-'));
  fs.writeFileSync(path.join(root, 'a.py'), 'def f():\n    return 1\n');
  const name = path.basename(root);
  try {
    const res = await analyzeRepo(name, root, 1, true); // 1 ms timeout kills every analyzer
    expect(Object.values(res.analyzers).some(a => 'error' in a)).toBe(true);
    expect(res.functions).toBeGreaterThanOrEqual(0);
  } finally {
    fs.rmSync(path.join(CACHE_DIR, `${name}-nogit.json`), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
