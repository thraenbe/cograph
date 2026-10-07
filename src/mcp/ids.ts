import type { GraphNode } from '../graphProvider';
import { relPath } from './paths';

/** One function/method as the MCP server exposes it. */
export interface Sym {
  /** Id in the graph cache: `<absPath>::<name>::<line>` or `library::<lib>::<name>`. */
  rawId: string;
  /** Agent-facing id: `<relPath>::<Class.>name`, plus `:<line>` only when that is ambiguous. */
  id: string;
  name: string;
  className?: string;
  classExtends?: string;
  classImplements?: string[];
  /** Absolute path, or null for library / module-level nodes. */
  file: string | null;
  /** Workspace-relative POSIX path, or null. */
  rel: string | null;
  line: number;
  language?: string;
  isLibrary: boolean;
  libraryName?: string;
  /** The synthetic `::MAIN::0` node: code at module level, outside any function. */
  isModule: boolean;
}

export const MODULE_ID = 'MAIN';

export function displayName(s: Pick<Sym, 'name' | 'className'>): string {
  return s.className ? `${s.className}.${s.name}` : s.name;
}

export function toSym(root: string, n: GraphNode): Sym {
  const isLibrary = !!n.isLibrary;
  const isModule = !isLibrary && !n.file && n.name === 'MAIN';
  const file = !isLibrary && n.file ? n.file : null;
  return {
    rawId: n.id,
    id: '',
    name: n.name,
    className: n.className,
    classExtends: n.classExtends,
    classImplements: n.classImplements,
    file,
    rel: file ? relPath(root, file) : null,
    line: n.line,
    language: n.language,
    isLibrary,
    libraryName: n.libraryName,
    isModule,
  };
}

/** The id before any disambiguation. Library ids are already path-free, so they are kept. */
export function baseId(s: Sym): string {
  if (s.isLibrary) { return s.rawId; }
  if (s.isModule || !s.rel) { return MODULE_ID; }
  return `${s.rel}::${displayName(s)}`;
}

/** Fill `id` on every symbol; returns the base → symbols map used for fuzzy resolution. */
export function assignIds(symbols: Sym[]): Map<string, Sym[]> {
  const byBase = new Map<string, Sym[]>();
  for (const s of symbols) {
    const b = baseId(s);
    const list = byBase.get(b);
    if (list) { list.push(s); } else { byBase.set(b, [s]); }
  }
  for (const [b, list] of byBase) {
    if (list.length === 1) { list[0].id = b; continue; }
    list.sort((a, c) => a.line - c.line);
    const seen = new Map<number, number>();
    for (const s of list) {
      const n = (seen.get(s.line) ?? 0) + 1;
      seen.set(s.line, n);
      s.id = n === 1 ? `${b}:${s.line}` : `${b}:${s.line}#${n}`;
    }
  }
  return byBase;
}

/** Split a trailing `:<line>` (and optional `#n`) off an agent id. */
export function splitLine(input: string): { base: string; line: number | null } {
  const m = /^(.*):(\d+)(?:#\d+)?$/.exec(input);
  return m ? { base: m[1], line: Number(m[2]) } : { base: input, line: null };
}
