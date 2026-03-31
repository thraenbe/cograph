import * as vscode from 'vscode';
import { GraphProvider } from './graphProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new GraphProvider(context);

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

  context.subscriptions.push(command, openOrReloadCommand);
}

export function deactivate() {}
