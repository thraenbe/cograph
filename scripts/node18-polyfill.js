// Polyfill for Node 18: File global is not defined but required by undici (used by vsce 2.x).
// Can be removed once Node 20+ is the baseline.
if (typeof File === 'undefined') {
  const { File } = require('buffer');
  global.File = File;
}
