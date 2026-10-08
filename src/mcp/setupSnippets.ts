/**
 * Config snippets for pointing an MCP client at the bundled CoGraph server. Pure string/JSON
 * building (no vscode, no fs) so every format is unit-tested. Formats checked 2026-09-29 against
 * code.claude.com/docs/en/mcp, cursor.com/docs/context/mcp and modelcontextprotocol.io.
 */

export const SERVER_KEY = 'cograph';

/** How to start the server: `node <server>` or, without node on PATH, VS Code's own runtime. */
export interface Launch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function launchFor(serverPath: string, nodeOnPath: boolean, execPath: string): Launch {
  return nodeOnPath
    ? { command: 'node', args: [serverPath] }
    : { command: execPath, args: [serverPath], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

export function quoteArg(arg: string, platform: NodeJS.Platform): string {
  if (/^[\w@%+=:,./\\-]+$/.test(arg)) { return arg; }
  return platform === 'win32' ? `"${arg.replace(/"/g, '\\"')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** `claude mcp add` for the default `local` scope: this project, this user only. */
export function claudeAddCommand(launch: Launch, workspace: string, platform: NodeJS.Platform): string {
  const q = (a: string) => quoteArg(a, platform);
  const env = Object.entries(launch.env ?? {}).map(([k, v]) => `--env ${q(`${k}=${v}`)} `).join('');
  const args = [...launch.args, '--workspace', workspace].map(q).join(' ');
  return `claude mcp add ${env}${SERVER_KEY} -- ${q(launch.command)} ${args}`;
}

export interface ServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function serverEntry(launch: Launch, workspaceArg: string | null): ServerEntry {
  const args = workspaceArg === null ? [...launch.args] : [...launch.args, '--workspace', workspaceArg];
  return launch.env ? { command: launch.command, args, env: { ...launch.env } } : { command: launch.command, args };
}

/** `{ "mcpServers": { "cograph": … } }`, pretty-printed for pasting. */
export function snippet(entry: ServerEntry): string {
  return JSON.stringify({ mcpServers: { [SERVER_KEY]: entry } }, null, 2);
}

export type MergeResult =
  | { ok: true; text: string; status: 'added' | 'replaced' | 'unchanged' }
  | { ok: false; error: string };

/**
 * Add or replace only the `cograph` entry of an `.mcp.json`; every other key and server is kept.
 * `replace: false` refuses to touch a different existing `cograph` entry (the caller asks first).
 */
export function mergeMcpJson(existing: string | null, entry: ServerEntry, replace: boolean): MergeResult {
  let doc: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return { ok: false, error: '.mcp.json is not a JSON object' }; }
      doc = parsed as Record<string, unknown>;
    } catch (err) {
      return { ok: false, error: `.mcp.json is not valid JSON (${(err as Error).message})` };
    }
  }
  const servers = doc.mcpServers ?? {};
  if (typeof servers !== 'object' || Array.isArray(servers)) { return { ok: false, error: '"mcpServers" in .mcp.json is not an object' }; }
  const current = (servers as Record<string, unknown>)[SERVER_KEY];
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(entry)) {
    return { ok: true, text: existing as string, status: 'unchanged' };
  }
  if (current !== undefined && !replace) { return { ok: false, error: 'exists' }; }
  const next = { ...doc, mcpServers: { ...(servers as Record<string, unknown>), [SERVER_KEY]: entry } };
  return { ok: true, text: `${JSON.stringify(next, null, 2)}\n`, status: current === undefined ? 'added' : 'replaced' };
}
