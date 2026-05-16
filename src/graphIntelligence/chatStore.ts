import * as fs from 'fs';
import * as path from 'path';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'error' | 'system';
  text: string;
  at: string;
}

interface ChatFile {
  /** Provider-id → session-id map for resume. One slot per provider so switching
   *  providers mid-chat doesn't drop either side's continuity. */
  sessions: Record<string, string>;
  messages: ChatMessage[];
}

const MAX_MESSAGES = 200;
export const DEFAULT_CHAT_KEY = '__default__';
const LEGACY_PROVIDER_ID = 'claude-code';

/**
 * Per-graph chat persistence. Each graph's chat lives at
 *   `.cograph/chats/<sanitized-key>.json`
 * and contains both the message history and a per-provider map of session IDs
 * used to resume the conversation. A `__default__` key is used when no graph is
 * loaded.
 */
export class ChatStore {
  private activeKey: string = DEFAULT_CHAT_KEY;

  constructor(private readonly workspaceRoot: string) {
    this.migrateLegacyChatFile();
  }

  /** Sanitize an arbitrary graph identifier into a safe filename stem. */
  static keyFromName(name: string | null | undefined): string {
    if (!name || !name.trim()) { return DEFAULT_CHAT_KEY; }
    return name.trim().replace(/[^a-zA-Z0-9_\- ]/g, '_');
  }

  setActive(key: string): void {
    this.activeKey = key || DEFAULT_CHAT_KEY;
  }

  getActiveKey(): string {
    return this.activeKey;
  }

  load(key?: string): ChatMessage[] {
    return this.readFile(key ?? this.activeKey).messages;
  }

  append(msg: ChatMessage, key?: string): void {
    const k = key ?? this.activeKey;
    const file = this.readFile(k);
    file.messages.push(msg);
    if (file.messages.length > MAX_MESSAGES) {
      file.messages = file.messages.slice(file.messages.length - MAX_MESSAGES);
    }
    this.writeFile(k, file);
  }

  clear(key?: string): void {
    const k = key ?? this.activeKey;
    try { fs.unlinkSync(this.filePathFor(k)); } catch { /* file may not exist */ }
  }

  getSessionId(provider: string, key?: string): string | null {
    const file = this.readFile(key ?? this.activeKey);
    return file.sessions[provider] ?? null;
  }

  setSessionId(provider: string, id: string | null, key?: string): void {
    const k = key ?? this.activeKey;
    const file = this.readFile(k);
    if (id) {
      file.sessions[provider] = id;
    } else {
      delete file.sessions[provider];
    }
    this.writeFile(k, file);
  }

  /** Reset the session(s) for this chat (next turn starts fresh) without
   *  erasing the visible message history. With `provider` specified, only
   *  that provider's session is cleared; without, ALL provider sessions are
   *  cleared (used by /new and the "+ New Session" button). */
  clearSession(provider?: string, key?: string): void {
    const k = key ?? this.activeKey;
    const file = this.readFile(k);
    if (provider) {
      delete file.sessions[provider];
    } else {
      file.sessions = {};
    }
    this.writeFile(k, file);
  }

  private readFile(key: string): ChatFile {
    try {
      const raw = fs.readFileSync(this.filePathFor(key), 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Legacy shape — bare array of messages.
        return { sessions: {}, messages: parsed };
      }
      if (parsed && typeof parsed === 'object') {
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        // Migrate old single-session field → claude-code slot.
        if (parsed.sessions && typeof parsed.sessions === 'object') {
          const sessions: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed.sessions)) {
            if (typeof v === 'string') { sessions[k] = v; }
          }
          return { sessions, messages };
        }
        if (typeof parsed.sessionId === 'string' && parsed.sessionId) {
          return { sessions: { [LEGACY_PROVIDER_ID]: parsed.sessionId }, messages };
        }
        return { sessions: {}, messages };
      }
    } catch {
      /* file missing or unreadable */
    }
    return { sessions: {}, messages: [] };
  }

  private writeFile(key: string, file: ChatFile): void {
    const filePath = this.filePathFor(key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf8');
  }

  private filePathFor(key: string): string {
    return path.join(this.workspaceRoot, '.cograph', 'chats', `${key}.json`);
  }

  /**
   * One-time: if the pre-per-graph `.cograph/chat.json` file exists and the new
   * `__default__` chat does not, migrate the legacy messages into it. The old
   * file is renamed to `chat.json.bak` so users can recover it if needed.
   */
  private migrateLegacyChatFile(): void {
    const legacy = path.join(this.workspaceRoot, '.cograph', 'chat.json');
    const defaultFile = this.filePathFor(DEFAULT_CHAT_KEY);
    if (!fs.existsSync(legacy) || fs.existsSync(defaultFile)) { return; }
    try {
      const raw = fs.readFileSync(legacy, 'utf8');
      const parsed = JSON.parse(raw);
      const messages = Array.isArray(parsed) ? parsed : [];
      fs.mkdirSync(path.dirname(defaultFile), { recursive: true });
      fs.writeFileSync(defaultFile, JSON.stringify({ sessions: {}, messages }, null, 2), 'utf8');
      fs.renameSync(legacy, legacy + '.bak');
    } catch {
      /* migration is best-effort; ignore failures */
    }
  }
}
