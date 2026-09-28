// funcSave.js — the Save round trip of the function source popup.
//
// The host saves only if the file still holds exactly the text the popup
// showed (sourceEditor.saveFuncSource), so a refusal is a normal outcome for a
// popup that went stale. The popup therefore stays open until the host
// answers, and whatever goes wrong (refused, host exception, no answer at all)
// the user keeps their edit, sees why, and can retry or copy it out.
//
// Save keeps comparing against what the user was last SHOWN: a retry is safe
// (it succeeds if the file really is unchanged and is refused again if not).
// Only "Reload from file" moves the popup onto the file's current text, and it
// replaces the edit, so it takes two clicks and never happens on its own.
//
// Globals used: vscode, state, closeFuncPopupInstance, updateSaveBtn,
// updateFuncHighlight (popups.js). Host strings go in with textContent.

const SAVE_REPLY_TIMEOUT_MS = 8000;
const RELOAD_CONFIRM_MS = 3000;
const SAVE_NO_REPLY_REASON = 'CoGraph did not confirm the save, so it may not have happened. Your edit is still here: Save again, or copy it out.';
let __funcSaveSeq = 0;

/** Line the popup's function starts at now (moved by a Reload), else the graph's. */
function funcSaveLine(inst) { return inst.line ?? inst.node.line; }

function startFuncSave(inst) {
  if (inst.saving || inst.textarea.readOnly) { return; }
  const reqId = 'save-' + (++__funcSaveSeq);
  const newSource = inst.textarea.value;
  clearFuncSaveError(inst);
  inst.saving = { reqId, newSource, timer: 0 };
  inst.textarea.readOnly = true;
  inst.saveBtn.disabled = true;
  inst.saveBtn.textContent = 'Saving…';
  inst.saving.timer = setTimeout(() => {
    if (!inst.saving || inst.saving.reqId !== reqId) { return; }
    // A late answer to this request is still honoured (onFuncSourceSaved).
    if (!inst.lateSaves) { inst.lateSaves = new Map(); }
    inst.lateSaves.set(reqId, newSource);
    endFuncSave(inst);
    showFuncSaveError(inst, SAVE_NO_REPLY_REASON, null, null);
  }, SAVE_REPLY_TIMEOUT_MS);
  // `original` = what the user was shown: the host saves only if the file still has exactly that.
  vscode.postMessage({
    type: 'save-func-source', file: inst.node.file, line: funcSaveLine(inst),
    newSource, original: inst.originalSource, reqId,
  });
}

/** Back to editable, text untouched. */
function endFuncSave(inst) {
  if (inst.saving && inst.saving.timer) { clearTimeout(inst.saving.timer); }
  inst.saving = null;
  inst.textarea.readOnly = false;
  inst.saveBtn.textContent = 'Save';
  updateSaveBtn(inst);
}

/** Host reply {type:'func-source-saved', reqId, ok, reason?, current?, line?}. */
function onFuncSourceSaved(msg) {
  for (const inst of state.funcPopups.values()) {
    if (inst.saving && inst.saving.reqId === msg.reqId) {
      if (msg.ok) { endFuncSave(inst); closeFuncPopupInstance(inst); return; }
      endFuncSave(inst);
      showFuncSaveError(inst, 'Not saved: ' + (msg.reason || 'unknown error.'), msg.current ?? null, msg.line ?? null);
      return;
    }
    if (inst.lateSaves && inst.lateSaves.has(msg.reqId)) {
      // The answer came after the timeout. A success means the file now holds that text.
      const saved = inst.lateSaves.get(msg.reqId);
      inst.lateSaves.delete(msg.reqId);
      if (msg.ok) {
        inst.originalSource = saved;
        updateSaveBtn(inst);
        showFuncSaveError(inst, 'The earlier save went through after all.', null, null);
      }
      return;
    }
  }
}

function clearFuncSaveError(inst) {
  if (inst.saveErrorEl) { inst.saveErrorEl.remove(); inst.saveErrorEl = null; }
}

function funcSaveButton(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/** Inline bar above the footer: reason, "Copy my edit", and — when the host sent the
 *  file's current text — a two-click "Reload from file". */
function showFuncSaveError(inst, reason, current, line) {
  clearFuncSaveError(inst);
  const bar = document.createElement('div');
  bar.className = 'func-save-error';
  bar.setAttribute('role', 'alert');
  const text = document.createElement('span');
  text.className = 'func-save-reason';
  text.textContent = reason;
  bar.appendChild(text);
  bar.appendChild(funcSaveButton('Copy my edit', 'func-save-copy', (e) => copyFuncEdit(inst, e.currentTarget)));
  if (typeof current === 'string') {
    bar.appendChild(funcSaveButton('Reload from file', 'func-save-reload', (e) => reloadFuncFromFile(inst, e.currentTarget, current, line)));
  }
  const footer = inst.element.querySelector('.func-footer');
  if (footer && footer.parentNode) { footer.parentNode.insertBefore(bar, footer); } else { inst.element.appendChild(bar); }
  inst.saveErrorEl = bar;
}

function copyFuncEdit(inst, btn) {
  const selectInstead = () => { inst.textarea.focus(); inst.textarea.select(); btn.textContent = 'Selected — press Ctrl+C'; };
  const clip = typeof navigator !== 'undefined' && navigator.clipboard;
  if (!clip || typeof clip.writeText !== 'function') { selectInstead(); return; }
  clip.writeText(inst.textarea.value).then(() => { btn.textContent = 'Copied'; }, selectInstead);
}

/** First click arms, a second click within RELOAD_CONFIRM_MS replaces the edit. */
function reloadFuncFromFile(inst, btn, current, line) {
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = 'Replace my edit? Click again';
    btn.__disarm = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = 'Reload from file'; }, RELOAD_CONFIRM_MS);
    return;
  }
  clearTimeout(btn.__disarm);
  inst.textarea.value = current;
  inst.originalSource = current;
  if (line != null) { inst.line = line; }
  clearFuncSaveError(inst);
  updateFuncHighlight(inst);
  updateSaveBtn(inst);
}

if (typeof module !== 'undefined') {
  module.exports = {
    startFuncSave, onFuncSourceSaved, endFuncSave, showFuncSaveError, reloadFuncFromFile, copyFuncEdit,
    SAVE_REPLY_TIMEOUT_MS, RELOAD_CONFIRM_MS, SAVE_NO_REPLY_REASON,
  };
}
