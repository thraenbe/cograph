import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fc = require('../../../src/webview/frameChrome.js');

suite('frameChrome — tab geometry', () => {
  test('tab height fits inside the 30px title strip the packer reserves', () => {
    assert.ok(fc.TAB.H < 30, `TAB.H must stay under 30, got ${fc.TAB.H}`);
  });

  test('tabWidth caps at 62% of the frame width', () => {
    const w = fc.tabWidth('averyveryverylongfoldername-more-more', 200);
    assert.strictEqual(w, 200 * fc.TAB.MAX_FRAC);
  });

  test('tabWidth scales with the name below the cap', () => {
    const short = fc.tabWidth('abc', 400);
    const long = fc.tabWidth('abcdefgh', 400);
    assert.ok(short < long, 'longer name → wider tab');
    assert.strictEqual(short, 3 * fc.TAB.CHAR_W + fc.TAB.EXTRA);
  });

  test('cutLabel ellipsizes only when needed', () => {
    assert.strictEqual(fc.cutLabel('webview', 10), 'webview');
    assert.strictEqual(fc.cutLabel('graphIntelligence', 8), 'graphIn…');
    assert.strictEqual(fc.cutLabel('ab', 1), 'a…', 'never returns an empty label');
  });

  test('tabChars never drops below one character', () => {
    assert.ok(fc.tabChars(0) >= 1);
    assert.ok(fc.tabChars(fc.tabWidth('a', 400)) >= 1);
  });
});

suite('frameChrome — path builders', () => {
  test('tabBodyPath is a closed path starting at the frame origin edge', () => {
    const d = fc.tabBodyPath(0, 0, 300, 200, 80);
    assert.ok(d.startsWith('M0 '), d.slice(0, 12));
    assert.ok(d.endsWith('Z'));
    // Manila step (R4): the body's top edge right of the flap sits at
    // y = TAB.STEP — a shallow step, NOT a full flap-height (TAB.H) lower.
    assert.ok(d.includes(` ${fc.TAB.STEP}H`), 'shoulder must land on the shallow step');
    assert.ok(!d.includes(` ${fc.TAB.H}H`), 'a full-flap drop would be the old silhouette');
    assert.ok(fc.TAB.STEP < fc.TAB.H, 'the step is shallower than the flap');
    assert.ok(Math.abs(fc.TAB.STEP - fc.TAB.H * 0.35) <= 1, 'step ~ th*0.35 per the sketch');
  });

  test('closed-folder glyph shares the manila silhouette (step present)', () => {
    const d = fc.closedFolderDims(20);
    assert.ok(d.step > 0 && d.step < d.th, 'closed glyph has the same shallow step');
    assert.ok(!fc.closedFolderPath(20).includes('NaN'));
  });

  test('tabBodyPath honours x/y offsets (absolute-coordinate callers)', () => {
    const d = fc.tabBodyPath(50, 70, 300, 200, 80);
    assert.ok(d.startsWith('M50 '), d.slice(0, 12));
    assert.ok(d.includes(`V${70 + 200 - 7}`), 'right edge descends to y+h-r');
  });

  test('tabOnlyPath closes back to the tab origin', () => {
    const d = fc.tabOnlyPath(0, 0, 80);
    assert.ok(d.startsWith(`M0 ${fc.TAB.H}`));
    assert.ok(d.endsWith('Z'));
  });

  test('rectPath is a plain rounded rect (root frame outline)', () => {
    const d = fc.rectPath(0, 0, 100, 60);
    assert.ok(d.startsWith('M8 0H92'));
    assert.ok(d.endsWith('Z'));
  });

  test('closedFolderPath is centred: extents symmetric around 0', () => {
    const d = fc.closedFolderPath(10);
    assert.ok(d.startsWith('M-10 '), d.slice(0, 12));
    assert.ok(d.endsWith('Z'));
  });

  test('closed-folder glyph fits its collision radius (F8)', () => {
    for (const r of [8, 15, 40, 115]) {
      const dims = fc.closedFolderDims(r);
      assert.ok(dims.w / 2 <= r + 1e-9, `half-width <= r at r=${r}`);
      assert.ok(dims.h / 2 <= r + 1e-9, `half-height <= r at r=${r}`);
      assert.ok(dims.w > dims.h, 'still reads as a folder (wider than tall)');
    }
  });

  test('small tab heights shrink radius and shoulder instead of degenerating', () => {
    const d = fc.tabBodyPath(-14, -8.5, 28, 17, 13.4, 7.65);
    assert.ok(!d.includes('NaN'));
    assert.ok(d.endsWith('Z'));
  });
});

suite('frameChrome — fitScale (F6)', () => {
  const W = 1280, H = 800;

  test('a single big glyph is capped by radius, not the 4x scale cap', () => {
    // bbox of one point (bw=bh=0), r=115 — the click Detail-0 case
    const s = fc.fitScale(0, 0, W, H, 115);
    assert.ok(Math.abs(s - (0.35 * H) / 115) < 1e-9, `expected radius cap, got ${s}`);
    assert.ok(s * 115 <= 0.35 * H + 1e-9, 'glyph stays under 35% of the short side');
  });

  test('normal graphs are unaffected (radius cap above the bbox scale)', () => {
    const dense = fc.fitScale(6800, 6800, W, H, 12);
    assert.ok(Math.abs(dense - (H - 120) / 6800) < 1e-9, 'bbox-driven fit unchanged');
    const roomy = fc.fitScale(100, 80, W, H, 12);
    assert.strictEqual(roomy, 4, 'hard cap still applies when nodes are small');
  });

  test('no radius → classic behaviour', () => {
    assert.strictEqual(fc.fitScale(0, 0, W, H, 0), 4);
  });
});

suite('frameChrome — counts', () => {
  test('long form when the strip is wide, short form when narrow', () => {
    assert.strictEqual(fc.countsText(33, 410, 200), '33 files · 410 fns');
    assert.strictEqual(fc.countsText(33, 410, 40), '33 · 410');
    assert.strictEqual(fc.countsText(1, 1, 200), '1 file · 1 fn', 'singulars');
  });

  test('memberCounts: functions counted, clusters not; files deduplicated', () => {
    const members = [
      { id: 'a.ts::f1::1', file: 'a.ts' },
      { id: 'a.ts::f2::2', file: 'a.ts' },
      { id: 'b.ts::g::1', file: 'b.ts' },
      { id: 'file::c.ts', isCluster: true, isFileCluster: true },
      { id: 'folder::/p/sub', isCluster: true, isFolderCluster: true },
    ];
    const c = fc.memberCounts(members);
    assert.strictEqual(c.files, 3, 'a.ts, b.ts and the collapsed c.ts');
    assert.strictEqual(c.fns, 3, 'only parsed functions count');
  });

  test('slotLabelText truncates the name, never the count (B6)', () => {
    assert.strictEqual(fc.slotLabelText('main.js', 5, 160, 5), 'main.js · 5');
    const tight = fc.slotLabelText('averylongfilename.test.ts', 196, 70, 5);
    assert.ok(tight.endsWith(' · 196'), tight);
    assert.ok(tight.length * 5 <= 70, `must fit 70px, got "${tight}"`);
    assert.ok(tight.includes('…'), 'name ellipsized');
  });

  test('slotLabelText keeps at least two name characters', () => {
    const t = fc.slotLabelText('abcdef', 9, 0, 5);
    assert.ok(t.startsWith('a…'), t);
  });

  test('DENSE thresholds exported for the label zoom gate', () => {
    assert.ok(fc.DENSE.SLOT_N >= 1 && fc.DENSE.LABEL_ZOOM > 0);
  });

  test('memberCounts tolerates empty/missing input', () => {
    assert.deepStrictEqual(fc.memberCounts([]), { files: 0, fns: 0 });
    assert.deepStrictEqual(fc.memberCounts(undefined), { files: 0, fns: 0 });
  });
});

suite('R3/R4 render contracts', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs2 = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path2 = require('path');
  const read = (f: string) =>
    fs2.readFileSync(path2.resolve(__dirname, '../../../src/webview/' + f), 'utf8');

  test('cross bundles use the fixed-size user-space marker (R3)', () => {
    const rendering = read('rendering.js');
    const marker = rendering.slice(rendering.indexOf("'arrow-bundle'") - 200,
      rendering.indexOf("'arrow-bundle'") + 600);
    assert.ok(marker.includes("'markerUnits', 'userSpaceOnUse'"),
      'bundle heads must not scale with the 24px bundle strokes');
    const fr = read('frameRender.js');
    const join = fr.slice(fr.indexOf("line.cross-bundle').data(bundles"));
    assert.ok(join.slice(0, 800).includes('url(#arrow-bundle)'),
      'bundles carry the dedicated marker');
    assert.ok(!join.slice(0, 800).includes("url(#arrow)'"),
      'the stroke-scaled #arrow stays off bundles');
  });

  test('the packer reserves the name line above the content (R4)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fr = require('../../../src/webview/frames.js');
    assert.ok(fr.FRAME.NAME_H >= 14, 'one label height reserved');
    const f = { kind: 'folder', abs: { x: 100, y: 200 } };
    const io = fr.innerOrigin(f);
    assert.strictEqual(io.y - f.abs.y, fr.FRAME.PAD + fr.FRAME.TITLE + fr.FRAME.NAME_H,
      'content (and with it the first slot row) starts below the name line');
    // symmetric outer/inner round trip keeps saved rects consistent
    const g2 = { kind: 'folder', inner: { w: 300, h: 200 }, userSize: null };
    const o = fr.outerOf ? fr.outerOf(g2) : null;
    if (o) {
      assert.strictEqual(o.h, 200 + 2 * fr.FRAME.PAD + fr.FRAME.TITLE + fr.FRAME.NAME_H);
    }
  });
});
