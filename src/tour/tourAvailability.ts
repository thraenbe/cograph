import type { Exec } from '../vcs/ghCliSource';
import type { PullRequest } from '../vcs/types';

/**
 * Whether the graph's blue "Take the PR tour" pill shows, and what it says
 * (docs/tour-protocol.md section 7). Local git only: the base comes from
 * refs this checkout already has, the open pull request from the list the
 * Version Control pane already loaded. No network call, no vscode import.
 */

export type TourAvailabilityState = 'none' | 'branch' | 'pr' | 'not-bundled' | 'disabled';

export interface TourAvailabilityMessage {
  type: 'tour-availability';
  state: TourAvailabilityState;
  label?: string;
  number?: number;
  branch?: string;
  baseRef?: string;
  counts?: { commits: number; files: number };
}

export interface AvailabilityDeps {
  workspaceRoot(): string | undefined;
  exec: Exec;
  /** The private package is in this build. */
  bundled(): boolean;
  setting<T>(key: string, fallback: T): T;
  /** The pull requests the Version Control pane has loaded (open and closed), possibly none yet. */
  pullRequests(): PullRequest[];
  post(message: TourAvailabilityMessage): void;
  log(line: string): void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function git(deps: AvailabilityDeps, root: string, args: string[]): Promise<string | null> {
  const res = await deps.exec('git', args, root, { timeoutMs: 10_000 });
  return res.code === 0 ? res.stdout.trim() : null;
}

/** The base branch from local refs only: origin/HEAD, else main or master as this checkout knows them. */
export async function localBaseRef(deps: AvailabilityDeps, root: string): Promise<{ name: string; ref: string } | null> {
  const sym = await git(deps, root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const names = sym && sym.startsWith('origin/') ? [sym.slice('origin/'.length)] : ['main', 'master'];
  for (const name of names) {
    for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      if (await git(deps, root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) { return { name, ref }; }
    }
  }
  return null;
}

async function branchState(deps: AvailabilityDeps, root: string, branch: string): Promise<TourAvailabilityMessage> {
  const none: TourAvailabilityMessage = { type: 'tour-availability', state: 'none' };
  const always = deps.setting<string>('tour.button', 'auto') === 'always';
  const muted: TourAvailabilityMessage = { type: 'tour-availability', state: 'branch', branch, label: `nothing to tour yet on ${branch}`, counts: { commits: 0, files: 0 } };
  const base = await localBaseRef(deps, root);
  if (!base) { return always ? muted : none; }
  if (base.name === branch) { return none; }
  const mb = await git(deps, root, ['merge-base', 'HEAD', base.ref]);
  const commits = mb ? Number(await git(deps, root, ['rev-list', '--count', `${mb}..HEAD`])) : NaN;
  if (!Number.isInteger(commits) || commits <= 0) { return always ? { ...muted, baseRef: base.name } : none; }
  const changed = await git(deps, root, ['diff', '--name-only', '-z', mb as string, 'HEAD']);
  const files = changed ? changed.split('\0').filter(Boolean).length : 0;
  return {
    type: 'tour-availability', state: 'branch', branch, baseRef: base.name, counts: { commits, files },
    label: `${branch} vs ${base.name} · ${plural(commits, 'commit')} · ${plural(files, 'file')}`,
  };
}

/** What the pill should show for the workspace right now. */
export async function computeAvailability(deps: AvailabilityDeps): Promise<TourAvailabilityMessage> {
  const none: TourAvailabilityMessage = { type: 'tour-availability', state: 'none' };
  if (!deps.bundled()) { return { type: 'tour-availability', state: 'not-bundled' }; }
  if (!deps.setting<boolean>('browserView.enabled', true)) { return { type: 'tour-availability', state: 'disabled' }; }
  if (deps.setting<string>('tour.button', 'auto') === 'never') { return none; }
  const root = deps.workspaceRoot();
  if (!root) { return none; }
  const branch = await git(deps, root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) { return none; } // detached, or not a repository
  const pr = deps.pullRequests().find(p => p.state === 'open' && p.headRef === branch);
  if (pr) {
    return {
      type: 'tour-availability', state: 'pr', number: pr.number, branch, baseRef: pr.baseRef,
      label: `PR #${pr.number} · ${plural(pr.changedFiles, 'file')}`,
    };
  }
  return branchState(deps, root, branch);
}

/**
 * Keeps the pill current: recomputes on demand (panel open, the git watcher, a new pull-request
 * list), one computation at a time, the last request winning, and posts only what changed.
 */
export class TourAvailability {
  private last: TourAvailabilityMessage = { type: 'tour-availability', state: 'none' };
  private running: Promise<void> | null = null;
  private again = false;
  private lastJson = '';

  constructor(private readonly deps: AvailabilityDeps) {}

  current(): TourAvailabilityMessage { return this.last; }

  /** Recompute and post; resolves when the newest request is answered. Never rejects. */
  refresh(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          this.last = await computeAvailability(this.deps);
        } catch (err) {
          this.deps.log(`[tour] availability could not be computed: ${(err as Error).message}`);
          this.last = { type: 'tour-availability', state: 'none' };
        }
      } while (this.again);
      this.running = null;
      const json = JSON.stringify(this.last);
      if (json !== this.lastJson) { this.lastJson = json; this.deps.post(this.last); }
    })();
    return this.running;
  }
}
