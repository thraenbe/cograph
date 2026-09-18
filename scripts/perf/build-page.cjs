// Perf bench, step 1: build the page + fixtures into scripts/perf/.out/.
//
// The page is the REAL webview HTML (getWebviewHtml with a `vscode` mock and
// file:// URIs), CSP stripped, d3 loaded locally, with preamble.js in front
// (rAF instrumentation + acquireVsCodeApi stub) and bench.js behind.
// Fixtures: the cograph.dev.loadSynthetic presets, plus optional corpus repos
// analysed with this checkout's analyzers.
//
// Usage: node scripts/perf/build-page.cjs [name:/abs/repo/root ...]
// Needs `npm run compile` (reads out/).
const Module = require('module');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, '.out');
const D3_CANDIDATES = [
  path.join(ROOT, 'dist', 'webview', 'd3.min.js'),
  path.join(ROOT, 'node_modules', 'd3', 'dist', 'd3.min.js'),
];

function buildPage() {
  const vscodeMock = {
    Uri: { joinPath: (base, ...p) => ({ fsPath: path.join(base.fsPath, ...p) }) },
    workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  };
  const origLoad = Module._load;
  Module._load = function (req, ...rest) {
    return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest);
  };
  const { getWebviewHtml } = require(path.join(ROOT, 'out', 'webviewHtmlBuilder.js'));
  Module._load = origLoad;

  const d3Path = D3_CANDIDATES.find(p => fs.existsSync(p));
  if (!d3Path) { throw new Error('d3.min.js not found — run npm ci'); }
  let html = getWebviewHtml(
    { asWebviewUri: (u) => 'file://' + u.fsPath, cspSource: 'file:' },
    { fsPath: ROOT },
  );
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '');
  html = html.replace(/<script nonce="[0-9a-f]+"\s+src="[^"]*d3\.min\.js[^"]*"><\/script>/,
    `<script src="file://${__dirname}/preamble.js"></script>\n  <script src="file://${d3Path}"></script>`);
  html = html.replace(/<script nonce="[0-9a-f]+">window\.COGRAPH_CONFIG = ([^<]*);<\/script>/,
    '<script>window.COGRAPH_CONFIG = Object.assign($1, window.__benchConfig);</script>');
  html = html.replace('</body>', `<script src="file://${__dirname}/bench.js"></script>\n</body>`);
  for (const marker of ['preamble.js', '__benchConfig', 'bench.js']) {
    if (!html.includes(marker)) { throw new Error(`page patching failed: ${marker}`); }
  }
  fs.writeFileSync(path.join(OUT, 'page.html'), html);
}

function writeFixture(name, structure, graph) {
  fs.writeFileSync(path.join(OUT, `fixture-${name}.js`),
    'window.__FIXTURE = ' + JSON.stringify({ structure, graph }) + ';');
  process.stdout.write(`fixture ${name}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, `
    + `${Object.keys(structure.folders).length} folders\n`);
}

function buildSynthetic() {
  const { makeSyntheticRepo } = require(path.join(ROOT, 'out', 'test', 'fixtures', 'syntheticGraph.js'));
  const presets = {
    '1k': { folders: 10, filesPerFolder: 10, fnsPerFile: 10, edges: 3000 },
    '3k': { folders: 30, filesPerFolder: 10, fnsPerFile: 10, edges: 10000 },
    '10k': { folders: 100, filesPerFolder: 10, fnsPerFile: 10, edges: 30000 },
  };
  for (const [name, p] of Object.entries(presets)) {
    const { structure, graph } = makeSyntheticRepo({ ...p, intraRatio: 0.95, seed: 1 });
    writeFixture(name, structure, graph);
  }
}

function buildCorpus(name, root) {
  const { scanStructure } = require(path.join(ROOT, 'out', 'structureScanner.js'));
  const { mergeGraph } = require(path.join(ROOT, 'out', 'graphMerge.js'));
  const t0 = Date.now();
  const structure = scanStructure(root);
  const timings = { scanMs: Date.now() - t0 };
  let graph = { nodes: [], edges: [], files: [] };
  const analyzers = [
    ['python3', 'analyze.py', 'python'], [process.execPath, 'analyze_ts.js', 'typescript'],
    [process.execPath, 'analyze_js.js', 'javascript'], [process.execPath, 'analyze_java.js', 'java'],
    [process.execPath, 'analyze_cpp.js', 'cpp'],
  ];
  for (const [bin, script, lang] of analyzers) {
    const t1 = Date.now();
    try {
      const stdout = execFileSync(bin, [path.join(ROOT, 'scripts', script), root],
        { maxBuffer: 1024 * 1024 * 1024, timeout: 600000, stdio: ['ignore', 'pipe', 'ignore'] });
      const g = JSON.parse(stdout);
      timings[lang] = { ms: Date.now() - t1, bytes: stdout.length, nodes: (g.nodes || []).length };
      graph = mergeGraph(graph, { nodes: g.nodes || [], edges: g.edges || [], files: g.files || [] });
    } catch (e) {
      timings[lang] = { ms: Date.now() - t1, error: String(e.message).slice(0, 120) };
    }
  }
  writeFixture(name, structure, graph);
  fs.writeFileSync(path.join(OUT, `host-${name}.json`), JSON.stringify(timings, null, 1));
}

fs.mkdirSync(OUT, { recursive: true });
buildPage();
buildSynthetic();
for (const spec of process.argv.slice(2)) {
  const idx = spec.indexOf(':');
  buildCorpus(spec.slice(0, idx), spec.slice(idx + 1));
}
