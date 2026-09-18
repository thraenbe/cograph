import * as cp from 'child_process';
import { MAX_OUTPUT_BYTES } from '../analyzerRunner';

export interface CliStreamOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Human name used in error messages, e.g. "Claude Code" or "Codex". */
  label: string;
  timeoutMs: number;
  /** Extra environment variables for the child, on top of the extension host's. */
  env?: Record<string, string>;
  /** Written to the child's stdin, which is then closed. Omit to leave stdin ignored. */
  stdin?: string;
  signal?: AbortSignal;
  onStdout: (text: string) => void;
  onStderr?: (text: string) => void;
  /** Called once after a clean exit, before the promise resolves (parser flush). */
  onEnd?: () => void;
}

const KILL_GRACE_MS = 1000;

/**
 * Spawn a provider CLI and stream its stdout, with the guards every Graph
 * Intelligence call needs: wall-clock timeout, output size cap, and
 * cancellation (SIGTERM, then SIGKILL after a short grace period).
 * Rejects with a user-facing message; never resolves after a kill.
 */
export function runCliStream(opts: CliStreamOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = cp.spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    let totalBytes = 0;
    let killed = false;

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      reject(new Error(`${opts.label} timed out after ${Math.round(opts.timeoutMs / 1000)}s.`));
    }, opts.timeoutMs);

    const onAbort = () => {
      killed = true;
      try { proc.kill('SIGTERM'); } catch { /* already exited */ }
      // Escalate if the process is still alive after a brief grace period.
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* gone */ }
      }, KILL_GRACE_MS);
      reject(new Error('Request cancelled.'));
    };
    if (opts.signal?.aborted) { onAbort(); }
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdout?.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        killed = true;
        proc.kill('SIGTERM');
        reject(new Error(`${opts.label} response exceeded maximum output size.`));
        return;
      }
      opts.onStdout(chunk.toString());
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      opts.onStderr?.(chunk.toString());
    });

    proc.on('error', (err) => {
      cleanup();
      reject(new Error(`Failed to start ${opts.label}: ${err.message}`));
    });

    proc.on('close', (code) => {
      cleanup();
      if (killed) { return; }
      opts.onEnd?.();
      if (code !== 0 && code !== null) {
        reject(new Error(`${opts.label} exited with code ${code}.`));
        return;
      }
      resolve();
    });

    if (opts.stdin !== undefined && proc.stdin) {
      // A child that exits early closes the pipe; the close/error handlers report that.
      proc.stdin.on('error', () => { /* EPIPE — surfaced via close */ });
      proc.stdin.end(opts.stdin);
    }
  });
}

/** Throw a user-facing error when `command` is not on PATH. */
export function ensureCliBinary(command: string, notFoundMessage: string): void {
  const result = cp.spawnSync(command, ['--version'], { stdio: 'ignore' });
  if (result.error) { throw new Error(notFoundMessage); }
}
