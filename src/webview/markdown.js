// Minimal markdown → safe HTML renderer for CoGraph chat bubbles.
// Handles: headings (#..####), paragraphs, bullet/ordered lists, fenced code
// (with lang tag + copy button), inline code, bold, italic, links, hr, blockquote.
// All input is HTML-escaped at entry; only tags generated here reach the DOM.
(function () {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatOutside(seg) {
    let s = escapeHtml(seg);
    s = s.replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_m, t, u) => '<a href="' + u + '" target="_blank" rel="noreferrer">' + t + '</a>',
    );
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return s;
  }

  function renderInline(text) {
    const parts = [];
    let i = 0;
    while (i < text.length) {
      const tick = text.indexOf('`', i);
      if (tick < 0) { parts.push(formatOutside(text.slice(i))); break; }
      parts.push(formatOutside(text.slice(i, tick)));
      const end = text.indexOf('`', tick + 1);
      if (end < 0) { parts.push(escapeHtml(text.slice(tick))); break; }
      parts.push('<code>' + escapeHtml(text.slice(tick + 1, end)) + '</code>');
      i = end + 1;
    }
    return parts.join('');
  }

  function renderMarkdown(src) {
    if (src === undefined || src === null || src === '') { return ''; }
    const lines = String(src).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const ln = lines[i];

      const fence = /^```([a-zA-Z0-9_+-]*)\s*$/.exec(ln);
      if (fence) {
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) { i++; }
        const langClass = lang ? ' class="lang-' + escapeHtml(lang) + '"' : '';
        out.push(
          '<pre><button class="code-copy" type="button" aria-label="Copy">⧉</button>' +
          '<code' + langClass + '>' + escapeHtml(buf.join('\n')) + '</code></pre>',
        );
        continue;
      }

      const h = /^(#{1,4})\s+(.*)$/.exec(ln);
      if (h) {
        const lvl = h[1].length;
        out.push('<h' + lvl + '>' + renderInline(h[2]) + '</h' + lvl + '>');
        i++;
        continue;
      }

      if (/^\s*---+\s*$/.test(ln)) { out.push('<hr/>'); i++; continue; }

      if (/^>\s?/.test(ln)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + renderInline(buf.join(' ')) + '</blockquote>');
        continue;
      }

      if (/^\s*[-*]\s+/.test(ln)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push('<li>' + renderInline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      if (/^\s*\d+\.\s+/.test(ln)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push('<li>' + renderInline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ol>' + items.join('') + '</ol>');
        continue;
      }

      if (!ln.trim()) { i++; continue; }

      const pbuf = [ln];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,4}\s|```|>|\s*[-*]\s|\s*\d+\.\s|---+\s*$)/.test(lines[i])
      ) {
        pbuf.push(lines[i]);
        i++;
      }
      out.push('<p>' + renderInline(pbuf.join(' ')) + '</p>');
    }
    return out.join('');
  }

  if (typeof window !== 'undefined') {
    window.renderMarkdown = renderMarkdown;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderMarkdown, escapeHtml };
  }
})();
