import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MAX_OUTPUT_BYTES } from '../analyzerRunner';
import type { GraphIntelligenceProvider, GraphIntelligenceRequest, GraphIntelligenceResult } from './provider';
import { ProgressEvent } from './progressParser';
import { extractCographResult } from './jsonRepair';

const WRAPPER_PROMPT = `Read ./.cograph/.intelligence-request.json. It holds the user's request under "prompt" and the current code graph under "graph" (nodes and edges). Fulfill the user's request.

Your final reply MUST be a single JSON object matching:
  {"graph":{"nodes":[...],"edges":[...]},"text":"<markdown>"}

The "text" field MUST be concise, skimmable markdown. Use:
  - short paragraphs (2-3 sentences max)
  - "##" / "###" headings when the answer has more than one section
  - "-" bullet lists for enumerations and trade-offs
  - fenced code blocks with a language tag (\`\`\`ts, \`\`\`py, \`\`\`bash) for code, file paths, symbol names that benefit from monospace, and shell snippets
  - backticks for inline identifiers, file paths, and flags
  - **bold** for the single most important takeaway, sparingly

Do NOT repeat the user's question. Do NOT restate the graph. Lead with the answer. If the change is trivial, a one-line answer is best.

Do not wrap the JSON object in a code fence. Do not include any prose outside the JSON.`;

/**
 * Parses OpenAI Codex CLI's `--json` event stream (newline-delimited JSON).
 *
 * Each line is shaped roughly like:
 *   {"id":"…","msg":{"type":"agent_message_delta","delta":"…"}}
 * Notable msg.type values we map onto our generic `ProgressEvent`:
 *   - session_configured  → init  (also captures session_id for resume)
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
        const sessionId = typeof msg.session_id === 'string' ? msg.session_id : undefined;
        const model = String(msg.model ?? '');
        this.onEvent({ kind: 'init', model, tools: [], sessionId });
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

export class CodexCliProvider implements GraphIntelligenceProvider {
  readonly id = 'codex';
  readonly displayName = 'OpenAI Codex';

  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  async run(req: GraphIntelligenceRequest, signal?: AbortSignal): Promise<GraphIntelligenceResult> {
    this.ensureCodexBinary();

    const cographDir = path.join(req.workspaceRoot, '.cograph');
    const tempFile = path.join(cographDir, '.intelligence-request.json');
    fs.mkdirSync(cographDir, { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify({ prompt: req.prompt, graph: req.graph }), 'utf8');

    let finalEvent: (ProgressEvent & { kind: 'result' }) | null = null;
    let errorEvent: (ProgressEvent & { kind: 'error' }) | null = null;
    let latestSessionId: string | null = req.sessionId ?? null;

    const parser = new CodexStreamParser((ev) => {
      if (ev.kind === 'init' && ev.sessionId) { latestSessionId = ev.sessionId; }
      if (ev.kind === 'result') { finalEvent = ev; }
      else if (ev.kind === 'error') { errorEvent = ev; }
      req.onProgress?.(ev);
    });

    try {
      await this.spawnStream(req, parser, signal);
    } finally {
      try { fs.unlinkSync(tempFile); } catch { /* already cleaned up */ }
    }

    if (errorEvent) {
      const e = errorEvent as ProgressEvent & { kind: 'error' };
      throw new Error(`Codex: ${e.subtype} — ${e.message}`);
    }
    if (!finalEvent) {
      throw new Error('Codex closed without emitting a result.');
    }
    const base = extractCographResult(finalEvent, 'Codex');
    return { ...base, sessionId: latestSessionId };
  }

  private ensureCodexBinary(): void {
    const result = cp.spawnSync('codex', ['--version'], { stdio: 'ignore' });
    if (result.error) {
      throw new Error(
        'Codex CLI not found on PATH. Install from https://github.com/openai/codex',
      );
    }
  }

  private spawnStream(req: GraphIntelligenceRequest, parser: CodexStreamParser, signal?: AbortSignal): Promise<void> {
    const config = vscode.workspace.getConfiguration('cograph');
    const timeoutMs = config.get<number>('graphIntelligence.timeoutMs', 300_000);
    const model = req.model ?? config.get<string>('graphIntelligence.codex.model', 'gpt-5-codex');

    // Codex CLI invocation:
    //   codex exec [resume <id>] --json --full-auto --skip-git-repo-check --cd <ws> --model M -- "<prompt>"
    // `--full-auto` gives workspace-write sandbox + auto-approval, matching Claude's
    // `--permission-mode dontAsk` so the chat stays non-interactive.
    const args: string[] = ['exec'];
    if (req.sessionId) {
      args.push('resume', req.sessionId);
    }
    args.push(
      '--json',
      '--full-auto',
      '--skip-git-repo-check',
      '--cd', req.workspaceRoot,
    );
    if (model && model !== 'default') {
      args.push('--model', model);
    }
    args.push(WRAPPER_PROMPT);

    return new Promise<void>((resolve, reject) => {
      const proc = cp.spawn('codex', args, {
        cwd: req.workspaceRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let totalBytes = 0;
      let killed = false;

      proc.stdout.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_OUTPUT_BYTES) {
          killed = true;
          proc.kill('SIGTERM');
          reject(new Error('Codex response exceeded maximum output size.'));
          return;
        }
        const text = chunk.toString();
        this.outputChannel.append(text);
        parser.feed(text);
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        this.outputChannel.append(`[codex stderr] ${chunk.toString()}`);
      });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        reject(new Error(`Codex timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);

      const onAbort = () => {
        killed = true;
        try { proc.kill('SIGTERM'); } catch { /* already exited */ }
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* gone */ }
        }, 1000);
        reject(new Error('Request cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      proc.on('error', (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`Failed to start Codex: ${err.message}`));
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (killed) { return; }
        parser.flush();
        if (code !== 0 && code !== null) {
          reject(new Error(`Codex exited with code ${code}.`));
          return;
        }
        resolve();
      });
    });
  }
}
