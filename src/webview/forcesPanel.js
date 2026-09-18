// forcesPanel.js — the single Forces box in the left toolbar. Shows only the
// sliders the current engine actually consumes, replaces them all with a hint
// under Static motion, and gates the "show more forces" expander. Pure DOM
// visibility — the slider wiring itself lives in controls.js.

const FP_BASIC = {
  shelf: ['row-repel-force', 'row-link-force', 'row-file-cluster'],
  global: ['row-center-force', 'row-repel-force', 'row-link-force',
    'row-file-cluster', 'row-folder-repel', 'row-file-repel'],
};

const FP_ADVANCED = {
  shelf: ['row-link-distance', 'row-velocity-decay', 'row-collide-pad', 'row-slot-pad'],
  global: ['row-link-distance', 'row-velocity-decay', 'row-collide-pad'],
};

// The slot-pull slider is the same setting in both engines; only its story differs.
const FP_CLUSTER_LABEL = { shelf: 'Keep near file', global: 'File Cluster Force' };

const FP_ALL = [...new Set([].concat(FP_BASIC.global, FP_ADVANCED.shelf))];

/** Sync the Forces box to the current engine × motion. Safe to call anytime. */
function updateForcesPanel(engine, mode) {
  if (typeof document === 'undefined') { return; }
  engine = engine || (typeof state !== 'undefined' && state.layoutEngine) || 'global';
  mode = mode || (typeof state !== 'undefined' && state.layoutMode) || 'dynamic';
  const isStatic = mode === 'static';
  const basic = new Set(FP_BASIC[engine] || FP_BASIC.global);
  const advanced = new Set(FP_ADVANCED[engine] || FP_ADVANCED.global);

  const hint = document.getElementById('forces-hint');
  if (hint) { hint.style.display = isStatic ? '' : 'none'; }

  for (const id of FP_ALL) {
    const el = document.getElementById(id);
    if (!el) { continue; }
    el.style.display = (!isStatic && (basic.has(id) || advanced.has(id))) ? '' : 'none';
  }

  // The expander button and its content vanish wholesale under Static; when
  // dynamic, the 'open' class (toggled in controls.js) decides the content.
  const moreBtn = document.getElementById('btn-show-more-forces');
  if (moreBtn) { moreBtn.style.display = isStatic ? 'none' : ''; }
  const adv = document.getElementById('forces-advanced');
  if (adv) { adv.style.display = isStatic ? 'none' : ''; }

  const label = document.getElementById('label-file-cluster');
  if (label) { label.textContent = FP_CLUSTER_LABEL[engine] || FP_CLUSTER_LABEL.global; }
}

// Initial sync at load — the scripts sit at the end of <body>, so the panel
// DOM and the state defaults (from COGRAPH_CONFIG) both exist already.
if (typeof document !== 'undefined' && document.getElementById('panel-forces')) {
  updateForcesPanel();
}

if (typeof module !== 'undefined') {
  module.exports = { updateForcesPanel, FP_BASIC, FP_ADVANCED, FP_CLUSTER_LABEL, FP_ALL };
}
