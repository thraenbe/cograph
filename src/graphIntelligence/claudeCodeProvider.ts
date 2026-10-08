import * as vscode from 'vscode';
import type { GraphIntelligenceProvider, JsonRequest, JsonResult } from './provider';
import { StreamJsonParser, ProgressEvent } from './progressParser';
import { extractJsonObject } from './jsonRepair';
import { runCliStream, ensureCliBinary } from './cliProcess';

const CLAUDE_NOT_FOUND =
  'Claude Code CLI not found on PATH. Install from https://docs.anthropic.com/en/docs/claude-code';

/** Read-only built-in tools granted when the caller opts into source reading. */
const READ_ONLY_TOOLS = 'Read,Grep,Glob';

/**
 * Short structured replies gain nothing from extended thinking. Measured with haiku:
 * thinking was ~4x the output tokens of a 40-file batch (cost and latency) with no
 * visible difference in the summaries. Exported for tests.
 */
export const JSON_CALL_ENV: Record<string, string> = { MAX_THINKING_TOKENS: '0' };

/** CLI arguments for `runJson`. Exported for tests. */
export function buildJsonArgs(req: JsonRequest): string[] {
  const args: string[] = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--json-schema', JSON.stringify(req.schema),
    '--tools', req.tools === 'read-only' ? READ_ONLY_TOOLS : '',
    // Drop the default prompt, MCP servers and skills: they are dead weight here
    // and dominate the cost of a small call.
    '--system-prompt', req.systemPrompt,
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    // The structured-output step counts as a turn, so digest mode needs > 1.
    '--max-turns', String(req.maxTurns ?? (req.tools === 'read-only' ? 10 : 4)),
  ];
  if (req.model && req.model !== 'default') { args.push('--model', req.model); }
  if (req.maxBudgetUsd !== undefined) { args.push('--max-budget-usd', String(req.maxBudgetUsd)); }
  return args;
}

export class ClaudeCodeProvider implements GraphIntelligenceProvider {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';

  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  /**
   * Narrow structured call. The prompt travels over stdin (no command-line length
   * limit, nothing written to disk). Tools are off unless the caller opts into
   * read-only; no write-capable tool or permission mode is ever passed.
   */
  async runJson(req: JsonRequest, signal?: AbortSignal): Promise<JsonResult> {
    ensureCliBinary('claude', CLAUDE_NOT_FOUND);
    const config = vscode.workspace.getConfiguration('cograph');
    const timeoutMs = config.get<number>('graphIntelligence.timeoutMs', 300_000);

    let finalEvent: (ProgressEvent & { kind: 'result' }) | null = null;
    let errorEvent: (ProgressEvent & { kind: 'error' }) | null = null;
    const parser = new StreamJsonParser((ev) => {
      if (ev.kind === 'result') { finalEvent = ev; }
      else if (ev.kind === 'error') { errorEvent = ev; }
      req.onProgress?.(ev);
    });

    await runCliStream({
      command: 'claude',
      args: buildJsonArgs(req),
      cwd: req.workspaceRoot,
      label: 'Claude Code',
      timeoutMs,
      stdin: req.prompt,
      env: JSON_CALL_ENV,
      signal,
      onStdout: (text) => parser.feed(text),
      onStderr: (text) => this.outputChannel.append(`[stderr] ${text}`),
      onEnd: () => parser.flush(),
    });

    if (errorEvent) {
      const e = errorEvent as ProgressEvent & { kind: 'error' };
      throw new Error(`Claude Code: ${e.subtype} — ${e.message}`);
    }
    if (!finalEvent) { throw new Error('Claude Code closed without emitting a result.'); }
    const done = finalEvent as ProgressEvent & { kind: 'result' };
    return { data: extractJsonObject(done, 'Claude Code'), usage: done.usage };
  }
}
