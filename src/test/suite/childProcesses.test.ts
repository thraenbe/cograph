import * as assert from 'assert';
import * as os from 'os';
import { killRunningChildren, runningChildCount } from '../../childProcesses';
import { defaultExec } from '../../vcs/ghCliSource';

// ELECTRON_RUN_AS_NODE: inside the VS Code test host process.execPath is VS Code itself, which must never open a window.
const NODE_ENV = { ELECTRON_RUN_AS_NODE: '1' };
const sleeper = () => defaultExec(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], os.tmpdir(), { env: NODE_ENV, timeoutMs: 60000 });

suite('child processes are ended on deactivate (childProcesses)', () => {
  teardown(() => { killRunningChildren('SIGKILL'); });

  test('a running defaultExec child is registered and killRunningChildren ends it', async () => {
    const before = runningChildCount();
    const pending = sleeper();
    assert.strictEqual(runningChildCount(), before + 1, 'defaultExec registers its child');
    const t0 = Date.now();
    assert.strictEqual(killRunningChildren(), before + 1);
    const res = await pending;
    assert.strictEqual(res.code, null, 'killed, not exited on its own');
    assert.ok(Date.now() - t0 < 5000, `ended at once (took ${Date.now() - t0} ms)`);
    assert.strictEqual(runningChildCount(), 0);
  });

  test('a child that exited is forgotten and never signalled', async () => {
    const res = await defaultExec(process.execPath, ['-e', ''], os.tmpdir(), { env: NODE_ENV });
    assert.strictEqual(res.code, 0);
    assert.strictEqual(runningChildCount(), 0);
    assert.strictEqual(killRunningChildren(), 0);
  });
});
