import { z } from 'zod';
import type { GraphIndex, IndexHolder } from './graphIndex';
import { fileChangedSinceAnalysis, resolveSymbol } from './graphIndex';
import {
  capText, footer, formatFind, formatImpact, formatOverview, formatSource, formatSymbol, formatWalk,
} from './format';
import { overviewOf } from './overview';
import { confine, ToolError } from './paths';
import { findSymbols, impactOf, seedsForPath, walk } from './queries';
import { readSlice } from './sourceSlice';

export interface ToolResult { text: string; isError: boolean; }

export interface ToolContext {
  holder: IndexHolder;
  now: () => number;
  log: (level: 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  run(args: z.objectOutputType<S, z.ZodTypeAny>, index: GraphIndex): string;
}

const STATIC_NOTE = 'Built by static analysis: calls through dynamic dispatch, callbacks, reflection or string lookups can be missing.';
const ID_NOTE = 'Ids look like "src/app.ts::Class.method" (a ":<line>" suffix is added only when the name repeats in that file); raw ids from earlier results keep working.';

const id = z.string().min(1).describe('Function id from find_symbol, get_symbol, callers, callees, impact or overview.');
const optPath = z.string().optional().describe('Workspace-relative file or folder to restrict to, e.g. "src/api".');

function def<S extends z.ZodRawShape>(d: ToolDef<S>): ToolDef<S> { return d; }

export const TOOLS = [
  def({
    name: 'find_symbol',
    title: 'Find functions by name',
    description: `Look up functions and methods by name in CoGraph's call graph of this workspace and get their ids. Matches exact name first, then prefix, then substring; "Class.method" works. Start here when you know a name but not the id. ${ID_NOTE}`,
    inputSchema: {
      query: z.string().min(1).describe('Name, "Class.method", part of a name, or an id.'),
      path: optPath,
      limit: z.number().int().min(1).max(200).default(20),
      includeLibraries: z.boolean().default(false).describe('Also match external library functions the code calls.'),
    },
    run: (a, index) => {
      const r = findSymbols(index, { query: a.query, path: a.path, limit: a.limit, includeLibraries: a.includeLibraries });
      return formatFind(index, a.query, r.items, r.total);
    },
  }),
  def({
    name: 'get_symbol',
    title: 'Get one function',
    description: `One function: location, class, the file's AI summary if annotated, a best-effort source slice with its exact line range, and its direct callers and callees. ${ID_NOTE}`,
    inputSchema: {
      id,
      includeSource: z.boolean().default(true),
      maxLines: z.number().int().min(1).max(400).default(80).describe('Cap on source lines.'),
    },
    run: (a, index) => {
      const s = resolveSymbol(index, a.id);
      const slice = a.includeSource && s.file ? sourceInside(index, s.file, s.line, a.maxLines) : null;
      return formatSymbol(index, s, formatSource(slice, s, !!s.file && fileChangedSinceAnalysis(index, s.file)), 25);
    },
  }),
  def({
    name: 'callers',
    title: 'Who calls this function',
    description: `Functions that call the given function, directly (depth 1) or transitively up to depth 5, grouped by distance. Use it before changing a signature or behaviour. ${STATIC_NOTE}`,
    inputSchema: {
      id,
      depth: z.number().int().min(1).max(5).default(1),
      limit: z.number().int().min(1).max(200).default(50),
    },
    run: (a, index) => {
      const s = resolveSymbol(index, a.id);
      return formatWalk(index, s, 'callers', a.depth, walk(index, s, 'callers', a.depth, a.limit, false));
    },
  }),
  def({
    name: 'callees',
    title: 'What this function calls',
    description: `Functions the given function calls, directly or transitively up to depth 5, grouped by distance. ${STATIC_NOTE}`,
    inputSchema: {
      id,
      depth: z.number().int().min(1).max(5).default(1),
      limit: z.number().int().min(1).max(200).default(50),
      includeLibraries: z.boolean().default(false).describe('Include calls into external libraries.'),
    },
    run: (a, index) => {
      const s = resolveSymbol(index, a.id);
      return formatWalk(index, s, 'callees', a.depth, walk(index, s, 'callees', a.depth, a.limit, a.includeLibraries));
    },
  }),
  def({
    name: 'impact',
    title: 'What breaks if this changes',
    description: `Everything that transitively calls into a function (id) or into every function of a file or folder (path): affected files nearest first, the tests that reach it, and the entry points at the top of those call chains. Use it before editing to see the blast radius. ${STATIC_NOTE}`,
    inputSchema: {
      id: id.optional(),
      path: optPath,
      limit: z.number().int().min(1).max(200).default(100).describe('How many nearest callers to list individually.'),
    },
    run: (a, index) => {
      if (!!a.id === !!a.path) { throw new ToolError('Pass exactly one of id or path.'); }
      const seeds = a.id ? [resolveSymbol(index, a.id)] : seedsForPath(index, a.path as string);
      const label = a.id ? seeds[0].id : `"${a.path}"`;
      return formatImpact(index, label, impactOf(index, seeds), a.limit);
    },
  }),
  def({
    name: 'overview',
    title: 'Project or folder overview',
    description: 'Orientation for the workspace, a folder or a file: languages, folder tree with function counts and AI summaries where annotated, entry points, and hot spots (most-called functions). For a file, it lists its functions. Also reports how fresh the analysis is.',
    inputSchema: {
      path: optPath,
      depth: z.number().int().min(1).max(4).default(2).describe('Folder levels to show.'),
    },
    run: (a, index) => formatOverview(index, overviewOf(index, a.path, a.depth)),
  }),
];

/** Source is only ever read from inside the workspace, even if the cache names a file elsewhere. */
function sourceInside(index: GraphIndex, file: string, line: number, maxLines: number) {
  try { confine(index.root, file); } catch { return { ok: false as const, error: 'file is outside the workspace' }; }
  return readSlice(file, line, { maxLines });
}

export const NO_ANALYSIS = 'No CoGraph analysis for this workspace yet. Open the project in VS Code with the CoGraph extension (CoGraph: Visualize Project) once; it writes .cograph/graph-cache.json, which this server reads.';

/** Run one tool; argument mistakes and missing data become `isError` results, never exceptions. */
export function runTool(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const index = ctx.holder.get();
  if (!index) { return { text: NO_ANALYSIS, isError: true }; }
  try {
    const parsed = z.object(tool.inputSchema).parse(args);
    const body = tool.run(parsed, index);
    return { text: capText(body) + footer(index, ctx.holder.staleness(), ctx.now()), isError: false };
  } catch (err) {
    if (err instanceof ToolError) { return { text: err.message, isError: true }; }
    if (err instanceof z.ZodError) {
      return { text: `Invalid arguments: ${err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`, isError: true };
    }
    ctx.log('error', 'tool failed', { tool: tool.name, error: (err as Error).message });
    return { text: `Internal error in ${tool.name}: ${(err as Error).message}`, isError: true };
  }
}
