import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Static assertions about package.json contribution points for the Activity
// Bar sidebar. Encodes the invariant that the activitybar icon MUST be a
// string path (an {light,dark} object here is silently rejected by VS Code).
// ---------------------------------------------------------------------------

const repoRoot = path.join(__dirname, '..', '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require(path.join(repoRoot, 'package.json'));

suite('package.json contributions', () => {
  test('activationEvents includes onView:cograph.savedGraphs', () => {
    assert.ok(
      Array.isArray(pkg.activationEvents),
      'activationEvents should be an array',
    );
    assert.ok(
      pkg.activationEvents.includes('onView:cograph.savedGraphs'),
      'activationEvents must contain onView:cograph.savedGraphs',
    );
  });

  test('viewsContainers.activitybar declares cograph-sidebar', () => {
    const bars = pkg.contributes?.viewsContainers?.activitybar;
    assert.ok(Array.isArray(bars) && bars.length > 0, 'activitybar container missing');
    const bar = bars[0];
    assert.strictEqual(bar.id, 'cograph-sidebar');
    assert.strictEqual(bar.title, 'Cograph');
  });

  test('activitybar icon is a string path (not an {light,dark} object)', () => {
    const bar = pkg.contributes.viewsContainers.activitybar[0];
    assert.strictEqual(
      typeof bar.icon,
      'string',
      'activitybar icon must be a string path — {light,dark} objects are silently rejected by VS Code',
    );
  });

  test('referenced activity-bar icon file exists on disk', () => {
    const bar = pkg.contributes.viewsContainers.activitybar[0];
    const iconPath = path.join(repoRoot, bar.icon.replace(/^\.\//, ''));
    assert.ok(fs.existsSync(iconPath), `icon file missing at ${iconPath}`);
  });

  test('views.cograph-sidebar declares cograph.savedGraphs webview', () => {
    const views = pkg.contributes?.views?.['cograph-sidebar'];
    assert.ok(Array.isArray(views) && views.length > 0, 'cograph-sidebar views missing');
    const view = views[0];
    assert.strictEqual(view.id, 'cograph.savedGraphs');
    assert.strictEqual(view.type, 'webview');
    assert.strictEqual(view.name, 'Cograph');
  });

  test('view id matches SidebarProvider.viewType', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SidebarProvider } = require('../../sidebarProvider');
    const view = pkg.contributes.views['cograph-sidebar'][0];
    assert.strictEqual(
      view.id,
      SidebarProvider.viewType,
      'package.json view id must match SidebarProvider.viewType or the view will never resolve',
    );
  });
});
