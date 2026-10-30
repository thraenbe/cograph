// copyTourPackage.js — puts the private PR Tour package into the build (docs/tour-protocol.md section 0).
//
// When node_modules/@thraenbe/pr-tour is installed (the release workflow installs it with
// `npm install --no-save` before packaging), its dist/host and dist/web are copied to
// dist/tour/host and dist/tour/web, the first place src/tour/tourModule.ts looks, with the
// package's LICENSE next to them (its notice must travel with the component). When it is
// not installed, a dist/tour left by an earlier build is removed, so a build without the
// package is exactly the public extension. Source maps are not copied: the source is private.

const fs = require('fs');
const path = require('path');

const PACKAGE = '@thraenbe/pr-tour';

/**
 * @param {{ root: string, log?: (line: string) => void }} opts root = the extension checkout
 * @returns {'copied' | 'absent'}
 */
function copyTourPackage(opts) {
  const log = opts.log || (() => undefined);
  const from = path.join(opts.root, 'node_modules', ...PACKAGE.split('/'), 'dist');
  const to = path.join(opts.root, 'dist', 'tour');
  fs.rmSync(to, { recursive: true, force: true });
  const host = path.join(from, 'host', 'index.js');
  const web = path.join(from, 'web');
  if (!fs.existsSync(host) || !fs.existsSync(web)) {
    log(`[tour] ${PACKAGE} not installed: building without the PR tour`);
    return 'absent';
  }
  for (const part of ['host', 'web']) {
    fs.cpSync(path.join(from, part), path.join(to, part), {
      recursive: true,
      dereference: true, // `npm install <folder>` links the package; copy the files, not the link
      filter: (src) => !src.endsWith('.map'),
    });
  }
  const licence = path.join(from, '..', 'LICENSE');
  if (fs.existsSync(licence)) { fs.copyFileSync(licence, path.join(to, 'LICENSE')); }
  else { log(`[tour] ${PACKAGE} has no LICENSE file: dist/tour ships without its notice`); }
  log(`[tour] ${PACKAGE} copied into dist/tour`);
  return 'copied';
}

module.exports = { copyTourPackage, PACKAGE };
