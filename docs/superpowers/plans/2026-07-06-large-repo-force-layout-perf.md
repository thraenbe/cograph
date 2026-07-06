# Large-Repo Force Layout Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve GitHub issue #52 (force layout jank on large repos), issue #27 (dynamic per-repo force defaults), and issue #50 Approach 3.1 (perf instrumentation), on branch `perf/large-repo-force-layout` off `origin/main`.

**Architecture:** All new decision logic lives in a new pure module `src/webview/layoutTuning.js` (browser-global + guarded CJS export, same pattern as `aggregate.js`) so it is unit-testable — `rendering.js` cannot be `require()`d (it touches d3/DOM at module load), so its edits stay thin wiring. Instrumentation goes through the existing `CoGraph` OutputChannel via the already-injected `log` callback (extension side) and a new `layout-metrics` webview→host message.

**Tech Stack:** VS Code extension (TS, `tsc` → `out/`, esbuild → `dist/`), webview in plain JS with d3 v7 (CDN), tests via `@vscode/test-electron` + mocha **TDD interface** (`suite`/`test`/`setup`/`teardown`) + node `assert` + `sinon`, jsdom for DOM tests.

## Global Constraints

- **Windows quirk:** node is not on PATH. Every npm command: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm test` (PowerShell).
- **Run tests with:** `npm test` (pretest runs `compile` + `bundle`; suite ~650 tests, VS Code 1.116.0 already cached in `.vscode-test`).
- **Small-graph invariance (issue #52 acceptance):** graphs below the large-graph threshold must behave exactly as today, except the deliberate `centerForce` init fix (0.025 → 0.05, reconciling main.js:41 vs controls.js:71/webviewHtmlBuilder.ts:347).
- **Test discovery:** new `src/test/suite/*.test.ts` files are auto-discovered (glob over compiled `out/test/suite/**/*.test.js`). Webview modules are required directly from source: `require('../../../src/webview/<file>.js')`.
- **Shared-global gotcha:** webview modules read globals (`state`, `settings`); tests must save in `setup()` and restore in `teardown()` (pattern: `drilldown.test.ts:35-38`).
- Coding standards: camelCase, files < 400 LOC, functions < 50 LOC, explicit error handling, no `console.log`.
- Never delete files. No scope expansion beyond this plan.
- Commit after every task (conventional commits: `feat:`/`fix:`/`test:`/`chore:`).

## File Structure

- **Create** `src/webview/layoutTuning.js` — all size-based tuning decisions (pure, ~80 LOC).
- **Create** `src/test/suite/layoutTuning.test.ts` — unit tests for the above.
- **Modify** `src/webviewHtmlBuilder.ts` — add `<script>` tag for layoutTuning.js (before rendering.js).
- **Modify** `src/webview/rendering.js` — size-aware sim build, settle-freeze, drag policy, `postLayoutMetrics`.
- **Modify** `src/webview/main.js` — centerForce init fix, `userTunedForces` flag, layout timing start, workflow clamp call.
- **Modify** `src/webview/folder.js`, `src/webview/class.js` — gate drag reheats.
- **Modify** `src/webview/controls.js` — `syncForceSliders`, userTuned flag on force-slider input, size-aware reset.
- **Modify** `src/webview/workflow.js` — `clampWorkflowLevel`.
- **Modify** `src/webview/state.js` — `layoutStartedAt` field.
- **Modify** `src/analyzerRunner.ts` — per-analyzer `durationMs` + `[perf]` log lines.
- **Modify** `src/graphProvider.ts` — payload metrics log + `layout-metrics` message handler.
- **Modify** tests: `webviewControls.test.ts`, `workflowDerive.test.ts`, `analyzerRunner.test.ts`, `graphProvider.test.ts`.
- **Modify** `CHANGELOG.md`.

---

### Task 1: `layoutTuning.js` pure module

**Files:**
- Create: `src/webview/layoutTuning.js`
- Create: `src/test/suite/layoutTuning.test.ts`
- Modify: `src/webviewHtmlBuilder.ts` (script tag list, ~lines 200-215 — insert **before** the rendering.js tag)

**Interfaces (Produces — later tasks call these as webview globals):**
- `isLargeGraph(nodeCount: number): boolean`
- `computeForceDefaults(nodeCount: number): { centerForce: number, repelForce: number, linkForce: number }`
- `alphaDecayFor(nodeCount: number): number`
- `useCollide(nodeCount: number): boolean`
- `dragShouldReheat(nodeCount: number): boolean`
- `shouldFreeze(alpha: number, nodeCount: number): boolean`
- Constants: `LARGE_GRAPH_NODE_THRESHOLD` (800), `WORKFLOW_MAX_NODES` (400)

- [ ] **Step 1: Write the failing test** — `src/test/suite/layoutTuning.test.ts`:

```ts
import * as assert from 'assert';

// Pure module, guarded CJS export (same pattern as aggregate.js).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tuning = require('../../../src/webview/layoutTuning.js');

suite('layoutTuning', () => {
  suite('computeForceDefaults', () => {
    test('small graphs keep the current defaults', () => {
      for (const n of [0, 10, 250, 499]) {
        assert.deepStrictEqual(tuning.computeForceDefaults(n),
          { centerForce: 0.05, repelForce: 250, linkForce: 1 });
      }
    });
    test('very large graphs get compact params (strong center, weak repel)', () => {
      const d = tuning.computeForceDefaults(3000);
      assert.strictEqual(d.centerForce, 0.15);
      assert.strictEqual(d.repelForce, 80);
      assert.strictEqual(d.linkForce, 1);
      // clamped beyond the scale window
      assert.deepStrictEqual(tuning.computeForceDefaults(50000), d);
    });
    test('scales monotonically between 500 and 3000 nodes', () => {
      let prevCenter = 0;
      let prevRepel = Infinity;
      for (const n of [500, 1000, 1750, 2500, 3000]) {
        const d = tuning.computeForceDefaults(n);
        assert.ok(d.centerForce >= prevCenter, `centerForce non-decreasing at ${n}`);
        assert.ok(d.repelForce <= prevRepel, `repelForce non-increasing at ${n}`);
        prevCenter = d.centerForce;
        prevRepel = d.repelForce;
      }
    });
  });

  suite('size thresholds', () => {
    test('large-graph boundary at 800 nodes', () => {
      assert.strictEqual(tuning.isLargeGraph(799), false);
      assert.strictEqual(tuning.isLargeGraph(800), true);
      assert.strictEqual(tuning.LARGE_GRAPH_NODE_THRESHOLD, 800);
    });
    test('collide and drag-reheat stay on for small graphs, off for large', () => {
      assert.strictEqual(tuning.useCollide(799), true);
      assert.strictEqual(tuning.useCollide(800), false);
      assert.strictEqual(tuning.dragShouldReheat(799), true);
      assert.strictEqual(tuning.dragShouldReheat(800), false);
    });
    test('alphaDecay unchanged for small graphs, faster for large', () => {
      assert.strictEqual(tuning.alphaDecayFor(799), 0.02);
      assert.strictEqual(tuning.alphaDecayFor(800), 0.05);
    });
  });

  suite('shouldFreeze', () => {
    test('never freezes small graphs', () => {
      assert.strictEqual(tuning.shouldFreeze(0.001, 799), false);
    });
    test('freezes large graphs only once alpha settles below 0.05', () => {
      assert.strictEqual(tuning.shouldFreeze(0.06, 800), false);
      assert.strictEqual(tuning.shouldFreeze(0.049, 800), true);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm test`
Expected: FAIL — `Cannot find module '../../../src/webview/layoutTuning.js'`

- [ ] **Step 3: Implement** — `src/webview/layoutTuning.js`:

```js
// Pure size-based tuning decisions for the force layout (issues #52, #27).
// No DOM, no d3 — keep it require()-able from Node tests (see aggregate.js).

// Above this rendered-node count the simulation gets the "large graph"
// treatment: faster settle, no collide force, no global reheat on drag.
const LARGE_GRAPH_NODE_THRESHOLD = 800;
// computeForceDefaults interpolates between these two sizes.
const FORCE_SCALE_MIN_NODES = 500;
const FORCE_SCALE_MAX_NODES = 3000;
// Large graphs stop simulating below this alpha (d3 default alphaMin is
// 0.001 — stopping at 0.05 saves the long low-energy tail of ticks).
const SETTLE_ALPHA_LARGE = 0.05;
const ALPHA_DECAY_SMALL = 0.02; // current value in startSimulation
const ALPHA_DECAY_LARGE = 0.05;
// Cap on rendered workflow-view nodes (issue #52 item 2).
const WORKFLOW_MAX_NODES = 400;

function isLargeGraph(nodeCount) {
  return nodeCount >= LARGE_GRAPH_NODE_THRESHOLD;
}

// Dynamic per-repo force defaults (issue #27): small graphs keep today's
// values; large graphs get stronger centering and weaker repel so the
// layout stays compact instead of exploding.
function computeForceDefaults(nodeCount) {
  const span = FORCE_SCALE_MAX_NODES - FORCE_SCALE_MIN_NODES;
  const t = Math.max(0, Math.min(1, (nodeCount - FORCE_SCALE_MIN_NODES) / span));
  return {
    centerForce: Math.round((0.05 + t * 0.10) * 1000) / 1000,
    repelForce: Math.round(250 - t * 170),
    linkForce: 1,
  };
}

function alphaDecayFor(nodeCount) {
  return isLargeGraph(nodeCount) ? ALPHA_DECAY_LARGE : ALPHA_DECAY_SMALL;
}

function useCollide(nodeCount) {
  return !isLargeGraph(nodeCount);
}

function dragShouldReheat(nodeCount) {
  return !isLargeGraph(nodeCount);
}

function shouldFreeze(alpha, nodeCount) {
  return isLargeGraph(nodeCount) && alpha < SETTLE_ALPHA_LARGE;
}

if (typeof module !== 'undefined') {
  module.exports = {
    LARGE_GRAPH_NODE_THRESHOLD,
    WORKFLOW_MAX_NODES,
    isLargeGraph,
    computeForceDefaults,
    alphaDecayFor,
    useCollide,
    dragShouldReheat,
    shouldFreeze,
  };
}
```

Then in `src/webviewHtmlBuilder.ts`, find the block of webview `<script>` tags (state, aggregate, clustering, workflow, highlight, rendering, …) and add a tag for `layoutTuning.js` **immediately after the `state.js` tag** (must load before rendering.js/folder.js/class.js/controls.js). Copy the exact tag syntax (nonce, `webview.asWebviewUri`) of the neighboring `state.js` line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm test`
Expected: PASS (all suites; new `layoutTuning` suite green)

- [ ] **Step 5: Commit**

```powershell
git add src/webview/layoutTuning.js src/test/suite/layoutTuning.test.ts src/webviewHtmlBuilder.ts
git commit -m "feat(webview): add layoutTuning module with size-based force defaults"
```

---

### Task 2: Size-aware simulation build + settle-and-freeze

**Files:**
- Modify: `src/webview/rendering.js` (`startSimulation` lines ~561-581; `ticked` lines ~274-278)
- Modify: `src/webview/main.js` (line 41, `centerForce: 0.025`)

**Interfaces:**
- Consumes: `alphaDecayFor`, `useCollide`, `shouldFreeze` (Task 1 globals).
- Produces: no new API. Behavior: large graphs settle fast and freeze; small graphs unchanged.

- [ ] **Step 1: Fix the centerForce init inconsistency** — `src/webview/main.js:41`: change `centerForce: 0.025,` to `centerForce: 0.05,` (matches the reset default at controls.js:71 and the slider default at webviewHtmlBuilder.ts:347).

- [ ] **Step 2: Wire size-aware build** — in `startSimulation` full-build path (rendering.js:561-581), with `const n = state.currentNodes.length;` at the top of the build:
  - Replace `.force('collision', d3.forceCollide(d => nodeRadius(d) + 1))` with a conditional applied after the chain:
    ```js
    if (useCollide(n)) {
      state.simulation.force('collision', d3.forceCollide(d => nodeRadius(d) + 1));
    }
    ```
    (d3 chaining note: build the simulation as today minus `.force('collision', …)`, then apply the conditional force — `simulation.force()` after construction is the idiomatic d3 way.)
  - Replace `.alphaDecay(0.02)` with `.alphaDecay(alphaDecayFor(n))`.

- [ ] **Step 3: Settle-and-freeze** — in `ticked()` (rendering.js:274-278), extend the existing auto-fit block:

```js
if (state.simulation) {
  const alpha = state.simulation.alpha();
  if (!state.hasFitted && alpha < 0.1) {
    state.hasFitted = true;
    fitToView();
  }
  if (shouldFreeze(alpha, state.currentNodes.length)) {
    state.simulation.stop();
  }
}
```

(Preserve the existing `!state.hasFitted && state.simulation` semantics — only restructure to share the `alpha` read. Reheat paths — `rerunLayout` `alpha(0.5).restart()`, `pendingReheat` `alpha(0.1).restart()`, `graph-loaded` — all call `.restart()`, which resumes a stopped simulation, so freezing is always recoverable.)

- [ ] **Step 4: Run full suite**

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm test`
Expected: PASS — no regressions (rendering.js has no direct unit tests; the decision functions were tested in Task 1).

- [ ] **Step 5: Commit**

```powershell
git add src/webview/rendering.js src/webview/main.js
git commit -m "feat(webview): settle-and-freeze large graphs, size-aware collide/alphaDecay (#52)"
```

---

### Task 3: Drag without global reheat on large graphs

**Files:**
- Modify: `src/webview/rendering.js` (drag handlers, lines ~206-231)
- Modify: `src/webview/folder.js` (drag reheats at lines ~622/654, 667/681, 705/722, 859/874)
- Modify: `src/webview/class.js` (drag reheats at lines ~158/172, 191/208)

**Interfaces:**
- Consumes: `dragShouldReheat` (Task 1 global), global `ticked()` from rendering.js.
- Produces: no new API. Behavior: on large graphs, dragging pins and moves the dragged node(s) directly (exactly like the existing `static` layout-mode branch) instead of reheating the whole simulation.

**IMPORTANT for the implementer:** read each drag handler in full before editing — folder.js/class.js handlers move *groups* of member nodes; mirror the same fx/fy updates into x/y in no-reheat mode. Line numbers are anchors, not gospel.

- [ ] **Step 1: rendering.js node drag** — apply this transformation to the `d3.drag()` handlers (lines 206-231):

```js
// start (was: if (state.layoutMode === 'dynamic' && !event.active && state.simulation) state.simulation.alphaTarget(0.3).restart();)
const reheat = dragShouldReheat(state.currentNodes.length);
if (state.layoutMode === 'dynamic' && reheat && !event.active && state.simulation) {
  state.simulation.alphaTarget(0.3).restart();
}
// (keep: d.fx = d.x; d.fy = d.y;)

// drag move: extend the existing static branch condition
// (was: if (state.layoutMode === 'static') { d.x = event.x; d.y = event.y; ticked(); })
if (state.layoutMode === 'static' || !dragShouldReheat(state.currentNodes.length)) {
  d.x = event.x;
  d.y = event.y;
  ticked();
}

// end: only the reheat path cools down and releases the pin; the
// no-reheat path keeps fx/fy pinned (issue #52: "fix that node").
if (state.layoutMode === 'dynamic' && dragShouldReheat(state.currentNodes.length)) {
  if (!event.active && state.simulation) state.simulation.alphaTarget(0);
  d.fx = null;
  d.fy = null;
}
// (keep the existing window.markDirty?.() call)
```

- [ ] **Step 2: folder.js and class.js** — for each of the six group-drag handlers, apply the same gate:
  - Every `state.simulation.alphaTarget(0.3).restart()` (start) becomes conditional on `dragShouldReheat(state.currentNodes.length)`.
  - Every matching `state.simulation.alphaTarget(0)` (end) gets the same condition.
  - In each **drag-move** handler, after the member nodes' `fx`/`fy` are updated, add:
    ```js
    if (!dragShouldReheat(state.currentNodes.length)) {
      // simulation is frozen — apply positions directly and repaint once
      for (const node of movedNodes) { node.x = node.fx; node.y = node.fy; }
      ticked();
    }
    ```
    where `movedNodes` is whatever collection that specific handler already iterates (read the handler; reuse its own variable).

- [ ] **Step 3: Run full suite**

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm test`
Expected: PASS (drilldown.test.ts exercises folder.js's pure force functions — they must be untouched).

- [ ] **Step 4: Commit**

```powershell
git add src/webview/rendering.js src/webview/folder.js src/webview/class.js
git commit -m "feat(webview): drag moves nodes directly on large graphs instead of reheating (#52)"
```

---

### Task 4: Apply dynamic force defaults + slider sync + reset consistency (#27)

**Files:**
- Modify: `src/webview/main.js` (settings object ~lines 30-48: add `userTunedForces: false`)
- Modify: `src/webview/controls.js` (wireSlider call sites ~114-123; reset handler ~66-74; new `syncForceSliders`)
- Modify: `src/webview/rendering.js` (`startSimulation` full-build path)
- Test: `src/test/suite/webviewControls.test.ts` (extend)

**Interfaces:**
- Consumes: `computeForceDefaults` (Task 1).
- Produces: `syncForceSliders()` (controls.js global — updates the three force sliders + value labels from `settings`); `settings.userTunedForces: boolean`.

- [ ] **Step 1: Write the failing tests** — extend `src/test/suite/webviewControls.test.ts` (follow its existing jsdom setup — DOM + globals installed *before* `require('.../controls.js')`; the DOM builder must contain `#slider-center-force`, `#slider-repel-force`, `#slider-link-force` and their value-label elements — read the existing `makeDOM` helper and the `wireSlider(id, valId, …)` call sites for the exact label ids, and extend `makeDOM` if any are missing):

```ts
suite('dynamic force defaults (#27)', () => {
  test('force slider input marks settings.userTunedForces', () => {
    (global as any).settings.userTunedForces = false;
    const slider = dom.window.document.getElementById('slider-repel-force') as any;
    slider.value = '300';
    dispatch(slider, 'input');
    assert.strictEqual((global as any).settings.userTunedForces, true);
  });

  test('syncForceSliders pushes settings values into sliders and labels', () => {
    (global as any).settings.centerForce = 0.15;
    (global as any).settings.repelForce = 80;
    (global as any).settings.linkForce = 1;
    (global as any).syncForceSliders();
    const slider = dom.window.document.getElementById('slider-repel-force') as any;
    assert.strictEqual(slider.value, '80');
  });

  test('reset restores size-based defaults and clears userTunedForces', () => {
    (global as any).state.currentNodes = new Array(3000).fill(0).map((_, i) => ({ id: String(i) }));
    (global as any).settings.userTunedForces = true;
    (global as any).settings.repelForce = 999;
    const btn = dom.window.document.getElementById('btn-reset-layout') as any; // read controls.js for the real reset control id
    dispatch(btn, 'click');
    assert.strictEqual((global as any).settings.repelForce, 80);
    assert.strictEqual((global as any).settings.userTunedForces, false);
  });
});
```

(The reset control's element id and event must be read from controls.js:66-74 and mirrored exactly — adjust the test to the real trigger. `computeForceDefaults` must be installed as a jsdom global in this suite's setup: `(global as any).computeForceDefaults = require('../../../src/webview/layoutTuning.js').computeForceDefaults;` — in the real webview it's a shared script global.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm test`
Expected: FAIL — `syncForceSliders is not a function`, userTunedForces undefined, reset restores 250 not 80.

- [ ] **Step 3: Implement**
  - `main.js` settings object: add `userTunedForces: false,`.
  - `controls.js`:
    - In the three force-slider `wireSlider` handlers (center/repel/link), set `settings.userTunedForces = true;` before `rerunLayout()`.
    - Add (as a top-level function declaration so it is a webview global; reuse the exact slider/label ids from the `wireSlider` call sites):
      ```js
      function syncForceSliders() {
        const rows = [
          ['slider-center-force', /* real label id */, settings.centerForce],
          ['slider-repel-force', /* real label id */, settings.repelForce],
          ['slider-link-force', /* real label id */, settings.linkForce],
        ];
        for (const [sliderId, labelId, value] of rows) {
          const slider = document.getElementById(sliderId);
          const label = document.getElementById(labelId);
          if (slider) slider.value = String(value);
          if (label) label.textContent = String(value);
        }
      }
      ```
      (Replace the `/* real label id */` placeholders with the actual ids found at the wireSlider call sites — this is a read-the-code substitution, not a design decision.)
    - Reset handler (controls.js:66-74): replace the hardcoded `centerForce: 0.05, repelForce: 250, linkForce: 1` assignments with:
      ```js
      const defaults = computeForceDefaults(state.currentNodes.length);
      settings.centerForce = defaults.centerForce;
      settings.repelForce = defaults.repelForce;
      settings.linkForce = defaults.linkForce;
      settings.userTunedForces = false;
      syncForceSliders();
      ```
      (keep whatever the handler already does afterwards — e.g. `rerunLayout()`.)
  - `rendering.js` `startSimulation` full-build path, before the forces are configured:
    ```js
    if (!settings.userTunedForces) {
      const defaults = computeForceDefaults(state.currentNodes.length);
      settings.centerForce = defaults.centerForce;
      settings.repelForce = defaults.repelForce;
      if (typeof syncForceSliders === 'function') syncForceSliders();
    }
    ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/webview/main.js src/webview/controls.js src/webview/rendering.js src/test/suite/webviewControls.test.ts
git commit -m "feat(webview): dynamic per-repo force defaults with slider sync (#27)"
```

---

### Task 5: Bound the workflow view node count

**Files:**
- Modify: `src/webview/workflow.js` (add `clampWorkflowLevel`; export it in the existing guarded CJS block)
- Modify: `src/webview/main.js` (`applyWorkflowComplexity`, lines ~174-199)
- Test: `src/test/suite/workflowDerive.test.ts` (extend)

**Interfaces:**
- Consumes: `deriveWorkflowView(projectData, level)` (existing, workflow.js:27-101), `WORKFLOW_MAX_NODES` (Task 1).
- Produces: `clampWorkflowLevel(projectData, level, maxNodes): number` — largest level ≤ `level` whose derived rendered-node count is ≤ `maxNodes` (level 0 is always allowed).

- [ ] **Step 1: Write the failing test** — extend `src/test/suite/workflowDerive.test.ts`. Read the file's existing synthetic-graph helper first and reuse it; the test builds a graph large enough that high levels exceed the cap:

```ts
test('clampWorkflowLevel lowers the level until the derived node count fits', () => {
  const data = makeBigWorkflowGraph(1200); // reuse/extend the file's existing graph builder
  const clamped = workflow.clampWorkflowLevel(data, 9, 400);
  assert.ok(clamped < 9);
  const view = workflow.deriveWorkflowView(data, clamped);
  assert.ok(countRenderedNodes(view) <= 400); // count via the same field buildClusteredElements consumes (clusterMembers)
  // level 0 always allowed even if still above the cap
  assert.strictEqual(workflow.clampWorkflowLevel(data, 0, 1), 0);
  // small graphs are never clamped
  const small = makeBigWorkflowGraph(50);
  assert.strictEqual(workflow.clampWorkflowLevel(small, 9, 400), 9);
});
```

(`countRenderedNodes` = however the existing tests count derived clusters — read workflowDerive.test.ts and use the same accessor; the rendered node count is the number of derived clusters, i.e. `view.clusterMembers.size` if clusterMembers is a Map.)

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — `workflow.clampWorkflowLevel is not a function`.

- [ ] **Step 3: Implement** in `src/webview/workflow.js`:

```js
// Largest level <= requested whose derived view renders at most maxNodes
// nodes (issue #52: the workflow view must stay bounded on huge repos).
function clampWorkflowLevel(projectData, level, maxNodes) {
  let lvl = level;
  while (lvl > 0) {
    const view = deriveWorkflowView(projectData, lvl);
    if (view.clusterMembers.size <= maxNodes) { break; }
    lvl -= 1;
  }
  return lvl;
}
```

(Adjust the node-count accessor to the real shape of `deriveWorkflowView`'s return — the test from Step 1 pins it. Add `clampWorkflowLevel` to the module's existing `module.exports` guard.)

In `main.js` `applyWorkflowComplexity` (lines ~174-199), clamp the level before deriving: where `deriveWorkflowView(projectData, state.workflowLevel)` is called, first do `state.workflowLevel = clampWorkflowLevel(projectData, state.workflowLevel, WORKFLOW_MAX_NODES);`.

- [ ] **Step 4: Run tests to verify they pass** — Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/webview/workflow.js src/webview/main.js src/test/suite/workflowDerive.test.ts
git commit -m "feat(webview): clamp workflow view detail to a bounded node count (#52)"
```

---

### Task 6: Per-analyzer timing instrumentation (#50 Approach 3.1, extension side)

**Files:**
- Modify: `src/analyzerRunner.ts`
- Test: `src/test/suite/analyzerRunner.test.ts` (extend)

**Interfaces:**
- Consumes: existing `log` callback (already wired to the `CoGraph` OutputChannel at graphProvider.ts:121).
- Produces: `AnalyzerResult.durationMs: number`; `AnalyzerStatus.durationMs?: number`; `[perf]`-prefixed log lines.

- [ ] **Step 1: Write the failing test** — extend `analyzerRunner.test.ts` (reuse `makeRunner`, `stubSpawnAuto`, `stubPythonResolution`, `stubFastBackoff` — and extend `makeRunner` to also capture `log` lines into an array if it doesn't already):

```ts
test('logs per-analyzer timing and totals on a successful run', async () => {
  const logs: string[] = [];
  const { runner, resultPromise } = makeRunnerCapturingLogs(logs); // extend makeRunner: pass log: (m) => logs.push(m)
  stubSpawnAuto(sandbox, realSetTimeout, (call) => emitNode(call)); // all five analyzers emit a node and exit 0
  runner.run('/w');
  await resultPromise;
  const perfLines = logs.filter(l => l.startsWith('[perf]'));
  // one line per analyzer + one attempt summary
  assert.strictEqual(perfLines.filter(l => /: ok in \d+ms$/.test(l)).length, 5);
  assert.ok(perfLines.some(l => /analysis attempt 1: \d+ms total, \d+ nodes \/ \d+ edges/.test(l)));
});
```

(Adapt helper names/shapes to the file's actual helpers — read lines 19-89 first. The assertion targets are the log format, which IS the deliverable.)

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL — no `[perf]` lines logged.

- [ ] **Step 3: Implement** in `src/analyzerRunner.ts`:
  - `AnalyzerResult` (lines 32-37): add `durationMs: number;`. `AnalyzerStatus` (lines 23-30): add `durationMs?: number;`.
  - `spawnAnalyzerProcess` (lines 306-380): `const startedAt = Date.now();` first line; add `durationMs: Date.now() - startedAt` to **every** `resolve({ … })` site in the function (timeout, spawn-error, output-too-large, close/parse paths).
  - `runOnce` (147-163): where statuses are built from results in the `flatMap`, carry `durationMs` through into each status entry.
  - `runWithRetry` (98-134): capture `const attemptStart = Date.now();` at the top of each loop iteration; after `runOnce` resolves (and after the stale-token check at line 110):
    ```ts
    for (const s of statuses) {
      this.log(`[perf] ${s.lang}: ${s.status} in ${s.durationMs ?? 0}ms`);
    }
    this.log(`[perf] analysis attempt ${attempt + 1}: ${Date.now() - attemptStart}ms total, ` +
      `${merged.nodes.length} nodes / ${merged.edges.length} edges`);
    ```
  - `runSubset` (174-212): after its `Promise.all`, one line: `this.log(\`[perf] subset parse (${files.length} files): ${Date.now() - startedAt}ms\`);` with `startedAt` captured at method start.

- [ ] **Step 4: Run tests to verify they pass** — Expected: PASS, including all pre-existing analyzerRunner tests (they assert on statuses and must be unaffected by the added field).

- [ ] **Step 5: Commit**

```powershell
git add src/analyzerRunner.ts src/test/suite/analyzerRunner.test.ts
git commit -m "feat(analysis): log per-analyzer wall time and attempt totals (#50)"
```

---

### Task 7: Payload metrics + webview layout-time round trip (#50 Approach 3.1)

**Files:**
- Modify: `src/graphProvider.ts` (`handleAnalysisResult` ~636-678; `onDidReceiveMessage` switch ~220-335)
- Modify: `src/webview/state.js` (add `layoutStartedAt: null,` near `hasFitted`)
- Modify: `src/webview/main.js` (`renderGraph` ~299-348: set `state.layoutStartedAt = Date.now();` at entry)
- Modify: `src/webview/rendering.js` (post metrics at the settle point)
- Test: `src/test/suite/graphProvider.test.ts` (extend)

**Interfaces:**
- Consumes: existing fake-webview test pattern (graphProvider.test.ts:75-76, 349-350).
- Produces: webview→host message `{ type: 'layout-metrics', ms: number, nodes: number }`; `[perf]` log lines in the `CoGraph` output channel.

- [ ] **Step 1: Write the failing tests** — extend `graphProvider.test.ts` (mirror its existing provider + fake panel setup, and its OutputChannel stubbing if present — otherwise stub `vscode.window.createOutputChannel` in the suite's sandbox to return `{ appendLine: sinon.stub(), … }`):

```ts
test('handleAnalysisResult logs payload size metrics', () => {
  // drive the provider's onResult callback (or handleAnalysisResult indirectly,
  // matching how existing tests inject analysis results) with a small graph JSON
  const stdout = JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }] });
  driveAnalysisResult(provider, stdout); // reuse the file's existing mechanism
  assert.ok(appendLineStub.args.some(([line]) =>
    /\[perf\] payload: 2 nodes \/ 1 edges, \d+(\.\d+)? (KB|MB)/.test(line)));
});

test('layout-metrics message from the webview is logged', () => {
  const onMessage = capturedOnDidReceiveMessage(); // the callback the provider registered on the fake panel
  onMessage({ type: 'layout-metrics', ms: 843, nodes: 1500 });
  assert.ok(appendLineStub.args.some(([line]) =>
    line.includes('[perf] webview layout settled in 843ms (1500 nodes)')));
});
```

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL — no `[perf]` payload/layout lines.

- [ ] **Step 3: Implement**
  - `graphProvider.ts` `handleAnalysisResult`, right after the `JSON.parse(stdout)` succeeds:
    ```ts
    const kb = Buffer.byteLength(stdout, 'utf8') / 1024;
    const size = kb >= 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${kb.toFixed(1)} KB`;
    this.outputChannel.appendLine(
      `[perf] payload: ${graph.nodes.length} nodes / ${graph.edges.length} edges, ${size}`);
    ```
  - `graphProvider.ts` `onDidReceiveMessage` switch: add
    ```ts
    case 'layout-metrics':
      this.outputChannel.appendLine(
        `[perf] webview layout settled in ${message.ms}ms (${message.nodes} nodes)`);
      break;
    ```
  - `state.js`: add `layoutStartedAt: null,` after `hasFitted: false,`.
  - `main.js` `renderGraph` entry: `state.layoutStartedAt = Date.now();`.
  - `rendering.js`: add near `ticked()`:
    ```js
    function postLayoutMetrics() {
      if (state.layoutStartedAt == null) { return; }
      const ms = Date.now() - state.layoutStartedAt;
      state.layoutStartedAt = null;
      vscode.postMessage({ type: 'layout-metrics', ms, nodes: state.currentNodes.length });
    }
    ```
    and call `postLayoutMetrics();` inside the one-shot auto-fit block from Task 2 (right after `fitToView();`). (`vscode` is the `acquireVsCodeApi()` global from main.js — same cross-file usage as popups.js.)

- [ ] **Step 4: Run tests to verify they pass** — Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/graphProvider.ts src/webview/state.js src/webview/main.js src/webview/rendering.js src/test/suite/graphProvider.test.ts
git commit -m "feat(perf): log payload size and webview layout settle time (#50)"
```

---

### Task 8: Changelog + final verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entry** — read the top of `CHANGELOG.md` and mirror its format; add under an Unreleased (or new version) heading:

```markdown
### Performance
- Large graphs (≥800 rendered nodes) now settle and freeze instead of simulating indefinitely; dragging a node moves it directly without reheating the whole graph (#52)
- Force defaults now scale with repository size; the Reset Layout button restores size-appropriate values (#27)
- Workflow view detail is clamped so huge repositories never render an unbounded node count (#52)
- The CoGraph output channel now logs per-analyzer wall time, payload size, and webview layout settle time (#50)

### Fixed
- Initial center force (0.025) now matches the slider/reset default (0.05)
```

- [ ] **Step 2: Full verification**

Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm test`
Expected: PASS — full suite.
Run: `$env:Path = "C:\Program Files\nodejs;$env:Path"; npm run lint`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```powershell
git add CHANGELOG.md
git commit -m "chore: changelog for large-repo layout performance work"
```

---

## Out of Scope (report-only — do NOT implement)

- **#50 Approaches 1 & 2.2-2.4** (incremental analysis cache, Web Worker simulation, canvas fallback, graph-patch deltas) — larger standalone efforts; #50 stays open.
- **rAF-throttling tick→DOM writes (#52 item 4a)** — verified moot: d3-force ticks via d3-timer, which is already requestAnimationFrame-driven; DOM writes are already at most once per frame.
- **#26 (dynamic dependencies), #6 (LLM cluster names)** — underspecified product features; per `.ai/system.md`, do not assume product decisions.
- **#40 (refactor JavaScript)** — empty issue body; the tech-debt file already tracks the oversized-file split. New logic added here goes into small new modules, which is directionally aligned.
- Persisting user-tuned force values into the save payload.
