// build-stage.js — dist/stage/: the stage as static files, the public half of the CI tour's viewer.
//
// The stage scripts become one file in getWebviewHtml's order, d3 first, whitespace stripped and no
// name changed (60 KB less gzipped, measured); the page comes from the same template as the panel (src/stagePage.ts), with no nonce and no inline script. staticBridge.js stands
// in for the extension host. The private viewer build reads stage.json, copies these files and puts
// its tags at the marker in index.html. Names carry a content hash and nothing here reads the clock,
// so two builds of one source are byte-identical.
//
// Usage: node scripts/build-stage.js [outDir]. Needs `npm ci` and nothing else.

const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const WEBVIEW = path.join(ROOT, 'src', 'webview');
const DEFAULT_OUT = path.join(ROOT, 'dist', 'stage');
const STAGE_FORMAT = 1;
// As esbuild.js: VS Code 1.75's Electron. The stage's own code goes in as written.
const BROWSER_TARGET = 'chrome108';

const readWebview = (file) => fs.readFileSync(path.join(WEBVIEW, file), 'utf8');

function bundle(entry, options) {
  const result = esbuild.buildSync({ entryPoints: [path.join(ROOT, entry)], bundle: true, write: false, logLevel: 'silent', tsconfigRaw: '{}', ...options });
  return result.outputFiles[0].text;
}

/** Load a module of src/ in this process: it imports no vscode, so plain Node can run it. */
function loadTs(entry) {
  const filename = path.join(ROOT, entry);
  const loaded = new Module(filename);
  loaded._compile(bundle(entry, { platform: 'node', format: 'cjs' }), filename);
  return loaded.exports;
}

/**
 * One classic script. The separator ends a file that stops on a comment or without a semicolon.
 * d3 stays as shipped: its copyright line is not a comment esbuild keeps.
 */
function stageScript(scripts) {
  const d3 = fs.readFileSync(path.join(ROOT, 'node_modules', 'd3', 'dist', 'd3.min.js'), 'utf8');
  const stage = scripts.map(readWebview).join('\n;\n');
  return `${d3}\n;\n${esbuild.transformSync(stage, { minifyWhitespace: true }).code}`;
}

/** docsUrl first: the bridge is a plain browser file, and this keeps src/docsUrl.ts its one source. */
function bridgeScript() {
  const docs = bundle('src/docsUrl.ts', { platform: 'browser', target: BROWSER_TARGET, format: 'iife', globalName: 'CoGraphDocs' });
  return `${docs}\n;\n${readWebview('staticBridge.js')}`;
}

/** Built here, not read from dist/webview: `npm run bundle` and a release minify it differently. */
function workerScript() {
  return bundle('src/webview/simWorker.js', { platform: 'browser', target: BROWSER_TARGET, format: 'iife', minify: true });
}

const hashedName = (stem, ext, text) =>
  `${stem}.${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}.${ext}`;

function buildStage(outDir = DEFAULT_OUT) {
  const page = loadTs('src/stagePage.ts');
  const outputs = {
    bridge: ['staticBridge', 'js', bridgeScript()],
    stage: ['stage', 'js', stageScript(page.STAGE_SCRIPTS)],
    css: ['stage', 'css', page.staticThemeCss() + readWebview('styles.css')],
    worker: ['simWorker', 'js', workerScript()],
  };
  const files = Object.fromEntries(Object.entries(outputs).map(([key, [stem, ext, text]]) => [key, hashedName(stem, ext, text)]));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const [key, [, , text]] of Object.entries(outputs)) { fs.writeFileSync(path.join(outDir, files[key]), text); }
  fs.writeFileSync(path.join(outDir, 'index.html'), page.renderStaticStagePage(files));
  const manifest = { format: STAGE_FORMAT, files, afterStage: page.STAGE_AFTER_MARKER };
  fs.writeFileSync(path.join(outDir, 'stage.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (require.main === module) {
  const manifest = buildStage(process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUT);
  console.log(`dist/stage: ${Object.values(manifest.files).join(', ')}`);
}

module.exports = { buildStage };
