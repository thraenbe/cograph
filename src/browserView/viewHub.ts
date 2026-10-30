import { WebviewReadyGate } from '../webviewReadyGate';
import { isUserMessage } from './messageGuard';

/**
 * One provider's views: its VS Code panel and every browser tab that mirrors it
 * (.ai/plans/webview.md D1, docs/tour-protocol.md section 4).
 *
 * Host → view messages fan out to all of them. The panel keeps the provider's own
 * delivery (its ready gate lives in graphProvider.ts); each browser client gets a
 * gate and a `__seq` space of its own, and starts with the provider's replay so a
 * late tab builds exactly what the panel shows. View → host messages from a tab are
 * handed to the provider with the tab's id; the last view the user worked in (any
 * message but the passive diagnostics) is the active one, where `save-request` goes.
 *
 * No vscode import: the hub runs in plain Node tests and in the lab.
 */

export const PANEL_VIEW = 'panel';

/** The workspace graph's id on the loopback server (`GET /`); every other provider has its own. */
export const MAIN_VIEW = 'main';

/** What the server tells a tab besides messages: the stage was rebuilt, or the view is gone. */
export type ClientControl = 'reload' | 'closed';

export interface ClientSink {
  /** One message, already JSON. */
  write(json: string): void;
  control(kind: ClientControl): void;
}

export interface ViewHubOptions {
  log(line: string): void;
  /** The ordered snapshot a new tab starts from (GraphProvider.replayMessages). */
  replay(): object[];
  /** A tab's message for the provider (GraphProvider.onViewMessage). */
  forward(message: { type?: unknown; [k: string]: unknown }, viewId: string): void;
  /** The bridge always says `ready`; the fallback only covers a tab that died while loading. */
  fallbackMs?: number;
}

interface Client { sink: ClientSink; gate: WebviewReadyGate }

export class ViewHub {
  private panelSend: ((message: object) => void) | undefined;
  private readonly clients = new Map<string, Client>();
  private active = PANEL_VIEW;
  private readonly countListeners = new Set<(count: number) => void>();

  constructor(private readonly opts: ViewHubOptions) {}

  /** The panel's postMessage while a panel exists; undefined when it is disposed. */
  setPanel(send: ((message: object) => void) | undefined): void {
    this.panelSend = send;
  }

  /** Every view: the panel directly, each tab through its gate. */
  post(message: object): void {
    this.panelSend?.(message);
    for (const client of this.clients.values()) { client.gate.post(message); }
  }

  /** Only the view the user last worked in (save-request: the hides of THAT view are saved). */
  postToActive(message: object): void {
    const client = this.clients.get(this.active);
    if (client) { client.gate.post(message); return; }
    this.panelSend?.(message);
  }

  /** A tab's event stream opened. A known id (a reconnect) replaces the old stream. */
  attachClient(id: string, sink: ClientSink): () => void {
    this.clients.get(id)?.gate.dispose();
    const gate = new WebviewReadyGate((m) => this.writeTo(id, sink, m), this.opts.fallbackMs ?? 5000);
    const client: Client = { sink, gate };
    this.clients.set(id, client);
    gate.arm();
    for (const m of this.safeReplay()) { gate.post(m); }
    this.notifyCount();
    return () => {
      if (this.clients.get(id) !== client) { return; } // a reconnect already took the id
      gate.dispose();
      this.clients.delete(id);
      if (this.active === id) { this.active = PANEL_VIEW; }
      this.notifyCount();
    };
  }

  /** A tab posted a message. `ready` opens its gate; everything else goes to the provider. */
  receive(id: string, message: { type?: unknown; [k: string]: unknown }): void {
    if (message.type === 'ready') {
      const client = this.clients.get(id);
      if (client) { client.gate.markReady(); }
      else { this.opts.log(`[browser] ready from a tab without an event stream (${id}); ignored`); }
      return;
    }
    if (isUserMessage(message)) { this.active = id; }
    this.opts.forward(message, id);
  }

  /** The panel posted a message: a user one makes it the active view again. */
  notePanelMessage(message: { type?: unknown }): void {
    if (isUserMessage(message)) { this.active = PANEL_VIEW; }
  }

  activeView(): string { return this.active; }

  /** The panel's document was replaced (new graph HTML): every tab reloads and starts from the replay. */
  reloadClients(): void {
    for (const client of this.clients.values()) { client.sink.control('reload'); }
  }

  /** The provider is gone (panel closed): tabs show their banner; the server ends the streams. */
  closeClients(): void {
    for (const [id, client] of [...this.clients]) {
      client.gate.dispose();
      client.sink.control('closed');
      this.clients.delete(id);
    }
    this.active = PANEL_VIEW;
    this.notifyCount();
  }

  clientCount(): number { return this.clients.size; }

  onClientCount(listener: (count: number) => void): { dispose(): void } {
    this.countListeners.add(listener);
    return { dispose: () => this.countListeners.delete(listener) };
  }

  dispose(): void {
    this.closeClients();
    this.countListeners.clear();
    this.panelSend = undefined;
  }

  /** The panel takes structured clones; a tab takes JSON. A message JSON cannot carry is dropped for tabs, and said. */
  private writeTo(id: string, sink: ClientSink, message: object): void {
    let json: string;
    try {
      json = JSON.stringify(message);
    } catch (err) {
      const type = (message as { type?: unknown }).type;
      this.opts.log(`[browser] dropped ${String(type)} for ${id}: not JSON (${(err as Error).message})`);
      return;
    }
    try {
      sink.write(json);
    } catch (err) {
      this.opts.log(`[browser] write to ${id} failed: ${(err as Error).message}`);
    }
  }

  private safeReplay(): object[] {
    try {
      return this.opts.replay();
    } catch (err) {
      this.opts.log(`[browser] replay failed: ${(err as Error).message}`);
      return [];
    }
  }

  private notifyCount(): void {
    const n = this.clients.size;
    for (const listener of [...this.countListeners]) { listener(n); }
  }
}
