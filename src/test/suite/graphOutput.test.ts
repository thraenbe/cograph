import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const go = require('../../../scripts/graphOutput.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

suite('analyzer graph output guard', () => {
  function io() {
    const out: string[] = [], err: string[] = [];
    let exit: number | undefined;
    return {
      out, err, exitCode: () => exit,
      io: { out: { write: (t: string) => { out.push(t); return true; } }, err: { write: (t: string) => { err.push(t); return true; } }, setExitCode: (c: number) => { exit = c; } },
    };
  }

  test('normal graph → one JSON line, byte-identical to the previous inline stringify', () => {
    const t = io();
    const graph = { nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'a' }], files: ['f.java'] };
    assert.strictEqual(go.writeGraph(graph, t.io), true);
    assert.deepStrictEqual(t.out, [JSON.stringify(graph) + '\n']);
    assert.deepStrictEqual(t.err, []);
    assert.strictEqual(t.exitCode(), undefined);
  });

  test('too many edges → readable failure, exit code 3, nothing on stdout', () => {
    const t = io();
    const edges = new Array(go.MAX_EDGES + 1); // sparse: only the length matters
    assert.strictEqual(go.writeGraph({ nodes: [{}, {}], edges, files: [] }, t.io), false);
    assert.deepStrictEqual(t.out, []);
    assert.strictEqual(t.exitCode(), 3);
    assert.ok(/graph too large \(1000001 edges from 2 definitions\): too many ambiguous call names/.test(t.err.join('')));
  });

  test('a serialisation error never escapes as a crash', () => {
    const t = io();
    const cyclic: any = { nodes: [], edges: [], files: [] };
    cyclic.nodes.push(cyclic);
    assert.strictEqual(go.writeGraph(cyclic, t.io), false);
    assert.strictEqual(t.exitCode(), 3);
    assert.ok(/too large to serialise/.test(t.err.join('')));
    assert.deepStrictEqual(t.out, []);
  });
});
