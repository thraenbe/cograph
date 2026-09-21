// Tiny HTML helpers shared by the run report and the sweep contact sheet.
// Self-contained static pages: inline CSS, relative links, nothing loaded from the net.

export function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ESC_CHAR = String.fromCharCode(27);
const ANSI = new RegExp(ESC_CHAR + '\\[[0-9;]*m', 'g');

/** Strip the ANSI colour codes Playwright puts into assertion messages. */
export function plain(s: unknown): string {
  return String(s ?? '').replace(ANSI, '');
}

export const CSS = `
:root{--bg:#14161a;--panel:#1d2026;--line:#2c313a;--fg:#d7dae0;--dim:#8b93a1;--ok:#3fb950;--skip:#8b93a1;--fail:#f85149;--high:#f85149;--medium:#d29922;--low:#58a6ff}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--panel:#fff;--line:#d9dde3;--fg:#1f2328;--dim:#59636e}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px 80px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:1240px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:15px;margin:20px 0 6px}a{color:var(--low)}code{font:12px ui-monospace,monospace}.dim{color:var(--dim)}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600}td.num{text-align:right;font-variant-numeric:tabular-nums}
.wrap{overflow-x:auto}.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0}
.pill{display:inline-block;padding:0 7px;border-radius:9px;font-size:11.5px;border:1px solid currentColor;margin:1px 2px 1px 0;white-space:nowrap}
.ok{color:var(--ok)}.skipped{color:var(--skip)}.failed{color:var(--fail)}.high{color:var(--high)}.medium{color:var(--medium)}.low{color:var(--low)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}.grid figure{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.grid img{width:100%;display:block}.grid figcaption{padding:6px 8px;font-size:12px}.best{outline:2px solid var(--ok)}.base{outline:2px solid var(--low)}
.run{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:16px}@media (max-width:900px){.run{grid-template-columns:1fr}}
video{width:100%;border-radius:6px;background:#000}.steps{max-height:420px;overflow:auto}.steps tr{cursor:pointer}.steps tr:hover{background:var(--line)}
.frames{display:flex;gap:8px;overflow-x:auto;padding:8px 0}.frames a{flex:0 0 220px;text-decoration:none}.frames img{width:220px;border-radius:4px;border:1px solid var(--line)}.frames span{display:block;font-size:11px;color:var(--dim)}
`;

export function page(title: string, body: string, script = ''): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}
