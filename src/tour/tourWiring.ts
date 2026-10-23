import * as vscode from 'vscode';
import { getBrowserServer } from '../browserView/browserLifetime';
import type { BrowserServer, MirroredView } from '../browserView/browserServer';
import { openExternalUrl, showOpenedToast } from '../browserView/openInBrowser';
import type { GraphProvider } from '../graphProvider';
import { loadAnnotations } from '../graphIntelligence/annotationStore';
import { createProvider } from '../graphIntelligence/provider';
import { defaultExec } from '../vcs/ghCliSource';
import type { PrController } from '../vcs/prController';
import { prDocumentUri } from '../vcs/prDocuments';
import type { VcsSidebar } from '../vcs/vcsSidebar';
import type { PullRequest } from '../vcs/types';
import type { TourTarget } from './tourApi';
import { TourAvailability } from './tourAvailability';
import { TourRunner } from './tourCommand';
import { createTourHostApi } from './tourHostApi';
import type { TourHostDeps } from './tourHostApi';
import { loadTourHost, resolveTourPackage } from './tourModule';
import type { LoadedTour } from './tourModule';

/**
 * The PR tour in VS Code: the two commands, the pill's click, the Tour buttons,
 * the pill's availability, and the VS Code side of the TourHostApi. Everything
 * with rules lives in the vscode-free modules next to this one.
 */

export interface TourWiringDeps {
  context: vscode.ExtensionContext;
  provider: GraphProvider;
  prController: PrController;
  vcsSidebar: VcsSidebar;
  channel: vscode.OutputChannel;
  storageDir: string | undefined;
}

export interface TourEntry {
  /** The private package is in this build (cheap: resolves, does not load). */
  available(): boolean;
  run(target: TourTarget): Promise<void>;
  runPullRequest(pr: PullRequest): Promise<void>;
  /** From the extension's one configuration listener: the pill follows its settings. */
  onConfigurationChanged(e: vscode.ConfigurationChangeEvent): void;
  disposables: vscode.Disposable[];
}

const setting = <T>(key: string, fallback: T): T => vscode.workspace.getConfiguration('cograph').get<T>(key, fallback);
const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

async function openAt(uri: vscode.Uri, line: number): Promise<void> {
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
}

function hostDeps(d: TourWiringDeps, repoRoot: string): TourHostDeps {
  return {
    repoRoot, storageDir: d.storageDir as string, exec: defaultExec,
    appendLine: (line) => d.channel.appendLine(line),
    setting,
    prepareDiff: (target, progress, signal) => d.prController.prepareDiff(target, progress, signal),
    confirm: async (message, detail, action) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action,
    runJson: (providerId, req, signal) => createProvider(providerId, d.channel).runJson(req, signal),
    loadAnnotations: () => { const root = workspaceRoot(); return root ? loadAnnotations(root) : null; },
    openFile: (kind, absPath, line, copy) => openAt(kind === 'copy' && copy ? prDocumentUri(copy.root, copy.label, absPath) : vscode.Uri.file(absPath), line),
    openExternal: async (url) => { await vscode.env.openExternal(vscode.Uri.parse(url)); },
    notify: (message) => { void vscode.window.showInformationMessage(message, 'OK'); },
  };
}

/** The tour package's host, created once per extension host; null in the public build or without storage. */
function tourLoader(d: TourWiringDeps): () => Promise<LoadedTour | null> {
  let loaded: Promise<LoadedTour | null> | undefined;
  return () => {
    loaded ??= (async () => {
      const root = workspaceRoot();
      if (!root || !d.storageDir) { return null; }
      const top = await defaultExec('git', ['rev-parse', '--show-toplevel'], root);
      const repoRoot = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : root;
      return loadTourHost(createTourHostApi(hostDeps(d, repoRoot)), d.context.extensionPath, { log: (l) => d.channel.appendLine(l) });
    })();
    return loaded;
  };
}

function runner(d: TourWiringDeps, loadTour: () => Promise<LoadedTour | null>): TourRunner {
  return new TourRunner({
    loadTour,
    getServer: () => getBrowserServer(),
    openUrl: (server, urlPath) => openExternalUrl(server as BrowserServer, urlPath),
    showOpened: showOpenedToast,
    // createHeadGraph makes a GraphProvider, which is the MirroredView the server mirrors.
    openPanel: (view, headDir, label) => d.prController.openTourPanel(view, headDir, label) as unknown as MirroredView | null,
    progress: (title, task) => Promise.resolve(vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        return task((message) => p.report({ message }), ac.signal);
      },
    )),
    info: (m) => { void vscode.window.showInformationMessage(m); },
    error: (m) => { void vscode.window.showErrorMessage(m); },
    log: (l) => d.channel.appendLine(l),
  });
}

/** The pill: recomputed on start, on git changes, on a new pull-request list and on its settings. */
function watchAvailability(d: TourWiringDeps, availability: TourAvailability): { disposables: vscode.Disposable[]; soon: () => void } {
  const out: vscode.Disposable[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => { if (timer) { clearTimeout(timer); } timer = setTimeout(() => { void availability.refresh(); }, 300); };
  const root = workspaceRoot();
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), '.git/{index,HEAD,refs/heads/**}'));
    out.push(watcher, watcher.onDidChange(soon), watcher.onDidCreate(soon), watcher.onDidDelete(soon));
  }
  out.push(d.vcsSidebar.onLoaded(soon));
  out.push({ dispose: () => { if (timer) { clearTimeout(timer); } } });
  void availability.refresh();
  return { disposables: out, soon };
}

export function registerTour(d: TourWiringDeps): TourEntry {
  const available = () => resolveTourPackage(d.context.extensionPath) !== null;
  const tours = runner(d, tourLoader(d));
  const run = async (target: TourTarget) => {
    try { await tours.run(target); } catch (err) { d.channel.appendLine(`[tour] run failed: ${(err as Error)?.stack ?? String(err)}`); }
  };
  const availability = new TourAvailability({
    workspaceRoot, exec: defaultExec, bundled: available, setting,
    pullRequests: () => d.vcsSidebar.loadedPullRequests(),
    post: (m) => d.provider.postToViews(m),
    log: (l) => d.channel.appendLine(l),
  });
  const pick = async () => {
    const branch = availability.current();
    const listed = d.vcsSidebar.loadedPullRequests().filter(p => p.state === 'open');
    const prs = listed.length ? listed : await d.prController.list({ state: 'open', limit: 50 }).then(r => (r.ok ? r.pullRequests : []));
    type Item = vscode.QuickPickItem & { target: TourTarget };
    const items: Item[] = [
      { label: '$(git-branch) Your branch vs base', description: branch.state === 'branch' ? branch.label : undefined, target: { kind: 'branch' } },
      ...prs.map((p): Item => ({ label: `#${p.number} ${p.title}`, description: `${p.headRef} → ${p.baseRef}`, target: { kind: 'pr', number: p.number } })),
    ];
    const chosen = await vscode.window.showQuickPick(items, { placeHolder: 'Which change should the tour walk through?' });
    if (chosen) { await run(chosen.target); }
  };
  const watching = watchAvailability(d, availability);
  const disposables = [
    vscode.commands.registerCommand('cograph.tourPullRequest', () => pick()),
    vscode.commands.registerCommand('cograph.tourBranch', () => run({ kind: 'branch' })),
    d.provider.onTourStart(() => {
      const a = availability.current();
      void run(a.state === 'pr' && a.number ? { kind: 'pr', number: a.number } : { kind: 'branch' });
    }),
    ...watching.disposables,
  ];
  const onConfigurationChanged = (e: vscode.ConfigurationChangeEvent) => {
    if (e.affectsConfiguration('cograph.tour.button') || e.affectsConfiguration('cograph.browserView.enabled')) { watching.soon(); }
  };
  return { available, run, runPullRequest: (pr) => run({ kind: 'pr', number: pr.number }), onConfigurationChanged, disposables };
}
