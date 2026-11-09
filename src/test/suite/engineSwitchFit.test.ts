import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// main.js cannot be require()d (top-level DOM wiring); the behaviour itself is covered in the browser by
// uxtest/unit/engineSwitchFit.test.ts. This contract keeps the reset in the place CI can see it.
const mainSrc = fs.readFileSync(path.resolve(__dirname, '../../../src/webview/main.js'), 'utf8');

suite('engine switch fits the new layout (source contract)', () => {
  test('setLayoutEngine clears hasFitted and userZoomed before it re-renders', () => {
    // Without the hasFitted reset Shelf kept Global's zoom transform unless its frames overflowed the view
    // by 30 %: synthetic-1k ended with 26 % of its nodes off screen, zod with all of them.
    const fn = mainSrc.slice(mainSrc.indexOf('function setLayoutEngine'), mainSrc.indexOf('updateLayoutButtons(); // boot config'));
    const render = fn.indexOf('applyComplexity()');
    const fitted = fn.indexOf('state.hasFitted = false');
    const zoomed = fn.indexOf('state.userZoomed = false');
    assert.ok(render > 0, 'setLayoutEngine re-renders through applyComplexity()');
    assert.ok(fitted > 0 && fitted < render, 'hasFitted is cleared before the re-render');
    assert.ok(zoomed > 0 && zoomed < render, 'userZoomed is cleared before the re-render');
  });
});
