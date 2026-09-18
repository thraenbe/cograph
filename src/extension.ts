import * as vscode from 'vscode';
import { GraphProvider } from './graphProvider';
import { SidebarProvider } from './sidebarProvider';
import { ChatStore } from './graphIntelligence/chatStore';

export function activate(context: vscode.ExtensionContext) {
  const provider = new GraphProvider(context);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const chatStore = workspaceRoot ? new ChatStore(workspaceRoot) : null;

  const sidebarProvider = new SidebarProvider(context.extensionUri, provider, chatStore, context.workspaceState);
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

  // Re-push the AI-enabled state to the sidebar whenever the user toggles it,
  // so the gray-out clears/reapplies without reopening the view.
  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('cograph.graphIntelligence.enabled')) {
      sidebarProvider.refreshAiEnabled();
      provider.refreshAnnotations();
    }
    if (e.affectsConfiguration('cograph.layout.defaultEngine')
        || e.affectsConfiguration('cograph.layout.defaultMode')) {
      provider.pushLayoutConfig();
    }
  });

  context.subscriptions.push(command, openOrReloadCommand, saveGraphCommand, saveGraphAsCommand, loadSyntheticCommand, configListener, annotateCommand);
}

export function deactivate() {}
