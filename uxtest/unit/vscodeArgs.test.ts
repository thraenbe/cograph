import { test, expect } from '@playwright/test';
import { vscodeLaunchArgs } from '../vscode/launch';

const base = { extRoot: '/ext', userDataDir: '/tmp/ud', extensionsDir: '/tmp/ext', size: { width: 1440, height: 900 }, workspace: '/tmp/ws/click' };

test.describe('Tier B launch argv (COGRAPH_TEST_WINDOW_ARGS)', () => {
  test('machine switches come first and never sit right before the workspace path', () => {
    // VS Code's argv parser reads an unknown `--switch` followed by a bare word as `--switch <word>`: the folder would vanish.
    const extra = ['--some-unknown-marker', '--disable-renderer-backgrounding'];
    const args = vscodeLaunchArgs(base, { COGRAPH_TEST_WINDOW_ARGS: extra.join(' ') });
    expect(args.slice(0, extra.length)).toEqual(extra);
    expect(args[args.length - 1]).toBe(base.workspace);
    expect(extra).not.toContain(args[args.length - 2]);
    expect(args[args.length - 2].startsWith('--window-size=')).toBe(true);
  });

  test('without the variable the argv is unchanged and ends with the workspace', () => {
    const args = vscodeLaunchArgs(base, {});
    expect(args[0]).toBe('--extensionDevelopmentPath=/ext');
    expect(args[args.length - 1]).toBe(base.workspace);
  });
});
