// Extra command-line switches for every test process that opens a window: the VS Code
// test instance (npm test), Tier B (uxtest/vscode) and the perf calibration.
//
// A machine can need switches the repo cannot know about, for example a window manager
// rule that keys on a marker switch, or `--ozone-platform=wayland` inside a headless
// compositor that has no X server. Set them in COGRAPH_TEST_WINDOW_ARGS, separated by
// whitespace:
//
//   COGRAPH_TEST_WINDOW_ARGS='--ozone-platform=wayland --disable-gpu' npm test
//
// Callers put these switches before any positional argument: VS Code parses argv with
// minimist, which reads an unknown `--switch` followed by a bare word as `--switch <word>`.
//
// Only switches are accepted. A bare word would be taken as a folder to open, so it is
// refused instead of silently changing what the test instance loads.
export const WINDOW_ARGS_ENV = 'COGRAPH_TEST_WINDOW_ARGS';

export function extraWindowArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[WINDOW_ARGS_ENV] ?? '';
  const args = raw.split(/\s+/).filter(Boolean);
  const bad = args.filter(a => !a.startsWith('--'));
  if (bad.length) {
    throw new Error(`${WINDOW_ARGS_ENV} takes switches only (each starting with --), got: ${bad.join(' ')}`);
  }
  return args;
}
