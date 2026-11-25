import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphProvider } from '../../graphProvider';
import { configureBrowserServer, stopBrowserServer } from '../../browserView/browserLifetime';
import { openInBrowser } from '../../browserView/openInBrowser';

/* eslint-disable @typescript-eslint/no-explicit-any */

// The Open in browser milestone end to end, inside the real extension host: a real
// GraphProvider and webview panel analysing a small repository, the real loopback
// server, and Chromium (Playwright) driving the tab: the graph renders, a folder
// expands, the hover card gets its source from the host, Save writes the layout.
//
// Opt-in, because it needs Playwright's Chromium:  COGRAPH_BROWSER_E2E=1 npm test
const ENABLED = process.env.COGRAPH_BROWSER_E2E === '1';

// Globals of the stage scripts, referenced by the page-side predicates below (a top-level
// const of a classic script is a global binding, not a window property).
declare const state: any;
declare function fitToView(): void;
const EXT_ROOT = path.resolve(__dirname, '..', '..', '..');

const FILES: Record<string, string> = {
  'src/app.ts': 'import { helper } from "./lib/util";\nexport function main() {\n  return helper(2);\n}\n',
  'src/lib/util.ts': 'export function helper(n: number) {\n  return twice(n) + 1;\n}\nexport function twice(n: number) {\n  return n * 2;\n}\n',
  'src/lib/more.ts': 'export function other() {\n  return 1;\n}\n',
};

(ENABLED ? suite : suite.skip)('browserView: Open in browser end to end (real host, Chromium)', function () {
  this.timeout(120_000);
  let sandbox: sinon.SinonSandbox;
  let root: string;
  let provider: GraphProvider;
  let browser: any;

  setup(() => {
    sandbox = sinon.createSandbox();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-e2e-'));
    for (const [rel, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    configureBrowserServer({ extensionRoot: EXT_ROOT, log: () => undefined });
    const ctx = { extensionPath: EXT_ROOT, extensionUri: vscode.Uri.file(EXT_ROOT) } as unknown as vscode.ExtensionContext;
    provider = new GraphProvider(ctx, { root, title: 'CoGraph e2e' });
  });

  teardown(async () => {
    await browser?.close();
    provider.close();
    await stopBrowserServer();
    sandbox.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the tab shows the graph; expand, hover and save work through the host', async () => {
    let opened = '';
    sandbox.stub(vscode.env, 'openExternal').callsFake(async (u: vscode.Uri) => { opened = u.toString(true); return true; });
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    sandbox.stub(vscode.window, 'showInputBox').resolves('e2e layout');
    await openInBrowser(provider);
    assert.match(opened, /^http:\/\/127\.0\.0\.1:\d+\/view\/view-\d+\?token=[0-9a-f]{64}$/, 'a provider with its own root is its own view');

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require('@playwright/test');
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(opened);
    // Function predicates only: a string would be eval'd in the page, which its CSP (rightly) refuses.
    await page.waitForFunction(() => typeof state !== 'undefined' && state.currentNodes && state.currentNodes.length > 0, undefined, { timeout: 60_000 });
    assert.strictEqual(provider.browserTabs(), 1);

    // Expand: Detail 1 opens every folder; the functions of util.ts are on the stage.
    await page.evaluate(() => {
      const s = document.getElementById('slider-complexity') as HTMLInputElement;
      s.value = '1';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => state.currentNodes.some((n: any) => String(n.id).includes('::twice::'))
      && document.querySelectorAll('#graph circle.regular-node').length >= 3, undefined, { timeout: 30_000 })
      .catch(async (err: Error) => {
        const seen = await page.evaluate(() => ({
          current: state.currentNodes.map((n: any) => n.name ?? n.id), circles: document.querySelectorAll('#graph circle.regular-node').length,
          data: (state.graphData?.nodes ?? []).map((n: any) => n.name), expanded: [...state.expandedFolders], depth: state.detailDepth,
          bridge: (window as any).__cographBridge?.errors,
        }));
        throw new Error(`${err.message}; stage: ${JSON.stringify(seen)}`);
      });
    await page.evaluate(() => fitToView());
    await page.waitForTimeout(800);

    // Hover: the card asks the real host for the function's first lines (funcBrief) and shows them.
    const spot = await page.evaluate(() => {
      const el = [...document.querySelectorAll('#graph circle.regular-node')].find(c => String((c as any).__data__?.id ?? '').includes('::helper::')) as Element | undefined;
      if (!el) { return null; }
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    assert.ok(spot, 'helper is rendered');
    await page.mouse.move(spot.x, spot.y, { steps: 6 });
    await page.waitForFunction(() => (document.querySelector('.hover-card.visible')?.textContent || '').includes('twice(n)'), undefined, { timeout: 15_000 });

    // Save: the layout the tab shows is written by the host.
    await page.mouse.move(5, 5);
    await page.click('#btn-save-graph');
    const saved = path.join(root, '.cograph', 'e2e layout.json');
    const t0 = Date.now();
    while (!fs.existsSync(saved) && Date.now() - t0 < 15_000) { await new Promise(r => setTimeout(r, 100)); }
    assert.ok(fs.existsSync(saved), 'Save Layout in the tab wrote the layout');
    const layout = JSON.parse(fs.readFileSync(saved, 'utf8'));
    assert.ok(Object.keys(layout.nodePositions ?? {}).length >= 3);
    assert.deepStrictEqual(errors, []);

    await page.screenshot({ path: path.join(os.tmpdir(), 'cograph-browser-e2e.png') });
  });
});
