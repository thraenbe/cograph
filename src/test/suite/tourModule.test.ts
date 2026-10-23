import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { STUB_SENTENCE, loadTourHost, resolveTourPackage } from '../../tour/tourModule';
import type { TourHostApi } from '../../tour/tourApi';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A host entry that records the api it got and returns `host` (or throws). */
function hostSource(body: string): string {
  return `exports.createTour = function (api) { ${body} };\n`;
}
const OK_HOST = 'return { version: 1, routes: [], webAssetsDir: __dirname + "/../web", prepare: async () => ({}), dispose() {}, got: api.version };';

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

suite('tour — the private package resolver and its stub', () => {
  let root: string;
  let ext: string;
  let dev: string;
  const api = { version: 1 } as unknown as TourHostApi;
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-tourmod-'));
    ext = path.join(root, 'ext');
    dev = path.join(root, 'private');
    fs.mkdirSync(ext);
    logs.length = 0;
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  const bundle = (body = OK_HOST) => { write(path.join(ext, 'dist/tour/host/index.js'), hostSource(body)); fs.mkdirSync(path.join(ext, 'dist/tour/web'), { recursive: true }); };
  const devBuild = (body = OK_HOST) => { write(path.join(dev, 'dist/host/index.js'), hostSource(body)); fs.mkdirSync(path.join(dev, 'dist/web'), { recursive: true }); };
  const nodeModules = () => {
    const pkg = path.join(ext, 'node_modules/@thraenbe/pr-tour');
    write(path.join(pkg, 'package.json'), JSON.stringify({ name: '@thraenbe/pr-tour', version: '0.1.0', exports: { './host': './dist/host/index.js' } }));
    write(path.join(pkg, 'dist/host/index.js'), hostSource(OK_HOST));
  };

  test('nothing installed: null, and the stub sentence the entry points show', () => {
    assert.strictEqual(resolveTourPackage(ext, { env: {} }), null);
    assert.strictEqual(loadTourHost(api, ext, { env: {}, log }), null);
    assert.strictEqual(STUB_SENTENCE, 'The PR tour is part of the Marketplace build of CoGraph.');
    assert.deepStrictEqual(logs, [], 'the stub is the normal public build, not a problem');
  });

  test('order: the packaged build, then COGRAPH_TOUR_PACKAGE, then node_modules', () => {
    nodeModules();
    assert.strictEqual(resolveTourPackage(ext, { env: {} })?.source, 'node_modules');
    devBuild();
    assert.strictEqual(resolveTourPackage(ext, { env: { COGRAPH_TOUR_PACKAGE: dev } })?.source, 'env');
    bundle();
    const first = resolveTourPackage(ext, { env: { COGRAPH_TOUR_PACKAGE: dev } });
    assert.deepStrictEqual(first, { source: 'bundled', hostEntry: path.join(ext, 'dist/tour/host/index.js') });
  });

  test('a rung without its web assets does not count', () => {
    write(path.join(ext, 'dist/tour/host/index.js'), hostSource(OK_HOST));
    write(path.join(dev, 'dist/host/index.js'), hostSource(OK_HOST));
    assert.strictEqual(resolveTourPackage(ext, { env: { COGRAPH_TOUR_PACKAGE: dev } }), null);
  });

  test('a loaded host gets the api and hands back its web assets directory', () => {
    devBuild();
    const loaded = loadTourHost(api, ext, { env: { COGRAPH_TOUR_PACKAGE: dev }, log });
    assert.ok(loaded);
    assert.strictEqual(loaded.source, 'env');
    assert.strictEqual((loaded.host as any).got, 1, 'createTour received the api');
    // Node loads a module through its real path (macOS: /var/folders → /private/var/folders), so the host's
    // __dirname-based directory is compared by real path, as the server serves it.
    assert.strictEqual(fs.realpathSync(loaded.webAssetsDir), fs.realpathSync(path.join(dev, 'dist/web')));
    assert.deepStrictEqual(logs, ['[tour] tour package loaded (env)']);
  });

  test('TourApiMismatch, a failing start, a bad host and a broken module all fall back to the stub, logged', () => {
    const cases: Array<[string, RegExp]> = [
      ['const e = new Error("api 1, package wants 2"); e.name = "TourApiMismatch"; throw e;', /another contract version \(api 1, package wants 2\)/],
      ['throw new Error("boom");', /failed to start: boom/],
      ['return { version: 2, routes: [], webAssetsDir: "/x", prepare() {} };', /no usable host/],
      ['return null;', /no usable host/],
    ];
    for (const [body, expected] of cases) {
      const dir = fs.mkdtempSync(path.join(root, 'case-'));
      write(path.join(dir, 'dist/host/index.js'), hostSource(body));
      fs.mkdirSync(path.join(dir, 'dist/web'), { recursive: true });
      logs.length = 0;
      assert.strictEqual(loadTourHost(api, ext, { env: { COGRAPH_TOUR_PACKAGE: dir }, log }), null, body);
      assert.match(logs.join('\n'), expected);
    }
    logs.length = 0;
    assert.strictEqual(loadTourHost(api, ext, { env: { COGRAPH_TOUR_PACKAGE: dev }, log, exists: () => true, load: () => { throw new Error('syntax'); } }), null);
    assert.match(logs[0], /could not be loaded: syntax/);
    logs.length = 0;
    assert.strictEqual(loadTourHost(api, ext, { env: { COGRAPH_TOUR_PACKAGE: dev }, log, exists: () => true, load: () => ({}) }), null);
    assert.match(logs[0], /exports no createTour/);
  });
});
