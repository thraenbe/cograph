import * as vscode from 'vscode';

/**
 * VS Code's MCP server definition provider API (stable since 1.101). Our engine floor is 1.75 and
 * the compiler must not see post-1.75 API, so this is the one place that reaches past it, through
 * these local shapes and always behind the runtime check in `mcpApi()`.
 * Checked against code.visualstudio.com/api/extension-guides/ai/mcp and @types/vscode 1.101.
 * VS Code derives the activation event `onMcpCollection:cograph` from the contribution.
 */
export const MCP_PROVIDER_ID = 'cograph';

interface McpStdioServerDefinition { cwd?: vscode.Uri }
type McpStdioCtor = new (label: string, command: string, args?: string[],
  env?: Record<string, string | number | null>, version?: string) => McpStdioServerDefinition;

interface McpServerDefinitionProvider {
  onDidChangeMcpServerDefinitions?: vscode.Event<void>;
  provideMcpServerDefinitions(token: vscode.CancellationToken): McpStdioServerDefinition[];
}

interface McpApi {
  register(id: string, provider: McpServerDefinitionProvider): vscode.Disposable;
  StdioDefinition: McpStdioCtor;
}

/** The API when this VS Code has it, otherwise undefined (VS Code < 1.101, or another editor). */
export function mcpApi(host: unknown = vscode): McpApi | undefined {
  const h = host as { lm?: { registerMcpServerDefinitionProvider?: unknown }; McpStdioServerDefinition?: unknown };
  const register = h.lm?.registerMcpServerDefinitionProvider;
  if (typeof register !== 'function' || typeof h.McpStdioServerDefinition !== 'function') { return undefined; }
  return {
    register: (id, provider) => (register as McpApi['register']).call(h.lm, id, provider),
    StdioDefinition: h.McpStdioServerDefinition as McpStdioCtor,
  };
}

/**
 * Offer the bundled server to VS Code's agent mode for the first workspace folder, run with VS
 * Code's own Node. Re-offered when the folders change. A no-op on hosts without the API.
 */
export function registerMcpProvider(serverPath: string, version: string, api: McpApi | undefined): vscode.Disposable | undefined {
  if (!api) { return undefined; }
  const changed = new vscode.EventEmitter<void>();
  const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire());
  const registration = api.register(MCP_PROVIDER_ID, {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { return []; }
      const def = new api.StdioDefinition('CoGraph', process.execPath, [serverPath, '--workspace', root],
        { ELECTRON_RUN_AS_NODE: '1' }, version);
      def.cwd = vscode.Uri.file(root);
      return [def];
    },
  });
  return vscode.Disposable.from(registration, folders, changed);
}
