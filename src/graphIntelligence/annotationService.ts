import * as vscode from 'vscode';
import type { GraphData } from '../graphProvider';
import type { StructureTree } from '../structureScanner';
import { ANNOTATE_SYSTEM_PROMPT, SUMMARY_SCHEMA } from './annotationPrompt';
import { executeRun, planRun } from './annotationRunner';
import type { CallRequest, RunOptions, RunPlan, RunProgress, RunResult } from './annotationRunner';
import { loadAnnotations, reconcile, saveAnnotations } from './annotationStore';
import type { AnnotationFile, AnnotationsMessage, AnnotationStatus, SummaryEntry } from './annotationTypes';
import type { GraphIntelligenceProvider, JsonResult } from './provider';

/** What the service needs from its owner (GraphProvider); keeps it testable without a panel. */
export interface AnnotationHost {
  getRoot(): string | undefined;
  getStructure(): StructureTree | undefined;
  getGraph(): GraphData | undefined;
  /** Deliver to the graph webview; a no-op when no panel is open. */
  post(msg: AnnotationsMessage): void;
  log(line: string): void;
  createProvider(id: string): GraphIntelligenceProvider;
}

export const AI_OFF_MESSAGE = 'AI features are off — enable them in CoGraph settings to annotate the graph.';

function aiEnabled(): boolean {
  return vscode.workspace.getConfiguration('cograph').get<boolean>('graphIntelligence.enabled', false);
}

/** Owns the annotation store, staleness and runs for one workspace. */
export class AnnotationService {
  private data: AnnotationFile | undefined;
  /** Mutated in place, never replaced: a running executeRun holds this same set. */
  private readonly stale = new Set<string>();
  private controller: AbortController | undefined;
  private progress: RunProgress | undefined;
  private note: string | undefined;
  private readonly listeners = new Set<(s: AnnotationStatus) => void>();

  constructor(private readonly host: AnnotationHost) {}

  get running(): boolean { return !!this.controller; }

  onStatus(listener: (s: AnnotationStatus) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * Re-check staleness against the files on disk, then push to the webview and the
   * sidebar. Never spends anything: a changed file only becomes "outdated".
   */
  refresh(): void {
    const root = this.host.getRoot();
    const tree = this.host.getStructure();
    if (!root || !tree) { return; }
    try {
      const data = this.data ?? loadAnnotations(root);
      this.data = data;
      const res = reconcile(root, tree, data);
      this.stale.clear();
      for (const rel of res.stale) { this.stale.add(rel); }
      if (res.dirty && !this.running) { saveAnnotations(root, data); }
    } catch (err) {
      this.host.log(`[annotate] refresh failed: ${(err as Error).message}`);
    }
    this.publish();
  }

  /** Message for the hover card; null until a workspace and structure exist. */
  buildMessage(): AnnotationsMessage | null {
    const root = this.host.getRoot();
    if (!root) { return null; }
    const pick = (m: Record<string, SummaryEntry>) =>
      Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.role ? { summary: v.summary, role: v.role } : { summary: v.summary }]));
    return {
      type: 'annotations',
      root,
      aiEnabled: aiEnabled(),
      files: pick(this.data?.files ?? {}),
      folders: pick(this.data?.folders ?? {}),
      stale: [...this.stale],
    };
  }

  status(): AnnotationStatus {
    // The sidebar can ask before the graph panel exists; read the store so an
    // already-annotated workspace does not look empty.
    const root = this.host.getRoot();
    if (!this.data && root) { this.data = loadAnnotations(root); }
    const tree = this.host.getStructure();
    const totalFiles = tree?.totalFiles ?? 0;
    const totalFolders = tree ? Object.keys(tree.folders).length : 0;
    const annotated = Object.keys(this.data?.files ?? {}).length + Object.keys(this.data?.folders ?? {}).length;
    return {
      state: this.running ? 'running' : 'idle',
      totalFiles,
      totalFolders,
      annotated,
      stale: this.stale.size,
      // Unknown until the structure is scanned (graph panel opened once).
      pending: tree ? Math.max(0, totalFiles + totalFolders - annotated) : 0,
      done: this.progress?.done,
      total: this.progress?.total,
      costUsd: this.progress?.costUsd,
      costKnown: this.progress?.costKnown,
      note: this.note,
    };
  }

  /** What a run would send, without sending anything. */
  plan(): RunPlan | null {
    const root = this.host.getRoot();
    const tree = this.host.getStructure();
    if (!root || !tree) { return null; }
    this.data = this.data ?? loadAnnotations(root);
    return planRun(root, tree, this.data, this.stale, this.options());
  }

  cancel(): void { this.controller?.abort(); }

  /**
   * Run (or resume, or update) annotations. `confirm` is shown the estimate and
   * must return true before anything leaves the machine.
   */
  async annotate(providerId: string, confirm: (text: string) => Promise<boolean>): Promise<RunResult | null> {
    if (!aiEnabled()) { throw new Error(AI_OFF_MESSAGE); }
    if (this.running) { return null; }
    const root = this.host.getRoot();
    const tree = this.host.getStructure();
    const graph = this.host.getGraph();
    if (!root || !tree || !graph) { throw new Error('Open the CoGraph graph first, so there is something to annotate.'); }

    this.refresh();
    const plan = this.plan();
    if (!plan || (plan.files.length === 0 && plan.folders.length === 0)) {
      this.note = 'Everything is up to date.';
      this.publish();
      return null;
    }
    const options = this.options();
    const model = this.model(providerId);
    if (!(await confirm(describePlan(plan, options, providerId, model)))) { return null; }

    const provider = this.host.createProvider(providerId);
    if (!provider.runJson) { throw new Error(`${provider.displayName} does not support Annotate Graph.`); }
    const data = this.data!;
    data.provider = providerId;
    data.model = model;
    this.controller = new AbortController();
    this.note = undefined;
    this.host.log(`[annotate] start provider=${providerId} model=${model} files=${plan.files.length} folders=${plan.folders.length} readSource=${options.readSource}`);
    try {
      const result = await executeRun({
        root, tree, graph, data, stale: this.stale, options,
        signal: this.controller.signal,
        save: (d) => { d.generatedAt = new Date().toISOString(); saveAnnotations(root, d); },
        onProgress: (p) => { this.progress = p; this.publish(); },
        callJson: (req: CallRequest, signal): Promise<JsonResult> => provider.runJson!({
          prompt: req.prompt, systemPrompt: ANNOTATE_SYSTEM_PROMPT, schema: SUMMARY_SCHEMA,
          workspaceRoot: root, model, tools: req.tools, maxBudgetUsd: req.maxBudgetUsd,
        }, signal),
      });
      this.note = describeResult(result);
      this.host.log(`[annotate] done files=${result.filesDone} folders=${result.foldersDone} pending=${result.pending.length} costUsd=${result.costUsd.toFixed(4)} costKnown=${result.costKnown}`);
      return result;
    } catch (err) {
      this.note = `Stopped: ${(err as Error).message}`;
      this.host.log(`[annotate] failed: ${(err as Error).message}`);
      throw err;
    } finally {
      this.controller = undefined;
      this.progress = undefined;
      this.refresh();
    }
  }

  private options(): RunOptions {
    const cfg = vscode.workspace.getConfiguration('cograph');
    return {
      readSource: cfg.get<boolean>('graphIntelligence.annotate.readSource', false),
      maxRunBudgetUsd: cfg.get<number>('graphIntelligence.annotate.maxRunBudgetUsd', 2),
    };
  }

  private model(providerId: string): string {
    const cfg = vscode.workspace.getConfiguration('cograph');
    return providerId === 'codex'
      ? cfg.get<string>('graphIntelligence.annotate.codex.model', 'gpt-5-mini')
      : cfg.get<string>('graphIntelligence.annotate.model', 'haiku');
  }

  private publish(): void {
    const msg = this.buildMessage();
    if (msg) { this.host.post(msg); }
    const status = this.status();
    for (const l of this.listeners) { l(status); }
  }
}

/** The text of the confirm dialog: what will be sent, how much, to whom, and the cap. */
export function describePlan(plan: RunPlan, o: RunOptions, providerId: string, model: string): string {
  const what = o.readSource
    ? 'Sends file paths, function names with their signature lines, import names and leading comments. The AI may also open and read your source files (read-only).'
    : providerId === 'codex'
      ? 'Sends file paths, function names with their signature lines, import names and leading comments. No function bodies are sent, but the Codex CLI itself can read files in this workspace.'
      : 'Sends file paths, function names with their signature lines, import names and leading comments. No function bodies are sent and the AI cannot open files.';
  const cap = providerId === 'codex'
    ? 'Codex does not report cost, so the run is limited to these requests.'
    : `The run stops at $${o.maxRunBudgetUsd.toFixed(2)}.`;
  return `Annotate ${plan.files.length} files and up to ${plan.folders.length} folders in about ${plan.requests} requests with ${model}.\n\n${what}\n\n${cap}`;
}

export function describeResult(r: RunResult): string {
  const cost = r.costKnown ? `$${r.costUsd.toFixed(2)}` : 'cost not reported';
  const head = `${r.filesDone} files, ${r.foldersDone} folders · ${cost}`;
  if (r.cancelled) { return `Cancelled · ${head}`; }
  if (r.stoppedAtBudget) { return `Stopped at budget · ${head} · ${r.pending.length} pending`; }
  return r.pending.length ? `${head} · ${r.pending.length} pending` : head;
}
