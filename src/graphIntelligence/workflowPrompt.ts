import type {
  GraphData,
  WorkflowNodeMeta,
  WorkflowEdgeMeta,
  WorkflowGraphMeta,
} from '../graphProvider';

/**
 * Instruction text for the AI Workflow Graph generation. It is prepended to the
 * user task and passed verbatim as the `prompt` to GraphProvider.runGraphIntelligence,
 * which writes it (plus the cached graph) into `.cograph/.intelligence-request.json`.
 *
 * The model annotates the EXISTING graph in place and returns the same
 * `{graph:{nodes,edges},text}` contract — extra `workflow` fields on the graph,
 * nodes and edges pass through extractCographResult untouched (it only requires
 * text:string and graph.nodes/edges arrays). We keep the model from re-reading
 * every source file so the call stays within the 15-turn / $2 caps.
 */
export const WORKFLOW_PROMPT = `Build a WORKFLOW MODEL of this codebase: a left-to-right view of how the system runs, from entry points on the far left, through the step-by-step pipeline in the middle, to the frontend output on the far right.

Read ./.cograph/.intelligence-request.json — it holds the current code graph under "graph" (nodes and edges). Classify the graph that is already there. Do NOT invent new nodes and do NOT change node ids; reuse the exact ids you are given (this keeps the output small and preserves saved layouts). Classify from the provided graph alone; only read a source file when a node's role is genuinely ambiguous, so you stay within the turn/budget caps.

For EVERY non-library node, add a "workflow" object with these fields:
  - "rank": integer, 0 = most important. Entry points, orchestrators and hub functions get the lowest numbers; leaf helpers get the highest. This controls which functions appear first as detail increases.
  - "stage": integer pipeline column, 0 = far-left entry/start. Increase left-to-right through the processing steps; the frontend output sits in the highest stages.
  - "tier": one of "backend", "frontend", or "shared".
  - "cluster": a stable lowercase-kebab slug grouping functions by TOPIC (e.g. "auth", "graph-render", "analysis"). Members of one topic share the same slug.
  - "clusterName": a short human label for that cluster (e.g. "Authentication", "Graph Rendering").
  - "isEntry": true only for far-left starting points (main(), CLI entry, request handlers).
  - "isOutput": true only for far-right frontend output (UI render, response writers).

For edges, add a "workflow" object:
  - "kind": "static" for a call/import present in the code, or "dynamic" for a runtime dependency not visible statically (events, callbacks, dependency injection, message passing). You MAY add a small number of new edges with kind:"dynamic" to capture important runtime flows.
  - "scope": "intra-file" if source and target live in the same file, else "inter-file".
  - "label": for inter-file or dynamic edges, a short intelligent label for what flows across the connection (e.g. "emits auth token"). Omit for ordinary intra-file calls.
  - "confidence": 0..1 for dynamic/inferred edges (omit for plain static edges).

Also add a top-level "workflow" object on the graph:
  - "stageCount": number of pipeline columns.
  - "dividerStage": the column index where backend ends and frontend begins (the divider is drawn just left of the first frontend column).
  - "clusters": array of { "id", "name", "tier", "stage" } summarising each topic cluster.
  - "generatedAt": current ISO timestamp.

Your final reply MUST be a single JSON object: {"graph":{"nodes":[...],"edges":[...],"workflow":{...}},"text":"<markdown>"}. The "text" field is a short, skimmable markdown summary of the workflow (2-3 short paragraphs or a few bullets). Do not wrap the JSON in a code fence and do not include prose outside the JSON.`;

/** One-line task appended to WORKFLOW_PROMPT for a fresh generation. */
export const WORKFLOW_TASK = 'Produce the workflow model for this project\'s graph.';

/** Build the full prompt string handed to runGraphIntelligence. */
export function buildWorkflowPrompt(task: string = WORKFLOW_TASK): string {
  return `${WORKFLOW_PROMPT}\n\n${task}`;
}

export interface WorkflowValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Lightweight check that a returned graph actually looks like a workflow model
 * (it carries workflow annotations). Used to decide whether to accept the AI
 * output as a workflow graph; normalizeWorkflowModel then fills any gaps.
 */
export function validateWorkflowModel(graph: GraphData | null | undefined): WorkflowValidation {
  const errors: string[] = [];
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return { ok: false, errors: ['graph is missing nodes/edges arrays'] };
  }
  const annotated = graph.nodes.filter(n => !n.isLibrary && n.workflow);
  if (annotated.length === 0 && !graph.workflow) {
    errors.push('no workflow annotations present on any node or on the graph');
  }
  return { ok: errors.length === 0, errors };
}

const DEFAULT_STAGE_COUNT = 3;

/**
 * Deterministically repair a (possibly partial) workflow model so the webview
 * can rely on every non-library node having a complete `workflow` object and the
 * graph carrying valid `workflow` metadata. Pure — does not mutate the input.
 */
export function normalizeWorkflowModel(graph: GraphData): GraphData {
  const nodes = graph.nodes.map(n => ({ ...n, workflow: n.workflow ? { ...n.workflow } : undefined }));
  const edges = graph.edges.map(e => ({ ...e, workflow: e.workflow ? { ...e.workflow } : undefined }));

  const fileById = new Map<string, string | null>();
  const degree = new Map<string, number>();
  for (const n of nodes) {
    fileById.set(n.id, n.file ?? null);
    degree.set(n.id, 0);
  }
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const internal = nodes.filter(n => !n.isLibrary);

  // Provisional stage count from any stages the model provided.
  let stageCount = graph.workflow?.stageCount ?? 0;
  for (const n of internal) {
    const s = n.workflow?.stage;
    if (typeof s === 'number' && isFinite(s)) { stageCount = Math.max(stageCount, Math.floor(s) + 1); }
  }
  if (stageCount < 2) { stageCount = DEFAULT_STAGE_COUNT; }

  const tierStage = (tier: string): number =>
    tier === 'backend' ? 0 : tier === 'frontend' ? stageCount - 1 : Math.floor((stageCount - 1) / 2);

  // 1) Fill in per-node workflow fields (tier/stage/cluster/clusterName) so a
  //    total rank order can then be computed.
  for (const n of internal) {
    const wf: Partial<WorkflowNodeMeta> = n.workflow ?? {};
    const tier = wf.tier === 'backend' || wf.tier === 'frontend' || wf.tier === 'shared' ? wf.tier : 'shared';
    let stage = typeof wf.stage === 'number' && isFinite(wf.stage) ? Math.floor(wf.stage) : tierStage(tier);
    stage = Math.max(0, Math.min(stageCount - 1, stage));
    const cluster = typeof wf.cluster === 'string' && wf.cluster ? wf.cluster : fileSlug(n.file) || 'misc';
    const clusterName = typeof wf.clusterName === 'string' && wf.clusterName ? wf.clusterName : prettify(cluster);
    n.workflow = {
      rank: typeof wf.rank === 'number' && isFinite(wf.rank) ? wf.rank : Number.POSITIVE_INFINITY,
      stage,
      tier,
      cluster,
      clusterName,
      ...(wf.isEntry ? { isEntry: true } : {}),
      ...(wf.isOutput ? { isOutput: true } : {}),
    };
  }

  // 2) Compute a clean total rank order 0..N-1. Respect provided ranks' relative
  //    order; break ties / fill missing ranks by node degree (hubs rank higher).
  const ordered = [...internal].sort((a, b) => {
    const ra = a.workflow!.rank, rb = b.workflow!.rank;
    if (ra !== rb) { return ra - rb; }
    return (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
  });
  ordered.forEach((n, i) => { n.workflow!.rank = i; });

  // 3) Normalize edges: default kind, infer scope from endpoint files.
  for (const e of edges) {
    const wf: Partial<WorkflowEdgeMeta> = e.workflow ?? {};
    const kind = wf.kind === 'dynamic' ? 'dynamic' : 'static';
    const sf = fileById.get(e.source);
    const tf = fileById.get(e.target);
    const scope = wf.scope === 'intra-file' || wf.scope === 'inter-file'
      ? wf.scope
      : (sf && tf && sf === tf ? 'intra-file' : 'inter-file');
    e.workflow = {
      kind,
      scope,
      ...(typeof wf.label === 'string' && wf.label ? { label: wf.label } : {}),
      ...(typeof wf.confidence === 'number' && isFinite(wf.confidence) ? { confidence: wf.confidence } : {}),
    };
  }

  // 4) Build graph-level workflow metadata.
  const clusterMap = new Map<string, { id: string; name: string; tier: string; stage: number }>();
  for (const n of internal) {
    const w = n.workflow!;
    const existing = clusterMap.get(w.cluster);
    if (!existing) {
      clusterMap.set(w.cluster, { id: w.cluster, name: w.clusterName, tier: w.tier, stage: w.stage });
    } else {
      existing.stage = Math.min(existing.stage, w.stage);
    }
  }
  const frontendStages = internal.filter(n => n.workflow!.tier === 'frontend').map(n => n.workflow!.stage);
  const dividerStage = graph.workflow?.dividerStage ??
    (frontendStages.length ? Math.min(...frontendStages) : stageCount - 1);

  const workflow: WorkflowGraphMeta = {
    stageCount,
    dividerStage: Math.max(0, Math.min(stageCount, dividerStage)),
    clusters: [...clusterMap.values()].sort((a, b) => a.stage - b.stage),
    ...(graph.workflow?.generatedAt ? { generatedAt: graph.workflow.generatedAt } : {}),
  };

  return { ...graph, nodes, edges, workflow };
}

function fileSlug(file: string | null): string {
  if (!file) { return ''; }
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function prettify(slug: string): string {
  return slug.split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || slug;
}
