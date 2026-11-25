import * as assert from 'assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { getWebviewHtml, WebviewHtmlOptions } from '../../webviewHtmlBuilder';

// The page VS Code shows, byte for byte. The hashes below were taken from getWebviewHtml before its
// template moved to stagePage.ts, so that move had to leave every one of them alone. Changing the page
// on purpose changes a hash here too: the assertion prints the new value, and the diff that needs
// reviewing is the template's, not this table.
// Changed on purpose twice since: stageLabels.js before stageApi.js (tour pin), and main 1.4.4's page
// merged in (legend, search bar, Settings without Filters, xfileGlyph.js, searchBar.js, pinnedCards.js).
// Checked then: main's panel page is kept whole; the merge only adds the tour line's tour pill, Open in
// browser, stageLabels.js and stageApi.js.

const inject: WebviewHtmlOptions['inject'] = (nonce) => ({
  head: '<style>/* head */</style>',
  before: `<script nonce="${nonce}">/* before */</script>`,
  after: `<script nonce="${nonce}" src="after.js"></script>`,
});

const OTHER_SETTINGS = {
  'layout.defaultEngine': 'global',
  'layout.defaultMode': 'dynamic',
  'debug.perfLog': true,
  'layout.workers': 'off',
  'display.sameFileEdgesOnly': false,
};

interface Variant {
  name: string;
  options: WebviewHtmlOptions;
  /** dist/webview holds d3 and the worker, as after `npm run bundle`. */
  bundled: boolean;
  settings?: Record<string, unknown>;
  sha256: string;
}

const VARIANTS: Variant[] = [
  { name: 'panel, unbundled', options: {}, bundled: false, sha256: '297fd802941d899cb0e528f98fe902abe062d314dafe05d2c5163cea679a475a' },
  { name: 'panel, bundled', options: {}, bundled: true, sha256: '73c48a93b0ab400a6d2c6e522402312a0d69470af4e51c4fe64b46f22283ffbc' },
  { name: 'panel, every setting off its default', options: {}, bundled: true, settings: OTHER_SETTINGS, sha256: 'a2287a19591b35813fb2017b38039edb87643adc27e9634dd63ebfce5ee53e04' },
  { name: 'timeline panel', options: { timelineMode: true }, bundled: true, sha256: '5cc1064265a645a9fac65428c4917fe80170828f1944f469a26a2ae0fcb9637e' },
  { name: 'browser tab, dark, injected tags', options: { transport: 'browser', theme: 'dark', inject }, bundled: true, sha256: '1e1e9e9d120287b1653361814892e94e2f1b844f9a60bc763780f093d82e30ba' },
  { name: 'browser tab, light, unbundled', options: { transport: 'browser', theme: 'light', inject }, bundled: false, sha256: '2083ed9da620a9c5c09a41dafb7c27ccf55b46850fd39acdb5d2a3c729156830' },
  { name: 'browser tab, no theme given', options: { transport: 'browser' }, bundled: true, sha256: '6d83f926c3a17789ee9a342e5e10028cd079ea45277c20c9db95ed9ab3852f6d' },
];

suite('webview HTML: byte-identical page', () => {
  const sandbox = sinon.createSandbox();
  let dir: string;

  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-golden-')); });
  teardown(() => { sandbox.restore(); fs.rmSync(dir, { recursive: true, force: true }); });

  /** Every resource URL is stable: the temporary extension root is gone from it. */
  function webview(): vscode.Webview {
    const asWebviewUri = (u: vscode.Uri) => ({ toString: () => `https://webview.test${u.path.slice(vscode.Uri.file(dir).path.length)}` });
    return { asWebviewUri, cspSource: 'https://webview.test' } as unknown as vscode.Webview;
  }

  function render(variant: Variant): string {
    if (variant.bundled) {
      fs.mkdirSync(path.join(dir, 'dist', 'webview'), { recursive: true });
      for (const file of ['d3.min.js', 'simWorker.js']) { fs.writeFileSync(path.join(dir, 'dist', 'webview', file), ''); }
    }
    const settings = variant.settings ?? {};
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((() => ({
      get: <T>(key: string, fallback: T): T => (key in settings ? settings[key] as T : fallback),
    })) as unknown as typeof vscode.workspace.getConfiguration);
    return getWebviewHtml(webview(), vscode.Uri.file(dir), variant.options);
  }

  for (const variant of VARIANTS) {
    test(variant.name, () => {
      const html = render(variant);
      const nonce = /'nonce-([0-9a-f]{32})'/.exec(html)?.[1];
      assert.ok(nonce, 'the page has a nonce');
      const stable = html.split(nonce).join('NONCE');
      assert.strictEqual(crypto.createHash('sha256').update(stable).digest('hex'), variant.sha256);
    });
  }
});
