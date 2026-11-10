import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GraphData } from '../graphProvider';
import { listProjectSourceFiles, type StructureLanguage } from '../structureScanner';
import { ordinal } from '../mcp/compare';
import type { JavaExportInfo } from './javaFacts';

export const LANGUAGES: StructureLanguage[] = ['python', 'typescript', 'javascript', 'java', 'cpp', 'c'];

const SCRIPT: Record<StructureLanguage, string> = {
  python: 'analyze.py', typescript: 'analyze_ts.js', javascript: 'analyze_js.js', java: 'analyze_java.js',
  cpp: 'analyze_cpp.js', c: 'analyze_c.js',
};

/** Every file an analyser reads besides its entry script; their hashes freeze the analyser version. */
export const ANALYZER_FILES = [
  'analyze.py', 'analyze_ts.js', 'analyze_js.js', 'analyze_java.js', 'analyze_cpp.js', 'analyze_c.js',
  'javaTypes.js', 'javaResolve.js', 'javaExportInfo.js', 'tsJsAnalyzer.js', 'sfcScript.js', 'cFamily.js', 'cStdlib.js',
  'narrowCalls.js', 'graphOutput.js', 'sourceFiles.js', 'skipDirs.js', 'skipDirs.json',
];

/** Vue and Svelte single-file components. */
const isComponent = (rel: string) => /\.(vue|svelte)$/i.test(rel);

const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

export interface SourceFile { abs: string; rel: string; language: StructureLanguage; }

export interface AnalysisResult {
  graph: GraphData;
  java: JavaExportInfo | null;
  files: SourceFile[];
  /** Per language: files given to the analyser, and its own counters when it reported any. */
  runs: Array<{ language: StructureLanguage; files: number; stats?: Record<string, number> }>;
}

/** A failure reported to the user as one line; `exitCode` becomes the process exit code (0 for --help). */
export class ExportError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); this.name = 'ExportError'; }
}

/** Path of `abs` relative to `root`, with forward slashes. */
export function relOf(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * The project's source files of the chosen languages, by the extension's own scope rule
 * (git-tracked when the folder is a git work tree, else a walk that skips artefact folders),
 * sorted ordinally by relative path so every analyser sees one input order.
 */
export function sourceFiles(root: string, languages: StructureLanguage[]): SourceFile[] {
  const want = new Set(languages);
  return listProjectSourceFiles(root)
    .filter((f) => want.has(f.language))
    .map((f) => ({ abs: f.path, rel: relOf(root, f.path), language: f.language }))
    .sort((a, b) => ordinal(a.rel, b.rel));
}

/**
 * Where the analyser scripts live. The sources under scripts/ win: a dist/ bundle can be older
 * than the checkout, and running it would silently export with an older analyser.
 */
export function scriptsDir(fromDir: string = __dirname): { bundled: string | null; sources: string } {
  const repo = path.resolve(fromDir, '..', '..');
  const bundled = path.join(repo, 'dist', 'scripts');
  return { bundled: fs.existsSync(path.join(bundled, 'analyze_java.js')) ? bundled : null, sources: path.join(repo, 'scripts') };
}

/** The analyser script of a language: the source under scripts/ when present, else the bundled copy. */
function scriptPath(language: StructureLanguage): string {
  const dirs = scriptsDir();
  const source = path.join(dirs.sources, SCRIPT[language]);
  if (fs.existsSync(source) || !dirs.bundled) { return source; }
  return path.join(dirs.bundled, SCRIPT[language]);
}

/**
 * Run one analyser on the file list and parse its JSON graph. A start failure, a non-zero
 * exit or invalid output is an ExportError.
 */
function runOne(language: StructureLanguage, root: string, listPath: string, python: string): GraphData & { stats?: Record<string, number>; exportInfo?: JavaExportInfo } {
  const bin = language === 'python' ? python : process.execPath;
  const args = [scriptPath(language), root, '--files', listPath];
  if (language === 'java') { args.push('--export-info'); }
  // A fixed hash seed, so nothing the Python analyser does can depend on set iteration order.
  const env = { ...process.env, PYTHONHASHSEED: '0' };
  const res = cp.spawnSync(bin, args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, env });
  if (res.error) { throw new ExportError(`the ${language} analyser could not start (${bin}): ${res.error.message}`); }
  if (res.status !== 0) {
    throw new ExportError(`the ${language} analyser failed with exit ${res.status}: ${(res.stderr || '').trim().slice(0, 400)}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new ExportError(`the ${language} analyser printed no valid JSON: ${(res.stderr || '').trim().slice(0, 400)}`);
  }
}

/**
 * Run the analysers one after another in a fixed language order and merge their graphs. A
 * failing analyser stops the export: a partial graph would be written as if it were complete.
 */
export function analyze(root: string, languages: StructureLanguage[], python: string): AnalysisResult {
  const files = sourceFiles(root, languages);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-export-'));
  const graph: GraphData = { nodes: [], edges: [], files: [] };
  const runs: AnalysisResult['runs'] = [];
  let java: JavaExportInfo | null = null;
  try {
    // One list for all, as the extension does: each analyser keeps its own extensions, and Vue and
    // Svelte components go to the TS or JS analyser by their script language.
    const listPath = path.join(tmp, 'files.txt');
    fs.writeFileSync(listPath, files.map((f) => f.abs).join('\n') + '\n', 'utf8');
    for (const language of LANGUAGES.filter((l) => languages.includes(l))) {
      const mine = files.filter((f) => f.language === language || (language === 'javascript' && f.language === 'typescript' && isComponent(f.rel)));
      if (mine.length === 0) { continue; }
      const out = runOne(language, root, listPath, python);
      graph.nodes.push(...out.nodes);
      graph.edges.push(...out.edges);
      runs.push({ language, files: mine.length, ...(out.stats ? { stats: out.stats } : {}) });
      if (out.exportInfo) { java = out.exportInfo; }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { graph, java, files, runs };
}
