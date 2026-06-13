// ── Syntax highlighting ────────────────────────────────────────────────────────
function highlightCode(source, lang) {
  const PY_KW = new Set(['False','None','True','and','as','assert','async','await','break','class',
    'continue','def','del','elif','else','except','finally','for','from','global','if','import',
    'in','is','lambda','nonlocal','not','or','pass','raise','return','try','while','with','yield']);
  const TS_KW = new Set(['abstract','as','async','await','break','case','catch','class','const',
    'continue','debugger','declare','default','delete','do','else','enum','export','extends',
    'false','finally','for','from','function','if','implements','import','in','instanceof',
    'interface','let','module','namespace','new','null','of','private','protected','public',
    'readonly','return','static','super','switch','this','throw','true','try','type','typeof',
    'undefined','var','void','while','with','yield']);
  const JAVA_KW = new Set(['abstract','assert','boolean','break','byte','case','catch','char','class',
    'const','continue','default','do','double','else','enum','extends','false','final','finally',
    'float','for','goto','if','implements','import','instanceof','int','interface','long','native',
    'new','null','package','private','protected','public','return','short','static','strictfp',
    'super','switch','synchronized','this','throw','throws','transient','true','try','void',
    'volatile','while','yield','record','sealed','permits','var']);
  const CPP_KW = new Set(['alignas','alignof','and','asm','auto','bool','break','case','catch',
    'char','char8_t','char16_t','char32_t','class','concept','const','consteval','constexpr',
    'constinit','const_cast','continue','co_await','co_return','co_yield','decltype','default',
    'delete','do','double','dynamic_cast','else','enum','explicit','export','extern','false',
    'final','float','for','friend','goto','if','inline','int','long','mutable','namespace',
    'new','noexcept','not','nullptr','operator','or','override','private','protected','public',
    'register','reinterpret_cast','requires','return','short','signed','sizeof','static',
    'static_assert','static_cast','struct','switch','template','this','thread_local','throw',
    'true','try','typedef','typeid','typename','union','unsigned','using','virtual','void',
    'volatile','wchar_t','while','xor']);
  const kws = lang === 'python' ? PY_KW
    : lang === 'java' ? JAVA_KW
    : lang === 'cpp' ? CPP_KW
    : TS_KW;
  const isPy = lang === 'python';

  function esc(t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  const cs = typeof getComputedStyle !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const C = {
    str:  (cs?.getPropertyValue('--hl-string').trim())   || '#ce9178',
    cmt:  (cs?.getPropertyValue('--hl-comment').trim())  || '#6a9955',
    kw:   (cs?.getPropertyValue('--hl-keyword').trim())  || '#569cd6',
    num:  (cs?.getPropertyValue('--hl-number').trim())   || '#b5cea8',
    fn:   (cs?.getPropertyValue('--hl-fn-name').trim())  || '#dcdcaa',
    cls:  (cs?.getPropertyValue('--hl-cls-name').trim()) || '#4ec9b0',
    deco: (cs?.getPropertyValue('--hl-deco').trim())     || '#c586c0',
  };
  function span(color, t) { return `<span style="color:${color}">${esc(t)}</span>`; }

  let out = '';
  let i = 0;
  const s = source;
  const n = s.length;

  while (i < n) {
    // Triple-quoted strings (Python only)
    if (isPy && (s.startsWith('"""', i) || s.startsWith("'''", i))) {
      const q = s.slice(i, i + 3);
      let j = i + 3;
      while (j < n && !s.startsWith(q, j)) j++;
      j = Math.min(j + 3, n);
      out += span(C.str, s.slice(i, j)); i = j; continue;
    }
    // Line comment
    if ((isPy && s[i] === '#') || (!isPy && s.startsWith('//', i))) {
      let j = i;
      while (j < n && s[j] !== '\n') j++;
      out += span(C.cmt, s.slice(i, j)); i = j; continue;
    }
    // Block comment (TS/JS only)
    if (!isPy && s.startsWith('/*', i)) {
      let j = i + 2;
      while (j < n && !s.startsWith('*/', j)) j++;
      j = Math.min(j + 2, n);
      out += span(C.cmt, s.slice(i, j)); i = j; continue;
    }
    // String literal
    if (s[i] === '"' || s[i] === "'" || (s[i] === '`' && !isPy)) {
      const q = s[i];
      let j = i + 1;
      while (j < n && s[j] !== q && s[j] !== '\n') { if (s[j] === '\\') j++; j++; }
      if (j < n && s[j] === q) j++;
      out += span(C.str, s.slice(i, j)); i = j; continue;
    }
    // Decorator (Python only)
    if (isPy && s[i] === '@') {
      let j = i + 1;
      while (j < n && /[\w.]/.test(s[j])) j++;
      if (j > i + 1) { out += span(C.deco, s.slice(i, j)); i = j; continue; }
    }
    // Number
    if (/[0-9]/.test(s[i]) || (s[i] === '.' && i + 1 < n && /[0-9]/.test(s[i + 1]))) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXoObB._eE]/.test(s[j])) j++;
      out += span(C.num, s.slice(i, j)); i = j; continue;
    }
    // Identifier / keyword
    if (/[a-zA-Z_$]/.test(s[i])) {
      let j = i;
      while (j < n && /[\w$]/.test(s[j])) j++;
      const word = s.slice(i, j);
      if (kws.has(word)) {
        if (word === 'def' || word === 'function') {
          out += span(C.kw, word); i = j;
          while (i < n && s[i] === ' ') out += s[i++];
          if (i < n && /[a-zA-Z_$]/.test(s[i])) {
            j = i; while (j < n && /[\w$]/.test(s[j])) j++;
            out += span(C.fn, s.slice(i, j)); i = j;
          }
          continue;
        }
        if (word === 'class') {
          out += span(C.kw, word); i = j;
          while (i < n && s[i] === ' ') out += s[i++];
          if (i < n && /[a-zA-Z_$]/.test(s[i])) {
            j = i; while (j < n && /[\w$]/.test(s[j])) j++;
            out += span(C.cls, s.slice(i, j)); i = j;
          }
          continue;
        }
        out += span(C.kw, word);
      } else {
        out += esc(word);
      }
      i = j; continue;
    }
    // Default
    out += esc(s[i]); i++;
  }
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { highlightCode };
}
