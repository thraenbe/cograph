import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const frameRenderSrc = fs.readFileSync(
  path.resolve(__dirname, '../../../src/webview/frameRender.js'), 'utf8');

suite('frame title drag — coordinate container (R1 jump fix)', () => {
  test('the title drag is configured with the stable zoomed-layer container', () => {
    const i = frameRenderSrc.indexOf('createFrameTitleDrag(frameDragDeps())');
    assert.ok(i > 0);
    const chain = frameRenderSrc.slice(i, frameRenderSrc.indexOf('.call(titleDrag)', i));
    assert.ok(/\.container\(function \(\) \{ return g\.node\(\); \}\)/.test(chain),
      'without .container(() => g.node()) d3-drag measures the pointer against ' +
      'the dragged frame’s own moving <g> — the traced 249→209→378 leap');
  });
});
