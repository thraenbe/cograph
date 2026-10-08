import * as vscode from 'vscode';
import type { GraphIntelligenceProvider, JsonRequest, JsonResult } from './provider';
import { ProgressEvent } from './progressParser';
import { extractJsonObject } from './jsonRepair';
import { runCliStream, ensureCliBinary } from './cliProcess';

/**
 * Parses OpenAI Codex CLI's `--json` event stream (newline-delimited JSON).
 *
 * Each line is shaped roughly like:
 *   {"id":"…","msg":{"type":"agent_message_delta","delta":"…"}}
 * Notable msg.type values we map onto our generic `ProgressEvent`:
 *   - session_configured  → init
 *   - agent_reasoning(_delta) → thinking
 *   - agent_message_delta → text
 *   - exec_command_begin  → tool-use (Bash)
 *   - task_complete       → result (carries last_agent_message)
 *   - error               → error
 */
export class CodexStreamParser {
  private buffer = '';
  private lastAgentMessage = '';

  constructor(private readonly onEvent: (e: ProgressEvent) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) { continue; }
      this.tryHandleLine(line);
    }
  }

  flush(): void {
    if (this.buffer.trim()) {
      this.tryHandleLine(this.buffer.trim());
    }
    this.buffer = '';
  }

  private tryHandleLine(line: string): void {
    try {
      const ev = JSON.parse(line);
      this.handleEvent(ev);
    } catch {
      /* non-JSON banner line — ignore */
    }
  }

  private handleEvent(ev: Record<string, unknown>): void {
    const msg = ev?.msg as Record<string, unknown> | undefined;
    if (!msg || typeof msg !== 'object') { return; }
    const t = String(msg.type ?? '');

    switch (t) {
      case 'session_configured': {
        const model = String(msg.model ?? '');
        this.onEvent({ kind: 'init', model, tools: [] });
        return;
      }
      case 'agent_reasoning':
      case 'agent_reasoning_delta': {
        const text = String(msg.text ?? msg.delta ?? '').slice(0, 200);
        if (text) { this.onEvent({ kind: 'thinking', snippet: text }); }
        return;
      }
      case 'agent_message_delta': {
        const delta = String(msg.delta ?? '');
        if (delta) { this.onEvent({ kind: 'text', delta }); }
        return;
      }
      case 'agent_message': {
        // Full message — keep it so task_complete can fall back to it.
        this.lastAgentMessage = String(msg.message ?? '');
        return;
      }
      case 'exec_command_begin': {
        const cmd = Array.isArray(msg.command) ? (msg.command as unknown[]).join(' ') : String(msg.command ?? '');
        this.onEvent({ kind: 'tool-use', name: 'Bash', summary: `Bash ${cmd.slice(0, 60)}` });
        return;
      }
      case 'task_complete': {
        const finalText = String(msg.last_agent_message ?? this.lastAgentMessage ?? '');
        const usage = msg.usage as { input_tokens?: number; output_tokens?: number; total_cost_usd?: number } | undefined;
        this.onEvent({
          kind: 'result',
          text: finalText,
          structured: undefined,
          usage: usage ? {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            costUsd: Number(usage.total_cost_usd ?? 0),
          } : undefined,
        });
        return;
      }
      case 'error': {
        this.onEvent({
          kind: 'error',
          subtype: 'codex_error',
          message: String(msg.message ?? 'Codex returned an error.'),
        });
        return;
      }
    }
  }
}

const CODEX_NOT_FOUND = 'Codex CLI not found on PATH. Install from https://github.com/openai/codex';

/** CLI arguments for `runJson`; the prompt is read from stdin (`-`). Exported for tests. */
export function buildCodexJsonArgs(req: JsonRequest): string[] {
  const args = ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', req.workspaceRoot];
  if (req.model && req.model !== 'default') { args.push('--model', req.model); }
  args.push('-');
  return args;
}

/** Prompt for `runJson`: instructions, task, then the schema the reply must match. Exported for tests. */
export function buildCodexJsonPrompt(req: JsonRequest): string {
  const fileRule = req.tools === 'none' ? 'Do not open or search any files. ' : '';
  return `${req.systemPrompt}\n\n${req.prompt}\n\n${fileRule}Your final reply MUST be a single JSON object `
    + `matching this JSON Schema, with no code fence and no prose outside it:\n${JSON.stringify(req.schema)}`;
}

export class CodexCliProvider implements GraphIntelligenceProvider {
  readonly id = 'codex';
  readonly displayName = 'OpenAI Codex';

  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  /**
   * Narrow structured call. Codex has no schema flag we rely on and no way to
   * switch tools off, so the JSON shape is enforced by the prompt and the CLI
   * always runs in the read-only sandbox (never `--full-auto`). Codex reports no
   * cost, so `usage` stays undefined.
   */
  async runJson(req: JsonRequest, signal?: AbortSignal): Promise<JsonResult> {
    ensureCliBinary('codex', CODEX_NOT_FOUND);
    const config = vscode.workspace.getConfiguration('cograph');
    const timeoutMs = config.get<number>('graphIntelligence.timeoutMs', 300_000);

    let finalEvent: (ProgressEvent & { kind: 'result' }) | null = null;
    let errorEvent: (ProgressEvent & { kind: 'error' }) | null = null;
    const parser = new CodexStreamParser((ev) => {
      if (ev.kind === 'result') { finalEvent = ev; }
      else if (ev.kind === 'error') { errorEvent = ev; }
      req.onProgress?.(ev);
    });

    await runCliStream({
      command: 'codex',
      args: buildCodexJsonArgs(req),
      cwd: req.workspaceRoot,
      label: 'Codex',
      timeoutMs,
      stdin: buildCodexJsonPrompt(req),
      signal,
      onStdout: (text) => parser.feed(text),
      onStderr: (text) => this.outputChannel.append(`[codex stderr] ${text}`),
      onEnd: () => parser.flush(),
    });

    if (errorEvent) {
      const e = errorEvent as ProgressEvent & { kind: 'error' };
      throw new Error(`Codex: ${e.subtype} — ${e.message}`);
    }
    if (!finalEvent) { throw new Error('Codex closed without emitting a result.'); }
    return { data: extractJsonObject(finalEvent as ProgressEvent & { kind: 'result' }, 'Codex') };
  }
}
