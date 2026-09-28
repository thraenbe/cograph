import * as assert from 'assert';

// createFrameSimFacade / syncPins / moveFrameTo are d3-free; createFrameTitleDrag
// (which touches d3.drag at call time) is exercised manually.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fi = require('../../../src/webview/frameInteract.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fr = require('../../../src/webview/frames.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeDeps() {
  const calls: any[] = [];
  const recs = [{ path: '/a' }, { path: '/b' }];
  const sched = {
    resumeAll: () => calls.push(['resumeAll']),
    pauseAll: () => calls.push(['pauseAll']),
    wake: () => calls.push(['wake']),
    bumpUser: (p: string) => calls.push(['bumpUser', p]),
    unsettleAll: (prep: any) => { calls.push(['unsettleAll']); for (const r of recs) { prep(r); } },
    maxAlpha: () => 0.42,
  };
  const ls = {
    applySettings: (rec: any, patch: any) => calls.push(['applySettings', rec.path, patch]),
    unsettle: (rec: any, floor: number) => calls.push(['unsettle', rec.path, floor]),
  };
  const nodes: any[] = [];
  return {
    calls, recs, nodes,
    deps: {
      sched,
      getSims: () => new Map(recs.map(r => [r.path, r])),
      getNodes: () => nodes,
      getSettings: () => ({ repelForce: 250, centerForce: 0.025, linkForce: 1, fileClusterForce: 0.2, nodeSize: 2.5 }),
      ls,
      alphaOf: () => 0,
    },
  };
}

suite('frameInteract — facade', () => {
  test('drag path: alphaTarget(>0).restart() bumps only pinned frames (next microtask)', async () => {
    const { calls, deps, nodes } = makeDeps();
    const sim = fi.createFrameSimFacade(deps);
    sim.alphaTarget(0.3).restart();
    // the drag handler sets the pin right after restart(), as in rendering.js
    nodes.push({ id: 'n0', fx: 10, fy: 10, _frame: '/a' });
    nodes.push({ id: 'n1', fx: null, _frame: '/b' });
    await Promise.resolve();
    assert.deepStrictEqual(calls.filter(c => c[0] === 'bumpUser'), [['bumpUser', '/a']]);
    assert.ok(calls.some(c => c[0] === 'wake'));
    assert.ok(!calls.some(c => c[0] === 'unsettleAll'), 'no global reheat on drag');
  });

  test('global path forwards the settings OPAQUELY (keys this facade does not know reach the sims)', () => {
    const { calls, deps } = makeDeps();
    const base = deps.getSettings();
    deps.getSettings = () => ({ ...base, linkDistance: 55, velocityDecay: 0.45, collidePad: 3, slotPad: 2,
      someFutureKey: 0.7, arrows: true, nested: { no: 1 }, fn: () => 1 });
    fi.createFrameSimFacade(deps).alpha(0.3).restart();
    const patch = calls.filter(c => c[0] === 'applySettings')[0][2];
    assert.deepStrictEqual([patch.linkDistance, patch.velocityDecay, patch.collidePad, patch.slotPad, patch.someFutureKey],
      [55, 0.45, 3, 2, 0.7]);
    assert.strictEqual(patch.arrows, true);
    assert.ok(!('nested' in patch) && !('fn' in patch), 'only structured-cloneable plain values (worker transport)');
  });

  test('global path: alpha(v).restart() re-applies settings + unsettles all with floor v', () => {
    const { calls, deps } = makeDeps();
    const sim = fi.createFrameSimFacade(deps);
    sim.alpha(0.5).restart();
    assert.ok(calls.some(c => c[0] === 'unsettleAll'));
    const applied = calls.filter(c => c[0] === 'applySettings');
    assert.strictEqual(applied.length, 2, 'settings pushed to every frame');
    assert.strictEqual(applied[0][2].repelForce, 250);
    const floors = calls.filter(c => c[0] === 'unsettle').map(c => c[2]);
    assert.deepStrictEqual(floors, [0.5, 0.5]);
    // next restart defaults back to 0.3
    sim.restart();
    const floors2 = calls.filter(c => c[0] === 'unsettle').map(c => c[2]);
    assert.deepStrictEqual(floors2.slice(-2), [0.3, 0.3]);
  });

  test('alphaTarget(0) drops the hot flag → restart becomes global again', () => {
    const { calls, deps } = makeDeps();
    const sim = fi.createFrameSimFacade(deps);
    sim.alphaTarget(0.3);
    sim.alphaTarget(0);
    sim.restart();
    assert.ok(calls.some(c => c[0] === 'unsettleAll'));
  });

  test('stop pauses; alpha() reads the scheduler; chains never throw', () => {
    const { calls, deps } = makeDeps();
    const sim = fi.createFrameSimFacade(deps);
    sim.stop();
    assert.ok(calls.some(c => c[0] === 'pauseAll'));
    assert.strictEqual(sim.alpha(), 0.42);
    assert.ok(sim.isFrameFacade);
    // the call shapes existing code uses:
    sim.force('charge').strength(-10);
    sim.force('link').strength(0.1).distance(40);
    sim.force('x', null);
    sim.nodes([]);
    sim.on('tick', () => {}).alphaDecay(0.1).velocityDecay(0.3).tick();
  });
});

suite('frameInteract — syncPins', () => {
  test('abs pins become local pins; cleared pins are released once', () => {
    const calls: any[] = [];
    const ls = {
      pin: (rec: any, id: string, x: number, y: number) => calls.push(['pin', id, x, y]),
      release: (rec: any, id: string) => calls.push(['release', id]),
    };
    const sn: any = { fx: 150, fy: 260 };
    const rec: any = { nodes: [{ id: 'n0', _ref: sn }, { id: 'n1', _ref: { fx: null } }] };
    const io = { x: 100, y: 200 };
    fi.syncPins(rec, io, ls);
    assert.deepStrictEqual(calls, [['pin', 'n0', 50, 60]]);
    calls.length = 0;
    sn.fx = null;
    fi.syncPins(rec, io, ls);
    assert.deepStrictEqual(calls, [['release', 'n0']]);
    calls.length = 0;
    fi.syncPins(rec, io, ls);
    assert.deepStrictEqual(calls, [], 'released only once');
  });
});

suite('frameInteract — moveFrameTo', () => {
  function smallFrameSet() {
    const tree = {
      root: '/p',
      folders: {
        '/p': { path: '/p', depth: 0, parent: null, childFolders: ['/p/a'], files: [], fileCount: 1 },
        '/p/a': { path: '/p/a', depth: 1, parent: '/p', childFolders: [], files: ['/p/a/y.ts'], fileCount: 1 },
      },
      files: [{ path: '/p/a/y.ts', language: 'typescript' }],
      totalFiles: 1,
    };
    const members = new Map([
      ['/p/a', [{ id: 'fn1', r: 10, file: '/p/a/y.ts', isFn: true }]],
    ]);
    return fr.buildFrames(tree, new Set(['/p', '/p/a']), members);
  }

  test('translates the frame and its members by the actual (clamped) delta', () => {
    const fs = smallFrameSet();
    const f = fs.byPath.get('/p/a');
    const node = { x: f.abs.x + 60, y: f.abs.y + 80, fx: null, fy: null };
    const moved: string[] = [];
    const deps = {
      frames: () => fs,
      framePaths: () => [...fs.byPath.keys()],
      nodesOf: (p: string) => (p === '/p/a' ? [node] : []),
      pin: fr.pinFrame,
      origin: fr.innerOrigin,
      onMoved: (p: string) => moved.push(p),
    };
    const before = { x: f.abs.x, y: f.abs.y, nx: node.x, ny: node.y };
    fi.moveFrameTo(deps, f, before.x + 100, before.y + 50);
    assert.strictEqual(f.abs.x, before.x + 100);
    assert.strictEqual(f.abs.y, before.y + 50);
    assert.strictEqual(node.x, before.nx + 100, 'member translated');
    assert.strictEqual(node.y, before.ny + 50);
    assert.ok(f.pinned);
    assert.ok(moved.includes('/p/a'));
    // Clamped move: far negative → local clamps to 0, node moves by actual delta only.
    const beforeClamp = { x: f.abs.x, nx: node.x };
    fi.moveFrameTo(deps, f, -10000, f.abs.y);
    const actualDx = f.abs.x - beforeClamp.x;
    assert.strictEqual(node.x, beforeClamp.nx + actualDx, 'node follows the clamped delta');
    assert.strictEqual(fs.byPath.get('/p/a').local.x, 0, 'clamped at the parent inner edge');
  });
});
