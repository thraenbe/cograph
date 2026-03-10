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

// ── Function source popup ─────────────────────────────────────────────────────
function updateSaveBtn() {
  const btn = document.getElementById('func-save-btn');
  const textarea = document.getElementById('func-source-textarea');
  const titleEl = document.getElementById('func-popup-title');
  if (!btn || !textarea) return;
  const hasChanges = !textarea.readOnly
    && state.originalFuncSource !== null
    && textarea.value !== state.originalFuncSource;
  btn.disabled = !hasChanges;
  if (titleEl && state.activeFuncNode) {
    titleEl.textContent = (hasChanges ? '● ' : '') + state.activeFuncNode.name;
  }
}

function updateFuncHighlight() {
  const codeEl = document.getElementById('func-highlight-code');
  if (!codeEl) return;
  const textarea = document.getElementById('func-source-textarea');
  const source = textarea ? textarea.value : '';
  if (textarea && textarea.readOnly) {
    codeEl.textContent = source;
  } else {
    const lang = state.activeFuncNode?.language ?? 'typescript';
    codeEl.innerHTML = highlightCode(source, lang) + '\n';
  }
  if (textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }
  const lineNumEl = document.getElementById('func-line-numbers');
  if (lineNumEl) {
    const lines = source.split('\n').length;
    lineNumEl.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  }
}

function showFuncPopup(d) {
  state.activeFuncNode = d;
  document.getElementById('func-popup-title').textContent = d.name;
  const textarea = document.getElementById('func-source-textarea');
  if (textarea) { textarea.value = 'Loading…'; textarea.readOnly = true; }
  state.originalFuncSource = null;
  updateFuncHighlight();
  updateSaveBtn();
  document.getElementById('func-popup').style.display = 'flex';
  state.funcSourceRequestId = Date.now();
  if (!d.file || d.line <= 0) {
    if (textarea) { textarea.value = '(source not available)'; }
    updateFuncHighlight();
    return;
  }
  vscode.postMessage({ type: 'get-func-source', file: d.file, line: d.line, reqId: state.funcSourceRequestId });
}
