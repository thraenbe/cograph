// In-page geometry snapshot. `snapshotInPage` is serialized by Playwright and
// runs inside the webview, so it must stay self-contained (no imports, no
// outer-scope references). It reads only what is stable across the ux/perf
// refactors: rendered SVG elements + their d3 data, and state.frames rects
// (with a DOM fallback when state.frames is unavailable).
import type { Page } from '@playwright/test';
import type { Snapshot } from './types';

export interface CollectOpts { maxLabels: number }

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const state: any;
declare const nodeRadius: any;
declare const FRAME: any;
declare const SLOT: any;

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

  // ── nodes (rendered + visible only) ───────────────────────────────────────
  const nodes: Snapshot['nodes'] = [];
  const indexOf = new Map<string, number>();
  const els = svgEl ? svgEl.querySelectorAll('circle.regular-node, path.cloud-node, circle.lib-node') : [];
  els.forEach((el) => {
    const d = (el as any).__data__;
    if (!d || d.id === undefined || typeof d.x !== 'number' || typeof d.y !== 'number' || !shown(el)) { return; }
    if (indexOf.has(d.id)) { return; }
    const r = radiusOf ? radiusOf(d) : Number(el.getAttribute('r')) || 3;
    const own = ownerOf.get(d.id);
    indexOf.set(d.id, nodes.length);
    nodes.push({ id: String(d.id), x: d.x, y: d.y, r,
      kind: d.isLibrary ? 'lib' : (d.isCluster || d.isSynthetic || d.isFolderCluster || d.isFileCluster) ? 'cluster' : 'fn',
      file: d.file ?? d._filePath ?? null, frame: own ? own.frame : null, slot: own ? own.slot : null });
  });

  // ── edges (rendered lines with both endpoints visible) ────────────────────
  const edges: Snapshot['edges'] = [];
  const idOf = (v: any): string | null => (v == null ? null : String(typeof v === 'object' ? v.id : v));
  (svgEl ? svgEl.querySelectorAll('line') : []).forEach((el) => {
    const d = (el as any).__data__;
    if (!d || !shown(el)) { return; }
    const a = indexOf.get(idOf(d._s ?? d.source) ?? ''), b = indexOf.get(idOf(d._t ?? d.target) ?? '');
    if (a !== undefined && b !== undefined && a !== b) { edges.push([a, b]); }
  });

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

  const mem = (performance as any).memory;
  return {
    engine: String(st.layoutEngine ?? ''), motion: String(st.layoutMode ?? ''),
    zoom: { k: zt.k, x: zt.x, y: zt.y }, viewport: { w: vw, h: vh },
    nodes, frames, slots, edges, labels, labelsTruncated,
    domNodes: document.querySelectorAll('*').length,
    heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function collectSnapshot(page: Page, opts: CollectOpts): Promise<Snapshot> {
  return page.evaluate(snapshotInPage, opts);
}
