import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readFuncSlice } from '../funcBrief';
import type { AnnotationFile } from '../graphIntelligence/annotationTypes';
import type { JsonRequest, JsonResult } from '../graphIntelligence/provider';
import { buildIndexFromGraph } from '../mcp/graphIndex';
import { impactOf } from '../mcp/queries';
import { githubRemote } from '../vcs/engine/headTree';
import type { EngineGraph } from '../vcs/engine/types';
import type { Exec } from '../vcs/ghCliSource';
import type { TourAi, TourGitActions, TourHostApi, TourProgress, TourTarget, TourTrees } from './tourApi';

/**
 * Assembles the TourHostApi the extension injects into the private package
 * (docs/tour-protocol.md section 2). No vscode import: every VS Code effect —
 * settings, the modal confirmations, opening files, the provider — comes in
 * through TourHostDeps, so the rules here (what is confirmed, how gh and git
 * are called, which files may be read) are tested without a window.
 */

export interface TourHostDeps {
  repoRoot: string;
  storageDir: string;
  /** The Version Control output channel. */
  appendLine(line: string): void;
  /** `cograph.<key>`, fallback when unset. */
  setting<T>(key: string, fallback: T): T;
  exec: Exec;
  prepareDiff(target: TourTarget, progress: TourProgress, signal: AbortSignal): Promise<TourTrees>;
  /** A modal warning: the message, its detail, one action button. True when the action was chosen. */
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  runJson(providerId: string, req: JsonRequest, signal?: AbortSignal): Promise<JsonResult>;
  loadAnnotations(): AnnotationFile | null;
  /** Opens a file: 'copy' read-only under a label, 'user' the user's own file. */
  openFile(kind: 'copy' | 'user', absPath: string, line: number, copy?: { root: string; label: string }): Promise<void>;
  openExternal(url: string): Promise<void>;
  notify(message: string): void;
  readText?: (absPath: string) => string;
}

const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]+$/;
const MAX_BODY_SHOWN = 3000;
const CLAUDE_MODELS = ['default', 'opus', 'sonnet', 'haiku'];
const CODEX_MODELS = ['gpt-5-codex', 'gpt-5', 'gpt-5-mini'];

function firstLine(text: string): string {
  return text.split('\n').map(l => l.trim()).find(Boolean) ?? '';
}

/** The text of a body as the confirmation shows it: whole up to a cap, then cut with a count. */
export function shownBody(body: string): string {
  return body.length <= MAX_BODY_SHOWN ? body : `${body.slice(0, MAX_BODY_SHOWN)}\n… (${body.length - MAX_BODY_SHOWN} more characters)`;
}

/** argv as the confirmation prints it: arguments with spaces or quotes quoted, for reading only (nothing runs through a shell). */
export function printCommand(command: string, args: string[]): string {
  return [command, ...args].map(a => (/^[\w./:=@+-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}

/** Under `root` (or root itself), after resolving `..`. */
function inside(root: string, p: string): boolean {
  const r = path.resolve(root), a = path.resolve(p);
  return a === r || a.startsWith(r + path.sep);
}

/** The model the tour passes: tour.ai.model, or Annotate's when it says inherit or names the other provider's model. */
export function tourModel(setting: <T>(key: string, fallback: T) => T, providerId: string): string | undefined {
  const codex = providerId === 'codex';
  const own = setting<string>('tour.ai.model', 'inherit');
  const fits = codex ? CODEX_MODELS.includes(own) : CLAUDE_MODELS.includes(own);
  const model = fits ? own : codex ? setting<string>('graphIntelligence.annotate.codex.model', 'gpt-5-mini') : setting<string>('graphIntelligence.annotate.model', 'haiku');
  return model === 'default' ? undefined : model;
}

function createAi(deps: TourHostDeps): TourAi {
  const providerId = () => (deps.setting<string>('graphIntelligence.provider', 'claude-code') === 'codex' ? 'codex' : 'claude-code');
  return {
    enabled: () => deps.setting<boolean>('graphIntelligence.enabled', false),
    providerId,
    model: () => tourModel(deps.setting, providerId()),
    confirmGate: (description) => deps.confirm('CoGraph PR tour: send this to the AI?', description, 'Continue'),
    runJson: (req, signal) => deps.runJson(providerId(), req, signal),
  };
}

/** Runs gh with the body in a temporary file (never on the command line), then removes it. */
async function withBodyFile<T>(body: string, run: (file: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-tour-'));
  const file = path.join(dir, 'body.md');
  try {
    fs.writeFileSync(file, body, 'utf8');
    return await run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A git action never rejects: an exception (no remote, a body file that cannot be written) is a reason. */
function guarded<A extends unknown[], R>(what: string, log: (l: string) => void, fn: (...args: A) => Promise<R>): (...args: A) => Promise<R | { ok: false; reason: string }> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      const reason = (err as Error)?.message ?? String(err);
      log(`${what} failed: ${reason}`);
      return { ok: false, reason };
    }
  };
}

function createGit(deps: TourHostDeps, log: (l: string) => void): TourGitActions {
  const actions = createGitActions(deps, log);
  return {
    push: guarded('git push', log, actions.push),
    createPr: guarded('gh pr create', log, actions.createPr),
    editPrBody: guarded('gh pr edit', log, actions.editPrBody),
    commentPr: guarded('gh pr comment', log, actions.commentPr),
  };
}

function createGitActions(deps: TourHostDeps, log: (l: string) => void): TourGitActions {
  const cancelled = { ok: false as const, reason: 'cancelled' };
  const ask = (message: string, command: string, extra = '') => deps.confirm(message, `${command}${extra}`, 'Run');
  const failed = (what: string, stderr: string, stdout: string) => {
    const reason = firstLine(stderr) || firstLine(stdout) || `${what} failed`;
    log(`${what} failed: ${reason}`);
    return { ok: false as const, reason };
  };
  return {
    async push(branch) {
      if (!BRANCH.test(branch)) { return { ok: false, reason: `"${branch}" is not a branch name.` }; }
      const remote = await githubRemote({ repoRoot: deps.repoRoot, storageDir: deps.storageDir, exec: deps.exec });
      const args = ['push', '-u', remote, branch];
      if (!(await ask(`Push ${branch} to ${remote}?`, printCommand('git', args)))) { return cancelled; }
      const res = await deps.exec('git', args, deps.repoRoot, { timeoutMs: 120_000 });
      return res.code === 0 ? { ok: true, remote } : failed('git push', res.stderr, res.stdout);
    },
    async createPr({ title, body, base, head, draft }) {
      if (!BRANCH.test(base) || !BRANCH.test(head)) { return { ok: false, reason: 'The base or head is not a branch name.' }; }
      // --title=… : a title that starts with '-' must not read as a flag.
      const args = ['pr', 'create', `--title=${title}`, '--body-file', '<body below>', '--base', base, '--head', head, ...(draft ? ['--draft'] : [])];
      if (!(await ask(`Create the pull request "${title}"?`, printCommand('gh', args), `\n\n${shownBody(body)}`))) { return cancelled; }
      return withBodyFile(body, async (file) => {
        const res = await deps.exec('gh', args.map(a => (a === '<body below>' ? file : a)), deps.repoRoot, { timeoutMs: 60_000 });
        if (res.code !== 0) { return failed('gh pr create', res.stderr, res.stdout); }
        const url = res.stdout.split('\n').map(l => l.trim()).reverse().find(l => /^https:\/\/\S+\/pull\/\d+$/.test(l)) ?? '';
        const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1] ?? 0);
        return url && number ? { ok: true, number, url } : failed('gh pr create', 'gh printed no pull-request URL', res.stdout);
      });
    },
    async editPrBody(number, body) {
      if (!Number.isInteger(number) || number <= 0) { return { ok: false, reason: 'That is not a pull request number.' }; }
      const args = ['pr', 'edit', String(number), '--body-file', '<body below>'];
      if (!(await ask(`Replace the description of pull request #${number}?`, printCommand('gh', args), `\n\n${shownBody(body)}`))) { return cancelled; }
      return withBodyFile(body, async (file) => {
        const res = await deps.exec('gh', args.map(a => (a === '<body below>' ? file : a)), deps.repoRoot, { timeoutMs: 60_000 });
        return res.code === 0 ? { ok: true } : failed('gh pr edit', res.stderr, res.stdout);
      });
    },
    async commentPr(number, body) {
      if (!Number.isInteger(number) || number <= 0) { return { ok: false, reason: 'That is not a pull request number.' }; }
      const args = ['pr', 'comment', String(number), '--body-file', '<body below>'];
      if (!(await ask(`Comment on pull request #${number}?`, printCommand('gh', args), `\n\n${shownBody(body)}`))) { return cancelled; }
      return withBodyFile(body, async (file) => {
        const res = await deps.exec('gh', args.map(a => (a === '<body below>' ? file : a)), deps.repoRoot, { timeoutMs: 60_000 });
        const url = res.stdout.split('\n').map(l => l.trim()).find(l => /^https:\/\//.test(l)) ?? '';
        return res.code === 0 ? { ok: true, url } : failed('gh pr comment', res.stderr, res.stdout);
      });
    },
  };
}

/** The tree copy a path lies in: `<storage>/<repo key>/<sha>`; null outside the storage. */
function copyOf(storageDir: string, absPath: string): { root: string; sha: string } | null {
  if (!inside(storageDir, absPath)) { return null; }
  const parts = path.relative(storageDir, absPath).split(path.sep);
  return parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[1]) ? { root: path.join(storageDir, parts[0], parts[1]), sha: parts[1] } : null;
}

export function createTourHostApi(deps: TourHostDeps): TourHostApi {
  const log = (line: string) => deps.appendLine(`[tour] ${line}`);
  const readText = deps.readText ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  const ai = createAi(deps);
  return {
    version: 1,
    repoRoot: deps.repoRoot,
    storageDir: deps.storageDir,
    log,
    settings: <T>(key: string, fallback: T) => deps.setting<T>(key, fallback),
    exec: deps.exec,
    prepareTrees: (target, progress, signal) => deps.prepareDiff(target, progress, signal),
    readFileAtRef: (sha, rel, maxBytes) => readFileAtRef(deps, sha, rel, maxBytes),
    impact: (graph, seeds) => impactOver(deps, graph, seeds),
    funcBrief: (absPath, line, maxLines) => {
      if (!inside(deps.storageDir, absPath) && !inside(deps.repoRoot, absPath)) { return { ok: false, error: 'outside the repository and its copies' }; }
      return readFuncSlice(absPath, readText, { startLine: line, maxLines });
    },
    annotations: () => {
      const file = deps.loadAnnotations();
      if (!file || (!Object.keys(file.files).length && !Object.keys(file.folders).length)) { return null; }
      const strip = <V extends { summary: string }>(m: Record<string, V>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { summary: v.summary }]));
      return { files: strip(file.files), folders: strip(file.folders) };
    },
    // A getter: switching AI off in the settings takes it away from a running tour at once.
    get ai() { return ai.enabled() ? ai : null; },
    git: createGit(deps, log),
    navigate: async (absPath, line) => {
      try { await navigate(deps, absPath, line, log); } catch (err) { log(`navigate failed: ${(err as Error)?.message ?? String(err)}`); }
    },
    openExternal: async (url) => {
      if (!/^https?:\/\//i.test(url)) { log(`openExternal refused a non-web URL`); return; }
      try { await deps.openExternal(url); } catch (err) { log(`openExternal failed: ${(err as Error)?.message ?? String(err)}`); }
    },
    notify: (message) => deps.notify(String(message)),
  };
}

/** `git show <sha>:<path>` from the objects the fetch brought; null when absent, outside the tree or above maxBytes. */
async function readFileAtRef(deps: TourHostDeps, sha: string, rel: string, maxBytes: number): Promise<string | null> {
  const segs = String(rel).split('/');
  if (!/^[0-9a-f]{7,40}$/.test(sha) || !rel || segs.some(s => !s || s === '.' || s === '..') || rel.startsWith('/')) { return null; }
  const spec = `${sha}:${rel}`;
  const size = await deps.exec('git', ['cat-file', '-s', spec], deps.repoRoot);
  const bytes = Number(size.stdout.trim());
  if (size.code !== 0 || !Number.isFinite(bytes) || bytes > maxBytes) { return null; }
  const res = await deps.exec('git', ['cat-file', 'blob', spec], deps.repoRoot);
  return res.code === 0 ? res.stdout : null;
}

/** impactOf over a graph in memory; the index is rooted at the copy the graph's files lie in. */
function impactOver(deps: TourHostDeps, graph: EngineGraph, seeds: string[]) {
  const anyFile = graph.nodes.find(n => n.file && !n.isLibrary)?.file ?? null;
  const root = (anyFile && copyOf(deps.storageDir, anyFile)?.root) ?? deps.repoRoot;
  const index = buildIndexFromGraph(root, graph as Parameters<typeof buildIndexFromGraph>[1]);
  const syms = seeds.map(id => index.byRaw.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
  return impactOf(index, syms);
}

/**
 * A copy's file opens read-only under the copy's label; when the copy is the commit the
 * checkout is on (a branch tour), the user's own file opens instead. Nothing else opens.
 */
async function navigate(deps: TourHostDeps, absPath: string, line: number, log: (l: string) => void): Promise<void> {
  const ln = Number.isInteger(line) && line > 0 ? line : 1;
  if (inside(deps.repoRoot, absPath) && !inside(deps.storageDir, absPath)) { await deps.openFile('user', absPath, ln); return; }
  const copy = copyOf(deps.storageDir, absPath);
  if (!copy) { log('navigate refused a path outside the repository and its copies'); return; }
  const head = await deps.exec('git', ['rev-parse', 'HEAD'], deps.repoRoot);
  const own = path.join(deps.repoRoot, path.relative(copy.root, absPath));
  if (head.code === 0 && head.stdout.trim() === copy.sha && fs.existsSync(own)) { await deps.openFile('user', own, ln); return; }
  await deps.openFile('copy', absPath, ln, { root: copy.root, label: `tour · ${copy.sha.slice(0, 7)}` });
}
