import type { PrController } from './prController';
import type { PrDiffDetail, PrTree } from './prController';
import type { PrViewCounts, PrViewFile } from './prView';
import type { PrProblem, PrProblemKind, PrStateFilter, PullRequest } from './types';

const PAGE = 50;
const MAX_LIMIT = 1000;
/** Files listed under the open pull request; the counts always cover all of them. */
const MAX_DETAIL_FILES = 300;

export interface VcsDetail {
  number: number;
  tree: PrTree;
  diff?: PrDiffDetail;
  counts: PrViewCounts;
  files: PrViewFile[];
  /** More files exist than `files` lists. */
  filesCut: boolean;
}

/** Host → sidebar: everything the Version Control pane renders. */
export interface VcsStateMessage {
  type: 'vcs-state';
  loading: boolean;
  filter: PrStateFilter;
  problem: PrProblem | null;
  /** Label of the problem's one-click fix; null when there is only Retry. */
  fixLabel: string | null;
  pullRequests: PullRequest[];
  /** More pull requests exist than were loaded. */
  truncated: boolean;
  /** ISO time of the last successful load; null before the first one. */
  fetchedAt: string | null;
  /** Pull request shown in the graph. */
  active: number | null;
  /** Pull request whose files are being fetched. */
  opening: number | null;
  detail: VcsDetail | null;
  /** Why the last clicked pull request could not be opened. */
  openProblem: { number: number; problem: PrProblem } | null;
}

export interface VcsSidebarDeps {
  openExternal: (url: string) => void;
  /** Open a terminal with `command` typed but not run. */
  openTerminal: (command: string) => void;
  now?: () => Date;
}

/** The "fix it" button of a problem row; kinds without an entry only offer Retry. */
const FIXES: Partial<Record<PrProblemKind, { label: string; run: (deps: VcsSidebarDeps) => void }>> = {
  'gh-missing': { label: 'Get the GitHub CLI', run: (deps) => deps.openExternal('https://cli.github.com/') },
  'gh-unauthenticated': { label: 'Sign in…', run: (deps) => deps.openTerminal('gh auth login') },
};

/**
 * Host side of the sidebar's Version Control pane: keeps the loaded list, answers
 * the pane's `vcs-*` messages and pushes one `vcs-state` snapshot after every
 * change. No vscode import — the two side effects it needs are injected.
 */
export class VcsSidebar {
  private post: ((message: VcsStateMessage) => void) | null = null;
  private loading = false;
  private loaded = false;
  private filter: PrStateFilter = 'open';
  private limit = PAGE;
  private problem: PrProblem | null = null;
  private pullRequests: PullRequest[] = [];
  private truncated = false;
  private fetchedAt: string | null = null;
  private opening: number | null = null;
  private detail: VcsDetail | null = null;
  private openProblem: { number: number; problem: PrProblem } | null = null;
  private loadSeq = 0;

  constructor(private readonly controller: PrController, private readonly deps: VcsSidebarDeps) {
    controller.onActiveChange((active) => {
      // The graph left the pull request on its own (Exit in the panel, a saved graph, the panel closed).
      if (active === null || active !== this.detail?.number) { this.detail = null; }
      this.push();
    });
  }

  /** Connect the pane's webview; `null` when the view is disposed. */
  attach(post: ((message: VcsStateMessage) => void) | null): void {
    this.post = post;
  }

  /** Handle a sidebar message. Returns false for messages that are not this pane's. */
  async handle(msg: { type?: unknown; [key: string]: unknown }): Promise<boolean> {
    const type = typeof msg?.type === 'string' ? msg.type : '';
    if (!type.startsWith('vcs-')) { return false; }
    switch (type) {
      case 'vcs-ready':
        if (this.loaded || this.loading) { this.push(); } else { await this.load(); }
        break;
      case 'vcs-refresh':
        await this.load();
        break;
      case 'vcs-filter':
        this.filter = msg.state === 'all' ? 'all' : 'open';
        this.limit = PAGE;
        await this.load();
        break;
      case 'vcs-more':
        this.limit = Math.min(MAX_LIMIT, this.limit + PAGE);
        await this.load();
        break;
      case 'vcs-open':
        await this.open(Number(msg.number), msg.tree === 'checkout' ? 'checkout' : undefined);
        break;
      case 'vcs-exit':
        this.controller.exit();
        break;
      case 'vcs-browse': {
        // The URL comes from the loaded list, never from the webview.
        const url = this.find(Number(msg.number))?.url ?? '';
        if (/^https:\/\//i.test(url)) { this.deps.openExternal(url); }
        break;
      }
      case 'vcs-fix':
        if (this.problem) { FIXES[this.problem.kind]?.run(this.deps); }
        break;
    }
    return true;
  }

  private find(prNumber: number): PullRequest | undefined {
    return this.pullRequests.find(p => p.number === prNumber);
  }

  private async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.loading = true;
    this.push();
    const result = await this.controller.list({ state: this.filter, limit: this.limit });
    if (seq !== this.loadSeq) { return; } // a newer load owns the pane
    this.loading = false;
    this.loaded = true;
    if (result.ok) {
      this.problem = null;
      this.pullRequests = result.pullRequests;
      this.truncated = result.truncated;
      this.fetchedAt = (this.deps.now?.() ?? new Date()).toISOString();
    } else {
      this.problem = result.problem;
      this.pullRequests = [];
      this.truncated = false;
    }
    this.push();
  }

  private async open(prNumber: number, tree?: 'checkout'): Promise<void> {
    const pr = this.find(prNumber);
    if (!pr || this.opening !== null) { return; }
    this.opening = pr.number;
    this.openProblem = null;
    this.push();
    const result = await this.controller.open(pr, tree);
    this.opening = null;
    if (result.ok) {
      const { counts, files, truncated } = result.opened;
      this.detail = {
        number: pr.number, tree: result.opened.tree, counts,
        ...(result.opened.diff ? { diff: result.opened.diff } : {}),
        files: files.slice(0, MAX_DETAIL_FILES),
        filesCut: truncated || files.length > MAX_DETAIL_FILES,
      };
    } else {
      this.openProblem = { number: pr.number, problem: result.problem };
    }
    this.push();
  }

  /** The snapshot the pane renders. */
  state(): VcsStateMessage {
    return {
      type: 'vcs-state',
      loading: this.loading,
      filter: this.filter,
      problem: this.problem,
      fixLabel: this.problem ? FIXES[this.problem.kind]?.label ?? null : null,
      pullRequests: this.pullRequests,
      truncated: this.truncated,
      fetchedAt: this.fetchedAt,
      active: this.controller.activePullRequest(),
      opening: this.opening,
      detail: this.detail,
      openProblem: this.openProblem,
    };
  }

  private push(): void {
    this.post?.(this.state());
  }
}
