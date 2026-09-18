// Scripted stand-in for the extension host (graphProvider.ts). Records every
// message the webview posts and answers the ones a real host would answer.
// Never writes to the repository under test.
import * as fs from 'fs';

export interface HostMessage { type: string; [k: string]: unknown }
export interface HostReply { message: HostMessage; delayMs?: number }
export interface LoggedMessage { atMs: number; message: HostMessage }

export interface GraphNodeLite { id: string; file: string | null; line: number; isLibrary?: boolean; [k: string]: unknown }
export interface GraphEdgeLite { source: string; target: string; [k: string]: unknown }
export interface GraphLite { nodes: GraphNodeLite[]; edges: GraphEdgeLite[]; files?: string[]; [k: string]: unknown }

export type HostMode = 'eager' | 'lazy';

export interface FakeHostOpts {
  graph: GraphLite;
  structure: unknown;
  mode?: HostMode;
  /** Simulated subset-parse latency in lazy mode. */
  parseDelayMs?: number;
  gitAvailable?: boolean;
  fileGitStatus?: Record<string, unknown>;
}

const MAX_SOURCE_LINES = 60;

/** Cut a function-sized slice out of a file; mirrors getFuncSource loosely. */
export function readSourceSlice(file: string, line: number): string {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = Math.max(0, line - 1);
  return lines.slice(start, start + MAX_SOURCE_LINES).join('\n');
}

/** Nodes of `files` plus every edge touching them and the library nodes those edges reach. */
export function cutPatch(graph: GraphLite, files: string[]): GraphLite {
  const want = new Set(files);
  const nodes = graph.nodes.filter(n => n.file !== null && want.has(n.file));
  const ids = new Set(nodes.map(n => n.id));
  const edges = graph.edges.filter(e => ids.has(e.source) || ids.has(e.target));
  const libIds = new Set<string>();
  for (const e of edges) { libIds.add(e.source); libIds.add(e.target); }
  const libs = graph.nodes.filter(n => n.isLibrary && libIds.has(n.id) && !ids.has(n.id));
  return { nodes: [...nodes, ...libs], edges, files };
}

export class FakeHost {
  readonly log: LoggedMessage[] = [];
  readonly saved: HostMessage[] = [];
  readonly editedSources = new Map<string, string>();
  private readonly t0 = Date.now();

  constructor(private readonly opts: FakeHostOpts) {}

  get mode(): HostMode { return this.opts.mode ?? 'eager'; }

  /** Messages a real host sends right after the panel opens. */
  openingMessages(): HostReply[] {
    const git = { gitAvailable: this.opts.gitAvailable ?? false, fileGitStatus: this.opts.fileGitStatus ?? {} };
    const structure: HostReply = { message: { type: 'structure', tree: this.opts.structure, autoEngage: true } };
    if (this.mode === 'lazy') {
      return [structure, { message: { type: 'analysis-state', backgroundParsing: true } }];
    }
    return [structure, { message: { type: 'graph', data: this.opts.graph, ...git, isReanalysis: false } }];
  }

  /** Lazy mode: the background pass finishing (full graph arrives). */
  backgroundDone(): HostReply[] {
    return [
      { message: { type: 'graph', data: this.opts.graph, gitAvailable: this.opts.gitAvailable ?? false,
        fileGitStatus: this.opts.fileGitStatus ?? {}, isReanalysis: false } },
      { message: { type: 'analysis-state', backgroundParsing: false } },
    ];
  }

  posted(type: string): HostMessage[] {
    return this.log.filter(l => l.message.type === type).map(l => l.message);
  }

  async onMessage(msg: HostMessage): Promise<HostReply[]> {
    this.log.push({ atMs: Date.now() - this.t0, message: msg });
    switch (msg.type) {
      case 'get-func-source': return [this.funcSource(msg)];
      case 'save-func-source': return this.saveFuncSource(msg);
      case 'get-lib-description':
        return [{ message: { type: 'lib-description', description: 'uxtest canned library description.', reqId: msg.reqId }, delayMs: 50 }];
      case 'expand-folder': return this.parseSubset((msg.files as string[]) ?? [], String(msg.folderPath ?? ''));
      case 'parse-file': {
        const fp = String(msg.filePath ?? '');
        return this.parseSubset(fp ? [fp] : [], fp.replace(/[\\/][^\\/]*$/, ''));
      }
      case 'save-graph':
        this.saved.push(msg);
        return [{ message: { type: 'clear-dirty' } }];
      case 'cancel-analysis':
        return [{ message: { type: 'analysis-state', backgroundParsing: false, cancelled: true } }];
      default:
        return []; // navigate, dirty-state, open-chat, open-docs, perf-report, … are record-only
    }
  }

  private funcSource(msg: HostMessage): HostReply {
    const file = String(msg.file ?? '');
    const line = Number(msg.line ?? 1);
    try {
      const source = this.editedSources.get(`${file}:${line}`) ?? readSourceSlice(file, line);
      const endLine = line + source.split('\n').length - 1;
      return { message: { type: 'func-source', source, endLine, reqId: msg.reqId }, delayMs: 30 };
    } catch (err) {
      return { message: { type: 'func-source', source: '', error: (err as Error).message, reqId: msg.reqId } };
    }
  }

  private saveFuncSource(msg: HostMessage): HostReply[] {
    this.editedSources.set(`${String(msg.file)}:${Number(msg.line)}`, String(msg.newSource ?? ''));
    return [];
  }

  private parseSubset(files: string[], folderTag: string): HostReply[] {
    if (!files.length) { return []; }
    return [
      { message: { type: 'analysis-state', parsingFolder: folderTag } },
      { message: { type: 'graph-patch', patch: cutPatch(this.opts.graph, files), parsedFolder: folderTag,
        replacedFiles: files, fileGitStatus: this.opts.fileGitStatus ?? {} }, delayMs: this.opts.parseDelayMs ?? 150 },
    ];
  }
}
