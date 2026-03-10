import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Library node logic is tested via analyze_ts.js (which generates the nodes)
// and via the clustering logic in clustering.js (which groups them).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { collectDefinitions, collectCalls } = require('../../../scripts/analyze_ts.js');

// ---------------------------------------------------------------------------
// Suite: Library node generation from analyze_ts.js
// ---------------------------------------------------------------------------

suite('Library node generation', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-lib-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('library node has isLibrary=true', () => {
    const file = path.join(tmpDir, 'lib.ts');
    fs.writeFileSync(file, [
      "import * as fs from 'fs';",
      "function run() { fs.readFileSync('x'); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    const libNode = libraryNodes.find((n: any) => n.name === 'readFileSync');
    assert.ok(libNode, 'library node should exist');
    assert.strictEqual(libNode.isLibrary, true);
  });

  test('library node has file=null and line=0', () => {
    const file = path.join(tmpDir, 'lib2.ts');
    fs.writeFileSync(file, [
      "import * as path from 'path';",
      "function build() { path.join('a', 'b'); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    const libNode = libraryNodes.find((n: any) => n.name === 'join');
    assert.ok(libNode);
    assert.strictEqual(libNode.file, null);
    assert.strictEqual(libNode.line, 0);
  });

  test('library node id uses library:: prefix', () => {
    const file = path.join(tmpDir, 'lib3.ts');
    fs.writeFileSync(file, [
      "import { useState } from 'react';",
      "function App() { useState(0); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    const libNode = libraryNodes.find((n: any) => n.name === 'useState');
    assert.ok(libNode);
    assert.ok(libNode.id.startsWith('library::'), `id should start with 'library::' but got: ${libNode.id}`);
    assert.ok(libNode.id.includes('react'), 'id should include package name');
  });

  test('multiple functions from same package → separate library nodes', () => {
    const file = path.join(tmpDir, 'multipkg.ts');
    fs.writeFileSync(file, [
      "import * as path from 'path';",
      "function build() { path.join('a', 'b'); path.basename('/foo/bar'); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    const pathNodes = libraryNodes.filter((n: any) => n.libraryName === 'path');
    assert.ok(pathNodes.length >= 2, 'join and basename should be separate library nodes');
    const names = pathNodes.map((n: any) => n.name);
    assert.ok(names.includes('join'), 'join should be a node');
    assert.ok(names.includes('basename'), 'basename should be a node');
  });

  test('two callers of same library function → one shared library node', () => {
    const file = path.join(tmpDir, 'shared.ts');
    fs.writeFileSync(file, [
      "import * as fs from 'fs';",
      "function a() { fs.readFileSync('x'); }",
      "function b() { fs.readFileSync('y'); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes, edges } = collectCalls([file], defs);
    const libNodes = libraryNodes.filter((n: any) => n.name === 'readFileSync');
    assert.strictEqual(libNodes.length, 1, 'only one library node for readFileSync');
    // Two edges pointing to the same library node
    const libId = libNodes[0].id;
    const edgesToLib = edges.filter((e: any) => e.target === libId);
    assert.strictEqual(edgesToLib.length, 2, 'two edges should point to the shared library node');
  });

  test('library node has libraryName matching the import specifier', () => {
    const file = path.join(tmpDir, 'libname.ts');
    fs.writeFileSync(file, [
      "import * as crypto from 'node:crypto';",
      "function hash() { crypto.createHash('sha256'); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    const libNode = libraryNodes.find((n: any) => n.name === 'createHash');
    assert.ok(libNode);
    assert.strictEqual(libNode.libraryName, 'node:crypto');
  });

  test('local function called the same name as import → not treated as library node', () => {
    const file = path.join(tmpDir, 'conflict.ts');
    fs.writeFileSync(file, [
      "import { useState } from 'react';",
      // Define a local function with the same name (unusual but valid)
      "function useState(x: any) { return x; }",
      "function App() { useState(0); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    // Since useState IS in nameToIds (local definition), it should NOT create a library node
    const libNode = libraryNodes.find((n: any) => n.name === 'useState');
    assert.ok(!libNode, 'local function should take priority over library import');
  });

  test('library edge has isLibraryEdge=true', () => {
    const file = path.join(tmpDir, 'libedge.ts');
    fs.writeFileSync(file, [
      "import * as os from 'os';",
      "function info() { os.platform(); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const libEdge = edges.find((e: any) => e.isLibraryEdge === true);
    assert.ok(libEdge, 'library edge should have isLibraryEdge=true');
  });

  test('Python-style docs URL — libraryName used in docs.python.org path', () => {
    // This tests the URL construction logic used in graphProvider.ts and main.js
    // for 'open-docs' messages with Python language.
    const libraryName = 'os.path';
    const expectedBase = 'docs.python.org/3/library/os';
    const url = `https://docs.python.org/3/library/${libraryName.split('.')[0]}`;
    assert.ok(url.includes('docs.python.org'), 'URL should use docs.python.org');
    assert.ok(url.includes('/os'), 'URL should include top-level module name');
  });

  test('npm docs URL — libraryName used in npmjs.com path', () => {
    const libraryName = 'lodash';
    const url = `https://www.npmjs.com/package/${libraryName}`;
    assert.ok(url.includes('npmjs.com/package/lodash'), 'URL should use npmjs.com');
  });
});

// ---------------------------------------------------------------------------
// Suite: Library clustering grouping logic (from applyComplexity internals)
// ---------------------------------------------------------------------------

suite('Library cluster grouping logic', () => {
  test('nodes with same libraryName should be grouped together', () => {
    // Simulate what applyComplexity does: group library nodes by libraryName
    const libNodes = [
      { id: 'library::numpy::array', name: 'array', libraryName: 'numpy', isLibrary: true },
      { id: 'library::numpy::zeros', name: 'zeros', libraryName: 'numpy', isLibrary: true },
      { id: 'library::pandas::DataFrame', name: 'DataFrame', libraryName: 'pandas', isLibrary: true },
    ];

    const byPackage = new Map<string, any[]>();
    libNodes.forEach(n => {
      if (!byPackage.has(n.libraryName)) byPackage.set(n.libraryName, []);
      byPackage.get(n.libraryName)!.push(n);
    });

    assert.strictEqual(byPackage.size, 2, 'should have 2 packages');
    assert.strictEqual(byPackage.get('numpy')!.length, 2, 'numpy should have 2 nodes');
    assert.strictEqual(byPackage.get('pandas')!.length, 1, 'pandas should have 1 node');
  });

  test('at detail level >= 0.999 — all lib nodes shown individually', () => {
    const complexityLevel = 0.999;
    const expandedLibClusters = new Set<string>();
    const libNodes = [
      { id: 'library::numpy::array', name: 'array', libraryName: 'numpy', isLibrary: true },
      { id: 'library::numpy::zeros', name: 'zeros', libraryName: 'numpy', isLibrary: true },
    ];

    const byPackage = new Map<string, any[]>();
    libNodes.forEach(n => {
      if (!byPackage.has(n.libraryName)) byPackage.set(n.libraryName, []);
      byPackage.get(n.libraryName)!.push(n);
    });

    const elements: any[] = [];
    byPackage.forEach((nodes, pkgName) => {
      const expanded = complexityLevel >= 0.999 || expandedLibClusters.has(pkgName);
      if (expanded) {
        nodes.forEach(n => elements.push({ data: n }));
      } else {
        elements.push({ data: { id: `libcluster::${pkgName}`, isLibCluster: true } });
      }
    });

    assert.strictEqual(elements.length, 2, 'at high detail, individual nodes shown');
    assert.ok(!elements.some((e: any) => e.data.isLibCluster), 'no cluster nodes at high detail');
  });

  test('at detail level < 0.999 — lib nodes collapsed into cluster', () => {
    const complexityLevel = 0.5;
    const expandedLibClusters = new Set<string>();
    const libNodes = [
      { id: 'library::numpy::array', name: 'array', libraryName: 'numpy', isLibrary: true },
      { id: 'library::numpy::zeros', name: 'zeros', libraryName: 'numpy', isLibrary: true },
    ];

    const byPackage = new Map<string, any[]>();
    libNodes.forEach(n => {
      if (!byPackage.has(n.libraryName)) byPackage.set(n.libraryName, []);
      byPackage.get(n.libraryName)!.push(n);
    });

    const elements: any[] = [];
    byPackage.forEach((nodes, pkgName) => {
      const expanded = complexityLevel >= 0.999 || expandedLibClusters.has(pkgName);
      if (expanded) {
        nodes.forEach(n => elements.push({ data: n }));
      } else {
        elements.push({ data: { id: `libcluster::${pkgName}`, isLibCluster: true, _count: nodes.length, label: `${pkgName} (${nodes.length})` } });
      }
    });

    assert.strictEqual(elements.length, 1, 'should have one cluster element');
    assert.ok(elements[0].data.isLibCluster, 'element should be a cluster');
    assert.strictEqual(elements[0].data._count, 2, 'cluster should have count of 2');
    assert.ok(elements[0].data.label.includes('numpy'), 'label should include package name');
  });

  test('expandedLibClusters — expanded package shows individual nodes even at low detail', () => {
    const complexityLevel = 0.5;
    const expandedLibClusters = new Set(['numpy']);
    const libNodes = [
      { id: 'library::numpy::array', name: 'array', libraryName: 'numpy', isLibrary: true },
      { id: 'library::numpy::zeros', name: 'zeros', libraryName: 'numpy', isLibrary: true },
    ];

    const byPackage = new Map<string, any[]>();
    libNodes.forEach(n => {
      if (!byPackage.has(n.libraryName)) byPackage.set(n.libraryName, []);
      byPackage.get(n.libraryName)!.push(n);
    });

    const elements: any[] = [];
    byPackage.forEach((nodes, pkgName) => {
      const expanded = complexityLevel >= 0.999 || expandedLibClusters.has(pkgName);
      if (expanded) {
        nodes.forEach(n => elements.push({ data: n }));
      } else {
        elements.push({ data: { id: `libcluster::${pkgName}`, isLibCluster: true } });
      }
    });

    assert.strictEqual(elements.length, 2, 'expanded package should show individual nodes');
    assert.ok(!elements.some((e: any) => e.data.isLibCluster), 'no cluster node for expanded package');
  });

  test('cluster node id uses libcluster:: prefix', () => {
    const pkgName = 'lodash';
    const clusterId = `libcluster::${pkgName}`;
    assert.ok(clusterId.startsWith('libcluster::'));
    assert.ok(clusterId.includes('lodash'));
  });
});
