// skipDirs.js — the standalone-walk side of the project rule (F30), shared by the node
// analyzers. The extension never relies on these walks: a full analysis passes the
// structure scanner's file list (`--files`), which also keeps git-tracked files inside
// artefact dirs. Without that list (CLI, tests) every artefact dir is skipped.
'use strict';

const cfg = require('./skipDirs.json');

const SKIPPED = new Set([...cfg.alwaysSkip, ...cfg.artefact]);

/** True when a standalone walk must not enter a directory called `name`. */
function isSkippedDirName(name) {
  return name.startsWith('.') || SKIPPED.has(name) || cfg.artefactPrefixes.some(p => name.startsWith(p));
}

module.exports = { isSkippedDirName };
