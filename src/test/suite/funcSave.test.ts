import * as assert from 'assert';
import * as sinon from 'sinon';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsv = require('../../../src/webview/funcSave.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;

/** A popup instance with the fields funcSave.js uses (same shape as popups.js builds). */
function makePopup(doc: Document, original: string) {
  const element = doc.createElement('div');
  const inner = doc.createElement('div');
  const footer = doc.createElement('div');
  footer.className = 'func-footer';
  const textarea = doc.createElement('textarea');
  const saveBtn = doc.createElement('button');
  saveBtn.textContent = 'Save';
  inner.append(textarea, footer);
  element.appendChild(inner);
  doc.body.appendChild(element);
  textarea.value = original;
  return { node: { id: 'n1', file: '/r/a.py', line: 4 }, element, textarea, saveBtn, originalSource: original } as any;
}

suite('funcSave: popup save round trip (never loses the edit)', () => {
  const GLOBALS = ['document', 'vscode', 'state', 'closeFuncPopupInstance', 'updateSaveBtn', 'updateFuncHighlight'];
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const setNav = (v: unknown) => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
  const saved: Record<string, unknown> = {};
  let clock: sinon.SinonFakeTimers;
  let posted: any[];
  let closed: any[];
  let doc: Document;

  setup(() => {
    for (const k of GLOBALS) { saved[k] = g[k]; }
    doc = new JSDOM('<!doctype html><body></body>').window.document;
    g.document = doc;
    posted = []; closed = [];
    g.vscode = { postMessage: (m: any) => posted.push(m) };
    g.state = { funcPopups: new Map() };
    g.closeFuncPopupInstance = (inst: any) => { closed.push(inst); inst.element.remove(); g.state.funcPopups.delete(inst.node.id); };
    g.updateSaveBtn = (inst: any) => { inst.saveBtn.disabled = inst.textarea.readOnly || inst.textarea.value === inst.originalSource; };
    g.updateFuncHighlight = () => { /* no-op */ };
    clock = sinon.useFakeTimers();
  });
  teardown(() => {
    clock.restore();
    if (navDesc) { Object.defineProperty(globalThis, 'navigator', navDesc); } else { delete g.navigator; }
    for (const k of GLOBALS) { if (saved[k] === undefined) { delete g[k]; } else { g[k] = saved[k]; } }
  });

  function open(original = 'def f():\n    return 1\n') {
    const inst = makePopup(doc, original);
    g.state.funcPopups.set(inst.node.id, inst);
    inst.textarea.value = 'def f():\n    return 42\n';   // the user's edit
    return inst;
  }

  test('save posts the edit, the shown original and a reqId, and waits (popup stays, read-only)', () => {
    const inst = open();
    fsv.startFuncSave(inst);
    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual({ ...posted[0], reqId: undefined }, {
      type: 'save-func-source', file: '/r/a.py', line: 4, newSource: 'def f():\n    return 42\n',
      original: 'def f():\n    return 1\n', reqId: undefined,
    });
    assert.ok(/^save-\d+$/.test(posted[0].reqId));
    assert.strictEqual(closed.length, 0, 'not closed before the host answers');
    assert.ok(inst.textarea.readOnly && inst.saveBtn.disabled && inst.saveBtn.textContent === 'Saving…');
    fsv.startFuncSave(inst);
    assert.strictEqual(posted.length, 1, 'a second click while saving sends nothing');
  });

  test('ok → the popup closes, as before', () => {
    const inst = open();
    fsv.startFuncSave(inst);
    fsv.onFuncSourceSaved({ type: 'func-source-saved', reqId: posted[0].reqId, ok: true });
    assert.deepStrictEqual(closed, [inst]);
    clock.tick(fsv.SAVE_REPLY_TIMEOUT_MS * 2);   // no stray timeout afterwards
    assert.strictEqual(inst.element.querySelector('.func-save-error'), null);
  });

  test('refused → popup stays open, edit intact and editable, reason inline, Save enabled for a retry', () => {
    const inst = open();
    fsv.startFuncSave(inst);
    fsv.onFuncSourceSaved({ type: 'func-source-saved', reqId: posted[0].reqId, ok: false, reason: 'the file changed since this popup was opened.' });
    assert.strictEqual(closed.length, 0);
    assert.strictEqual(inst.textarea.value, 'def f():\n    return 42\n');
    assert.strictEqual(inst.textarea.readOnly, false);
    assert.strictEqual(inst.saveBtn.disabled, false);
    assert.strictEqual(inst.saveBtn.textContent, 'Save');
    const bar = inst.element.querySelector('.func-save-error');
    assert.ok(bar, 'inline error shown');
    assert.strictEqual(bar.querySelector('.func-save-reason').textContent, 'Not saved: the file changed since this popup was opened.');
    assert.ok(bar.querySelector('.func-save-copy'));
    assert.strictEqual(bar.querySelector('.func-save-reload'), null, 'no Reload without the current text');
    assert.strictEqual(inst.originalSource, 'def f():\n    return 1\n', 'a retry still compares against what the user was SHOWN');
    assert.strictEqual(bar.nextSibling.className, 'func-footer');
    // a retry clears the old error and sends the same original again
    fsv.startFuncSave(inst);
    assert.strictEqual(inst.element.querySelector('.func-save-error'), null);
    assert.strictEqual(posted[1].original, 'def f():\n    return 1\n');
  });

  test('NO REPLY → after the timeout the popup looks exactly like a refusal (edit kept, reason, Save enabled)', () => {
    const inst = open();
    fsv.startFuncSave(inst);
    clock.tick(fsv.SAVE_REPLY_TIMEOUT_MS - 1);
    assert.ok(inst.textarea.readOnly, 'still waiting just before the timeout');
    clock.tick(1);
    assert.strictEqual(closed.length, 0);
    assert.strictEqual(inst.textarea.value, 'def f():\n    return 42\n');
    assert.strictEqual(inst.textarea.readOnly, false);
    assert.strictEqual(inst.saveBtn.disabled, false);
    assert.strictEqual(inst.element.querySelector('.func-save-reason').textContent, fsv.SAVE_NO_REPLY_REASON);
    assert.ok(inst.element.querySelector('.func-save-copy'));
  });

  test('a LATE ok after the timeout: the file has the saved text now, so it becomes the original', () => {
    const inst = open();
    fsv.startFuncSave(inst);
    const reqId = posted[0].reqId;
    clock.tick(fsv.SAVE_REPLY_TIMEOUT_MS);
    inst.textarea.value += '# more typing\n';
    fsv.onFuncSourceSaved({ type: 'func-source-saved', reqId, ok: true });
    assert.strictEqual(closed.length, 0, 'the user may be typing: never close on a late answer');
    assert.strictEqual(inst.originalSource, 'def f():\n    return 42\n');
    assert.ok(inst.textarea.value.endsWith('# more typing\n'), 'the newer typing is kept');
    assert.ok(/went through/.test(inst.element.querySelector('.func-save-reason').textContent));
    fsv.onFuncSourceSaved({ type: 'func-source-saved', reqId, ok: true });   // duplicate: ignored
  });

  test('an answer for another request or a closed popup is ignored', () => {
    const inst = open();
    fsv.startFuncSave(inst);
    fsv.onFuncSourceSaved({ type: 'func-source-saved', reqId: 'save-999999', ok: true });
    assert.strictEqual(closed.length, 0);
    assert.ok(inst.textarea.readOnly, 'still waiting for its own answer');
  });

  test('Reload replaces the edit only on a second click, never on its own', () => {
    const inst = open();
    fsv.startFuncSave(inst);
    fsv.onFuncSourceSaved({ type: 'func-source-saved', reqId: posted[0].reqId, ok: false, reason: 'x', current: 'def f():\n    return 7\n', line: 6 });
    const reload = inst.element.querySelector('.func-save-reload');
    const copy = inst.element.querySelector('.func-save-copy');
    assert.ok(copy.compareDocumentPosition(reload) & 4, 'Copy comes before Reload');
    clock.tick(60_000);
    assert.strictEqual(inst.textarea.value, 'def f():\n    return 42\n', 'no auto-reload');
    reload.click();
    assert.strictEqual(inst.textarea.value, 'def f():\n    return 42\n', 'first click only arms');
    assert.ok(reload.classList.contains('armed'));
    clock.tick(fsv.RELOAD_CONFIRM_MS);
    assert.ok(!reload.classList.contains('armed'), 'disarms again');
    reload.click(); reload.click();
    assert.strictEqual(inst.textarea.value, 'def f():\n    return 7\n');
    assert.strictEqual(inst.originalSource, 'def f():\n    return 7\n', 'Save now compares against the reloaded text');
    assert.strictEqual(inst.line, 6, 'and targets where the function is now');
    assert.strictEqual(inst.element.querySelector('.func-save-error'), null);
    inst.textarea.value = 'def f():\n    return 8\n';
    fsv.startFuncSave(inst);
    assert.strictEqual(posted[1].line, 6);
  });

  test('Copy my edit: clipboard when available, otherwise selects the text', async () => {
    const inst = open();
    fsv.showFuncSaveError(inst, 'x', null, null);
    const btn = inst.element.querySelector('.func-save-copy');
    let copied = '';
    setNav({ clipboard: { writeText: (t: string) => { copied = t; return Promise.resolve(); } } });
    btn.click();
    await Promise.resolve();
    assert.strictEqual(copied, 'def f():\n    return 42\n');
    assert.strictEqual(btn.textContent, 'Copied');
    setNav({});
    btn.click();
    assert.ok(/Ctrl\+C/.test(btn.textContent));
    assert.strictEqual(inst.textarea.selectionEnd - inst.textarea.selectionStart, inst.textarea.value.length);
  });
});
