// readyHandshake.js — webview half of the host's WebviewReadyGate (F11).
// The host holds structure/graph until this page says `ready`: a message
// posted into a still-loading document is silently lost ("blank graph on first
// open"). If the host's fallback delivery and `ready` cross, it re-sends with
// the same `__seq`; installSeqDedupe drops a sequence number that was already
// handled — before any other listener (main.js, controls.js, timeline.js).
// Loaded BEFORE main.js so its listener is first in line.

function installSeqDedupe(win) {
  const seen = new Set();
  win.addEventListener('message', (event) => {
    const seq = event.data && event.data.__seq;
    if (seq == null) { return; }
    if (seen.has(seq)) { event.stopImmediatePropagation(); return; }
    seen.add(seq);
  }, true);
  return seen;
}

/** Every webview script is a parser-blocking tag at the end of <body>, so by
 *  DOMContentLoaded all of their message listeners are attached. */
function announceReady(doc, post, defer) {
  const say = () => post({ type: 'ready' });
  if (doc.readyState === 'loading') { doc.addEventListener('DOMContentLoaded', say, { once: true }); }
  else { (defer || ((fn) => setTimeout(fn, 0)))(say); }
}

if (typeof module !== 'undefined') {
  module.exports = { installSeqDedupe, announceReady };
}
