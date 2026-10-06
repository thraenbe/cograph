import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// F27: Shelf replaces link ends with node objects (frameRender stampLinkRefs) before
// renderLinks runs; renderLinks tested the OBJECT against the id set, so every
// in-frame call line started with display:none (1.3.0, measured in the lab: 0 of 79).
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');

suite('F27: Shelf in-frame call lines are painted', () => {
  test('stampLinkRefs hands node objects to renderLinks (the precondition)', () => {
    const fr = read('src/webview/frameRender.js');
    const stamp = fr.indexOf('stampLinkRefs(allLinks, __fr.byId);');
    const render = fr.indexOf("renderLinks(intra.get(f.path) || [], visibleSet, sub.select('g.f-links'))");
    assert.ok(stamp > 0 && render > stamp, 'links are stamped before the per-frame renderLinks');
  });

  test('renderLinks resolves ids before testing visibility', () => {
    const r = read('src/webview/rendering.js');
    assert.ok(r.includes("visibleSet.has(linkEndId(d.source)) && visibleSet.has(linkEndId(d.target))"));
    assert.ok(!/visibleSet\.has\(d\.source\)/.test(r), 'no raw object test left');
    // the helper itself
    const m = r.match(/function linkEndId\(e\) \{[^}]*\}/);
    assert.ok(m, 'linkEndId defined');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const linkEndId = new Function(m![0] + '; return linkEndId;')();
    assert.strictEqual(linkEndId({ id: 'a::f::1' }), 'a::f::1');
    assert.strictEqual(linkEndId('a::f::1'), 'a::f::1');
    assert.strictEqual(linkEndId(null), null);
  });
});
