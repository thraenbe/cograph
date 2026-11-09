// Global + Static: the drill-down folder boxes must get their geometry on the render that creates them.
// A static simulation paints once inside startSimulation(), before the overlays of that render exist, and
// never ticks again. Before the fix every box stayed 0×0 (express, Detail 0.6: 30 boxes, none drawn),
// so the folders could not be seen or dragged (Tier B f14-restore skipped "Drag one folder by its title").
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openLab } from '../lib/lab';
import { setSlider } from '../lib/actions';

/** Runs in the page: size of every drill-down box titlebar and whether its centre hits it. */
function boxTitlebars(): { path: string; w: number; h: number; hittable: boolean }[] {
  return [...document.querySelectorAll('#graph g.folder-bubble')].map(g => {
    const bar = g.querySelector('.folder-bubble-titlebar') as SVGGraphicsElement;
    const b = bar.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { path: String((g as unknown as { __data__?: { folderPath?: string } }).__data__?.folderPath ?? ''), w: b.width, h: b.height, hittable: hit === bar };
  });
}

test('Global + Static draws the drill-down folder boxes as soon as they are created', async ({ browser }) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-global-static-'));
  const lab = await openLab({ repo: 'synthetic-1k', engine: 'global', motion: 'static', scenario: 'global-static-boxes', browser, outDir, video: false });
  try {
    await setSlider(lab.page, 'detailSlider', 0.6);
    await lab.page.waitForTimeout(500);
    const mode = await lab.page.evaluate('({ engine: state.layoutEngine, motion: state.layoutMode, drill: isDrilldown() })');
    expect(mode).toEqual({ engine: 'global', motion: 'static', drill: true });
    const boxes = await lab.page.evaluate(boxTitlebars);
    expect(boxes.length, 'Detail 0.6 opens folders, each gets a box').toBeGreaterThan(0);
    expect(boxes.filter(b => b.w < 1 || b.h < 1).map(b => b.path), 'boxes left without geometry').toEqual([]);
    expect(boxes.some(b => b.hittable), 'at least one folder title can be grabbed').toBe(true);
  } finally {
    await lab.close();
  }
});
