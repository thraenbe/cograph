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
  { name: 'panel, unbundled', options: {}, bundled: false, sha256: '52d08d12ff72be6dea9d57de4f5511c9cd69ae7abc81388d0a42713f90460b01' },
  { name: 'panel, bundled', options: {}, bundled: true, sha256: 'ec1a8547a30d98bf0b2b89602261d853998520365ff5df43567e8374782a5d3c' },
  { name: 'panel, every setting off its default', options: {}, bundled: true, settings: OTHER_SETTINGS, sha256: '1843e7070d6dca094f1199e0a6185302b664cc6c44aae126d3e2d01bc29ecebb' },
  { name: 'timeline panel', options: { timelineMode: true }, bundled: true, sha256: '4039a115eff5eb8f6053dfdc022f66f609cc3c52518b3706951090125a630769' },
  { name: 'browser tab, dark, injected tags', options: { transport: 'browser', theme: 'dark', inject }, bundled: true, sha256: '39b6edd3ec48d5ac9a82f34b42afaa9957667633cbcd4f72481190e7fbf5e971' },
  { name: 'browser tab, light, unbundled', options: { transport: 'browser', theme: 'light', inject }, bundled: false, sha256: '6a6261a8fe1a76f7aa457bef38d30919e1e98c2f7462d5aaf86fcf9667f3e34f' },
  { name: 'browser tab, no theme given', options: { transport: 'browser' }, bundled: true, sha256: '727154f8b5e6b27984c9e709530c1e0d4c676d30d1d6a95a66935a0c43f821dd' },
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
