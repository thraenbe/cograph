/**
 * Delivers host → webview messages only once the webview can receive them (F11).
 *
 * `structure` / `graph` used to be posted on a timer (150 ms) after assigning
 * `webview.html`. On a cold open the page's scripts can still be loading then,
 * the message is lost and the graph stays blank ("graph not loading on first
 * try"). The webview now announces `{ type: 'ready' }` once its message
 * listener is attached; until then messages wait here.
 *
 * Compatibility: a webview that never says `ready` (stale cached scripts, test
 * doubles) still gets its data after `fallbackMs` — the old timing. If `ready`
 * arrives AFTER such a fallback delivery, the page was evidently not listening
 * yet, so those messages are sent again. Every gated message carries `__seq`
 * and the webview ignores a sequence number it has already handled, so a
 * re-send can never be applied twice.
 */
export class WebviewReadyGate {
  private ready = true;               // never armed → pass-through (panels we did not load)
  private queue: object[] = [];
  private unconfirmed: object[] = []; // delivered by the fallback, no `ready` seen yet
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private disposed = false;

  constructor(
    private readonly send: (message: object) => void,
    private readonly fallbackMs = 150,
  ) {}

  /** Call right after assigning graph HTML to the webview: a new document is loading. */
  arm(): void {
    this.clearTimer();
    this.ready = false;
    this.queue = [];
    this.unconfirmed = [];
  }

  post(message: object): void {
    if (this.disposed) { return; }
    const stamped = { ...message, __seq: ++this.seq };
    if (this.ready) { this.send(stamped); return; }
    this.queue.push(stamped);
    if (!this.timer) { this.timer = setTimeout(() => this.flushByFallback(), this.fallbackMs); }
  }

  /** The webview's message listener is attached. */
  markReady(): void {
    if (this.disposed) { return; }
    this.clearTimer();
    this.ready = true;
    const pending = [...this.unconfirmed, ...this.queue];
    this.unconfirmed = [];
    this.queue = [];
    for (const m of pending) { this.send(m); }
  }

  isReady(): boolean { return this.ready; }
  pendingCount(): number { return this.queue.length + this.unconfirmed.length; }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.queue = [];
    this.unconfirmed = [];
  }

  private flushByFallback(): void {
    this.timer = undefined;
    if (this.disposed || this.ready) { return; }
    const pending = this.queue;
    this.queue = [];
    for (const m of pending) { this.send(m); }
    this.unconfirmed.push(...pending);
  }

  private clearTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }
}
