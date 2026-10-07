import * as vscode from 'vscode';
import * as path from 'path';
import { GraphProvider } from './graphProvider';
import { SidebarProvider } from './sidebarProvider';
import { showChatRemovalNotice } from './chatRemovalNotice';
import { scanStructure } from './structureScanner';
import { pickFolder } from './folderPicker';
import { specForFolder } from './subgraphScope';
import { flushCacheWrites } from './cacheStore';
import { GhCliSource } from './vcs/ghCliSource';
import { PrController } from './vcs/prController';
import { VcsSidebar } from './vcs/vcsSidebar';
import { clearRepoRefs, clearTrees, evictTrees } from './vcs/engine/headTree';
import { defaultExec } from './vcs/ghCliSource';
import { createTreeAnalyzer } from './vcs/headAnalyzer';
import { prDocumentUri, registerPrDocuments } from './vcs/prDocuments';

export function activate(context: vscode.ExtensionContext) {
  const provider = new GraphProvider(context);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  void showChatRemovalNotice(workspaceRoot, context.workspaceState);

  // Version Control pane: pull requests through the developer's own `gh` sign-in.
  const vcsLog = vscode.window.createOutputChannel('CoGraph Version Control');
  // Materialised pull-request heads live under the extension's global storage, within a budget.
  // Without global storage (some test hosts) only the checkout view exists.
  const treeStorage = context.globalStorageUri?.fsPath ? path.join(context.globalStorageUri.fsPath, 'pr-trees') : undefined;
  if (treeStorage) {
    evictTrees(treeStorage, undefined, [], defaultExec, (l) => vcsLog.appendLine(l))
      .catch((err: unknown) => vcsLog.appendLine(`[vcs] eviction on activation failed: ${(err as Error).message}`));
  }
  const prController = new PrController(new GhCliSource(), provider, {
    workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    scanStructure,
    unchangedFolders: () => vscode.workspace.getConfiguration('cograph')
      .get<string>('pullRequests.unchangedFolders', 'collapse') === 'hide' ? 'hide' : 'collapse',
    log: (line) => vcsLog.appendLine(line),
    storageDir: treeStorage,
    // The PR's own commit gets a provider of its own: same engine, another root, nothing writable.
    createHeadGraph: treeStorage
      ? (root, title) => new GraphProvider(context, { root, readOnly: true, title, readOnlyUri: (file) => prDocumentUri(root, title, file) })
      : undefined,
    analyzer: createTreeAnalyzer(context, (line) => vcsLog.appendLine(line)),
    progress: (title, task) => Promise.resolve(vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (p, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        return task((message) => p.report({ message }), ac.signal);
      },
    )),
  });
  if (treeStorage) { context.subscriptions.push(registerPrDocuments(treeStorage)); }
  const clearTreesCommand = vscode.commands.registerCommand('cograph.clearPullRequestTrees', async () => {
    try {
      const log = (l: string) => vcsLog.appendLine(l);
      const cleared = treeStorage ? await clearTrees(treeStorage, defaultExec, log) : { trees: 0, bytes: 0 };
      // Trees gone, and every refs/cograph/* ref of this repository with them: nothing keeps the fetched objects alive.
      const refs = workspaceRoot ? await clearRepoRefs(workspaceRoot, defaultExec) : [];
      const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
      vscode.window.showInformationMessage(`CoGraph: Pull-request trees cleared — ${n(cleared.trees, 'tree')}, ${(cleared.bytes / (1024 * 1024)).toFixed(1)} MB, ${n(refs.length, 'ref')}.`);
    } catch (err) {
      vscode.window.showErrorMessage(`CoGraph: Could not clear pull-request trees — ${(err as Error).message}`);
    }
  });
  const vcsSidebar = new VcsSidebar(prController, {
    openExternal: (url) => { void vscode.env.openExternal(vscode.Uri.parse(url)); },
    openTerminal: (command) => {
      const terminal = vscode.window.createTerminal('GitHub CLI');
      terminal.show();
      terminal.sendText(command, false); // typed, not run: the developer presses Enter
    },
  });

  const sidebarProvider = new SidebarProvider(context.extensionUri, provider, context.workspaceState, vcsSidebar);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider),
  );
  provider.setSidebarProvider(sidebarProvider);

  const command = vscode.commands.registerCommand('cograph.visualize', () => {
    provider.show();
  });

  const openOrReloadCommand = vscode.commands.registerCommand('cograph.openOrReload', () => {
    if (provider.isOpen()) {
      provider.reloadLayout();
    } else {
      provider.show();
    }
  });

  const saveGraphCommand = vscode.commands.registerCommand('cograph.saveGraph', () => {
    provider.requestSave('save');
  });

  const saveGraphAsCommand = vscode.commands.registerCommand('cograph.saveGraphAs', () => {
    provider.requestSave('save-as');
  });

  // Dev-only fixture loader (no-op with a hint unless cograph.debug.perfLog is on).
  const loadSyntheticCommand = vscode.commands.registerCommand('cograph.dev.loadSynthetic', () => {
    void provider.showSyntheticFixture();
  });

  const annotateCommand = vscode.commands.registerCommand('cograph.annotateGraph', async () => {
    const providerId = vscode.workspace.getConfiguration('cograph').get<string>('graphIntelligence.provider', 'claude-code');
    try {
      await provider.annotateGraph(providerId);
    } catch (err) {
      vscode.window.showErrorMessage(`CoGraph: Annotate Graph failed — ${(err as Error).message}`);
    }
  });

  // Round 3: pick one folder and open the panel scoped to it (unsaved until Save).
  const visualizeFolderCommand = vscode.commands.registerCommand('cograph.visualizeFolder', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { vscode.window.showErrorMessage('CoGraph: No workspace folder open.'); return; }
    try {
      const rel = await pickFolder(scanStructure(root), root);
      if (rel !== null) { provider.showScoped(specForFolder(rel), 'folder'); }
    } catch (err) {
      vscode.window.showErrorMessage(`CoGraph: Only visualize folder failed — ${(err as Error).message}`);
    }
  });

  // Re-push the AI-enabled state to the sidebar whenever the user toggles it,
  // so the gray-out clears/reapplies without reopening the view.
  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('cograph.graphIntelligence.enabled')) {
      sidebarProvider.refreshAiEnabled();
      // Switching AI off mid-run stops the run; the summaries already saved are kept.
      if (!vscode.workspace.getConfiguration('cograph').get<boolean>('graphIntelligence.enabled', false)) {
        provider.cancelAnnotate();
      }
      provider.refreshAnnotations();
    }
    if (e.affectsConfiguration('cograph.layout.defaultEngine')
        || e.affectsConfiguration('cograph.layout.defaultMode')) {
      provider.pushLayoutConfig();
    }
  });

  context.subscriptions.push(vcsLog, clearTreesCommand, command, openOrReloadCommand, saveGraphCommand, saveGraphAsCommand, loadSyntheticCommand, configListener, annotateCommand, visualizeFolderCommand);
}

// VS Code awaits a returned promise on shutdown: persist a still-debounced graph cache.
export function deactivate(): Promise<void> {
  return flushCacheWrites();
}
