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

  test('declares cograph.debug.perfLog boolean setting, default false', () => {
    const prop = pkg.contributes?.configuration?.properties?.['cograph.debug.perfLog'];
    assert.ok(prop, 'cograph.debug.perfLog setting missing');
    assert.strictEqual(prop.type, 'boolean');
    assert.strictEqual(prop.default, false);
  });

  test('declares the two layout axes: defaultEngine (shelf) and defaultMode (static)', () => {
    const engine = pkg.contributes?.configuration?.properties?.['cograph.layout.defaultEngine'];
    assert.ok(engine, 'cograph.layout.defaultEngine setting missing');
    assert.deepStrictEqual(engine.enum, ['shelf', 'global']);
    assert.strictEqual(engine.default, 'shelf');
    const mode = pkg.contributes?.configuration?.properties?.['cograph.layout.defaultMode'];
    assert.ok(mode, 'cograph.layout.defaultMode setting missing');
    assert.deepStrictEqual(mode.enum, ['dynamic', 'static']);
    assert.strictEqual(mode.default, 'static');
    assert.strictEqual(
      pkg.contributes?.configuration?.properties?.['cograph.layout.engine'],
      undefined,
      'the pre-release cograph.layout.engine setting must be removed',
    );
  });

  test('declares the cograph.dev.loadSynthetic command', () => {
    const cmds = pkg.contributes?.commands ?? [];
    assert.ok(
      cmds.some((c: { command: string }) => c.command === 'cograph.dev.loadSynthetic'),
      'cograph.dev.loadSynthetic command missing',
    );
  });

  test('declares the Annotate Graph command, activation event and settings', () => {
    const cmds = pkg.contributes?.commands ?? [];
    assert.ok(cmds.some((c: { command: string }) => c.command === 'cograph.annotateGraph'), 'command missing');
    assert.ok(pkg.activationEvents.includes('onCommand:cograph.annotateGraph'), 'activation event missing');
    const props = pkg.contributes.configuration.properties;
    assert.strictEqual(props['cograph.graphIntelligence.annotate.readSource'].default, false, 'source reading must be opt-in');
    assert.match(props['cograph.graphIntelligence.annotate.readSource'].markdownDescription, /No function bodies/);
    assert.strictEqual(props['cograph.graphIntelligence.annotate.model'].default, 'haiku');
    assert.strictEqual(props['cograph.graphIntelligence.annotate.codex.model'].default, 'gpt-5-mini');
    assert.strictEqual(props['cograph.graphIntelligence.annotate.maxRunBudgetUsd'].default, 2);
  });

  test("'Open or Reset Layout' title with the UNCHANGED command id", () => {
    const cmds = pkg.contributes?.commands ?? [];
    const cmd = cmds.find((c: { command: string }) => c.command === 'cograph.openOrReload');
    assert.ok(cmd, 'cograph.openOrReload must keep its id — keybindings/users depend on it');
    assert.strictEqual(cmd.title, 'CoGraph: Open or Reset Layout',
      "the command opens a FRESH layout; 'Reload' read like loading a saved graph");
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

  test('declares cograph.layout.workers (auto | on | off, default auto)', () => {
    const w = pkg.contributes?.configuration?.properties?.['cograph.layout.workers'];
    assert.ok(w, 'cograph.layout.workers setting missing');
    assert.deepStrictEqual(w.enum, ['auto', 'on', 'off']);
    assert.strictEqual(w.default, 'auto');
    assert.strictEqual(w.enumDescriptions.length, 3);
  });
});
