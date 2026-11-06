// locateNode() must only return a point that really hits the node: a node under the controls panel cannot be
// hovered. zod, hover-card step 8: the largest collapsed folder glyph sat under the panel, the pointer rested
// on the panel and the step reported a missing hover card.
import { test, expect, type Page } from '@playwright/test';
import { locateNode } from '../lib/actions';
import { SkipStep } from '../lib/step';

/** Two collapsed-folder glyphs; the larger one at the left, where the panel can cover it. */
async function stage(page: Page, panel: boolean): Promise<void> {
  await page.setViewportSize({ width: 800, height: 500 });
  await page.setContent(`<!doctype html><html><body style="margin:0">
    <div id="graph"><svg width="800" height="500">
      <path class="cloud-node" id="big" d="M 40 200 h 120 v 80 h -120 z" fill="#c33"></path>
      <path class="cloud-node" id="small" d="M 500 200 h 40 v 30 h -40 z" fill="#c33"></path>
      <path class="cloud-node" id="lone" d="M 60 420 h 40 v 30 h -40 z" fill="#c33"></path>
    </svg></div>
    ${panel ? '<div id="controls" style="position:fixed;left:0;top:0;width:200px;height:500px;background:#222"></div>' : ''}
  </body></html>`);
  await page.evaluate(() => {
    const data: Record<string, { id: string; name: string; isFolderCluster: boolean; count: number }> = {
      big: { id: 'folder::big', name: 'big', isFolderCluster: true, count: 50 },
      small: { id: 'folder::small', name: 'small', isFolderCluster: true, count: 5 },
      lone: { id: 'folder::lone', name: 'lone', isFolderCluster: true, count: 1 },
    };
    for (const [el, d] of Object.entries(data)) { (document.getElementById(el) as unknown as { __data__: unknown }).__data__ = d; }
  });
}

test.describe('locateNode picks only nodes a pointer can reach', () => {
  test('the largest glyph under the controls panel is passed over for one in the open', async ({ page }) => {
    await stage(page, true);
    const hit = await locateNode(page, { kind: 'folder', pick: 'largest' });
    expect(hit.id).toBe('folder::small');
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [hit.x, hit.y])).toBe('small');
  });

  test('without the panel the largest glyph wins (the pick rule itself is unchanged)', async ({ page }) => {
    await stage(page, false);
    expect((await locateNode(page, { kind: 'folder', pick: 'largest' })).id).toBe('folder::big');
  });

  test('a node that is only under the panel is a skip, not a point on the panel', async ({ page }) => {
    await stage(page, true);
    await expect(locateNode(page, { kind: 'folder', id: 'folder::lone' })).rejects.toBeInstanceOf(SkipStep);
  });
});
