// The canvas legend (1.4 feedback F1: "what does a dashed outline mean?"). One row per
// outline or glyph the Shelf canvas draws, one short line each. Static markup, no
// repository text, so it is safe to inline into the webview HTML.
//
// Meanings, kept to one per mark:
//   solid file slot     a file with functions
//   dashed file slot    a file with no functions found (dashed = empty / not there yet)
//   tabbed frame        a folder
//   faint solid outline the files at the top level of the repository (the root frame)
//   dashed line         calls still being parsed
//   ↗ at a function     its calls go to other files and are hidden by "Only calls within a file"
//   ↗N after a file     N calls leave that file, hidden by the same switch
//   thick slot border   the file changed (Git mode)

interface LegendRow { swatch: string; label: string; title?: string }

const SW = 'width="24" height="14" viewBox="0 0 24 14" aria-hidden="true"';

const ROWS: LegendRow[] = [
  {
    swatch: `<svg ${SW}><rect x="1.5" y="1.5" width="21" height="11" rx="3" fill="none" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.2"/></svg>`,
    label: 'File',
  },
  {
    swatch: `<svg ${SW}><rect x="1.5" y="1.5" width="21" height="11" rx="3" fill="none" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.2" stroke-dasharray="4 3"/></svg>`,
    label: 'File with no functions found',
  },
  {
    swatch: `<svg ${SW}><path d="M1.5 12.5V3.5a2 2 0 0 1 2-2H10l2 2h8.5a2 2 0 0 1 2 2v7z" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.2"/></svg>`,
    label: 'Folder',
  },
  {
    swatch: `<svg ${SW}><rect x="1.5" y="1.5" width="21" height="11" rx="3" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1"/></svg>`,
    label: 'Files at the top level of the repository',
  },
  {
    swatch: `<svg ${SW}><line x1="1" y1="7" x2="23" y2="7" stroke="currentColor" stroke-opacity="0.7" stroke-width="1.5" stroke-dasharray="4 3"/></svg>`,
    label: 'Calls still being parsed',
  },
  {
    // the arrow is xfileArrowD(7, 9, 4.5), the canvas geometry at a small radius
    swatch: `<svg ${SW}><circle cx="7" cy="9" r="4.5" fill="currentColor" fill-opacity="0.75"/>`
      + '<path d="M11.3 4L12.8 2.4L12.3 1.9L14.5 1.5L14.1 3.7L13.6 3.2L12 4.7Z" fill="currentColor" fill-opacity="0.85"/></svg>',
    label: 'Only calls other files (hidden)',
    title: 'This function only calls functions in other files. "Only calls within a file" hides those lines; hover the function to see them.',
  },
  {
    swatch: '<span class="tl-legend-glyph">a.py ↗3</span>',
    label: 'Calls leaving the file (hidden)',
    title: '3 calls go from this file to other files. Shown while "Only calls within a file" hides them.',
  },
  {
    swatch: `<svg ${SW}><rect x="1.5" y="1.5" width="21" height="11" rx="3" fill="none" stroke="#ff9800" stroke-width="2"/></svg>`,
    label: 'File changed (Git)',
  },
];

function rowHtml(r: LegendRow): string {
  const title = r.title ? ` title="${r.title.replace(/"/g, '&quot;')}"` : '';
  return `<div class="tl-legend-row"${title}><span class="tl-legend-swatch">${r.swatch}</span>`
    + `<span class="tl-legend-label">${r.label}</span></div>`;
}

/** Collapsible "Legend" header + body for the Folder panel (wired by controls.js). */
export const SHAPES_LEGEND_HTML = `<div class="tl-legend-header" id="toggle-shapes-legend">
        <span>Legend</span>
        <span class="tl-chevron">▾</span>
      </div>
      <div class="tl-legend" id="shapes-legend-body">
        ${ROWS.map(rowHtml).join('\n        ')}
      </div>`;

/** The meanings in order, for tests. */
export const SHAPES_LEGEND_LABELS: readonly string[] = ROWS.map(r => r.label);
