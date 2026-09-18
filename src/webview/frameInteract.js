// frameInteract.js — the state.simulation facade for the frames engine plus
// frame-level interactions (pin sync, title-bar drag, reset).
//
// Every existing drag/reheat call site keeps talking to `state.simulation`
// (alphaTarget/restart/alpha/stop/force/nodes); under frames that object is
// this facade, which routes the intent to the per-frame simulations:
//   · alphaTarget(>0).restart()  → drag: wake the scheduler; the dragged
//     node's pin (synced abs→local before each tick) reheats its own frame.
//   · alpha(v).restart()         → global reheat (sliders, graph-loaded,
//     layout-mode switch): re-apply settings and unsettle every frame.
//   · stop()                     → static mode: pause the scheduler.
// The facade itself is d3-free and unit-testable via injected deps.

function createFrameSimFacade(deps) {
  // deps: { sched, getSims():Map, getNodes():[], getSettings():{}, ls:{applySettings, unsettle}, alphaOf(rec) }
  let hot = false;        // a drag is driving (alphaTarget > 0)
  let nextAlpha = 0.3;
  const stub = {};
  for (const k of ['strength', 'distance', 'links', 'radius', 'x', 'y', 'theta', 'distanceMax', 'iterations']) {
    stub[k] = () => stub;
  }
  const api = {
    isFrameFacade: true,
    alphaTarget(v) {
      if (v === undefined) { return hot ? 0.3 : 0; }
      hot = v > 0;
      return api;
    },
    alpha(v) {
      if (v === undefined) { return deps.sched.maxAlpha(deps.alphaOf); }
      nextAlpha = v;
      return api;
    },
    restart() {
      deps.sched.resumeAll();
      if (hot) {
        // Drag: the caller sets fx/fy right AFTER alphaTarget(0.3).restart(),
        // so scan for pinned members one microtask later and reheat exactly
        // their frames (a settled frame is never picked, so a pin alone
        // cannot wake it).
        Promise.resolve().then(() => {
          for (const n of deps.getNodes()) {
            if (n.fx != null && n._frame) { deps.sched.bumpUser(n._frame); }
          }
          deps.sched.wake();
        });
        return api;
      }
      // Global reheat: settings snapshot onto every frame, everything unsettles.
      const s = deps.getSettings();
      const patch = {
        repelForce: s.repelForce, centerForce: s.centerForce,
        linkForce: s.linkForce, fileClusterForce: s.fileClusterForce,
      };
      const floor = nextAlpha;
      deps.sched.unsettleAll(rec => {
        deps.ls.applySettings(rec, patch);
        deps.ls.unsettle(rec, floor);
      });
      nextAlpha = 0.3;
      return api;
    },
    stop() { deps.sched.pauseAll(); return api; },
    force(name, f) { return f === undefined && arguments.length < 2 ? stub : api; },
    nodes(n) { return n === undefined ? deps.getNodes() : api; },
    on() { return api; },
    tick() { return api; },
    alphaDecay() { return api; },
    velocityDecay() { return api; },
    alphaMin() { return 0.001; },
  };
  return api;
}

/**
 * Copy the members' absolute fx/fy pins into the frame's local simulation
 * (and release local pins whose absolute pin was cleared). Called by the
 * scheduler's beforeTick hook, so drag handlers stay completely untouched.
 * `io` = the frame's inner origin; `ls` = localSim function set.
 */
function syncPins(rec, io, ls) {
  if (!rec._pinnedIds) { rec._pinnedIds = new Set(); }
  for (const ln of rec.nodes) {
    const sn = ln._ref;
    if (!sn) { continue; }
    if (sn.fx != null) {
      ls.pin(rec, ln.id, sn.fx - io.x, sn.fy - io.y);
      rec._pinnedIds.add(ln.id);
    } else if (rec._pinnedIds.has(ln.id)) {
      ls.release(rec, ln.id);
      rec._pinnedIds.delete(ln.id);
    }
  }
}

/**
 * Move a frame to a new absolute position: pin it in the packer (parent-local,
 * clamped ≥ 0 — the parent grows rather than the child escaping) and translate
 * the member nodes of the frame and every descendant frame by the actual
 * delta. DOM update is one transform per frame group (via deps.onMoved).
 * deps: { frames():FrameSet, nodesOf(path):node[], framePaths():string[],
 *         pin:pinFrame, origin:innerOrigin, onMoved(path) }
 */
function moveFrameTo(deps, f, absX, absY) {
  const fs = deps.frames();
  const parent = fs.byPath.get(f.parent);
  const io = parent ? deps.origin(parent) : { x: 0, y: 0 };
  const before = { x: f.abs.x, y: f.abs.y };
  deps.pin(fs, f.path, { x: absX - io.x, y: absY - io.y });
  const dx = f.abs.x - before.x;
  const dy = f.abs.y - before.y;
  if (!dx && !dy) { return; }
  const under = (p) => p === f.path || p.startsWith(f.path + '/') || p.startsWith(f.path + '\\');
  for (const path of deps.framePaths()) {
    if (!under(path)) { continue; }
    for (const n of deps.nodesOf(path)) {
      n.x += dx; n.y += dy;
      if (n.fx != null) { n.fx += dx; n.fy += dy; }
    }
    deps.onMoved(path);
  }
}

/** d3 drag for a frame's title bar. `deps` as for moveFrameTo. */
function createFrameTitleDrag(deps) {
  return d3.drag()
    .on('start', function (event, f) {
      f._dragStart = { x: event.x, y: event.y, fx: f.abs.x, fy: f.abs.y };
    })
    .on('drag', function (event, f) {
      if (!f._dragStart) { return; }
      moveFrameTo(deps, f,
        f._dragStart.fx + (event.x - f._dragStart.x),
        f._dragStart.fy + (event.y - f._dragStart.y));
    })
    .on('end', function (event, f) {
      delete f._dragStart;
      if (typeof window !== 'undefined') { window.markDirty?.(); }
    });
}

if (typeof module !== 'undefined') {
  module.exports = { createFrameSimFacade, syncPins, moveFrameTo, createFrameTitleDrag };
}
