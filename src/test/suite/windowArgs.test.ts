import * as assert from 'assert';
import { extraWindowArgs, WINDOW_ARGS_ENV } from '../windowArgs';

suite('extraWindowArgs (COGRAPH_TEST_WINDOW_ARGS)', () => {
  test('unset or blank adds nothing', () => {
    assert.deepStrictEqual(extraWindowArgs({}), []);
    assert.deepStrictEqual(extraWindowArgs({ [WINDOW_ARGS_ENV]: '  \n ' }), []);
  });

  test('splits switches on any whitespace and keeps their order', () => {
    const env = { [WINDOW_ARGS_ENV]: ' --marker  --ozone-platform=wayland\t--disable-gpu\n' };
    assert.deepStrictEqual(extraWindowArgs(env), ['--marker', '--ozone-platform=wayland', '--disable-gpu']);
  });

  test('refuses a bare word, which VS Code would open as a folder', () => {
    const env = { [WINDOW_ARGS_ENV]: '--disable-gpu /tmp/other-workspace' };
    assert.throws(() => extraWindowArgs(env), /switches only.*\/tmp\/other-workspace/);
  });
});
