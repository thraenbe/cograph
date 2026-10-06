import * as vscode from 'vscode';
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

export function activate(context: vscode.ExtensionContext) {
  const provider = new GraphProvider(context);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  void showChatRemovalNotice(workspaceRoot, context.workspaceState);

  // Version Control pane: pull requests through the developer's own `gh` sign-in.
  const vcsLog = vscode.window.createOutputChannel('CoGraph Version Control');
  const prController = new PrController(new GhCliSource(), provider, {
    workspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    scanStructure,
    unchangedFolders: () => vscode.workspace.getConfiguration('cograph')
      .get<string>('pullRequests.unchangedFolders', 'collapse') === 'hide' ? 'hide' : 'collapse',
    log: (line) => vcsLog.appendLine(line),
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

  context.subscriptions.push(vcsLog, command, openOrReloadCommand, saveGraphCommand, saveGraphAsCommand, loadSyntheticCommand, configListener, annotateCommand, visualizeFolderCommand);
}

// VS Code awaits a returned promise on shutdown: persist a still-debounced graph cache.
export function deactivate(): Promise<void> {
  return flushCacheWrites();
}
