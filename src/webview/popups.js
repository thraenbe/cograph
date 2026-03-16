// ── Library doc popup ─────────────────────────────────────────────────────────
function showLibDocPopup(d) {
  state.activeLibNode = d;
  const docsUrl = d.language === 'python'
    ? `https://docs.python.org/3/library/${d.libraryName.split('.')[0]}`
    : `https://www.npmjs.com/package/${d.libraryName}`;

  document.getElementById('lib-doc-title').textContent = `${d.libraryName}.${d.name}`;
  document.getElementById('lib-doc-lang-badge').textContent = d.language === 'python' ? 'Python' : 'TypeScript';
  document.getElementById('lib-doc-lang-badge').className = `lang-badge lang-badge-${d.language}`;
  document.getElementById('lib-doc-function').textContent = d.name;
  document.getElementById('lib-doc-package').textContent = d.libraryName;
  document.getElementById('lib-doc-url').textContent = docsUrl;

  const descEl = document.getElementById('lib-doc-desc');
  const descRow = document.getElementById('lib-doc-desc-row');
  if (descEl) { descEl.textContent = '…'; }
  if (descRow) { descRow.style.display = 'block'; }

  document.getElementById('lib-doc-popup').style.display = 'flex';
  state.libDescRequestId = Date.now();
  vscode.postMessage({ type: 'get-lib-description', libraryName: d.libraryName, functionName: d.name, language: d.language, reqId: state.libDescRequestId });
}

// ── Function source popup — factory pattern ───────────────────────────────────

function updateSaveBtn(inst) {
  const hasChanges = !inst.textarea.readOnly
    && inst.originalSource !== null
    && inst.textarea.value !== inst.originalSource;
  inst.saveBtn.disabled = !hasChanges;
  const base  = inst.node.file.split('/').pop();
  const range = inst.endLine ? `${inst.node.line}-${inst.endLine}` : inst.node.line;
  inst.titleEl.textContent = (hasChanges ? '● ' : '') + base + ':' + range;
}

function updateFuncHighlight(inst) {
  const source = inst.textarea.value;
  if (inst.textarea.readOnly) {
    if (inst.colorizedHtml) {
      const html = inst.colorizedHtml
        .replace(/<div[^>]*>/gi, '')
        .replace(/<\/div>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n');
      inst.codeEl.innerHTML = html;
    } else {
      inst.codeEl.textContent = source;
    }
  } else {
    const lang = inst.node?.language ?? 'typescript';
    inst.codeEl.innerHTML = highlightCode(source, lang) + '\n';
  }
  inst.textarea.style.height = 'auto';
  inst.textarea.style.height = inst.textarea.scrollHeight + 'px';
  const lines = source.split('\n').length;
  inst.lineNumEl.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
}

function bringToFront(inst) {
  state.funcPopupZCounter += 1;
  inst.element.style.zIndex = state.funcPopupZCounter;
}

function closeFuncPopupInstance(inst) {
  inst.element.remove();
  state.funcPopups.delete(inst.node.id);
}

function createFuncPopupInstance(d) {
  const popupIndex = state.funcPopups.size;
  state.funcPopupZCounter += 1;

  // ── Build DOM ──────────────────────────────────────────────────────────────
  const card = document.createElement('div');
  card.className = 'func-card';
  card.style.zIndex = state.funcPopupZCounter;

  const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  dirs.forEach(dir => {
    const h = document.createElement('div');
    h.className = `func-resize-handle func-resize-${dir}`;
    h.dataset.dir = dir;
    card.appendChild(h);
  });

  const cardInner = document.createElement('div');
  cardInner.className = 'func-card-inner';

  const header = document.createElement('div');
  header.className = 'func-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'func-popup-title';
  titleEl.textContent = d.file.split('/').pop() + ':' + d.line;

  const closeBtn = document.createElement('button');
  closeBtn.title = 'Close';
  closeBtn.innerHTML = '&#x2715;';

  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'func-body';

  const editorWrap = document.createElement('div');
  editorWrap.className = 'func-editor-wrap';

  const lineNumEl = document.createElement('div');
  lineNumEl.className = 'func-line-numbers';
  lineNumEl.setAttribute('aria-hidden', 'true');

  const pre = document.createElement('pre');
  pre.className = 'func-highlight';
  pre.setAttribute('aria-hidden', 'true');

  const codeEl = document.createElement('code');
  pre.appendChild(codeEl);

  const textarea = document.createElement('textarea');
  textarea.className = 'func-source-textarea';
  textarea.spellcheck = false;
  textarea.setAttribute('autocorrect', 'off');
  textarea.setAttribute('autocapitalize', 'off');
  textarea.value = 'Loading…';
  textarea.readOnly = true;

  editorWrap.appendChild(lineNumEl);
  editorWrap.appendChild(pre);
  editorWrap.appendChild(textarea);
  body.appendChild(editorWrap);

  const footer = document.createElement('div');
  footer.className = 'func-footer';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'func-save-btn';
  saveBtn.textContent = 'Save';
  saveBtn.disabled = true;

  const openFileBtn = document.createElement('button');
  openFileBtn.className = 'func-open-file-btn';
  openFileBtn.innerHTML = 'Open File &#x2197;';

  footer.appendChild(saveBtn);
  footer.appendChild(openFileBtn);

  cardInner.appendChild(header);
  cardInner.appendChild(body);
  cardInner.appendChild(footer);
  card.appendChild(cardInner);

  // ── Instance ───────────────────────────────────────────────────────────────
  const inst = {
    node: d,
    element: card,
    card,
    textarea,
    codeEl,
    lineNumEl,
    titleEl,
    saveBtn,
    reqId: null,
    originalSource: null,
    colorizedHtml: null,
    endLine: null,
  };

  // ── Initial position (cascade) ─────────────────────────────────────────────
  const offsetX = popupIndex * 30;
  const offsetY = popupIndex * 30;
  card.style.left = Math.max(0, (window.innerWidth - 660) / 2 + offsetX) + 'px';
  card.style.top  = Math.max(0, (window.innerHeight - 460) / 2 + offsetY) + 'px';

  // ── Event listeners ────────────────────────────────────────────────────────
  card.addEventListener('mousedown', () => bringToFront(inst));

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeFuncPopupInstance(inst);
  });

  textarea.addEventListener('input', () => {
    updateFuncHighlight(inst);
    updateSaveBtn(inst);
  });

  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (!saveBtn.disabled) saveBtn.click();
      return;
    }
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const start = textarea.selectionStart;
    const end   = textarea.selectionEnd;
    textarea.value = textarea.value.slice(0, start) + '\t' + textarea.value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + 1;
    updateFuncHighlight(inst);
  });

  saveBtn.addEventListener('click', () => {
    const node = inst.node;
    if (!node || textarea.readOnly) return;
    vscode.postMessage({ type: 'save-func-source', file: node.file, line: node.line, newSource: textarea.value });
    closeFuncPopupInstance(inst);
  });

  openFileBtn.addEventListener('click', () => {
    const node = inst.node;
    if (!node) return;
    vscode.postMessage({ type: 'navigate', file: node.file, line: node.line });
  });

  // ── Drag ──────────────────────────────────────────────────────────────────
  let dragging = false;
  let dragStartX, dragStartY, dragStartLeft, dragStartTop;

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    const rect = card.getBoundingClientRect();
    dragStartX    = e.clientX;
    dragStartY    = e.clientY;
    dragStartLeft = rect.left;
    dragStartTop  = rect.top;
    dragging = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const cardW = card.offsetWidth;
    const cardH = card.offsetHeight;
    const newLeft = Math.max(0, Math.min(window.innerWidth  - cardW, dragStartLeft + e.clientX - dragStartX));
    const newTop  = Math.max(0, Math.min(window.innerHeight - cardH, dragStartTop  + e.clientY - dragStartY));
    card.style.left = newLeft + 'px';
    card.style.top  = newTop  + 'px';
  });

  document.addEventListener('mouseup', () => { dragging = false; });

  // ── Resize ─────────────────────────────────────────────────────────────────
  let resizing = false;
  let resizeDir, resStartX, resStartY, resStartLeft, resStartTop, resStartW, resStartH;

  card.querySelectorAll('.func-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      const rect = card.getBoundingClientRect();
      resizeDir  = handle.dataset.dir;
      resStartX  = e.clientX;
      resStartY  = e.clientY;
      resStartLeft = rect.left;
      resStartTop  = rect.top;
      resStartW  = card.offsetWidth;
      resStartH  = card.offsetHeight;
      card.style.left = resStartLeft + 'px';
      card.style.top  = resStartTop  + 'px';
      resizing = true;
      e.preventDefault();
      e.stopPropagation();
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    applyResizeDelta(card, resizeDir, e.clientX - resStartX, e.clientY - resStartY, resStartLeft, resStartTop, resStartW, resStartH);
  });

  document.addEventListener('mouseup', () => { resizing = false; });

  document.body.appendChild(card);
  return inst;
}

function showFuncPopup(d) {
  if (state.funcPopups.has(d.id)) {
    bringToFront(state.funcPopups.get(d.id));
    return;
  }

  const inst = createFuncPopupInstance(d);
  state.funcPopups.set(d.id, inst);

  inst.originalSource = null;
  updateFuncHighlight(inst);
  updateSaveBtn(inst);

  inst.reqId = Date.now();
  if (!d.file || d.line <= 0) {
    inst.textarea.value = '(source not available)';
    inst.textarea.readOnly = true;
    updateFuncHighlight(inst);
    return;
  }
  vscode.postMessage({ type: 'get-func-source', file: d.file, line: d.line, reqId: inst.reqId });
}

if (typeof module !== 'undefined') {
  module.exports = { createFuncPopupInstance, showFuncPopup };
}
