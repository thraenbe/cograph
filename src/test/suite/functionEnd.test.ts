/**
 * N1 (PR tour review round 2, 16.11.2026): a function ends at its own closing token, not at the
 * next definition. Before, the last function of a file (or of a class, before the next class)
 * ran on to the next definition or to the end of the file, so a module-level line appended after
 * it counted inside it: graphDiff called it "changed", and GitService marked it modified.
 * Shapes from cograph-lab/pr-tour-test PR 3 (web/app.js, web/discounts.js) and PR 2 (shop/tax.py).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { diffGraphs, type DiffTree } from '../../vcs/engine/graphDiff';
import { GitService } from '../../gitService';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
const js = require('../../../scripts/analyze_js.js');

const APP_BASE = [
  'function render() {', "  const lines = document.getElementById('lines');", '  lines.textContent = total();', '}', '',
  'renderProducts();', 'render();', '',
].join('\n');
const APP_HEAD = [
  'function render() {', "  const lines = document.getElementById('lines');", '  lines.textContent = total();', '}', '',
  'renderProducts();', "document.getElementById('coupon-form').addEventListener('submit', applyCoupon);", 'render();', '',
].join('\n');
const DISCOUNTS = [
  'class Discount {', '  constructor(label) { this.label = label; }', '  apply(total) { return total; }', '}', '',
  'class PercentOff extends Discount {', '  constructor(percent) { super(percent); }', '  apply(total) { return total * 0.9; }', '}', '',
  'const COUPONS = { WELCOME10: () => new PercentOff(10) };', '',
  'const discountFor = (code) => {', '  return COUPONS[code];', '};', '',
].join('\n');

function write(dir: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function analysed(dir: string, sha: string): DiffTree {
  const files = fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, String(f))).filter(f => f.endsWith('.js'));
  const defs = js.collectDefinitions(files);
  return { root: dir, sha, graph: { nodes: Object.values(defs) as any[], edges: [], files } };
}

suite('function end lines (N1)', () => {
  let root: string;
  setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-end-')); });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test('the JS analyzer gives each definition the line of its closing token', () => {
    const dir = write(path.join(root, 'h'), { 'web/discounts.js': DISCOUNTS, 'web/app.js': APP_HEAD });
    const defs = Object.values(js.collectDefinitions([path.join(dir, 'web/discounts.js'), path.join(dir, 'web/app.js')])) as any[];
    const end = (file: string, name: string, line: number) => defs.find(d => d.file.endsWith(file) && d.name === name && d.line === line)?.endLine;
    assert.deepStrictEqual(
      [end('discounts.js', 'constructor', 2), end('discounts.js', 'apply', 3), end('discounts.js', 'apply', 8), end('discounts.js', 'discountFor', 13), end('app.js', 'render', 1)],
      [2, 3, 8, 15, 4],
    );
  });

  test('graphDiff: a module-level line appended after the last function does not change it', () => {
    const base = analysed(write(path.join(root, 'b'), { 'web/app.js': APP_BASE }), 'b'.repeat(40));
    const head = analysed(write(path.join(root, 'h'), { 'web/app.js': APP_HEAD }), 'a'.repeat(40));
    const d = diffGraphs(base, head);
    assert.deepStrictEqual(d.functions.map(f => `${f.kind}:${f.name}`), []);
    assert.strictEqual(d.summary.changed, 0);
  });

  test('graphDiff: the last method of a class ends at its brace, not at the next class', () => {
    const base = analysed(write(path.join(root, 'b'), { 'web/d.js': DISCOUNTS }), 'b'.repeat(40));
    const head = analysed(write(path.join(root, 'h'), { 'web/d.js': DISCOUNTS.replace('class PercentOff extends Discount {', 'class PercentOff extends Discount { // ten') }), 'a'.repeat(40));
    assert.deepStrictEqual(diffGraphs(base, head).functions.map(f => `${f.kind}:${f.name}`), []);
  });

  test('graphDiff without end lines keeps the old rule (a graph from an older analyzer)', () => {
    const strip = (t: DiffTree): DiffTree => ({ ...t, graph: { ...t.graph, nodes: t.graph.nodes.map((n: any) => { const { endLine: _e, ...rest } = n; return rest; }) } });
    const base = strip(analysed(write(path.join(root, 'b'), { 'web/app.js': APP_BASE }), 'b'.repeat(40)));
    const head = strip(analysed(write(path.join(root, 'h'), { 'web/app.js': APP_HEAD }), 'a'.repeat(40)));
    assert.deepStrictEqual(diffGraphs(base, head).functions.map(f => `${f.kind}:${f.name}`), ['changed:render']);
  });

  test('GitService: a hunk after the last function of a file does not mark it', () => {
    const file = path.join(root, 'shop', 'tax.py').replace(/\\/g, '/');
    const nodes: any[] = [
      { id: 'a', name: 'vat', file, line: 4, endLine: 5 },
    ];
    const git = new GitService();
    git.setOverride({ files: new Map([[file, { unstaged: 'modified', staged: null }]]), hunks: new Map([[file, [{ start: 8, end: 12, isNew: true }]]]) } as any);
    git.applyGitStatuses(nodes, root);
    assert.strictEqual(nodes[0].gitStatus.unstaged, null);
    const old: any[] = [{ id: 'a', name: 'vat', file, line: 4 }];
    git.applyGitStatuses(old, root);
    assert.strictEqual(old[0].gitStatus.unstaged, 'modified', 'without an end line the old rule stands');
  });
});
