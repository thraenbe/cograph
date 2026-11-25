import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import * as zlib from 'zlib';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildStage } = require('../../../scripts/build-stage.js');

const GZ_BUDGET_BYTES = 300 * 1000;

suite('build-stage.js: dist/stage', function () {
  this.timeout(30_000);
  let dir: string;
  let manifest: { format: number; files: Record<'bridge' | 'stage' | 'css' | 'worker', string>; afterStage: string };
  let html: string;
  const read = (name: string): string => fs.readFileSync(path.join(dir, name), 'utf8');

  suiteSetup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-stage-'));
    manifest = buildStage(path.join(dir, 'a'));
    dir = path.join(dir, 'a');
    html = read('index.html');
  });
  suiteTeardown(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

  test('stage.json on disk is the manifest, and names what is there, no more', () => {
    assert.deepStrictEqual(JSON.parse(read('stage.json')), manifest);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), [...Object.values(manifest.files), 'index.html', 'stage.json'].sort());
    assert.match(manifest.files.stage, /^stage\.[0-9a-f]{12}\.js$/);
    assert.match(manifest.files.css, /^stage\.[0-9a-f]{12}\.css$/);
  });

  test('no inline script and no event attribute: script-src is self alone', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.deepStrictEqual(scripts.map(m => /src="([^"]+)"/.exec(m[1])?.[1]), [manifest.files.bridge, manifest.files.stage]);
    assert.ok(scripts.every(m => m[2] === ''));
    assert.ok(!/\son[a-z]+\s*=/i.test(html));
    assert.ok(!html.includes('nonce'));
  });

  test('the marker is there once, right after the stage tag, and the html line is literal', () => {
    assert.strictEqual(html.split(manifest.afterStage).length, 2);
    assert.ok(html.includes(`<script src="${manifest.files.stage}"></script>\n  ${manifest.afterStage}\n</body>`));
    assert.ok(html.includes('\n<html lang="en">\n'));
    assert.ok(html.includes('<body class="cg-browser">'));
    assert.ok(html.includes(`<meta name="cograph-worker" content="${manifest.files.worker}" />`));
    assert.ok(!html.includes('id="btn-open-browser"'), 'a static page opens no second copy of itself');
  });

  test('the meta CSP is delivery\'s without what a meta tag cannot carry', () => {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /worker-src blob:/);
    assert.match(csp, /base-uri 'none'/);
    assert.ok(!csp.includes('sandbox') && !csp.includes('frame-ancestors') && !csp.includes('unsafe-eval'));
  });

  test('the stage is one script that parses, d3 first with its copyright, stageApi last', () => {
    const text = read(manifest.files.stage);
    assert.doesNotThrow(() => new vm.Script(text));
    assert.ok(text.startsWith('// https://d3js.org'));
    const marks = ['const state=', 'function installSeqDedupe', 'function createHoverCard', 'function bootStageApi'].map(m => text.indexOf(m));
    assert.ok(marks.every(i => i > 0), marks.join());
    assert.deepStrictEqual([...marks].sort((a, b) => a - b), marks);
  });

  test('stripping whitespace renamed nothing the tour layer or a test reads', () => {
    const text = read(manifest.files.stage);
    for (const name of ['stageApi', 'acquireVsCodeApi', 'applyFileClusters', 'renderGraph']) { assert.ok(text.includes(name), name); }
  });

  test('the bridge carries docsUrl in front of it, and no directive leaks over the file', () => {
    const text = read(manifest.files.bridge);
    assert.doesNotThrow(() => new vm.Script(text));
    assert.ok(text.indexOf('CoGraphDocs') < text.indexOf('function installStaticBridge'));
    assert.ok(!text.trimStart().startsWith('"use strict"'));
  });

  test('the css holds both theme sets ahead of the stage\'s own rules', () => {
    const text = read(manifest.files.css);
    assert.ok(text.includes('--vscode-editor-background: #1f1f1f;'));
    assert.match(text, /@media \(prefers-color-scheme: light\) \{ :root \{[^}]*--vscode-editor-background: #ffffff;/);
    assert.ok(text.indexOf('@media (prefers-color-scheme: light)') < text.indexOf('body.vscode-light'));
  });

  test('nothing the page loads names the storage or the origin the sandbox takes away', () => {
    for (const name of fs.readdirSync(dir)) {
      const text = read(name);
      assert.ok(!text.includes('sessionStorage'), name);
      assert.ok(!text.includes('location.origin'), name);
    }
  });

  test('two builds are byte-identical', () => {
    const again = path.join(path.dirname(dir), 'b');
    buildStage(again);
    assert.deepStrictEqual(fs.readdirSync(again).sort(), fs.readdirSync(dir).sort());
    for (const name of fs.readdirSync(dir)) { assert.ok(fs.readFileSync(path.join(again, name)).equals(fs.readFileSync(path.join(dir, name))), name); }
  });

  test('a rebuild into a used folder leaves no stale file', () => {
    const used = path.join(path.dirname(dir), 'c');
    fs.mkdirSync(used);
    fs.writeFileSync(path.join(used, 'stage.old.js'), '');
    buildStage(used);
    assert.ok(!fs.existsSync(path.join(used, 'stage.old.js')));
  });

  test('under 300 KB gzipped', () => {
    const total = fs.readdirSync(dir).reduce((sum, name) => sum + zlib.gzipSync(fs.readFileSync(path.join(dir, name)), { level: 9 }).length, 0);
    assert.ok(total < GZ_BUDGET_BYTES, `${total} bytes`);
  });
});

suite('packaging: the static stage stays out of the extension', () => {
  test('.vscodeignore drops dist/stage', () => {
    const lines = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '.vscodeignore'), 'utf8').split('\n');
    assert.ok(lines.includes('dist/stage/**'));
  });
});
