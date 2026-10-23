import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveTourPackage } from '../../tour/tourModule';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { copyTourPackage, PACKAGE } = require('../../../scripts/copyTourPackage.js');

const REPO = path.resolve(__dirname, '..', '..', '..');

function write(file: string, text = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A fake installed package: dist/host and dist/web as the private build lays them out. */
function installPackage(dir: string): void {
  write(path.join(dir, 'dist', 'host', 'index.js'), 'exports.createTour = () => null;');
  write(path.join(dir, 'dist', 'host', 'index.js.map'), '{}');
  write(path.join(dir, 'dist', 'web', 'tour.js'), '/* tour */');
  write(path.join(dir, 'dist', 'web', 'tour.css'), '/* css */');
  write(path.join(dir, 'dist', 'web', 'tour.js.map'), '{}');
  write(path.join(dir, 'package.json'), '{"name":"@thraenbe/pr-tour","version":"0.1.0"}');
  write(path.join(dir, 'LICENSE'), 'CoGraph PR Tour. All rights reserved.');
}

const listed = (dir: string): string[] => fs.existsSync(dir)
  ? (fs.readdirSync(dir, { recursive: true }) as string[]).map(p => p.split(path.sep).join('/')).sort()
  : [];

suite('build: copyTourPackage (esbuild.js)', () => {
  let root: string;
  const logs: string[] = [];
  const pkgDir = () => path.join(root, 'node_modules', ...String(PACKAGE).split('/'));

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tourcopy-'));
    logs.length = 0;
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test('package present: host and web land in dist/tour, without source maps; the resolver finds the bundled build', () => {
    installPackage(pkgDir());
    assert.strictEqual(copyTourPackage({ root, log: (l: string) => logs.push(l) }), 'copied');
    assert.deepStrictEqual(listed(path.join(root, 'dist', 'tour')), ['LICENSE', 'host', 'host/index.js', 'web', 'web/tour.css', 'web/tour.js']);
    assert.strictEqual(fs.readFileSync(path.join(root, 'dist', 'tour', 'LICENSE'), 'utf8'), 'CoGraph PR Tour. All rights reserved.', 'the notice travels with the component');
    assert.deepStrictEqual(resolveTourPackage(root, { env: {}, resolve: () => { throw new Error('not here'); } }), {
      source: 'bundled', hostEntry: path.join(root, 'dist', 'tour', 'host', 'index.js'),
    });
    assert.ok(logs.some(l => l.includes('copied into dist/tour')));
  });

  test('package absent: nothing is created, a stale dist/tour from an earlier build is removed, the resolver falls back to the stub', () => {
    write(path.join(root, 'dist', 'tour', 'host', 'index.js'), 'stale');
    write(path.join(root, 'dist', 'tour', 'web', 'tour.js'), 'stale');
    write(path.join(root, 'dist', 'extension.js'), 'kept');
    assert.strictEqual(copyTourPackage({ root, log: (l: string) => logs.push(l) }), 'absent');
    assert.strictEqual(fs.existsSync(path.join(root, 'dist', 'tour')), false);
    assert.strictEqual(fs.existsSync(path.join(root, 'dist', 'extension.js')), true, 'only dist/tour is touched');
    assert.strictEqual(resolveTourPackage(root, { env: {}, resolve: () => { throw new Error('not here'); } }), null);
    assert.ok(logs.some(l => l.includes('not installed')));
  });

  test('a package without a LICENSE is still copied, and the missing notice is said', () => {
    installPackage(pkgDir());
    fs.rmSync(path.join(pkgDir(), 'LICENSE'));
    assert.strictEqual(copyTourPackage({ root, log: (l: string) => logs.push(l) }), 'copied');
    assert.strictEqual(fs.existsSync(path.join(root, 'dist', 'tour', 'LICENSE')), false);
    assert.ok(logs.some(l => l.includes('no LICENSE')));
  });

  test('a half package (host without web) counts as absent', () => {
    write(path.join(pkgDir(), 'dist', 'host', 'index.js'), '');
    assert.strictEqual(copyTourPackage({ root }), 'absent');
    assert.strictEqual(fs.existsSync(path.join(root, 'dist', 'tour')), false);
  });

  test('a rebuild replaces dist/tour: a file the new package no longer has does not linger', () => {
    installPackage(pkgDir());
    write(path.join(root, 'dist', 'tour', 'web', 'old-chunk.js'), 'from an older package');
    copyTourPackage({ root });
    assert.strictEqual(fs.existsSync(path.join(root, 'dist', 'tour', 'web', 'old-chunk.js')), false);
  });

  test('a linked package (npm install <folder>) is copied as files, not as a link', function () {
    const real = path.join(root, 'checkout');
    installPackage(real);
    fs.mkdirSync(path.dirname(pkgDir()), { recursive: true });
    try { fs.symlinkSync(real, pkgDir(), 'dir'); } catch { this.skip(); }
    assert.strictEqual(copyTourPackage({ root }), 'copied');
    const copied = path.join(root, 'dist', 'tour', 'host');
    assert.strictEqual(fs.lstatSync(copied).isSymbolicLink(), false);
    assert.strictEqual(fs.readFileSync(path.join(copied, 'index.js'), 'utf8'), 'exports.createTour = () => null;');
  });

  test('packaging keeps dist/tour and the pin lives in package.json', () => {
    const ignore = fs.readFileSync(path.join(REPO, '.vscodeignore'), 'utf8').split(/\r?\n/);
    assert.ok(ignore.includes('!dist/tour/**'));
    assert.ok(!ignore.some(l => /^dist(\/|$)/.test(l.trim())), 'dist itself is never ignored');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require(path.join(REPO, 'package.json'));
    assert.match(pkg.cograph?.tourPackage ?? '', /^\d+\.\d+\.\d+$/);
    assert.strictEqual(pkg.dependencies?.[PACKAGE], undefined, 'the public package.json never lists the private package');
    assert.strictEqual(pkg.devDependencies?.[PACKAGE], undefined);
  });

  test('the release workflow installs the pinned package from GitHub Packages, only when the secret is set', () => {
    const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
    const step = wf.slice(wf.indexOf('- name: Install the PR Tour package'));
    assert.ok(step.length > 0 && wf.includes('- name: Install the PR Tour package'));
    assert.match(step, /if: \$\{\{ env\.TOUR_PACKAGE_TOKEN != '' \}\}/);
    assert.match(step, /TOUR_PACKAGE_TOKEN: \$\{\{ secrets\.TOUR_PACKAGE_TOKEN \}\}/);
    assert.match(step, /npm\.pkg\.github\.com/);
    assert.match(step, /require\('\.\/package\.json'\)\.cograph\.tourPackage/);
    assert.match(step, /npm install --no-save "@thraenbe\/pr-tour@\$\{version\}"/);
    assert.ok(wf.indexOf('- name: Install the PR Tour package') < wf.indexOf('- name: Package extension'), 'installed before the package is bundled');
    assert.ok(!/_authToken=[^$]/.test(wf), 'the token is never written literally');
  });
});
