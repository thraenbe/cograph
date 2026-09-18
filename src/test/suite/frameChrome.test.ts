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
    // body top edge sits at y = TAB.H (the shoulder curve descends th)
    assert.ok(d.includes(` ${fc.TAB.H}H`), 'shoulder must land on the body top edge');
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
    assert.ok(d.startsWith(`M${-(2.8 * 10) / 2} `), d.slice(0, 12));
    assert.ok(d.endsWith('Z'));
  });

  test('small tab heights shrink radius and shoulder instead of degenerating', () => {
    const d = fc.tabBodyPath(-14, -8.5, 28, 17, 13.4, 7.65);
    assert.ok(!d.includes('NaN'));
    assert.ok(d.endsWith('Z'));
  });
});

suite('frameChrome — counts', () => {
  test('long form when the strip is wide, short form when narrow', () => {
    assert.strictEqual(fc.countsText(33, 410, 200), '33 files · 410 fns');
    assert.strictEqual(fc.countsText(33, 410, 40), '33 · 410');
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
