import * as vscode from 'vscode';
import { GraphProvider } from './graphProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new GraphProvider(context);

  const command = vscode.commands.registerCommand('cograph.visualize', () => {
    provider.show();
  });

  context.subscriptions.push(command);
}

export function deactivate() {}
