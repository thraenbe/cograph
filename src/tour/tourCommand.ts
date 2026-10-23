import type { MirroredView } from '../browserView/browserServer';
import type { PrGraphView, ProgressRunner } from '../vcs/prController';
import { HeadTreeError } from '../vcs/engine/headTree';
import { tourGraphView } from '../vcs/tourView';
import type { TourPrepared, TourRoute, TourTarget } from './tourApi';
import type { LoadedTour } from './tourModule';
import { STUB_SENTENCE } from './tourModule';

/**
 * One tour, from a click to the browser tab: prepare it behind one cancellable
 * progress, open the pull-request panel on the head copy as a pull-request
 * click does (Q11), mirror that panel on the loopback server with the tour's
 * routes and assets, open the page. Every way it can fail ends in one sentence.
 * No vscode import: VS Code supplies the effects.
 */

/** The part of BrowserServer a tour uses (src/browserView/browserServer.ts). */
export interface TourServer {
  registerView(id: string, view: MirroredView): void;
  mount(routes: TourRoute[]): void;
  serveStatic(prefix: string, dir: string): void;
  serveTourPage(tourId: string, viewId: string, opts: { assets: boolean }): void;
}

export interface TourRunnerDeps {
  /** The private package's host, created once; null in the public build. */
  loadTour(): LoadedTour | null;
  /** The loopback server; null when cograph.browserView.enabled is off. Rejects when it cannot listen. */
  getServer(): Promise<TourServer | null>;
  /** server.url(path) through asExternalUri, opened in the default browser. */
  openUrl(server: TourServer, urlPath: string): Promise<{ url: string; opened: boolean }>;
  /** The "opened in your browser" toast with Copy URL (the URL carries the token: never shown). */
  showOpened(message: string, url: string, opened: boolean): Promise<void>;
  /** The pull-request panel on the head copy; null when no panel could be opened. */
  openPanel(view: PrGraphView, headDir: string, label: string): MirroredView | null;
  progress: ProgressRunner;
  info(message: string): void;
  error(message: string): void;
  log(line: string): void;
}

export type TourOutcome = 'opened' | 'cancelled' | 'unavailable' | 'failed';

export const BROWSER_OFF_SENTENCE = 'The PR tour opens in your browser, and Open in browser is switched off (setting cograph.browserView.enabled).';

export function describeTarget(target: TourTarget): string {
  if (target.kind === 'pr') { return `pull request #${target.number}`; }
  return target.branch ? `${target.branch}${target.baseRef ? ` vs ${target.baseRef}` : ''}` : 'your branch';
}

export class TourRunner {
  /** Servers that already carry the tour's routes and assets (a restarted server is a new one). */
  private readonly prepared = new WeakSet<TourServer>();
  private busy = false;

  constructor(private readonly deps: TourRunnerDeps) {}

  async run(target: TourTarget): Promise<TourOutcome> {
    if (this.busy) { this.deps.info('CoGraph: A tour is being prepared already.'); return 'cancelled'; }
    this.busy = true;
    try {
      return await this.runOnce(target);
    } finally {
      this.busy = false;
    }
  }

  private async runOnce(target: TourTarget): Promise<TourOutcome> {
    const tour = this.deps.loadTour();
    if (!tour) { this.deps.info(`CoGraph: ${STUB_SENTENCE}`); return 'unavailable'; }
    let server: TourServer | null;
    try {
      server = await this.deps.getServer();
    } catch (err) {
      this.deps.error(`CoGraph: The browser view could not start: ${(err as Error).message}`);
      return 'failed';
    }
    if (!server) { this.deps.info(`CoGraph: ${BROWSER_OFF_SENTENCE}`); return 'unavailable'; }
    const prepared = await this.prepare(tour, target);
    if (prepared === 'cancelled' || prepared === 'failed') { return prepared; }
    return this.open(tour, server, prepared, target);
  }

  private async prepare(tour: LoadedTour, target: TourTarget): Promise<TourPrepared | 'cancelled' | 'failed'> {
    let cancelled = false;
    try {
      return await this.deps.progress(`Preparing the tour of ${describeTarget(target)}`, (report, signal) => {
        signal.addEventListener('abort', () => { cancelled = true; });
        return tour.host.prepare(target, report, signal);
      });
    } catch (err) {
      if (cancelled || (err as Error)?.name === 'AbortError' || (err instanceof HeadTreeError && err.kind === 'cancelled')) { this.deps.log('[tour] cancelled'); return 'cancelled'; }
      const message = err instanceof HeadTreeError ? err.message : `The tour could not be prepared: ${(err as Error)?.message ?? String(err)}`;
      this.deps.log(`[tour] prepare failed: ${(err as Error)?.stack ?? String(err)}`);
      this.deps.error(`CoGraph: ${message}`);
      return 'failed';
    }
  }

  private async open(tour: LoadedTour, server: TourServer, prepared: TourPrepared, target: TourTarget): Promise<TourOutcome> {
    try {
      const view = tourGraphView(prepared, target);
      const panel = this.deps.openPanel(view, prepared.headDir, view.name);
      if (!panel) { this.deps.error('CoGraph: The tour needs an open folder: the pull-request panel could not be opened.'); return 'failed'; }
      if (!this.prepared.has(server)) {
        server.mount(tour.host.routes);
        server.serveStatic('/tour-assets', tour.webAssetsDir);
        this.prepared.add(server);
      }
      const viewId = `tour-${prepared.tourId}`;
      server.registerView(viewId, panel);
      server.serveTourPage(prepared.tourId, viewId, { assets: true });
      const { url, opened } = await this.deps.openUrl(server, `/tour/${encodeURIComponent(prepared.tourId)}`);
      this.deps.log(`[tour] ${prepared.tourId} opened in the browser`);
      await this.deps.showOpened('CoGraph: Tour opened in your browser.', url, opened);
      return 'opened';
    } catch (err) {
      this.deps.log(`[tour] open failed: ${(err as Error)?.stack ?? String(err)}`);
      this.deps.error(`CoGraph: The tour could not be opened: ${(err as Error)?.message ?? String(err)}`);
      return 'failed';
    }
  }
}
