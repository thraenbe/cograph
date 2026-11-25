// staticBridge.js — the webview's VS Code API in the static viewer: no server, no extension host.
//
// Loaded before stage.<h>.js (scripts/build-stage.js). It defines acquireVsCodeApi
// and COGRAPH_CONFIG, sets the body's theme class, and answers the stage from what
// the viewer hands to __cographStaticBridge.open(). A page is one tour: one replay
// after `ready`, no live updates, no reconnect.
//
// The page runs under CSP `sandbox`, in an opaque origin. That shapes three things:
// messages go to '*', because the page's origin is the string "null" and a message
// posted to it is dropped without a word; state lives in memory, because the
// browser's page storage throws there; and the first capture listener checks
// event.source, because every origin reads "null" and proves nothing.
//
// What a bundle holds is hostile input. The viewer validates it before open(), and
// the bridge still copies named fields only: `colorizedHtml` reaches innerHTML in
// popups.js and must never come from here.

const STATIC_NOT_IN_TOUR = 'This function is not part of the tour.';
const STATIC_READ_ONLY = 'This tour is read-only.';
/** The host's cap on a hover peek (graphProvider.ts). */
const STATIC_MAX_PEEK_LINES = 80;
/** Sent by the stage, needing neither an answer here nor a line in the log. */
const STATIC_SILENT = new Set(['get-annotations', 'dirty-state', 'perf-report']);

function staticBootConfig(doc) {
  const worker = doc.querySelector('meta[name="cograph-worker"]');
  return {
    defaultEngine: 'shelf', defaultMode: 'static', perf: false, workers: 'auto',
    workerUri: worker ? worker.getAttribute('content') : null, sameFileEdgesOnly: true,
  };
}

/** The same query as the theme block of stage.<h>.css, before the stage reads the class. */
function staticApplyTheme(win, doc) {
  const light = !!win.matchMedia && win.matchMedia('(prefers-color-scheme: light)').matches;
  doc.body.classList.add(light ? 'vscode-light' : 'vscode-dark');
}

/** First in line, ahead of readyHandshake's __seq check: a foreign message must not consume a number. */
function staticDropForeignMessages(win) {
  win.addEventListener('message', (event) => {
    if (event.source !== win) { event.stopImmediatePropagation(); }
  }, true);
}

const staticText = (v) => (typeof v === 'string' ? v : '');
const staticFirstLines = (text, n) => text.split('\n').slice(0, n).join('\n');

function staticRelPath(file, root) {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return staticText(file).startsWith(prefix) ? file.slice(prefix.length) : staticText(file);
}

function staticDirname(file) {
  const i = staticText(file).lastIndexOf('/');
  return i > 0 ? file.slice(0, i) : '';
}

/** A slice as the host would have cut it: the hover asks for `maxLines`, a popup takes all of it. */
function staticSliceAnswer(slice, msg) {
  const source = staticText(slice.source);
  if (typeof msg.maxLines !== 'number') {
    return { type: 'func-source', reqId: msg.reqId, source, endLine: slice.endLine };
  }
  const cap = Math.max(1, Math.min(STATIC_MAX_PEEK_LINES, msg.maxLines));
  const shown = staticFirstLines(source, cap);
  const cut = shown.length < source.length;
  return {
    type: 'func-source', reqId: msg.reqId, source: shown,
    signature: staticText(slice.signature), doc: staticText(slice.doc), body: staticFirstLines(staticText(slice.body), cap),
    endLine: cut ? msg.line + cap - 1 : slice.endLine, totalLines: slice.totalLines, endReason: cut ? 'maxLines' : slice.endReason,
  };
}

/** The hover has no room for a URL; the popup's text can be selected, so it carries the link. */
function staticNoSlice(msg, link) {
  const error = link && typeof msg.maxLines !== 'number' ? `${STATIC_NOT_IN_TOUR}\n${link}` : STATIC_NOT_IN_TOUR;
  return { type: 'func-source', reqId: msg.reqId, source: '', error };
}

const staticSend = (win, m) => win.postMessage(m, '*');

/** The handler table: each stage message answered as graphProvider.onViewMessage would, from memory. */
function staticHandlers(win, data, deps) {
  const send = (m) => staticSend(win, m);
  const emptyPatch = (folder) => send({ type: 'graph-patch', parsedFolder: folder, patch: { nodes: [], edges: [], files: [] } });
  const newTab = (url) => win.open(url, '_blank', 'noopener,noreferrer');
  return new Map([
    ['expand-folder', (m) => emptyPatch(m.folderPath)],
    ['parse-file', (m) => emptyPatch(staticDirname(m.filePath))],
    ['get-func-source', (m) => {
      const slice = data.sources && data.sources[`${staticRelPath(m.file, data.stageRoot)}:${m.line}`];
      send(slice ? staticSliceAnswer(slice, m) : staticNoSlice(m, data.fileLink(m.file, m.line)));
    }],
    ['navigate', (m) => {
      const url = data.fileLink(m.file, m.line);
      if (url) { newTab(url); } else { data.log({ event: 'no-link', file: m.file }); }
    }],
    ['open-docs', (m) => newTab(deps.docsUrl(m))],
    ['get-lib-description', (m) => send({ type: 'lib-description', reqId: m.reqId, description: '' })],
    ['save-func-source', (m) => send({ type: 'func-source-saved', reqId: m.reqId, ok: false, reason: STATIC_READ_ONLY })],
    ['webview-log', (m) => data.log({ event: 'webview-log', entry: m.entry })],
  ]);
}

function staticDispatch(table, data, msg) {
  const type = msg && msg.type;
  if (STATIC_SILENT.has(type)) { return; }
  const handler = table.get(type);
  if (!handler) { data.log({ event: 'unhandled', type }); return; }
  try { handler(msg); }
  catch (err) { data.log({ event: 'handler-error', type, message: String(err && err.message) }); }
}

/** The API object plus open(): nothing is answered before both `ready` and open() have happened. */
function staticBridge(win, deps) {
  const waiting = [];
  let data = null;
  let table = null;
  let ready = false;
  let replayed = false;
  let saved;

  const start = () => {
    if (replayed || !ready || !data) { return; }
    replayed = true;
    for (const msg of data.replay) { staticSend(win, msg); }
    for (const msg of waiting.splice(0)) { staticDispatch(table, data, msg); }
  };

  return {
    api: {
      postMessage(msg) {
        if (msg && msg.type === 'ready') { ready = true; start(); }
        else if (replayed) { staticDispatch(table, data, msg); }
        else { waiting.push(msg); }
      },
      getState() { return saved; },
      setState(s) { saved = s; return s; },
    },
    open({ replay, sources, stageRoot, fileLink, log }) {
      if (data) { throw new Error('the static bridge opens once per page'); }
      if (!Array.isArray(replay)) { throw new TypeError('open() needs the replay messages'); }
      data = { replay, sources: sources || null, stageRoot: staticText(stageRoot), fileLink: fileLink || (() => null), log: log || (() => undefined) };
      table = staticHandlers(win, data, deps);
      start();
    },
  };
}

/** Install on `win`; deps.docsUrl is src/docsUrl.ts, built in front of this file by build-stage.js. */
function installStaticBridge(win, doc, deps) {
  win.COGRAPH_CONFIG = staticBootConfig(doc);
  staticApplyTheme(win, doc);
  staticDropForeignMessages(win);
  const bridge = staticBridge(win, deps);
  win.acquireVsCodeApi = () => bridge.api;
  win.__cographStaticBridge = { open: bridge.open };
  return bridge;
}

if (typeof module !== 'undefined') {
  module.exports = { installStaticBridge, STATIC_NOT_IN_TOUR, STATIC_READ_ONLY };
} else {
  installStaticBridge(window, document, { docsUrl: CoGraphDocs.docsUrl });
}
