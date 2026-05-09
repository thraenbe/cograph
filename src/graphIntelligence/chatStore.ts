import * as fs from 'fs';
import * as path from 'path';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  text: string;
  at: string;
}

const MAX_MESSAGES = 200;

export class ChatStore {
  constructor(private readonly workspaceRoot: string) {}

  load(): ChatMessage[] {
    try {
      const raw = fs.readFileSync(this.filePath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) { return []; }
      return parsed;
    } catch {
      return [];
    }
  }

  append(msg: ChatMessage): void {
    const messages = this.load();
    messages.push(msg);
    const capped = messages.length > MAX_MESSAGES
      ? messages.slice(messages.length - MAX_MESSAGES)
      : messages;
    const dir = path.dirname(this.filePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath(), JSON.stringify(capped, null, 2), 'utf8');
  }

  clear(): void {
    try { fs.unlinkSync(this.filePath()); } catch { /* file may not exist */ }
  }

  private filePath(): string {
    return path.join(this.workspaceRoot, '.cograph', 'chat.json');
  }
}
