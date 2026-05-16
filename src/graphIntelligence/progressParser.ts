import * as path from 'path';

export type ProgressEvent =
  | { kind: 'init'; model: string; tools: string[]; sessionId?: string }
  | { kind: 'thinking'; snippet: string }
  | { kind: 'tool-use'; name: string; summary: string }
  | { kind: 'text'; delta: string }
  | { kind: 'result'; text: string; structured?: unknown; usage?: { inputTokens: number; outputTokens: number; costUsd: number } }
  | { kind: 'error'; subtype: string; message: string };

export class StreamJsonParser {
  private buffer = '';

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
      const msg = JSON.parse(line);
      this.handleLine(msg);
    } catch {
      /* non-JSON banner line — ignore */
    }
  }

  private handleLine(msg: Record<string, unknown>): void {
    const type = msg.type;
    if (type === 'system' && msg.subtype === 'init') {
      const tools = Array.isArray(msg.tools) ? (msg.tools as unknown[]).map(String) : [];
      const sessionId = typeof msg.session_id === 'string' ? msg.session_id : undefined;
      this.onEvent({ kind: 'init', model: String(msg.model ?? ''), tools, sessionId });
      return;
    }
    if (type === 'assistant') {
      const message = msg.message as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
      for (const block of content) {
        if (block.type === 'thinking') {
          const snippet = String(block.thinking ?? '').slice(0, 200);
          this.onEvent({ kind: 'thinking', snippet });
        } else if (block.type === 'tool_use') {
          const name = String(block.name ?? '');
          const summary = summarizeToolInput(name, block.input);
          this.onEvent({ kind: 'tool-use', name, summary });
        } else if (block.type === 'text') {
          const delta = String(block.text ?? '');
          if (delta) { this.onEvent({ kind: 'text', delta }); }
        }
      }
      return;
    }
    if (type === 'result') {
      if (msg.subtype === 'success') {
        const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        this.onEvent({
          kind: 'result',
          text: String(msg.result ?? ''),
          structured: msg.structured_output,
          usage: usage ? {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            costUsd: Number(msg.total_cost_usd ?? 0),
          } : undefined,
        });
      } else {
        const errors = Array.isArray(msg.errors) ? (msg.errors as Array<{ message?: unknown }>) : [];
        const message = errors[0]?.message ? String(errors[0].message) : 'Claude Code returned an error.';
        this.onEvent({ kind: 'error', subtype: String(msg.subtype ?? 'unknown'), message });
      }
      return;
    }
  }
}

export function summarizeToolInput(name: string, input: unknown): string {
  const i = (input ?? {}) as { file_path?: unknown; pattern?: unknown; command?: unknown };
  switch (name) {
    case 'Read':
      return i.file_path ? `Read ${path.basename(String(i.file_path))}` : 'Read';
    case 'Glob':
      return i.pattern ? `Glob ${String(i.pattern)}` : 'Glob';
    case 'Grep':
      return i.pattern ? `Grep "${String(i.pattern).slice(0, 40)}"` : 'Grep';
    case 'Bash':
      return i.command ? `Bash ${String(i.command).slice(0, 60)}` : 'Bash';
    case 'Edit':
    case 'Write':
      return i.file_path ? `${name} ${path.basename(String(i.file_path))}` : name;
    default:
      return name || 'tool';
  }
}
