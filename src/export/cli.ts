import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildIndex, type GraphIndex } from '../mcp/graphIndex';
import { ordinal } from '../mcp/compare';
import type { StructureLanguage } from '../structureScanner';
import { analyze, ANALYZER_FILES, ExportError, LANGUAGES, relOf, scriptsDir, type AnalysisResult } from './analyze';
import { allClassNames, resolveEntry, type Resolved } from './entries';
import { indexJavaFacts, type JavaFacts } from './javaFacts';
import { fileEntries, folderTotals, MANIFEST, Pages, sha256, stableJson, writeExport } from './output';
import { renderPages, type RenderOptions } from './render';
import { REASONS } from './renderJava';

/** Bumped when the layout or a page format changes in a way a consumer must know about. */
export const EXPORT_FORMAT = 1;

const USAGE = `Usage: npm run export:md -- <repo> --out <dir> [options]   (or: node out/export/cli.js ...)
  --lang <list>           analysers to run: ${LANGUAGES.join(',')} (default: all)
  --symbols <list|@file>  only these get a symbol file (comma list, or one entry per line in a file)
  --features <file.json>  {"<feature>": ["<entry>", ...]}; an entry is a method, a class or a file.
                          A file grouped by project ({"<set>": {"<feature>": [...]}}) needs
  --feature-set <name>    the group to use (default: the repo folder's name)
  --depth <1-5>           callers and callees depth in symbol and feature files (default 2)
  --source                add the source slice to symbol and feature files
  --python <bin>          Python for the Python analyser (default python3)
  --clean                 replace <dir> when it holds an earlier export`;

export interface CliOptions {
  repo: string; out: string; languages: StructureLanguage[]; symbols: string[] | null;
  featuresFile: string | null; featureSet: string | null; depth: number; source: boolean; python: string; clean: boolean;
}

/** Command line -> options; a usage error is an ExportError with exit code 2, `--help` one with exit code 0. */
export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { repo: '', out: '', languages: [...LANGUAGES], symbols: null, featuresFile: null, featureSet: null, depth: 2, source: false, python: 'python3', clean: false };
  /** The value after argument i; a missing one is a usage error. */
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { throw new ExportError(`${flag} needs a value\n${USAGE}`, 2); }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--out': o.out = value(i++, a); break;
      case '--lang': {
        const langs = value(i++, a).split(',').map((s) => s.trim()).filter(Boolean);
        const bad = langs.filter((l) => !(LANGUAGES as string[]).includes(l));
        if (bad.length || !langs.length) { throw new ExportError(`unknown language: ${bad.join(', ') || '(none)'}; use ${LANGUAGES.join(', ')}`, 2); }
        o.languages = LANGUAGES.filter((l) => langs.includes(l));
        break;
      }
      case '--symbols': {
        const v = value(i++, a);
        const raw = v.startsWith('@') ? fs.readFileSync(v.slice(1), 'utf8').split('\n') : v.split(',');
        o.symbols = raw.map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '--features': o.featuresFile = value(i++, a); break;
      case '--feature-set': o.featureSet = value(i++, a); break;
      case '--depth': {
        const d = Number(value(i++, a));
        if (!Number.isInteger(d) || d < 1 || d > 5) { throw new ExportError('--depth must be a whole number from 1 to 5', 2); }
        o.depth = d;
        break;
      }
      case '--source': o.source = true; break;
      case '--clean': o.clean = true; break;
      case '--python': o.python = value(i++, a); break;
      case '--help': case '-h': throw new ExportError(USAGE, 0);
      default:
        if (a.startsWith('--') || o.repo) { throw new ExportError(`unexpected argument: ${a}\n${USAGE}`, 2); }
        o.repo = a;
    }
  }
  if (!o.repo || !o.out) { throw new ExportError(USAGE, 2); }
  return o;
}

const FEATURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

/** A plain object (not null, not an array). */
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Features from the JSON file: `{feature: [entries]}` or, when grouped by project, the group
 * named `set`. Names and entry lists are validated; both come out sorted and deduplicated.
 */
function readFeatures(file: string, set: string): Array<{ name: string; entries: string[] }> {
  let data: unknown;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new ExportError(`cannot read ${file}: ${(err as Error).message}`, 2); }
  if (!isObject(data)) { throw new ExportError(`${file} must hold {"<feature>": ["<entry>", ...]}`, 2); }
  const values = Object.values(data);
  if (values.length && values.every(isObject)) {
    const group = data[set];
    if (!isObject(group)) { throw new ExportError(`${file} has no feature set "${set}"; it has: ${Object.keys(data).sort(ordinal).join(', ')}`, 2); }
    data = group;
  }
  return Object.entries(data as Record<string, unknown>).map(([name, entries]) => {
    if (!FEATURE_NAME.test(name)) { throw new ExportError(`feature name "${name}" may only use letters, digits, space, dot, dash and underscore`, 2); }
    if (!Array.isArray(entries) || !entries.length || !entries.every((e) => typeof e === 'string')) {
      throw new ExportError(`feature "${name}" needs a non-empty list of entry strings`, 2);
    }
    return { name, entries: [...new Set(entries as string[])].sort(ordinal) };
  }).sort((a, b) => ordinal(a.name, b.name));
}

interface ToolInfo { version: string; commit: string | null; dirty: boolean | null; analyzers: Record<string, string>; analyzerId: string; }

/** Version, commit and dirty state of this checkout, plus the sha256 of every analyser file and their combined id. */
function toolInfo(): ToolInfo {
  const repo = path.resolve(__dirname, '..', '..');
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version; } catch { /* not in a checkout */ }
  /** Trimmed git output, or null when git or the checkout is missing. */
  const git = (args: string[]) => { try { return cp.execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const commit = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain', '--', 'scripts', 'src']);
  const dirs = scriptsDir();
  const analyzers: Record<string, string> = {};
  const fromSources = fs.existsSync(path.join(dirs.sources, 'analyze_java.js'));
  const [prefix, dir] = fromSources || !dirs.bundled ? ['scripts', dirs.sources] : ['dist/scripts', dirs.bundled];
  for (const f of ANALYZER_FILES) {
    try { analyzers[`${prefix}/${f}`] = sha256(fs.readFileSync(path.join(dir, f))); } catch { /* not part of this build */ }
  }
  const sorted = Object.keys(analyzers).sort(ordinal);
  const analyzerId = sha256(sorted.map((k) => `${k}\t${analyzers[k]}\n`).join(''));
  return { version, commit, dirty: status === null ? null : status !== '', analyzers: Object.fromEntries(sorted.map((k) => [k, analyzers[k]])), analyzerId };
}

/** README.md of the export: format and options, what each file holds, and the limits of the analysis. */
function readme(o: CliOptions, tool: ToolInfo, result: AnalysisResult): string {
  const langs = result.runs.map((r) => `${r.language} (${r.files} files)`).join(', ') || 'none';
  return `# CoGraph Markdown export

Deterministic call-graph context, made by CoGraph's analysers and the formatters of its MCP server. No
AI is involved: Annotate Graph summaries are left out. Two runs on the same code give byte-identical
files, also from another path or machine.

- Format ${EXPORT_FORMAT}, CoGraph ${tool.version}, commit ${tool.commit ? tool.commit.slice(0, 12) : 'unknown'}${tool.dirty ? ' with uncommitted changes' : ''}, analyser id ${tool.analyzerId.slice(0, 16)}
- Analysed: ${langs}
- Options: depth ${o.depth}, source slices ${o.source ? 'on' : 'off'}, symbol files ${o.symbols ? `for ${o.symbols.length} entries` : 'for every function'}

## Files

- \`overview.md\`: languages, folder tree, entry points, hot spots, and the Java classes.
- \`files/<path>.md\`: per source file its classes (class cards) and functions with direct callers and callees.
- \`symbols/<path>/<Class.method>.md\`: per function its card, callers and callees within depth ${o.depth}, impact, and (Java) its call sites. A \`-L<line>\` suffix marks a name that repeats in the file.
- \`features/<name>.md\`: per feature its entries, class cards, functions, the callers and callees around them, and the combined impact.
- \`edges.md\`, \`edges.tsv\`: edge counts per language and file; every edge (caller, callee, kind).
- \`callsites.tsv\`, \`unresolved.tsv\` (Java): every call site with its targets, and the ones without an edge with the reason.
- \`nodes.tsv\`, \`signatures.tsv\`, \`literals.tsv\` (Java): classes and methods with line ranges, declarations and
  signatures with Javadoc, and the string literals that name a URL, an asset or a file.
- \`manifest.json\`: inputs with sha256, options, analyser hashes, and bytes, words (runs of non-whitespace) and sha256 per file.

## Limits

Static analysis: a call through reflection, a callback or a string lookup has no edge. A recursive call to the
same function is not an edge. Java calls link to the static target (the method javac would pick for the declared
receiver type); overrides in subclasses are not added. Java call sites without an edge, by reason:

${Object.entries(REASONS).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n')}

Ids are \`<path>::<Class.method>\`, with \`:<line>\` added when the name repeats in a file (overloads), so they
change when lines move. Library ids are \`library::<package>.<Class>::<method>\` in Java, constructors \`<init>\`.
`;
}

/** manifest.json: tool, options, inputs with hashes, analyser runs and the per-file and per-folder totals. */
function manifest(o: CliOptions, tool: ToolInfo, result: AnalysisResult, features: Array<{ name: string; entries: Resolved[] }>, pages: Pages): string {
  const files = fileEntries(pages);
  return stableJson({
    format: EXPORT_FORMAT,
    tool: { name: 'cograph-export', version: tool.version, commit: tool.commit, dirty: tool.dirty, analyzerId: tool.analyzerId, analyzers: tool.analyzers },
    options: { languages: o.languages, depth: o.depth, source: o.source, symbols: o.symbols, features: features.map((f) => ({ name: f.name, entries: f.entries.map((e) => e.entry), seeds: [...new Set(f.entries.flatMap((e) => e.seeds.map((s) => s.id)))].sort(ordinal) })) },
    inputs: result.files.map((f) => ({ path: f.rel, language: f.language, sha256: sha256(fs.readFileSync(f.abs)) })),
    // snake case and this formula as in the research's interim export, whose readers check it.
    inputs_sha256: sha256(result.files.map((f) => `${f.rel}\t${sha256(fs.readFileSync(f.abs))}\n`).join('')),
    analyzers: result.runs,
    totals: folderTotals(files),
    files,
  });
}

/** Real path of `p`; a path that does not exist yet resolves its nearest existing ancestor and keeps the rest. */
export function realPathOf(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) { break; }
    rest.unshift(path.basename(cur));
    cur = up;
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

/** The repo folder as a real path; a missing or unreadable path is a usage error, not an internal one. */
function repoRoot(repo: string): string {
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(repo));
  } catch (err) {
    throw new ExportError(`cannot open the repo folder ${path.resolve(repo)}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`, 2);
  }
  if (!fs.statSync(root).isDirectory()) { throw new ExportError(`${root} is not a folder`, 2); }
  return root;
}

/**
 * The output folder must not be the repo or one of its parents: with --clean the swap would replace
 * the analysed sources. A folder inside the repo (`<repo>/export`) is fine.
 */
function checkOutDir(root: string, outDir: string): void {
  const out = realPathOf(outDir);
  const up = path.relative(out, root);
  const outside = up === '..' || up.startsWith(`..${path.sep}`) || path.isAbsolute(up);
  if (!outside) {
    throw new ExportError(`--out ${out} is the repo folder or one of its parents; use a folder beside the repo or a subfolder of it`, 2);
  }
}

/** The whole export: analyse, index, render, write. Returns the number of files written. */
export function runExport(o: CliOptions): number {
  const root = repoRoot(o.repo);
  checkOutDir(root, o.out);
  const result = analyze(root, o.languages, o.python);
  if (result.graph.nodes.length === 0) { throw new ExportError(`no functions found in ${root} for ${o.languages.join(', ')}`); }
  const empty = { version: 0, provider: '', model: '', generatedAt: '', files: {}, folders: {} };
  const index: GraphIndex = buildIndex(root, { schemaVersion: 1, savedAt: '1970-01-01T00:00:00.000Z', manifest: {}, graph: result.graph }, empty);
  const facts: JavaFacts = indexJavaFacts(root, result.java);
  const sourceRels = new Set(result.files.map((f) => f.rel));
  const classNames = allClassNames(index, [...facts.classesByRel].flatMap(([rel, cs]) => cs.map((c) => ({ rel, name: c.name }))));
  /** An entry string -> its functions and classes. */
  const resolve = (e: string) => resolveEntry(index, e, sourceRels, classNames);
  const set = o.featureSet ?? path.basename(root);
  const features = o.featuresFile ? readFeatures(o.featuresFile, set).map((f) => ({ name: f.name, entries: f.entries.map(resolve) })) : [];
  const symbols = o.symbols ? [...new Map(o.symbols.flatMap((e) => resolve(e).seeds).map((s) => [s.rawId, s])).values()] : null;
  const ro: RenderOptions = { depth: o.depth, source: o.source, symbols, features };
  const pages = renderPages(root, index, result.files, facts, result.runs, ro);
  const tool = toolInfo();
  pages.put('README.md', readme(o, tool, result));
  pages.put(MANIFEST, manifest(o, tool, result, features, pages));
  writeExport(o.out, pages, o.clean);
  return pages.entries().length;
}

/** Run the export and return the process exit code; an ExportError prints one line, anything else its stack. */
export function main(argv = process.argv.slice(2)): number {
  try {
    const o = parseArgs(argv);
    const n = runExport(o);
    process.stderr.write(`cograph-export: wrote ${n} files to ${path.resolve(o.out)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof ExportError) {
      (err.exitCode === 0 ? process.stdout : process.stderr).write(`${err.exitCode === 0 ? '' : 'cograph-export: '}${err.message}\n`);
      return err.exitCode;
    }
    process.stderr.write(`cograph-export: internal error: ${(err as Error).stack ?? String(err)}\n`);
    return 1;
  }
}

if (require.main === module) { process.exitCode = main(); }

export { relOf };
