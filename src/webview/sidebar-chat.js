// ── Chat UI — live-telemetry aesthetic ────────────────────────────────────────
(function () {
  const scroll = document.getElementById('chat-scroll');
  const status = document.getElementById('chat-status');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const cancelBtn = document.getElementById('chat-cancel');
  const pill = document.getElementById('model-pill');
  const pillGlyph = document.getElementById('model-glyph');
  const pillName = document.getElementById('model-name');
  const gear = document.getElementById('model-settings');
  const menu = document.getElementById('model-menu');
  const slashMenu = document.getElementById('slash-menu');
  const liveDot = document.querySelector('.chat-live-dot');

  if (!scroll || !form || !input || !sendBtn || !cancelBtn || !status) { return; }

  const SUGGESTED_PROMPTS = [
    'What does this module depend on?',
    'Show me the largest classes.',
    'Which files have grown most recently?',
  ];

  // Slash-command catalog — local UI shortcuts that route to extension handlers.
  const SLASH_COMMANDS = [
    { name: 'clear',    args: '',         desc: 'Clear chat history (keeps the session)' },
    { name: 'new',      args: '',         desc: 'Start a fresh session for this graph' },
    { name: 'resume',   args: '<id>',     desc: 'Attach an existing session id to this chat' },
    { name: 'model',    args: '<name>',   desc: 'Switch model (sonnet | opus | gpt-5-codex …)' },
    { name: 'provider', args: '<name>',   desc: 'Switch provider (claude-code | codex)' },
    { name: 'graph',    args: '',         desc: 'Open the graph picker' },
    { name: 'cost',     args: '',         desc: 'Show last-turn token + cost usage' },
    { name: 'help',     args: '',         desc: 'List available slash commands' },
  ];

  // Populated from `provider-catalog` message; structure mirrors PROVIDER_CATALOG in provider.ts.
  let providerCatalog = [];
  const MAX_LOG_ROWS = 3;
  let timerId = null;
  let timerStart = 0;
  let streamingBubble = null;
  let activeProvider = 'claude-code';
  let activeModel = 'sonnet';
  let streamingText = '';
  let slashSelection = 0;
  let slashFiltered = [];

  // ── Bubbles ────────────────────────────────────────────────────────────
  function renderAssistantText(div, text) {
    const md = typeof window !== 'undefined' && typeof window.renderMarkdown === 'function'
      ? window.renderMarkdown(text || '')
      : '';
    if (md) {
      div.innerHTML = md;
    } else {
      div.textContent = text || '';
    }
  }

  function appendBubble(msg, opts) {
    removeEmptyPrompts();
    const div = document.createElement('div');
    div.className = 'bubble bubble--' + msg.role;
    if (msg.role === 'system') {
      const isDivider = (opts && opts.divider) || /^──.*──$/.test((msg.text || '').trim());
      if (isDivider) { div.classList.add('bubble--divider'); }
    }
    if (msg.role === 'assistant') {
      renderAssistantText(div, msg.text);
    } else {
      div.textContent = msg.text;
    }
    scroll.appendChild(div);
    scroll.scrollTop = scroll.scrollHeight;
    return div;
  }

  function renderHistory(messages) {
    scroll.innerHTML = '';
    if (!messages || messages.length === 0) {
      renderEmptyPrompts();
      return;
    }
    messages.forEach((m) => appendBubble(m));
  }

  function renderEmptyPrompts() {
    if (scroll.querySelector('.empty-prompts')) { return; }
    const wrap = document.createElement('div');
    wrap.className = 'empty-prompts';
    const label = document.createElement('div');
    label.className = 'empty-prompts-label';
    label.textContent = 'Try asking';
    wrap.appendChild(label);
    SUGGESTED_PROMPTS.forEach((text) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'empty-prompt-chip';
      btn.textContent = text;
      btn.addEventListener('click', () => {
        input.value = text;
        form.dispatchEvent(new Event('submit'));
      });
      wrap.appendChild(btn);
    });
    scroll.appendChild(wrap);
  }

  function removeEmptyPrompts() {
    const wrap = scroll.querySelector('.empty-prompts');
    if (wrap) { wrap.remove(); }
  }

  function beginStreamingBubble() {
    streamingBubble = document.createElement('div');
    streamingBubble.className = 'bubble bubble--assistant bubble--streaming';
    scroll.appendChild(streamingBubble);
    scroll.scrollTop = scroll.scrollHeight;
    streamingText = '';
  }

  function appendToStreamingBubble(delta) {
    if (!streamingBubble) { beginStreamingBubble(); }
    streamingText += delta;
    streamingBubble.textContent = streamingText;
    scroll.scrollTop = scroll.scrollHeight;
  }

  function finalizeStreamingBubble(meta) {
    if (!streamingBubble) { return; }
    streamingBubble.classList.remove('bubble--streaming');
    renderAssistantText(streamingBubble, streamingText);
    if (meta) {
      const m = document.createElement('div');
      m.className = 'bubble-meta';
      m.textContent = meta;
      streamingBubble.insertAdjacentElement('afterend', m);
    }
    streamingBubble = null;
    streamingText = '';
  }

  function discardStreamingBubble() {
    if (streamingBubble && streamingBubble.parentNode) {
      streamingBubble.parentNode.removeChild(streamingBubble);
    }
    streamingBubble = null;
    streamingText = '';
  }

  // ── Status pane ────────────────────────────────────────────────────────
  function setStatus(opts) {
    const active = opts && opts.active;
    status.hidden = !active;
    if (!active) {
      stopTimer();
      clearLog();
      return;
    }
    if (opts.stage) {
      status.querySelector('.status-stage').textContent = opts.stage;
    }
    if (opts.model) {
      status.querySelector('.status-model').textContent = providerGlyph(activeProvider) + ' ' + opts.model;
      pill.classList.add('streaming');
      if (liveDot) { liveDot.classList.add('live'); }
    }
    if (opts.detail) { appendLogRow(opts.detail); }
    if (!timerId) { startTimer(); }
  }

  function appendLogRow(text) {
    const log = status.querySelector('.status-log');
    if (!log) { return; }
    const li = document.createElement('li');
    li.textContent = text;
    log.appendChild(li);
    while (log.children.length > MAX_LOG_ROWS) {
      log.removeChild(log.firstChild);
    }
  }

  function clearLog() {
    const log = status.querySelector('.status-log');
    if (log) { log.innerHTML = ''; }
    const stageEl = status.querySelector('.status-stage');
    if (stageEl) { stageEl.textContent = 'Thinking'; }
    const timerEl = status.querySelector('.status-timer');
    if (timerEl) { timerEl.textContent = '0:00'; }
  }

  function resetStatus() {
    clearLog();
    status.hidden = false;
    status.querySelector('.status-model').textContent = providerGlyph(activeProvider) + ' ' + activeModel;
    pill.classList.add('streaming');
    if (liveDot) { liveDot.classList.add('live'); }
    startTimer();
  }

  function startTimer() {
    stopTimer();
    timerStart = Date.now();
    const el = status.querySelector('.status-timer');
    if (!el) { return; }
    el.textContent = '0:00';
    timerId = setInterval(() => {
      const s = Math.floor((Date.now() - timerStart) / 1000);
      const mm = Math.floor(s / 60);
      const ss = String(s % 60).padStart(2, '0');
      el.textContent = mm + ':' + ss;
    }, 250);
  }

  function stopTimer() {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
    }
    pill.classList.remove('streaming');
    if (liveDot) { liveDot.classList.remove('live'); }
  }

  // ── Provider/model menu ────────────────────────────────────────────────
  function providerGlyph(providerId) {
    const p = providerCatalog.find((x) => x.id === providerId);
    return p ? p.glyph : '◆';
  }

  function setModelLabel(provider, model) {
    if (provider) { activeProvider = provider; }
    if (model) { activeModel = model; }
    if (pillGlyph) { pillGlyph.textContent = providerGlyph(activeProvider); }
    if (pillName) { pillName.textContent = activeModel; }
    const sm = status.querySelector('.status-model');
    if (sm) { sm.textContent = providerGlyph(activeProvider) + ' ' + activeModel; }
  }

  function renderModelMenu() {
    if (!providerCatalog || providerCatalog.length === 0) {
      menu.innerHTML = '<div class="mm-footer" data-action="settings">CoGraph settings…</div>';
    } else {
      const parts = [];
      providerCatalog.forEach((prov) => {
        parts.push('<div class="mm-header">' + prov.glyph + '  ' + escapeHtml(prov.displayName) + '</div>');
        prov.models.forEach((m) => {
          const checked = (prov.id === activeProvider && m.id === activeModel) ? '✓' : '';
          parts.push(
            '<div class="mm-item" data-provider="' + prov.id + '" data-model="' + m.id + '">' +
              '<span class="mm-check">' + checked + '</span>' +
              '<span class="mm-label">' + escapeHtml(m.label) + '</span>' +
              '<span class="mm-desc">' + escapeHtml(m.desc) + '</span>' +
            '</div>'
          );
        });
      });
      parts.push('<div class="mm-footer" data-action="settings">CoGraph settings…</div>');
      menu.innerHTML = parts.join('');
    }
    menu.querySelectorAll('.mm-item').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const provider = el.dataset.provider;
        const model = el.dataset.model;
        if (provider && model && (provider !== activeProvider || model !== activeModel)) {
          vscode.postMessage({ type: 'chat-model-change', provider, model });
        }
        hideModelMenu();
      });
    });
    const footer = menu.querySelector('[data-action="settings"]');
    if (footer) {
      footer.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'chat-open-settings' });
        hideModelMenu();
      });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function toggleModelMenu() {
    if (menu.classList.contains('hidden')) {
      renderModelMenu();
      menu.classList.remove('hidden');
    } else {
      hideModelMenu();
    }
  }

  function hideModelMenu() { menu.classList.add('hidden'); }

  if (pill) { pill.addEventListener('click', (e) => { e.stopPropagation(); toggleModelMenu(); }); }
  if (gear) { gear.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'chat-open-settings' }); }); }
  document.addEventListener('click', (e) => {
    if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== pill) {
      hideModelMenu();
    }
  });

  // ── Code-copy (delegated) ──────────────────────────────────────────────
  scroll.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.code-copy');
    if (!btn) { return; }
    const codeEl = btn.parentNode && btn.parentNode.querySelector('code');
    const text = codeEl ? codeEl.textContent : '';
    if (!text || !navigator.clipboard) { return; }
    navigator.clipboard.writeText(text).then(() => {
      const original = btn.textContent;
      btn.classList.add('copied');
      btn.textContent = '✓';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = original;
      }, 1000);
    }).catch(() => { /* clipboard blocked; silent fail */ });
  });

  // ── Slash commands ─────────────────────────────────────────────────────
  function parseSlashInput(value) {
    // Returns { isSlash, cmd, args } or null. Only triggers when input STARTS with `/`.
    if (!value || value[0] !== '/') { return null; }
    const stripped = value.slice(1);
    const sp = stripped.indexOf(' ');
    if (sp < 0) {
      return { isSlash: true, cmd: stripped, args: '' };
    }
    return { isSlash: true, cmd: stripped.slice(0, sp), args: stripped.slice(sp + 1).trim() };
  }

  function refreshSlashMenu() {
    if (!slashMenu) { return; }
    const value = input.value;
    const parsed = parseSlashInput(value);
    if (!parsed) {
      slashMenu.classList.add('hidden');
      slashFiltered = [];
      return;
    }
    const prefix = parsed.cmd.toLowerCase();
    slashFiltered = SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix));
    if (slashFiltered.length === 0) {
      slashMenu.classList.add('hidden');
      return;
    }
    if (slashSelection >= slashFiltered.length) { slashSelection = 0; }
    const rows = slashFiltered.map((c, i) => {
      const sel = i === slashSelection ? ' selected' : '';
      const fullName = '/' + c.name + (c.args ? ' ' + c.args : '');
      return (
        '<div class="slash-item' + sel + '" data-name="' + c.name + '">' +
          '<span class="slash-name">' + escapeHtml(fullName) + '</span>' +
          '<span class="slash-desc">' + escapeHtml(c.desc) + '</span>' +
        '</div>'
      );
    });
    slashMenu.innerHTML = rows.join('');
    slashMenu.classList.remove('hidden');
    slashMenu.querySelectorAll('.slash-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const name = el.dataset.name;
        completeSlash(name);
      });
    });
  }

  function completeSlash(name) {
    const cmd = SLASH_COMMANDS.find((c) => c.name === name);
    if (!cmd) { return; }
    // If the command takes args, insert "/name " and stay in the input.
    // Otherwise, run it immediately.
    if (cmd.args) {
      input.value = '/' + name + ' ';
      slashSelection = 0;
      slashMenu && slashMenu.classList.add('hidden');
      input.focus();
    } else {
      input.value = '/' + name;
      executeSlashIfApplicable();
    }
  }

  function executeSlashIfApplicable() {
    const parsed = parseSlashInput(input.value);
    if (!parsed) { return false; }
    const cmd = SLASH_COMMANDS.find((c) => c.name === parsed.cmd);
    if (!cmd) {
      appendBubble({ role: 'system', text: 'Unknown command: /' + parsed.cmd + ' — try /help', at: new Date().toISOString() });
      input.value = '';
      slashMenu && slashMenu.classList.add('hidden');
      return true;
    }
    input.value = '';
    slashMenu && slashMenu.classList.add('hidden');
    dispatchSlash(parsed.cmd, parsed.args);
    return true;
  }

  function dispatchSlash(name, args) {
    switch (name) {
      case 'help': {
        const lines = SLASH_COMMANDS.map((c) => {
          const left = '/' + c.name + (c.args ? ' ' + c.args : '');
          return left.padEnd(22, ' ') + c.desc;
        });
        appendBubble({
          role: 'system',
          text: 'Available commands:\n' + lines.join('\n'),
          at: new Date().toISOString(),
        });
        return;
      }
      case 'clear': {
        scroll.innerHTML = '';
        renderEmptyPrompts();
        vscode.postMessage({ type: 'chat-clear' });
        return;
      }
      case 'new': {
        vscode.postMessage({ type: 'chat-new-session' });
        return;
      }
      case 'resume': {
        if (!args) {
          appendBubble({ role: 'system', text: '/resume needs a session id — e.g. /resume 8c1f2e…', at: new Date().toISOString() });
          return;
        }
        vscode.postMessage({ type: 'chat-set-session', sessionId: args });
        return;
      }
      case 'model': {
        if (!args) {
          appendBubble({ role: 'system', text: '/model needs a model name — e.g. /model sonnet', at: new Date().toISOString() });
          return;
        }
        vscode.postMessage({ type: 'chat-model-change', model: args });
        return;
      }
      case 'provider': {
        if (!args) {
          appendBubble({ role: 'system', text: '/provider needs a provider id (claude-code | codex)', at: new Date().toISOString() });
          return;
        }
        vscode.postMessage({ type: 'chat-provider-change', provider: args });
        return;
      }
      case 'graph': {
        vscode.postMessage({ type: 'chat-pick-graph' });
        return;
      }
      case 'cost': {
        vscode.postMessage({ type: 'chat-show-cost' });
        return;
      }
    }
  }

  input.addEventListener('input', () => {
    slashSelection = 0;
    refreshSlashMenu();
  });

  // ── Send / cancel ──────────────────────────────────────────────────────
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    // Slash commands intercept submit BEFORE we go to the backend.
    if (executeSlashIfApplicable()) { return; }
    const prompt = input.value.trim();
    if (!prompt) { return; }
    input.value = '';
    sendBtn.disabled = true;
    cancelBtn.style.display = '';
    resetStatus();
    vscode.postMessage({ type: 'chat-send', prompt });
  });

  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'chat-cancel' });
  });

  input.addEventListener('keydown', (e) => {
    const menuOpen = slashMenu && !slashMenu.classList.contains('hidden') && slashFiltered.length > 0;
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashSelection = (slashSelection + 1) % slashFiltered.length;
        refreshSlashMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashSelection = (slashSelection - 1 + slashFiltered.length) % slashFiltered.length;
        refreshSlashMenu();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        completeSlash(slashFiltered[slashSelection].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        slashMenu.classList.add('hidden');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event('submit'));
    }
  });

  // ── Progress dispatcher ────────────────────────────────────────────────
  function stageForTool(name) {
    return ({
      Read: 'Reading',
      Glob: 'Searching',
      Grep: 'Searching',
      Bash: 'Running',
      Edit: 'Editing',
      Write: 'Writing',
    })[name] || 'Working';
  }

  function formatUsage(u, model) {
    if (!u) { return providerGlyph(activeProvider) + ' ' + model; }
    const tokens = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    const cost = typeof u.costUsd === 'number' && u.costUsd > 0 ? ' · $' + u.costUsd.toFixed(3) : '';
    return providerGlyph(activeProvider) + ' ' + model + ' · ' + tokens(u.inputTokens) + ' in / ' + tokens(u.outputTokens) + ' out' + cost;
  }

  function handleProgress(ev) {
    if (!ev || !ev.kind) { return; }
    switch (ev.kind) {
      case 'init': {
        if (ev.model) { setModelLabel(activeProvider, ev.model); }
        setStatus({ active: true, stage: 'Connecting', model: ev.model || activeModel });
        break;
      }
      case 'thinking': {
        const snippet = (ev.snippet || '').replace(/\s+/g, ' ').slice(0, 60);
        setStatus({ active: true, stage: 'Thinking', detail: snippet || 'thinking…' });
        break;
      }
      case 'tool-use': {
        setStatus({ active: true, stage: stageForTool(ev.name), detail: ev.summary || ev.name });
        break;
      }
      case 'text': {
        setStatus({ active: true, stage: 'Answering' });
        if (ev.delta) { appendToStreamingBubble(ev.delta); }
        break;
      }
      case 'result': {
        setStatus({ active: true, stage: 'Done' });
        finalizeStreamingBubble(formatUsage(ev.usage, activeModel));
        break;
      }
      case 'error': {
        setStatus({ active: false });
        discardStreamingBubble();
        break;
      }
    }
  }

  // ── Message listener ───────────────────────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'chat-history':
        renderHistory(msg.messages || []);
        break;
      case 'chat-append': {
        discardStreamingBubble();
        appendBubble(msg.message, { divider: !!msg.divider });
        break;
      }
      case 'chat-status': {
        const thinking = msg.stage === 'thinking';
        sendBtn.disabled = thinking;
        cancelBtn.style.display = thinking ? '' : 'none';
        if (!thinking) {
          setStatus({ active: false });
          discardStreamingBubble();
        }
        break;
      }
      case 'chat-progress':
        handleProgress(msg.event);
        break;
      case 'provider-catalog':
        providerCatalog = Array.isArray(msg.catalog) ? msg.catalog : [];
        // Refresh display in case provider id is in the catalog already.
        setModelLabel(activeProvider, activeModel);
        break;
      case 'chat-model-set':
        if (msg.provider || msg.model) { setModelLabel(msg.provider, msg.model); }
        break;
      case 'chat-input-restore':
        input.value = typeof msg.text === 'string' ? msg.text : '';
        sendBtn.disabled = false;
        cancelBtn.style.display = 'none';
        try { input.focus(); } catch (e) { /* ignore */ }
        break;
    }
  });
})();
