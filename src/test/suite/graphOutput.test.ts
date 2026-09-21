import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const go = require('../../../scripts/graphOutput.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

suite('analyzer graph output guard', () => {
  let savedExit: any;
  let stderr: string[];
  let savedWrite: any;
  setup(() => {
    savedExit = process.exitCode;
    stderr = [];
    savedWrite = process.stderr.write;
    (process.stderr as any).write = (s: string) => { stderr.push(String(s)); return true; };
  });
  teardown(() => { (process.stderr as any).write = savedWrite; process.exitCode = savedExit; });

  const sink = () => { const chunks: string[] = []; return { chunks, write: (s: string) => { chunks.push(s); return true; } }; };

  test('normal graph → one JSON line, byte-identical to the previous inline stringify', () => {
    const out = sink();
    const graph = { nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'a' }], files: ['f.java'] };
    assert.strictEqual(go.writeGraph(graph, out), true);
    assert.deepStrictEqual(out.chunks, [JSON.stringify(graph) + '\n']);
    assert.deepStrictEqual(stderr, []);
  });

  test('too many edges → readable failure, exit code 3, nothing on stdout', () => {
    const out = sink();
    const edges = new Array(go.MAX_EDGES + 1); // sparse: only the length matters
    assert.strictEqual(go.writeGraph({ nodes: [{}, {}], edges, files: [] }, out), false);
    assert.deepStrictEqual(out.chunks, []);
    assert.strictEqual(process.exitCode, 3);
    assert.ok(/graph too large \(1000001 edges from 2 definitions\): too many ambiguous call names/.test(stderr.join('')));
  });

  test('a serialisation error never escapes as a crash', () => {
    const out = sink();
    const cyclic: any = { nodes: [], edges: [], files: [] };
    cyclic.nodes.push(cyclic);
    assert.strictEqual(go.writeGraph(cyclic, out), false);
    assert.strictEqual(process.exitCode, 3);
    assert.ok(/too large to serialise/.test(stderr.join('')));
    assert.deepStrictEqual(out.chunks, []);
  });
});
