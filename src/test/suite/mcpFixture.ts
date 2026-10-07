import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeCache } from '../../cacheStore';
import type { GraphData, GraphEdge, GraphNode } from '../../graphProvider';
import { saveAnnotations, emptyAnnotations } from '../../graphIntelligence/annotationStore';
import { scanStructure } from '../../structureScanner';

/**
 * A small real workspace for the MCP tests (no vscode import, so these suites also run under
 * plain mocha for coverage). Call graph:
 *   tests/test_a.ts::testMain → src/a.ts::main → helper → leaf
 *   main → library lodash.map;  src/b.py::run → helper_py → leaf (cross-file)
 *   src/c.ts::Svc.start → helper;  src/cycle.ts: x ⇄ y;  src/dup.py: two `cli` (ambiguous name)
 *   MAIN (module level) → run;  src/a.ts::orphan has no callers
 */
export const FILES: Record<string, string> = {
  'src/a.ts': [
    'export function main() {', '  helper();', '  map([]);', '}',
    'export function helper() {', '  return leaf();', '}',
    'function leaf() { return 1; }',
    'function orphan() {', '  const s = "}";', '  return s;', '}',
  ].join('\n'),
  'src/b.py': ['def run():', '    helper_py()', '', 'def helper_py():', '    leaf()', ''].join('\n'),
  'src/c.ts': ['class Svc {', '  start() {', '    helper();', '  }', '}'].join('\n'),
  'src/cycle.ts': ['function x() { y(); }', 'function y() { x(); }'].join('\n'),
  'src/dup.py': ['def cli():', '    pass', '', 'def cli():', '    pass', ''].join('\n'),
  'tests/test_a.ts': ['function testMain() {', '  main();', '}'].join('\n'),
};

export interface Fixture {
  root: string;
  abs(rel: string): string;
  raw(rel: string, name: string, line: number): string;
  cleanup(): void;
}

export function makeFixture(opts: { annotate?: boolean; cache?: boolean } = {}): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-mcp-')));
  const abs = (rel: string) => path.join(root, ...rel.split('/'));
  for (const [rel, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), text, 'utf8');
  }
  const raw = (rel: string, name: string, line: number) => `${abs(rel)}::${name}::${line}`;
  const node = (rel: string, name: string, line: number, extra: Partial<GraphNode> = {}): GraphNode => ({
    id: raw(rel, name, line), name, file: abs(rel), line,
    language: rel.endsWith('.py') ? 'python' : 'typescript', ...extra,
  });
  const nodes: GraphNode[] = [
    node('src/a.ts', 'main', 1), node('src/a.ts', 'helper', 5), node('src/a.ts', 'leaf', 8),
    node('src/a.ts', 'orphan', 9), node('src/b.py', 'run', 1), node('src/b.py', 'helper_py', 4),
    node('src/c.ts', 'start', 2, { className: 'Svc', classExtends: 'Base' }),
    node('src/cycle.ts', 'x', 1), node('src/cycle.ts', 'y', 2),
    node('src/dup.py', 'cli', 1), node('src/dup.py', 'cli', 4),
    node('tests/test_a.ts', 'testMain', 1),
    { id: 'library::lodash::map', name: 'map', file: null, line: 0, isLibrary: true, libraryName: 'lodash' },
    { id: '::MAIN::0', name: 'MAIN', file: '', line: 0 },
  ];
  const e = (s: string, t: string): GraphEdge => ({ source: s, target: t });
  const edges: GraphEdge[] = [
    e(raw('tests/test_a.ts', 'testMain', 1), raw('src/a.ts', 'main', 1)),
    e(raw('src/a.ts', 'main', 1), raw('src/a.ts', 'helper', 5)),
    { source: raw('src/a.ts', 'main', 1), target: 'library::lodash::map', isLibraryEdge: true },
    e(raw('src/a.ts', 'helper', 5), raw('src/a.ts', 'leaf', 8)),
    e(raw('src/b.py', 'run', 1), raw('src/b.py', 'helper_py', 4)),
    e(raw('src/b.py', 'helper_py', 4), raw('src/a.ts', 'leaf', 8)),
    e(raw('src/c.ts', 'start', 2), raw('src/a.ts', 'helper', 5)),
    e(raw('src/cycle.ts', 'x', 1), raw('src/cycle.ts', 'y', 2)),
    e(raw('src/cycle.ts', 'y', 2), raw('src/cycle.ts', 'x', 1)),
    e(raw('src/cycle.ts', 'x', 1), raw('src/cycle.ts', 'x', 1)),
    e('::MAIN::0', raw('src/b.py', 'run', 1)),
    e(raw('src/a.ts', 'main', 1), 'missing::node::1'),
  ];
  const graph: GraphData = { nodes, edges, files: Object.keys(FILES).map(abs) };
  if (opts.cache !== false) { writeCache(root, graph, scanStructure(root)); }
  if (opts.annotate) {
    const a = emptyAnnotations();
    a.folders['.'] = { summary: 'The fixture workspace.', childrenHash: '', at: '' };
    a.folders.src = { summary: 'Application code.', childrenHash: '', at: '' };
    a.files['src/a.ts'] = { summary: 'Entry point and helpers.', hash: '', size: 0, mtimeMs: 0, at: '' };
    saveAnnotations(root, a);
  }
  return { root, abs, raw, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
