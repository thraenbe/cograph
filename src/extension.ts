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

  // Re-push the AI-enabled state to the sidebar whenever the user toggles it,
  // so the gray-out clears/reapplies without reopening the view.
  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('cograph.graphIntelligence.enabled')) {
      sidebarProvider.refreshAiEnabled();
    }
  });

  context.subscriptions.push(command, openOrReloadCommand, saveGraphCommand, saveGraphAsCommand, configListener);
}

export function deactivate() {}
