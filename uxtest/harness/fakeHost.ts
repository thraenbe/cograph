// Scripted stand-in for the extension host (graphProvider.ts). Records every
// message the webview posts and answers the ones a real host would answer.
// Never writes to the repository under test.
import * as fs from 'fs';
import { MAX_SOURCE_LINES, VirtualSources, type FuncEndLib } from './fakeSource';

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
  /** Reply to `get-annotations` (annotate's hover card). Default: AI off, nothing annotated. */
  annotations?: AnnotationsFixture;
  /** round3 W4: open with a subgraph scope (workspace-relative POSIX folders, folder + descendants). The
   *  `subgraph` message goes out BEFORE structure/graph and the graph arrives already scoped. */
  scope?: { name: string | null; root: string; include: string[]; exclude?: string[] };
  /** Function-end scanner for the source popup. Default: out/funcEnd.js of the checkout under test (null = none). */
  funcEnd?: FuncEndLib | null;
  /** A pull request on screen (the Version Control pane's click, src/vcs/prController.ts). Its `pr-view` message goes
   *  out after `subgraph` and before `structure`, its statuses replace the working tree's, and `subgraph-exit` leaves
   *  it the way GraphProvider.exitPullRequest does: `subgraph` back to the whole project, then `pr-view` inactive. */
  pullRequest?: PullRequestFixture;
}

export interface PullRequestFixture {
  /** The exact `pr-view` message the host sends (PrViewMessage): name, refs, tree, diff, expand, fileGitStatus, counts. */
  message: HostMessage & { fileGitStatus: Record<string, { unstaged: string | null; staged: string | null }> };
}

export interface AnnotationsFixture {
  root: string; aiEnabled: boolean;
  files: Record<string, { summary?: string; role?: string }>;
  folders: Record<string, { summary?: string; role?: string }>;
  stale: string[];
}

/** Cut a function-sized slice out of a file; mirrors getFuncSource loosely. */
export function readSourceSlice(file: string, line: number): string {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); // corpus repos may be CRLF (Windows-authored or a Windows checkout)
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

const posix = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
const under = (file: string, root: string, rel: string): boolean => {
  const abs = rel === '.' || rel === '' ? posix(root) : posix(root) + '/' + posix(rel);
  const f = posix(file);
  return f === abs || f.startsWith(abs + '/');
};

export class FakeHost {
  readonly log: LoggedMessage[] = [];
  readonly saved: HostMessage[] = [];
  /** The function popup's files, in memory: saves land here, never on disk. `sources.externalEdit` changes a file behind the popup. */
  readonly sources: VirtualSources;
  private readonly t0 = Date.now();

  constructor(private readonly opts: FakeHostOpts) {
    this.scope = opts.scope ?? null;
    this.pr = opts.pullRequest ?? null;
    this.sources = opts.funcEnd === undefined ? new VirtualSources() : new VirtualSources(opts.funcEnd);
  }

  get mode(): HostMode { return this.opts.mode ?? 'eager'; }

  /** The current scope (mutable: subgraph-include / -exclude / -exit change it like the real host). */
  scope: FakeHostOpts['scope'] | null = null;

  /** The pull request on screen, until `subgraph-exit` leaves it. */
  pr: PullRequestFixture | null = null;

  /** gitAvailable + fileGitStatus as the host sends them: the PR's statuses while one is shown. */
  private git(): { gitAvailable: boolean; fileGitStatus: Record<string, unknown> } {
    if (this.pr) { return { gitAvailable: true, fileGitStatus: this.pr.message.fileGitStatus }; }
    return { gitAvailable: this.opts.gitAvailable ?? false, fileGitStatus: this.opts.fileGitStatus ?? {} };
  }

  /** The PR's file statuses on its nodes, as GitService.setOverride + applyGitStatuses put them there. */
  private withPrStatuses(graph: GraphLite): GraphLite {
    const statuses = this.pr?.message.fileGitStatus;
    if (!statuses) { return graph; }
    return { ...graph, nodes: graph.nodes.map(n => (n.file && statuses[n.file] ? { ...n, gitStatus: statuses[n.file] } : n)) };
  }

  /** The graph as the real host sends it: only files inside the scope. */
  scopedGraph(): GraphLite {
    const sc = this.scope;
    if (!sc || !sc.include.length) { return this.opts.graph; }
    const inScope = (file: string | null): boolean => !!file && sc.include.some(i => under(file, sc.root, i)) && !(sc.exclude ?? []).some(e => under(file, sc.root, e));
    return cutPatch(this.opts.graph, (this.opts.graph.files ?? [...new Set(this.opts.graph.nodes.map(n => n.file).filter((f): f is string => !!f))]).filter(inScope));
  }

  private subgraphMessage(): HostReply {
    const sc = this.scope;
    return { message: sc ? { type: 'subgraph', name: sc.name, root: sc.root, include: sc.include, exclude: sc.exclude ?? [] } : { type: 'subgraph', name: null, root: '', include: [], exclude: [] } };
  }

  /** Messages a real host sends right after the panel opens. */
  openingMessages(): HostReply[] {
    const git = this.git();
    const structure: HostReply = { message: { type: 'structure', tree: this.opts.structure, autoEngage: true } };
    const pre: HostReply[] = this.scope ? [this.subgraphMessage()] : []; // scope first: no flash of the full project
    if (this.pr) { pre.push({ message: this.pr.message }); } // before structure: the first build opens the PR's folders
    if (this.mode === 'lazy') {
      return [...pre, structure, { message: { type: 'analysis-state', backgroundParsing: true } }];
    }
    return [...pre, structure, { message: { type: 'graph', data: this.withPrStatuses(this.scopedGraph()), ...git, isReanalysis: false } }];
  }

  /** Lazy mode: the background pass finishing (full graph arrives). */
  backgroundDone(): HostReply[] {
    return [
      { message: { type: 'graph', data: this.withPrStatuses(this.opts.graph), ...this.git(), isReanalysis: false } },
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
      case 'get-annotations':
        return [{ message: { type: 'annotations', ...(this.opts.annotations ?? { root: '', aiEnabled: false, files: {}, folders: {}, stale: [] }) } }];
      case 'subgraph-include': return this.changeScope(String(msg.path ?? ''), true);
      case 'subgraph-exclude': return this.changeScope(String(msg.path ?? ''), false);
      case 'subgraph-exit': { // session-178: NOT a fresh `graph` - the cached nodes of the files that were out of scope come back as a patch
        if (this.pr) { return this.leavePullRequest(); }
        if (!this.scope) { return []; }
        const inScope = new Set(this.scopedGraph().files ?? []);
        const back = this.allFiles().filter(f => !inScope.has(f));
        this.scope = null;
        return [this.subgraphMessage(), { message: { type: 'graph-patch', patch: cutPatch(this.opts.graph, back), replacedFiles: back, fileGitStatus: this.opts.fileGitStatus ?? {} } }];
      }
      case 'cancel-analysis':
        return [{ message: { type: 'analysis-state', backgroundParsing: false, cancelled: true } }];
      default:
        return []; // navigate, dirty-state, open-docs, perf-report, … are record-only
    }
  }

  /** GraphProvider.exitPullRequest on the main panel: the scope goes back, then `pr-view` inactive with restore. */
  private leavePullRequest(): HostReply[] {
    this.pr = null;
    this.scope = null;
    const fileGitStatus = this.opts.fileGitStatus ?? {};
    return [
      this.subgraphMessage(),
      { message: { type: 'git-update', nodes: this.opts.graph.nodes.filter(n => !n.isLibrary).map(n => ({ id: n.id, gitStatus: n.gitStatus ?? { unstaged: null, staged: null } })), fileGitStatus } },
      { message: { type: 'pr-view', active: false, restore: true, fileGitStatus } },
    ];
  }

  private allFiles(): string[] {
    return this.opts.graph.files ?? [...new Set(this.opts.graph.nodes.map(n => n.file).filter((f): f is string => !!f))];
  }

  /** Folder enters: subgraph → graph-patch with the cached nodes (the real host adds analysis-state + a parsed
   *  patch only for files its cache lacks - the FakeHost has everything cached); leaves: subgraph → prune patch. */
  private changeScope(rel: string, include: boolean): HostReply[] {
    if (!this.scope || !rel) { return []; }
    const files = this.allFiles().filter(f => under(f, this.scope!.root, rel));
    if (include) {
      this.scope = { ...this.scope, include: [...new Set([...this.scope.include, rel])], exclude: (this.scope.exclude ?? []).filter(e => e !== rel) };
      return [this.subgraphMessage(), { message: { type: 'graph-patch', patch: cutPatch(this.opts.graph, files), replacedFiles: files, fileGitStatus: this.opts.fileGitStatus ?? {} } }];
    }
    this.scope = { ...this.scope, include: this.scope.include.filter(i => i !== rel), exclude: [...new Set([...(this.scope.exclude ?? []), rel])] };
    return [this.subgraphMessage(), { message: { type: 'graph-patch', patch: { nodes: [], edges: [] }, replacedFiles: files, fileGitStatus: this.opts.fileGitStatus ?? {} } }];
  }

  private funcSource(msg: HostMessage): HostReply {
    const file = String(msg.file ?? '');
    const line = Number(msg.line ?? 1);
    try {
      const source = this.sources.read(file, line);
      const endLine = line + source.split('\n').length - 1;
      return { message: { type: 'func-source', source, endLine, reqId: msg.reqId }, delayMs: 30 };
    } catch (err) {
      return { message: { type: 'func-source', source: '', error: (err as Error).message, reqId: msg.reqId } };
    }
  }

  /** Like graphProvider: a save with a reqId (PR #69 popup) is answered with func-source-saved; without one it stays silent. */
  private saveFuncSource(msg: HostMessage): HostReply[] {
    let result;
    try { result = this.sources.save(String(msg.file ?? ''), Number(msg.line ?? 1), String(msg.newSource ?? ''), msg.original); }
    catch (err) { result = { ok: false, reason: (err as Error).message }; }
    return msg.reqId === undefined ? [] : [{ message: { type: 'func-source-saved', reqId: msg.reqId, ...result }, delayMs: 30 }];
  }

  private parseSubset(files: string[], folderTag: string): HostReply[] {
    if (!files.length) { return []; }
    return [
      { message: { type: 'analysis-state', parsingFolder: folderTag } },
      { message: { type: 'graph-patch', patch: this.withPrStatuses(cutPatch(this.opts.graph, files)), parsedFolder: folderTag,
        replacedFiles: files, fileGitStatus: this.git().fileGitStatus }, delayMs: this.opts.parseDelayMs ?? 150 },
    ];
  }
}
