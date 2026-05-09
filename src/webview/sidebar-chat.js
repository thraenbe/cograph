// ── Chat UI — live-telemetry aesthetic ────────────────────────────────────────
(function () {
  const scroll = document.getElementById('chat-scroll');
  const status = document.getElementById('chat-status');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const cancelBtn = document.getElementById('chat-cancel');
  const pill = document.getElementById('model-pill');
  const pillName = document.getElementById('model-name');
  const gear = document.getElementById('model-settings');
  const menu = document.getElementById('model-menu');

  if (!scroll || !form || !input || !sendBtn || !cancelBtn || !status) { return; }

  const MODELS = [
    { id: 'default',  label: 'default',  desc: 'Your Claude Code account default' },
    { id: 'opus',     label: 'opus',     desc: 'Deepest reasoning · slowest · most expensive' },
    { id: 'sonnet',   label: 'sonnet',   desc: 'Balanced speed & quality — recommended' },
    { id: 'haiku',    label: 'haiku',    desc: 'Fastest, cheapest · no extended thinking' },
    { id: 'opusplan', label: 'opusplan', desc: 'Opus plans, Sonnet executes' },
  ];
  const MAX_LOG_ROWS = 3;
  let timerId = null;
  let timerStart = 0;
  let streamingBubble = null;
  let activeModel = 'sonnet';
  let streamingText = '';

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

  function appendBubble(msg) {
    const div = document.createElement('div');
    div.className = 'bubble bubble--' + msg.role;
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
    messages.forEach(appendBubble);
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
      status.querySelector('.status-model').textContent = '◆ ' + opts.model;
      pill.classList.add('streaming');
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
    status.querySelector('.status-model').textContent = '◆ ' + activeModel;
    pill.classList.add('streaming');
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
  }

  // ── Model menu ─────────────────────────────────────────────────────────
  function setModelLabel(id) {
    activeModel = id;
    if (pillName) { pillName.textContent = id; }
    const sm = status.querySelector('.status-model');
    if (sm) { sm.textContent = '◆ ' + id; }
  }

  function renderModelMenu() {
    const items = MODELS.map((m) => {
      const checked = m.id === activeModel ? '✓' : '';
      return (
        '<div class="mm-item" data-model="' + m.id + '">' +
          '<span class="mm-check">' + checked + '</span>' +
          '<span class="mm-label">' + m.label + '</span>' +
          '<span class="mm-desc">' + m.desc + '</span>' +
        '</div>'
      );
    }).join('');
    menu.innerHTML = items + '<div class="mm-footer" data-action="settings">CoGraph settings…</div>';
    menu.querySelectorAll('.mm-item').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = el.dataset.model;
        if (id && id !== activeModel) {
          vscode.postMessage({ type: 'chat-model-change', model: id });
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

  // ── Send / cancel ──────────────────────────────────────────────────────
  form.addEventListener('submit', (e) => {
    e.preventDefault();
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
    if (!u) { return model; }
    const tokens = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    const cost = typeof u.costUsd === 'number' ? ' · $' + u.costUsd.toFixed(3) : '';
    return model + ' · ' + tokens(u.inputTokens) + ' in / ' + tokens(u.outputTokens) + ' out' + cost;
  }

  function handleProgress(ev) {
    if (!ev || !ev.kind) { return; }
    switch (ev.kind) {
      case 'init': {
        if (ev.model) { setModelLabel(ev.model); }
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
        appendBubble(msg.message);
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
      case 'chat-model-set':
        if (msg.model) { setModelLabel(msg.model); }
        break;
    }
  });
})();
