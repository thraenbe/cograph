import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IndexHolder } from './graphIndex';
import { findWorkspaceRoot } from './paths';
import { runTool, TOOLS, type ToolContext } from './tools';

/**
 * CoGraph MCP server: a local, read-only stdio server answering call-graph questions from the
 * workspace's `.cograph/graph-cache.json`. No network, no API key, no LLM. stdout carries only
 * MCP frames, so every log line goes to stderr as one JSON object.
 *
 * Usage: node server.js [--workspace <dir>]
 */

export const SERVER_NAME = 'cograph';
export const SERVER_VERSION = '1.0.0';

export function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra })}\n`);
}

export function parseArgs(argv: string[]): { workspace?: string } {
  const i = argv.indexOf('--workspace');
  if (i >= 0 && argv[i + 1]) { return { workspace: argv[i + 1] }; }
  const eq = argv.find((a) => a.startsWith('--workspace='));
  return eq ? { workspace: eq.slice('--workspace='.length) } : {};
}

export function createServer(root: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const ctx: ToolContext = { holder: new IndexHolder(root), now: Date.now, log };
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        const r = runTool(tool, args, ctx);
        return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError };
      },
    );
  }
  return server;
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const root = findWorkspaceRoot(cwd, parseArgs(argv).workspace);
  const server = createServer(root);
  await server.connect(new StdioServerTransport());
  log('info', 'started', { root, version: SERVER_VERSION });
}

if (require.main === module) {
  main().catch((err: Error) => {
    log('error', 'fatal', { error: err.message });
    process.exit(1);
  });
}
