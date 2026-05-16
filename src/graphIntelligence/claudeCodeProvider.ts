import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MAX_OUTPUT_BYTES } from '../analyzerRunner';
import type { GraphIntelligenceProvider, GraphIntelligenceRequest, GraphIntelligenceResult } from './provider';
import { StreamJsonParser, ProgressEvent } from './progressParser';
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

const COGRAPH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['graph', 'text'],
  properties: {
    text: { type: 'string' },
    graph: {
      type: 'object',
      required: ['nodes', 'edges'],
      properties: {
        nodes: { type: 'array', items: { type: 'object' } },
        edges: { type: 'array', items: { type: 'object' } },
      },
    },
  },
};

export class ClaudeCodeProvider implements GraphIntelligenceProvider {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';

  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  async run(req: GraphIntelligenceRequest, signal?: AbortSignal): Promise<GraphIntelligenceResult> {
    this.ensureClaudeBinary();

    const cographDir = path.join(req.workspaceRoot, '.cograph');
    const tempFile = path.join(cographDir, '.intelligence-request.json');
    fs.mkdirSync(cographDir, { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify({ prompt: req.prompt, graph: req.graph }), 'utf8');

    let finalEvent: (ProgressEvent & { kind: 'result' }) | null = null;
    let errorEvent: (ProgressEvent & { kind: 'error' }) | null = null;
    let latestSessionId: string | null = req.sessionId ?? null;

    const parser = new StreamJsonParser((ev) => {
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
      throw new Error(`Claude Code: ${e.subtype} — ${e.message}`);
    }
    if (!finalEvent) {
      throw new Error('Claude Code closed without emitting a result.');
    }
    const base = extractCographResult(finalEvent);
    return { ...base, sessionId: latestSessionId };
  }

  private ensureClaudeBinary(): void {
    const result = cp.spawnSync('claude', ['--version'], { stdio: 'ignore' });
    if (result.error) {
      throw new Error(
        'Claude Code CLI not found on PATH. Install from https://docs.anthropic.com/en/docs/claude-code',
      );
    }
  }

  private spawnStream(req: GraphIntelligenceRequest, parser: StreamJsonParser, signal?: AbortSignal): Promise<void> {
    const config = vscode.workspace.getConfiguration('cograph');
    const timeoutMs = config.get<number>('graphIntelligence.timeoutMs', 300_000);
    const model = req.model ?? config.get<string>('graphIntelligence.model', 'sonnet');
    const effort = req.effort ?? config.get<string>('graphIntelligence.effort', 'auto');
    const maxTurns = req.maxTurns ?? config.get<number>('graphIntelligence.maxTurns', 15);
    const maxBudgetUsd = req.maxBudgetUsd ?? config.get<number>('graphIntelligence.maxBudgetUsd', 2.0);

    const args: string[] = [
      '-p', WRAPPER_PROMPT,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--json-schema', JSON.stringify(COGRAPH_SCHEMA),
      '--permission-mode', 'dontAsk',
      '--max-turns', String(maxTurns),
      '--max-budget-usd', String(maxBudgetUsd),
    ];
    if (req.sessionId) {
      args.push('--resume', req.sessionId);
    }
    if ((model === 'opus' || model === 'opusplan') && effort && effort !== 'auto') {
      args.push('--effort', effort);
    }

    return new Promise<void>((resolve, reject) => {
      const proc = cp.spawn('claude', args, {
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
          reject(new Error('Claude Code response exceeded maximum output size.'));
          return;
        }
        const text = chunk.toString();
        this.outputChannel.append(text);
        parser.feed(text);
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        this.outputChannel.append(`[stderr] ${chunk.toString()}`);
      });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        reject(new Error(`Claude Code timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);

      const onAbort = () => {
        killed = true;
        try { proc.kill('SIGTERM'); } catch { /* already exited */ }
        // Escalate to SIGKILL if the process is still alive after a brief grace period.
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* gone */ }
        }, 1000);
        reject(new Error('Request cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      proc.on('error', (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`Failed to start Claude Code: ${err.message}`));
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (killed) { return; }
        parser.flush();
        if (code !== 0 && code !== null) {
          reject(new Error(`Claude Code exited with code ${code}.`));
          return;
        }
        resolve();
      });
    });
  }
}
