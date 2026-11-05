import { ordinal } from '../mcp/compare';
import { resolveSymbol, type GraphIndex } from '../mcp/graphIndex';
import { displayName, type Sym } from '../mcp/ids';
import { byLocation, isLocal } from '../mcp/queries';
import { ExportError } from './analyze';

/** One resolved entry: the functions it stands for, and the classes whose cards belong with it. */
export interface Resolved {
  entry: string;
  kind: 'method' | 'class' | 'file';
  seeds: Sym[];
  /** `<rel>::<Class>` of every class the entry covers or the method sits in. */
  classes: string[];
}

const classKey = (rel: string, cls: string) => `${rel}::${cls}`;

/**
 * A feature or symbol entry: a file (`src/a/Score.java`), a class (`Score`, or
 * `src/a/Score.java::Score` when the name exists in several files), or a method (an MCP id, or a
 * unique `Class.method` or method name). A file or class stands for all its functions. Anything
 * that matches more than one thing is an error that lists the candidates; nothing is guessed.
 * `classNames` holds every `<rel>::<Class>` of the project, also classes without methods.
 */
export function resolveEntry(index: GraphIndex, entry: string, sourceRels: Set<string>, classNames: Set<string>): Resolved {
  const e = entry.trim();
  if (!e) { throw new ExportError('an empty entry', 2); }
  const local = index.symbols.filter(isLocal);
  if (sourceRels.has(e)) {
    const seeds = (index.byFile.get(e) ?? []).filter(isLocal);
    const classes = [...classNames].filter((k) => k.startsWith(`${e}::`));
    return { entry: e, kind: 'file', seeds, classes: classes.sort(ordinal) };
  }
  const sep = e.lastIndexOf('::');
  const relPart = sep < 0 ? null : e.slice(0, sep);
  const clsPart = sep < 0 ? e : e.slice(sep + 2);
  const classHits = [...classNames].filter((k) => {
    const i = k.lastIndexOf('::');
    return k.slice(i + 2) === clsPart && (relPart === null || k.slice(0, i) === relPart);
  }).sort(ordinal);
  if (classHits.length > 1) {
    throw new ExportError(`entry "${e}" names ${classHits.length} classes; use one of: ${classHits.join(', ')}`, 2);
  }
  if (classHits.length === 1) {
    const k = classHits[0];
    const i = k.lastIndexOf('::');
    const rel = k.slice(0, i);
    const cls = k.slice(i + 2);
    const seeds = local.filter((s) => s.rel === rel && s.className === cls).sort(byLocation);
    return { entry: e, kind: 'class', seeds, classes: [k] };
  }
  let s: Sym;
  try {
    s = resolveSymbol(index, e);
  } catch (err) {
    const byName = local.filter((x) => displayName(x) === e || x.name === e).sort(byLocation);
    if (byName.length !== 1) {
      const why = byName.length ? `names ${byName.length} functions; use one of: ${byName.map((x) => x.id).join(', ')}` : (err as Error).message;
      throw new ExportError(`entry "${e}" ${why}`, 2);
    }
    s = byName[0];
  }
  if (!isLocal(s)) { throw new ExportError(`entry "${e}" is not a function of this project`, 2); }
  return { entry: e, kind: 'method', seeds: [s], classes: s.className && s.rel ? [classKey(s.rel, s.className)] : [] };
}

/** Every `<rel>::<Class>` the graph or the Java facts know. */
export function allClassNames(index: GraphIndex, javaClasses: Array<{ rel: string; name: string }>): Set<string> {
  const out = new Set<string>();
  for (const s of index.symbols) { if (isLocal(s) && s.className && s.rel) { out.add(classKey(s.rel, s.className)); } }
  for (const c of javaClasses) { out.add(classKey(c.rel, c.name)); }
  return out;
}
