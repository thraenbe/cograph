import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
const ANALYZERS = ['analyze_ts.js', 'analyze_js.js', 'analyze_java.js', 'analyze_cpp.js', 'analyze_c.js'];

suite('node analyzers: require() never runs the CLI', () => {
  let tmp: string;

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-entry-'));
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'export function foo() { return bar(); }\nfunction bar() { return 1; }\n');
    fs.writeFileSync(path.join(tmp, 'b.js'), 'function baz() { return 1; }\nmodule.exports = { baz };\n');
  });
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function requireWithArgv(script: string, argv: string[]) {
    const code = `process.argv = ${JSON.stringify([process.execPath, ...argv])};`
      + `require(${JSON.stringify(path.join(SCRIPTS, script))});`;
    return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  }

  for (const script of ANALYZERS) {
    test(`${script}: a workspace path in the host's argv is not analyzed`, () => {
      const res = requireWithArgv(script, ['host', tmp]);
      assert.strictEqual(res.status, 0, res.stderr);
      assert.strictEqual(res.stdout, '');
      assert.strictEqual(res.stderr, '');
    });

    test(`${script}: a short host argv does not exit the process`, () => {
      const res = requireWithArgv(script, []);
      assert.strictEqual(res.status, 0, res.stderr);
      assert.strictEqual(res.stderr, '');
      assert.strictEqual(res.stdout, '');
    });
  }
});
