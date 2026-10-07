import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { cachePath } from '../cacheStore';
import { ago } from './format';
import {
  claudeAddCommand, launchFor, mergeMcpJson, serverEntry, snippet, type Launch,
} from './setupSnippets';
import { mcpApi, registerMcpProvider } from './vscodeRegistration';

export const CONNECT_COMMAND = 'cograph.connectAgent';
const BUNDLE = path.join('dist', 'mcp', 'server.js');

type Log = (msg: string, err?: unknown) => void;

/**
 * Copy the bundled server to a path that survives extension updates (the extension folder name
 * carries the version). Skipped when the copy is already identical. Never throws.
 */
export async function installStableServer(extensionPath: string, storageDir: string, log: Log): Promise<string | null> {
  const src = path.join(extensionPath, BUNDLE);
  const dest = path.join(storageDir, 'mcp', 'server.js');
  try {
    const bundle = await fs.promises.readFile(src);
    const current = await fs.promises.readFile(dest).catch(() => null);
    if (!current || !current.equals(bundle)) {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, bundle);
      await fs.promises.rename(tmp, dest);
    }
    return dest;
  } catch (err) {
    log('could not install the MCP server copy', err);
    return null;
  }
}

export function nodeOnPath(): Promise<boolean> {
  return new Promise((resolve) => {
    cp.execFile('node', ['--version'], { timeout: 3000, windowsHide: true }, (err) => resolve(!err));
  });
}

function cacheAge(root: string): string {
  try { return `graph analysed ${ago(fs.statSync(cachePath(root)).mtime.toISOString(), Date.now())}`; } catch { return 'no analysis yet: open the graph once'; }
}

interface Choice extends vscode.QuickPickItem { run?: () => Promise<void> }

async function copy(text: string, what: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  void vscode.window.showInformationMessage(`CoGraph: ${what} copied to the clipboard.`);
}

/** Merge the `cograph` entry into `<root>/.mcp.json` after a confirm; other servers are kept. */
export async function writeTeamConfig(root: string, launch: Launch): Promise<void> {
  const file = path.join(root, '.mcp.json');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const entry = serverEntry(launch, null);
  let merged = mergeMcpJson(existing, entry, false);
  if (!merged.ok && merged.error === 'exists') {
    const ok = await vscode.window.showWarningMessage('.mcp.json already has a "cograph" server. Replace it?', { modal: true }, 'Replace');
    if (ok !== 'Replace') { return; }
    merged = mergeMcpJson(existing, entry, true);
  }
  if (!merged.ok) { void vscode.window.showErrorMessage(`CoGraph: ${merged.error}. Nothing was changed.`); return; }
  if (merged.status === 'unchanged') { void vscode.window.showInformationMessage('CoGraph: .mcp.json already points at CoGraph.'); return; }
  const confirm = await vscode.window.showInformationMessage(
    `${merged.status === 'added' ? 'Add' : 'Update'} the "cograph" server in .mcp.json? The file is shared with your team through git, and the server path in it is specific to this machine.`,
    { modal: true }, 'Write .mcp.json');
  if (confirm !== 'Write .mcp.json') { return; }
  fs.writeFileSync(file, merged.text, 'utf8');
  void vscode.window.showInformationMessage('CoGraph: .mcp.json updated. Restart Claude Code in this folder to pick it up.');
}

export function choicesFor(root: string, launch: Launch, platform: NodeJS.Platform, hasVsCodeApi: boolean): Choice[] {
  const items: Choice[] = [];
  if (hasVsCodeApi) {
    items.push({ label: '$(check) VS Code agent mode already sees CoGraph', description: 'nothing to set up', kind: vscode.QuickPickItemKind.Separator });
  }
  items.push(
    { label: '$(terminal) Claude Code: just me', description: 'copies a `claude mcp add` command (local scope)',
      run: () => copy(claudeAddCommand(launch, root, platform), 'Claude Code command') },
    { label: '$(organization) Claude Code: whole team', description: 'adds CoGraph to .mcp.json in this workspace',
      run: () => writeTeamConfig(root, launch) },
    { label: '$(json) Cursor', description: 'copies the .cursor/mcp.json snippet',
      run: () => copy(snippet(serverEntry(launch, '${workspaceFolder}')), 'Cursor config') },
    { label: '$(json) Claude Desktop', description: 'copies the claude_desktop_config.json snippet',
      run: () => copy(snippet(serverEntry(launch, root)), 'Claude Desktop config') },
  );
  return items;
}

export async function connectAgent(stableServer: Promise<string | null>): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { void vscode.window.showErrorMessage('CoGraph: Open a folder first.'); return; }
  const server = await stableServer;
  if (!server) { void vscode.window.showErrorMessage('CoGraph: The MCP server bundle is missing from this installation.'); return; }
  const launch = launchFor(server, await nodeOnPath(), process.execPath);
  const picked = await vscode.window.showQuickPick(choicesFor(root, launch, process.platform, !!mcpApi()), {
    title: `Connect an AI agent to CoGraph · ${cacheAge(root)}`,
    placeHolder: 'Local and read-only: the server reads .cograph/ and your source files, sends nothing anywhere, needs no API key.',
  });
  await picked?.run?.();
}

/** Wire MCP into the extension: stable server copy, VS Code provider (1.101+), setup command. */
export function activateMcp(context: vscode.ExtensionContext): void {
  let channel: vscode.OutputChannel | undefined;
  const log: Log = (msg, err) => {
    channel ??= vscode.window.createOutputChannel('CoGraph MCP');
    channel.appendLine(JSON.stringify({ ts: new Date().toISOString(), msg, error: err ? String((err as Error).message ?? err) : undefined }));
  };
  let stable: Promise<string | null> = Promise.resolve(null);
  try {
    stable = installStableServer(context.extensionPath, context.globalStorageUri.fsPath, log);
    const bundled = path.join(context.extensionPath, BUNDLE);
    const version = String((context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '0');
    const provider = fs.existsSync(bundled) ? registerMcpProvider(bundled, version, mcpApi()) : undefined;
    if (provider) { context.subscriptions.push(provider); }
  } catch (err) {
    log('MCP provider setup failed', err); // never let MCP break activation; the command still works
  }
  const command = vscode.commands.registerCommand(CONNECT_COMMAND, async () => {
    try { await connectAgent(stable); } catch (err) {
      log('connect agent failed', err);
      void vscode.window.showErrorMessage(`CoGraph: Could not set up the agent connection — ${(err as Error).message}`);
    }
  });
  context.subscriptions.push(command, { dispose: () => channel?.dispose() });
}
