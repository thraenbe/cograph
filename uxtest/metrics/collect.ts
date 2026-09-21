// In-page geometry snapshot. `snapshotInPage` is serialized by Playwright and
// runs inside the webview, so it must stay self-contained (no imports, no
// outer-scope references).
//
// Two kinds of data, deliberately from two sources:
//  - LAYOUT INVARIANTS (overlap, containment, crossings) come from STATE (state.currentNodes filtered by
//    getVisibleNodeIds(), state.frames, the engines' link lists). The perf branch detaches culled frames and
//    LOD layers from the document, so the DOM only holds what is on screen at the current zoom.
//  - LEGIBILITY (labels, folder boxes) stays DOM-based: it describes what is actually painted.
// Every state source has a DOM fallback, so the snapshot still works if an internal is renamed.
import type { Frame, Page } from '@playwright/test';
import type { Snapshot } from './types';

export interface CollectOpts { maxLabels: number }

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const state: any;
declare const nodeRadius: any;
declare const FRAME: any;
declare const SLOT: any;
declare const getVisibleNodeIds: any;
declare const __fr: any;

function snapshotInPage(opts: CollectOpts): Snapshot {
  const g = globalThis as any;
  // Free identifiers resolve against the page's global lexical scope (state,
  // nodeRadius, FRAME, SLOT are top-level bindings of the webview scripts).
  // No eval: the production CSP forbids it.
  const st: any = typeof state !== 'undefined' ? state : {};
  const radiusOf: ((d: any) => number) | null = typeof nodeRadius === 'function' ? nodeRadius : null;
  const FRAME_K = typeof FRAME !== 'undefined' ? FRAME : { PAD: 40, TITLE: 30 };
  const SLOT_K = typeof SLOT !== 'undefined' ? SLOT : { LABEL_H: 16 };
  const svgEl = document.querySelector('#graph svg') as SVGSVGElement | null;
  const zt = svgEl && g.d3 ? g.d3.zoomTransform(svgEl) : { k: 1, x: 0, y: 0 };
  const shown = (el: Element): boolean => {
    for (let cur: Element | null = el; cur && cur !== svgEl; cur = cur.parentElement) {
      const s = (cur as HTMLElement).style;
      if (s && (s.display === 'none' || s.visibility === 'hidden')) { return false; }
    }
    return true;
  };

  // ── frames + slots ────────────────────────────────────────────────────────
  const frames: Snapshot['frames'] = [];
  const slots: Snapshot['slots'] = [];
  const ownerOf = new Map<string, { frame: string; slot: string | null }>();
  const byPath: Map<string, any> | null = st.frames && st.frames.byPath ? st.frames.byPath : null;
  if (byPath) {
    for (const f of byPath.values()) {
      const root = f.kind === 'root';
      const io = root ? { x: f.abs.x, y: f.abs.y } : { x: f.abs.x + FRAME_K.PAD, y: f.abs.y + FRAME_K.PAD + FRAME_K.TITLE };
      frames.push({ path: f.path, kind: f.kind, parent: f.parent ?? null,
        rect: { x: f.abs.x, y: f.abs.y, w: f.abs.w, h: f.abs.h },
        inner: { x: io.x, y: io.y, w: f.inner.w, h: f.inner.h } });
      const cp = f.contentPos || { x: 0, y: 0 };
      for (const [key, s] of (f.slots || new Map())) {
        const rx = io.x + cp.x + s.x, ry = io.y + cp.y + s.y;
        slots.push({ frame: f.path, key, rect: { x: rx, y: ry, w: s.w, h: s.h },
          interior: { x: rx + 2, y: ry + SLOT_K.LABEL_H, w: Math.max(8, s.w - 4), h: Math.max(8, s.h - SLOT_K.LABEL_H - 2) } });
      }
      for (const [id, key] of (f.slotOf || new Map())) { ownerOf.set(id, { frame: f.path, slot: key }); }
    }
  }

  // ── nodes: state first (complete under culling/LOD), rendered DOM as fallback ──────────────
  const nodes: Snapshot['nodes'] = [];
  const indexOf = new Map<string, number>();
  const pushNode = (d: any, fallbackR: number): void => {
    if (!d || d.id === undefined || typeof d.x !== 'number' || typeof d.y !== 'number' || indexOf.has(String(d.id))) { return; }
    const own = ownerOf.get(d.id);
    indexOf.set(String(d.id), nodes.length);
    nodes.push({ id: String(d.id), x: d.x, y: d.y, r: radiusOf ? radiusOf(d) : fallbackR,
      kind: d.isLibrary ? 'lib' : (d.isCluster || d.isSynthetic || d.isFolderCluster || d.isFileCluster) ? 'cluster' : 'fn',
      file: d.file ?? d._filePath ?? null, frame: own ? own.frame : null, slot: own ? own.slot : null });
  };
  let visibleIds: Set<unknown> | null = null;
  try { visibleIds = typeof getVisibleNodeIds === 'function' ? getVisibleNodeIds() : null; } catch { visibleIds = null; }
  if (visibleIds && Array.isArray(st.currentNodes)) {
    const libsDrawn = st.layoutEngine !== 'shelf'; // the shelf engine does not draw library nodes
    for (const d of st.currentNodes) { if (visibleIds.has(d.id) && !d.isFileAnchor && (libsDrawn || !d.isLibrary)) { pushNode(d, 3); } }
  } else {
    (svgEl ? svgEl.querySelectorAll('circle.regular-node, path.cloud-node, circle.lib-node') : []).forEach((el) => {
      if (shown(el)) { pushNode((el as any).__data__, Number(el.getAttribute('r')) || 3); }
    });
  }

  // ── edges: the engines' own link lists, rendered lines as fallback ────────────────────────
  const edges: Snapshot['edges'] = [];
  const idOf = (v: any): string | null => (v == null ? null : String(typeof v === 'object' ? v.id : v));
  const pushEdge = (d: any): void => {
    if (!d) { return; }
    const a = indexOf.get(idOf(d._s ?? d.source) ?? ''), b = indexOf.get(idOf(d._t ?? d.target) ?? '');
    if (a !== undefined && b !== undefined && a !== b) { edges.push([a, b]); }
  };
  let fromState = false;
  try {
    if (st.layoutEngine === 'shelf' && typeof __fr !== 'undefined' && __fr.intraByFrame) {
      for (const list of __fr.intraByFrame.values()) { for (const l of list) { pushEdge(l); } }
      fromState = true; // drawn lines of the shelf engine = intra-frame links (cross-frame calls are bundles)
    } else if (st.simulation && !st.simulation.isFrameFacade && st.simulation.force) {
      const links = st.simulation.force('link') && st.simulation.force('link').links ? st.simulation.force('link').links() : null;
      if (Array.isArray(links)) { for (const l of links) { pushEdge(l); } fromState = true; }
    }
  } catch { fromState = false; }
  if (!fromState) {
    edges.length = 0;
    (svgEl ? svgEl.querySelectorAll('line') : []).forEach((el) => { if (shown(el)) { pushEdge((el as any).__data__); } });
  }

  // ── labels (screen space, actually painted) ───────────────────────────────
  const labels: Snapshot['labels'] = [];
  let labelsTruncated = false;
  const vw = window.innerWidth, vh = window.innerHeight;
  const texts = svgEl ? svgEl.querySelectorAll('text') : [];
  for (let i = 0; i < texts.length; i++) {
    const el = texts[i];
    if (!el.textContent || !shown(el)) { continue; }
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) { continue; }
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1 || b.right < 0 || b.bottom < 0 || b.left > vw || b.top > vh) { continue; }
    if (labels.length >= opts.maxLabels) { labelsTruncated = true; break; }
    labels.push({ x: b.left, y: b.top, w: b.width, h: b.height });
  }

  // ── folder boxes (screen space; both engines draw .folder-bubble-shape) ───
  const boxes: NonNullable<Snapshot['boxes']> = [];
  (svgEl ? svgEl.querySelectorAll('.folder-bubble-shape') : []).forEach((el) => {
    if (!shown(el)) { return; }
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) { boxes.push({ x: b.left, y: b.top, w: b.width, h: b.height }); }
  });

  const mem = (performance as any).memory;
  return {
    engine: String(st.layoutEngine ?? ''), motion: String(st.layoutMode ?? ''), viewMode: String(st.viewMode ?? 'cluster'),
    zoom: { k: zt.k, x: zt.x, y: zt.y }, viewport: { w: vw, h: vh },
    nodes, frames, slots, edges, labels, boxes, labelsTruncated,
    domNodes: document.querySelectorAll('*').length,
    heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function collectSnapshot(page: Page | Frame, opts: CollectOpts): Promise<Snapshot> {
  return page.evaluate(snapshotInPage, opts);
}
