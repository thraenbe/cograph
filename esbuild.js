// esbuild.js — production bundling for vsce packaging.
//
// The packaged extension runs entirely from dist/: the extension host bundle
// (dist/extension.js) and one self-contained bundle per node analyzer
// subprocess (dist/scripts/analyze_*.js), so no node_modules ship in the
// .vsix. Tests and lint keep using tsc output in out/ — analyzerRunner falls
// back to the scripts/ sources whenever dist/ is absent.
//
// Usage: node esbuild.js [--production] [--watch]

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// VS Code engine floor is 1.75, which ships a Node 16 extension host.
const common = {
  bundle: true,
  platform: 'node',
  target: 'node16',
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

async function main() {
  // `vscode` is provided by the extension host at runtime.
  const extension = await esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
  });

  // Analyzer subprocesses (spawned via child_process, so they need their
  // dependencies — typescript, java-parser, web-tree-sitter — inlined).
  const analyzers = await esbuild.context({
    ...common,
    entryPoints: [
      'scripts/analyze_ts.js',
      'scripts/analyze_js.js',
      'scripts/analyze_java.js',
      'scripts/analyze_cpp.js',
    ],
    outdir: 'dist/scripts',
  });

  // Webview simulation worker (P6): browser iife with d3-force + localSim.js
  // inlined. VS Code webviews boot it from a Blob (see src/webview/simPool.js).
  const simWorker = await esbuild.context({
    bundle: true,
    platform: 'browser',
    target: 'chrome108',          // VS Code 1.75's Electron
    format: 'iife',
    minify: production,
    sourcemap: false,             // loaded from a Blob URL: a map could not resolve
    logLevel: 'info',
    entryPoints: ['src/webview/simWorker.js'],
    outfile: 'dist/webview/simWorker.js',
  });

  // Both WASM files are resolved relative to __dirname at runtime:
  // tree-sitter-cpp.wasm by scripts/analyze_cpp.js, web-tree-sitter.wasm by
  // web-tree-sitter's Emscripten loader (scriptDirectory = __dirname).
  fs.mkdirSync(path.join(__dirname, 'dist', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(__dirname, 'dist', 'webview'), { recursive: true });
  for (const [src, dest] of [
    ['scripts/tree-sitter-cpp.wasm', 'dist/scripts/tree-sitter-cpp.wasm'],
    ['node_modules/web-tree-sitter/web-tree-sitter.wasm', 'dist/scripts/web-tree-sitter.wasm'],
    // Vendored d3 for the webview: no CDN round-trip, works offline.
    ['node_modules/d3/dist/d3.min.js', 'dist/webview/d3.min.js'],
  ]) {
    fs.copyFileSync(path.join(__dirname, src), path.join(__dirname, dest));
  }

  if (watch) {
    await Promise.all([extension.watch(), analyzers.watch(), simWorker.watch()]);
  } else {
    await Promise.all([extension.rebuild(), analyzers.rebuild(), simWorker.rebuild()]);
    await Promise.all([extension.dispose(), analyzers.dispose(), simWorker.dispose()]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
