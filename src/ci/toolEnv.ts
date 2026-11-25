import * as fs from 'fs';
import * as path from 'path';
import { defaultExec } from '../vcs/ghCliSource';
import type { Exec } from '../vcs/ghCliSource';

/**
 * What the tools of a headless run may see, and which git they get. No vscode import.
 *
 * An allowlist, on top of what the parent `ci` already strips from its `build` child: git and
 * the analyzers read a pull request's files, so a token in their environment is one bug away
 * from a bundle whose reader is that pull request's author. This is no boundary against code
 * running as this uid, which can read `.git/config` all the same.
 */

const KEPT = ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR', 'PATHEXT'];

/**
 * `env[key]`, by any case of the name on Windows. process.env finds `Path` as `PATH` there, but a copy
 * of it (`{ ...process.env }`) is a plain object that keeps the variable's own case, and the
 * GitHub Windows runner names it `Path`.
 */
export function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env[key] !== undefined || platform !== 'win32') { return env[key]; }
  const name = Object.keys(env).find(k => k.toUpperCase() === key.toUpperCase());
  return name === undefined ? undefined : env[name];
}

export function toolEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_NO_LAZY_FETCH: '1',   // `build` makes no network call: what `fetch` did not bring fails the copy (git 2.45 and up)
    GIT_TERMINAL_PROMPT: '0', // a job has nobody to ask
    COGRAPH_PYTHON_MEMORY_MB: '2800', // a bound the parent's output cap cannot give: the memory is in the analyzer, not the pipe
  };
  for (const key of KEPT) {
    const value = envValue(from, key);
    if (value !== undefined) { env[key] = value; }
  }
  return env;
}

/**
 * The `git` on PATH as an absolute path, or null. A bare name would not do: on Windows the search
 * starts in the child's cwd, which is the checkout, and a relative PATH entry does the same anywhere.
 */
export function resolveGit(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const dir of (envValue(env, 'PATH') ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) { continue; }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) { return candidate; }
    } catch { /* next directory */ }
  }
  return null;
}

/** An Exec that runs that git in `baseEnv` and nothing else: a headless run has no other tool to call. */
export function gitExec(baseEnv: NodeJS.ProcessEnv): Exec {
  const git = resolveGit(baseEnv);
  return async (command, args, cwd, opts = {}) => {
    if (command !== 'git') { return { code: null, stdout: '', stderr: `${command} is not available in CI`, notFound: false }; }
    if (!git) { return { code: null, stdout: '', stderr: 'git is not on PATH', notFound: true }; }
    return defaultExec(git, args, cwd, { ...opts, baseEnv });
  };
}
