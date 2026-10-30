// sourceFiles.js — the files each node analyzer reads: a workspace walk or the --files list.
'use strict';

const fs = require('fs');
const path = require('path');
const { isSkippedDirName } = require('./skipDirs.js');

// isSourceFile receives the file's full path (a .vue/.svelte check reads the file).
function collectSourceFiles(root, isSourceFile) {
  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!isSkippedDirName(entry.name)) walk(full);
      } else if (entry.isFile() && isSourceFile(full)) {
        results.push(full);
      }
    }
  }
  walk(root);
  return results;
}

function explicitFileList(isSourceFile, argv = process.argv) {
  const i = argv.indexOf('--files');
  if (i === -1 || !argv[i + 1]) { return null; }
  let raw;
  try { raw = fs.readFileSync(argv[i + 1], 'utf8'); } catch { return []; }
  return raw.split('\n').map(s => s.trim()).filter(Boolean).filter(isSourceFile);
}

module.exports = { collectSourceFiles, explicitFileList };
