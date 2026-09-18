import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';
import { SidebarProvider, GraphController } from '../../sidebarProvider';
import { ANNOTATION_CARD_CSS, ANNOTATION_CARD_SCRIPT } from '../../graphIntelligence/annotationCard';
import type { AnnotationStatus } from '../../graphIntelligence/annotationTypes';

const IDLE: AnnotationStatus = { state: 'idle', totalFiles: 40, totalFolders: 6, annotated: 0, stale: 0, pending: 46 };

// ── Client script, run in jsdom ────────────────────────────────────────────────

interface CardPage {
  list: HTMLElement;
  readonly posted: Array<{ type: string }>;
  render(): void;
  status(s: AnnotationStatus | null): void;
  setAi(on: boolean): void;
  card(): HTMLElement;
}

function makePage(ai: boolean): CardPage {
  const dom = new JSDOM('<div id="list"></div>', { runScripts: 'outside-only' });
  const w = dom.window as unknown as { eval(code: string): unknown; document: Document; __posted: Array<{ type: string }> };
  w.eval(`var __posted = []; var vscode = { postMessage: function (m) { __posted.push(m); } }; var aiEnabled = ${ai};`);
  w.eval(ANNOTATION_CARD_SCRIPT);
  const list = w.document.getElementById('list')!;
  const page: CardPage = {
    list,
    // Copy across the jsdom realm boundary, or deepStrictEqual rejects the foreign prototypes.
    get posted() { return JSON.parse(JSON.stringify(w.__posted)) as Array<{ type: string }>; },
    render: () => { w.eval(`(function () { var l = document.getElementById('list'); l.innerHTML = renderAnnotateCard(); wireAnnotateCard(l); })()`); },
    status: (s) => { w.eval(`onAnnotateStatus(${JSON.stringify({ status: s })})`); },
    setAi: (on) => { w.eval(`aiEnabled = ${on};`); },
    card: () => w.document.getElementById('annotate-card')!,
  };
  page.render();
  return page;
}

function click(el: Element): void {
  el.dispatchEvent(new (el.ownerDocument.defaultView!.MouseEvent)('click', { bubbles: true }));
}

suite('Annotate Graph sidebar card (client script)', () => {
  test('locked while AI is off: click opens the AI settings, never starts a run', () => {
    const p = makePage(false);
    assert.ok(p.card().classList.contains('locked'));
    assert.match(p.card().textContent ?? '', /Enable AI Features/);
    click(p.card());
    assert.deepStrictEqual(p.posted, [{ type: 'open-ai-settings' }]);
  });

  test('before: shows the scope and starts a run on click', () => {
    const p = makePage(true);
    p.status(IDLE);
    assert.ok(p.card().classList.contains('before'));
    assert.match(p.card().textContent ?? '', /40 files, 6 folders · shown on hover/);
    click(p.card());
    assert.deepStrictEqual(p.posted, [{ type: 'annotate-generate' }]);
  });

  test('running: progress, cost and a Cancel button; the card itself is not clickable', () => {
    const p = makePage(true);
    p.status({ ...IDLE, state: 'running', done: 120, total: 412, costUsd: 0.084, costKnown: true });
    assert.ok(p.card().classList.contains('running'));
    assert.match(p.card().textContent ?? '', /120 \/ 412 · \$0\.08/);
    assert.strictEqual((p.card().querySelector('.an-bar > span') as HTMLElement).style.width, '29%');
    click(p.card());
    assert.deepStrictEqual(p.posted, []);
    click(p.card().querySelector('.an-btn')!);
    assert.deepStrictEqual(p.posted, [{ type: 'annotate-cancel' }]);
  });

  test('running with Codex says the cost is not reported', () => {
    const p = makePage(true);
    p.status({ ...IDLE, state: 'running', done: 1, total: 4, costKnown: false });
    assert.match(p.card().textContent ?? '', /1 \/ 4 · cost not reported/);
  });

  test('ready and up to date: count, no Update button', () => {
    const p = makePage(true);
    p.status({ ...IDLE, annotated: 46, pending: 0, note: '40 files, 6 folders · $0.11' });
    assert.ok(p.card().classList.contains('ready'));
    assert.match(p.card().textContent ?? '', /46 summaries/);
    assert.match(p.card().textContent ?? '', /\$0\.11/);
    assert.strictEqual(p.card().querySelector('.an-btn'), null);
  });

  test('ready with outdated and missing paths: Update (N) posts annotate-update', () => {
    const p = makePage(true);
    p.status({ ...IDLE, annotated: 40, stale: 3, pending: 6 });
    const btn = p.card().querySelector('.an-btn')!;
    assert.strictEqual(btn.textContent, 'Update (9)');
    assert.match(p.card().textContent ?? '', /40 summaries · 3 outdated · 6 missing/);
    click(btn);
    assert.deepStrictEqual(p.posted, [{ type: 'annotate-update' }]);
  });

  test('a note containing HTML is shown as text', () => {
    const p = makePage(true);
    p.status({ ...IDLE, annotated: 1, note: 'Stopped: <img src=x onerror=alert(1)>' });
    assert.strictEqual(p.card().querySelector('img'), null);
    assert.match(p.card().textContent ?? '', /<img src=x/);
  });

  test('a status update replaces only the card and keeps it wired', () => {
    const p = makePage(true);
    p.list.insertAdjacentHTML('beforeend', '<div id="sibling">saved graph</div>');
    p.status({ ...IDLE, annotated: 5, stale: 1 });
    assert.ok(p.list.querySelector('#sibling'), 'the rest of the list is untouched');
    assert.strictEqual(p.list.querySelectorAll('#annotate-card').length, 1);
    click(p.card().querySelector('.an-btn')!);
    assert.deepStrictEqual(p.posted, [{ type: 'annotate-update' }]);
  });

  test('switching AI off locks a ready card on the next render', () => {
    const p = makePage(true);
    p.status({ ...IDLE, annotated: 46, pending: 0 });
    p.setAi(false);
    p.render();
    assert.ok(p.card().classList.contains('locked'));
  });

  test('the embedded strings cannot break the host template', () => {
    assert.ok(!ANNOTATION_CARD_SCRIPT.includes('`'));
    assert.ok(!ANNOTATION_CARD_SCRIPT.includes('${'));
    assert.ok(ANNOTATION_CARD_CSS.includes('.annotate-card'));
  });
});

// ── Host side: SidebarProvider message routing ─────────────────────────────────

function makeView() {
  const received: Array<(msg: unknown) => void | Promise<void>> = [];
  const webview = {
    options: {} as object,
    html: '',
    postMessage: sinon.stub().resolves(true),
    onDidReceiveMessage: sinon.stub().callsFake((cb: (m: unknown) => void) => { received.push(cb); return { dispose: () => undefined }; }),
    asWebviewUri: sinon.stub().callsFake((uri: vscode.Uri) => uri),
    cspSource: 'vscode-resource:',
  };
  let onDispose: (() => void) | undefined;
  const view = {
    webview,
    onDidDispose: sinon.stub().callsFake((cb: () => void) => { onDispose = cb; return { dispose: () => undefined }; }),
  } as unknown as vscode.WebviewView;
  return { view, webview, received, dispose: () => onDispose?.() };
}

function makeController(over: Partial<GraphController>): GraphController {
  return {
    show: sinon.stub(), isOpen: sinon.stub().returns(false), reloadLayout: sinon.stub(),
    loadGraph: sinon.stub().resolves(), openTimeline: sinon.stub(), ...over,
  } as unknown as GraphController;
}

function stubAi(sandbox: sinon.SinonSandbox, enabled: boolean): void {
  sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((() => ({
    get: (key: string, dflt?: unknown) => (key === 'graphIntelligence.enabled' ? enabled : dflt),
    has: () => false, inspect: () => undefined, update: async () => undefined,
  })) as unknown as typeof vscode.workspace.getConfiguration);
}

function open(controller: GraphController) {
  const fake = makeView();
  new SidebarProvider(vscode.Uri.file('/fake/ext'), controller)
    .resolveWebviewView(fake.view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
  return fake;
}

suite('Annotate Graph sidebar card (host routing)', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => sandbox.restore());

  const statuses = (webview: { postMessage: sinon.SinonStub }) =>
    webview.postMessage.getCalls().map(c => c.args[0]).filter(m => m.type === 'annotate-status');

  test('the sidebar HTML embeds the card script, styles and message hook', () => {
    const { webview } = open(makeController({}));
    assert.ok(webview.html.includes('function renderAnnotateCard()'));
    assert.ok(webview.html.includes('.annotate-card {'));
    assert.ok(webview.html.includes("msg.type === 'annotate-status'"));
    assert.ok(webview.html.includes('wireAnnotateCard(list);'));
  });

  for (const type of ['annotate-generate', 'annotate-update']) {
    test(`${type} while AI is off → controller untouched, settings opened`, async () => {
      stubAi(sandbox, false);
      const exec = sandbox.stub(vscode.commands, 'executeCommand').resolves();
      const annotateGraph = sinon.stub().resolves(null);
      const { received } = open(makeController({ annotateGraph }));
      await received[0]({ type });
      assert.ok(annotateGraph.notCalled);
      assert.ok(exec.called, 'AI settings opened');
    });

    test(`${type} while AI is on → runs with the configured provider and re-sends the status`, async () => {
      stubAi(sandbox, true);
      const annotateGraph = sinon.stub().resolves(null);
      const annotationStatus = sinon.stub().returns(IDLE);
      const { received, webview } = open(makeController({ annotateGraph, annotationStatus }));
      await received[0]({ type });
      assert.ok(annotateGraph.calledOnceWithExactly('claude-code'));
      assert.deepStrictEqual(statuses(webview).pop().status, IDLE);
    });
  }

  test('annotate-cancel always reaches the controller, even with AI off', async () => {
    stubAi(sandbox, false);
    const cancelAnnotate = sinon.stub();
    const { received } = open(makeController({ cancelAnnotate }));
    await received[0]({ type: 'annotate-cancel' });
    assert.ok(cancelAnnotate.calledOnce);
  });

  test('a failing run surfaces an error message', async () => {
    stubAi(sandbox, true);
    const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    const { received } = open(makeController({ annotateGraph: sinon.stub().rejects(new Error('CLI not found')) }));
    await received[0]({ type: 'annotate-generate' });
    assert.match(showError.firstCall.args[0], /Annotate Graph failed — CLI not found/);
  });

  test('a controller without annotate support reports it instead of throwing', async () => {
    stubAi(sandbox, true);
    const showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    const { received } = open(makeController({}));
    await received[0]({ type: 'annotate-generate' });
    assert.match(showError.firstCall.args[0], /not available/);
  });

  test('status changes are forwarded to the webview until the view is disposed', () => {
    let listener: ((s: AnnotationStatus) => void) | undefined;
    const unsubscribe = sinon.stub();
    const onAnnotationStatus = (l: (s: AnnotationStatus) => void) => { listener = l; return { dispose: unsubscribe }; };
    const fake = open(makeController({ onAnnotationStatus }));
    listener!({ ...IDLE, state: 'running', done: 1, total: 2 });
    assert.strictEqual(statuses(fake.webview).pop().status.done, 1);
    fake.dispose();
    assert.ok(unsubscribe.calledOnce);
  });

  test('ready → the current status is pushed with the initial state', async () => {
    stubAi(sandbox, true);
    const { received, webview } = open(makeController({ annotationStatus: () => IDLE }));
    await received[0]({ type: 'ready' });
    assert.deepStrictEqual(statuses(webview).pop().status, IDLE);
  });
});
