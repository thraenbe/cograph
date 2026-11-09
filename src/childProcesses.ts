import type { ChildProcess } from 'child_process';

// Every asynchronous child process the extension starts (git and gh through
// defaultExec, the analyzers, the library describer) is registered here
// until it exits. The extension host does not take its children down when it
// shuts down: a `gh pr list` started by the Version Control view kept running
// after VS Code had closed. deactivate() ends whatever is still running.

const running = new Set<ChildProcess>();

/** Register a child until it exits; returns it for chaining. */
export function trackChild<T extends ChildProcess>(child: T): T {
  if (child.exitCode !== null || child.signalCode !== null) { return child; }
  running.add(child);
  const forget = () => { running.delete(child); };
  child.once('exit', forget);
  child.once('error', forget);
  return child;
}

/** Children registered and not yet exited. */
export function runningChildCount(): number {
  return running.size;
}

/**
 * Send `signal` to every registered child that is still running and forget
 * them; returns how many were signalled. A child that already exited is never
 * signalled, so a recycled pid is never hit.
 */
export function killRunningChildren(signal: NodeJS.Signals = 'SIGTERM'): number {
  let n = 0;
  for (const child of running) {
    if (child.exitCode === null && child.signalCode === null) {
      try { if (child.kill(signal)) { n++; } } catch { /* already gone */ }
    }
  }
  running.clear();
  return n;
}
