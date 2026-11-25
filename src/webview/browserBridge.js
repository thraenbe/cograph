// browserBridge.js — the webview's VS Code API in a browser tab (src/browserView).
//
// Loaded before state.js, in browser mode only (webviewHtmlBuilder transport
// 'browser'). It defines window.acquireVsCodeApi over the loopback server:
// postMessage = POST /msg (one at a time, in order), getState/setState =
// sessionStorage. Host → view messages arrive on an EventSource and are
// re-dispatched as window.postMessage(msg, origin), so main.js, controls.js,
// readyHandshake.js and hoverCard.js run unchanged.
//
// The stream opens only after DOMContentLoaded: while the parser waits for a
// script, the event loop runs, and a replay delivered then would reach a page
// whose listeners are not attached yet. On open the bridge says `ready` (the
// host holds the replay until then) and sends what the page posted meanwhile.
//
// A reconnect reloads the tab: messages sent while the stream was down are
// gone, and a page that missed some cannot be patched. After three failed
// reconnects, a closed stream, or a refused POST (a new token after VS Code
// restarted), a banner says the tab is no longer connected.

const BRIDGE_MAX_FAILURES = 3;

const BRIDGE_TEXT = {
  closed: 'This view was closed in VS Code. Open it again from CoGraph in VS Code.',
  lost: 'Lost the connection to VS Code. Open the graph again from CoGraph (Open in browser).',
};

function bridgeClientId(win) {
  const bytes = new Uint8Array(8);
  if (win.crypto && typeof win.crypto.getRandomValues === 'function') { win.crypto.getRandomValues(bytes); }
  else { for (let i = 0; i < bytes.length; i++) { bytes[i] = Math.floor(Math.random() * 256); } }
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function bridgeShowBanner(doc, kind) {
  let el = doc.getElementById('browser-banner');
  if (!el) {
    el = doc.createElement('div');
    el.id = 'browser-banner';
    el.setAttribute('role', 'alert');
    doc.body.appendChild(el);
  }
  el.dataset.kind = kind;
  el.textContent = BRIDGE_TEXT[kind] || BRIDGE_TEXT.lost;
}

/** The vscode API object: posts go out in order once the stream is open; state lives per tab. */
function bridgeApi(win, cfg, clientId, onFailure) {
  const key = `cograph-state:${cfg.view}`;
  const outbox = [];
  let open = false;
  let chain = Promise.resolve();
  const send = (msg) => {
    const body = JSON.stringify(msg);
    chain = chain.then(() => win.fetch(`${cfg.msgUrl}&client=${clientId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })).then((res) => { if (!res.ok) { onFailure(`POST ${msg.type} refused (${res.status})`); } },
      (err) => onFailure(`POST ${msg.type} failed (${err && err.message})`));
  };
  return {
    api: {
      postMessage(msg) { if (open) { send(msg); } else { outbox.push(msg); } },
      getState() {
        try { const raw = win.sessionStorage.getItem(key); return raw ? JSON.parse(raw) : undefined; }
        catch (err) { onFailure(`getState failed (${err && err.message})`, true); return undefined; }
      },
      setState(s) {
        try { win.sessionStorage.setItem(key, JSON.stringify(s)); }
        catch (err) { onFailure(`setState failed (${err && err.message})`, true); }
        return s;
      },
    },
    /** The stream is open: `ready` first, then what waited (its own `ready` dropped: one is enough). */
    opened() {
      open = true;
      send({ type: 'ready' });
      for (const m of outbox.splice(0)) { if (!m || m.type !== 'ready') { send(m); } }
    },
    closed() { open = false; },
  };
}

function bridgeConnect(win, doc, cfg, clientId, bridge, status) {
  const es = new win.EventSource(`${cfg.eventsUrl}&client=${clientId}`);
  let everOpen = false;
  let failures = 0;
  es.onopen = () => {
    if (everOpen) { win.location.reload(); return; }
    everOpen = true;
    failures = 0;
    bridge.opened();
  };
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { status.errors.push(`bad event (${err && err.message})`); return; }
    win.postMessage(msg, win.location.origin);
  };
  es.addEventListener('control', (e) => {
    let kind = '';
    try { kind = JSON.parse(e.data).kind; } catch (err) { status.errors.push(`bad control (${err && err.message})`); }
    if (kind === 'reload') { win.location.reload(); return; }
    if (kind === 'closed') { es.close(); bridge.closed(); bridgeShowBanner(doc, 'closed'); }
  });
  es.onerror = () => {
    bridge.closed();
    failures += 1;
    if (es.readyState === 2 /* CLOSED: EventSource gave up */ || failures >= BRIDGE_MAX_FAILURES) {
      es.close();
      bridgeShowBanner(doc, 'lost');
    }
  };
  return es;
}

/** Install the shim on `win`; the stream opens once the document has run every script. */
function installBrowserBridge(win, doc) {
  const cfg = win.COGRAPH_BROWSER;
  if (!cfg || !cfg.eventsUrl || !cfg.msgUrl) { return null; }
  const clientId = bridgeClientId(win);
  const status = { clientId, errors: [], es: null };
  const onFailure = (why, soft) => {
    status.errors.push(why);
    if (!soft) { bridgeShowBanner(doc, 'lost'); }
  };
  const bridge = bridgeApi(win, cfg, clientId, onFailure);
  win.acquireVsCodeApi = () => bridge.api;
  const connect = () => { status.es = bridgeConnect(win, doc, cfg, clientId, bridge, status); };
  if (doc.readyState === 'loading') { doc.addEventListener('DOMContentLoaded', connect, { once: true }); }
  else { connect(); }
  win.__cographBridge = status;
  return status;
}

if (typeof window !== 'undefined' && window.COGRAPH_BROWSER) {
  installBrowserBridge(window, document);
}

if (typeof module !== 'undefined') {
  module.exports = { installBrowserBridge, bridgeShowBanner, BRIDGE_TEXT, BRIDGE_MAX_FAILURES };
}
