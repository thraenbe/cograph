import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ordinal } from '../mcp/compare';
import type { Sym } from '../mcp/ids';
import { ExportError } from './analyze';

/** Marker file of an export folder: `--clean` only ever replaces a folder that holds one. */
export const MANIFEST = 'manifest.json';

export const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');
/** Words: maximal runs of non-whitespace characters. */
export const wordCount = (s: string): number => (s.match(/\S+/g) ?? []).length;

/** Characters Windows forbids in file names become %XX, so every path is valid everywhere. */
export function escapeSegment(seg: string): string {
  return seg.replace(/[<>:"|?*\\%]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

export function relPathFile(prefix: string, rel: string, suffix = '.md'): string {
  return `${prefix}/${rel.split('/').map(escapeSegment).join('/')}${suffix}`;
}

/** `src/a/Score.java::Score.save:12#2` -> `symbols/src/a/Score.java/Score.save-L12-2.md`. */
export function symbolPath(s: Sym): string {
  const m = /^(.*)::(.*?)(?::(\d+)(?:#(\d+))?)?$/.exec(s.id);
  if (!m || !s.rel) { throw new ExportError(`symbol without a file: ${s.id}`); }
  const base = m[2] + (m[3] ? `-L${m[3]}${m[4] ? `-${m[4]}` : ''}` : '');
  return `symbols/${s.rel.split('/').map(escapeSegment).join('/')}/${escapeSegment(base)}.md`;
}

/** The pages of one export, keyed by output-relative path. */
export class Pages {
  private readonly pages = new Map<string, string>();
  private readonly folded = new Map<string, string>();

  /** LF line endings, exactly one trailing newline; paths that differ only in case are an error. */
  put(rel: string, text: string): void {
    const low = rel.toLowerCase();
    const other = this.folded.get(low);
    if (other !== undefined && other !== rel) {
      throw new ExportError(`two output files differ only in case, which breaks on macOS and Windows: ${other} and ${rel}`);
    }
    this.folded.set(low, rel);
    // Only trailing newlines go: a TSV's last row can end in an empty cell, i.e. a tab.
    this.pages.set(rel, `${text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')}\n`);
  }

  entries(): Array<[string, string]> {
    return [...this.pages].sort((a, b) => ordinal(a[0], b[0]));
  }
}

export interface FileEntry { path: string; bytes: number; words: number; sha256: string; }

export function fileEntries(pages: Pages): FileEntry[] {
  return pages.entries().map(([p, text]) => ({ path: p, bytes: Buffer.byteLength(text, 'utf8'), words: wordCount(text), sha256: sha256(text) }));
}

/** Byte and word totals per top-level folder ('.' for files in the root). */
export function folderTotals(entries: FileEntry[]): Record<string, { files: number; bytes: number; words: number }> {
  const out: Record<string, { files: number; bytes: number; words: number }> = {};
  for (const e of entries) {
    const i = e.path.indexOf('/');
    const k = i < 0 ? '.' : e.path.slice(0, i);
    const t = out[k] ?? (out[k] = { files: 0, bytes: 0, words: 0 });
    t.files++; t.bytes += e.bytes; t.words += e.words;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => ordinal(a[0], b[0])));
}

/** JSON with keys in a fixed order (as built) and two-space indent. */
export const stableJson = (v: unknown): string => JSON.stringify(v, null, 2);

/**
 * Write the pages to a fresh folder next to `outDir` and swap it into place, so a failed run
 * leaves nothing half written and no file of an earlier export survives. An existing `outDir`
 * is replaced only with `clean` and only when it holds an earlier export's manifest.
 */
export function writeExport(outDir: string, pages: Pages, clean: boolean): void {
  const target = path.resolve(outDir);
  if (fs.existsSync(target)) {
    const entries = fs.readdirSync(target);
    if (entries.length > 0) {
      if (!clean) { throw new ExportError(`${target} is not empty; pass --clean to replace an earlier export`, 2); }
      if (!fs.existsSync(path.join(target, MANIFEST))) {
        throw new ExportError(`${target} holds no ${MANIFEST}, so it is not an earlier export; refusing to replace it`, 2);
      }
    }
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(parent, `.${path.basename(target)}.tmp-`));
  try {
    for (const [rel, text] of pages.entries()) {
      const file = path.join(tmp, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
    }
    if (fs.existsSync(target)) {
      const old = `${tmp}.old`;
      fs.renameSync(target, old);
      fs.renameSync(tmp, target);
      fs.rmSync(old, { recursive: true, force: true });
    } else {
      fs.renameSync(tmp, target);
    }
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}
