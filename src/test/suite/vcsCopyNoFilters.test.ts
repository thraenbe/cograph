import * as assert from 'assert';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { defaultExec } from '../../vcs/ghCliSource';
import type { Exec } from '../../vcs/ghCliSource';
import { BlobWriter } from '../../vcs/engine/blobWriter';
import { HeadTreeError, listTrees, materializeCommit, treeDir } from '../../vcs/engine/headTree';
import type { HeadTreeDeps } from '../../vcs/engine/headTree';
import { DECLARED_TRACKED } from '../../projectScope';
import { relPath } from '../../vcs/engine/treeAnalysis';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
const GIT_ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };

function sh(cwd: string, args: string[], input?: string | Buffer): string {
  return cp.execFileSync('git', args, { cwd, input, encoding: 'utf8', env: { ...process.env, ...GIT_ID, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

/** A commit built in git alone, as a fetched pull request is: nothing of it is in any working tree. */
function commitOf(repo: string, entries: Record<string, string | Buffer>): string {
  for (const [rel, content] of Object.entries(entries)) {
    sh(repo, ['update-index', '--add', '--cacheinfo', `100644,${sh(repo, ['hash-object', '-w', '--stdin'], content)},${rel}`]);
  }
  sh(repo, ['commit', '--quiet', '-m', 'entries']);
  return sh(repo, ['rev-parse', 'HEAD']);
}

/** A tree object written as given: git's own commands refuse these names, a fetched commit need not have asked them. */
function rawTree(repo: string, entries: Array<[mode: string, name: string, oid: string]>): string {
  const body = entries.map(([mode, name, oid]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]));
  return sh(repo, ['hash-object', '-w', '-t', 'tree', '--stdin', '--literally'], Buffer.concat(body));
}

function commitOfTree(repo: string, tree: string): string {
  return sh(repo, ['commit-tree', tree, '-m', 'raw']);
}

/** Every file under `dir`, at any depth. */
function allFiles(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
}

/** Files this process holds open whose path contains `part`; empty where only Linux can tell. */
function openFilesUnder(part: string): string[] {
  if (!fs.existsSync('/proc/self/fd')) { return []; }
  const open = fs.readdirSync('/proc/self/fd').map((fd) => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return ''; } });
  return open.filter(target => target.includes(part));
}

/** A repository in its own temp folder, for one test. */
function useRepo(prefix: string) {
  const at = { root: '', repo: '', deps: {} as HeadTreeDeps };
  suiteSetup(function () { try { sh(os.tmpdir(), ['--version']); } catch { this.skip(); } });
  setup(() => {
    at.root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    at.repo = path.join(at.root, 'repo');
    fs.mkdirSync(at.repo);
    sh(at.repo, ['init', '--quiet', '-b', 'main']);
    at.deps = { repoRoot: at.repo, storageDir: path.join(at.root, 'storage'), exec: defaultExec };
  });
  teardown(() => fs.rmSync(at.root, { recursive: true, force: true }));
  return at;
}

/** Every function each analyzer finds under `dir`, as `path::name::line`. */
function functionsIn(dir: string): string[] {
  const runs: Array<[string, string]> = [
    [process.execPath, 'analyze_ts.js'], [process.execPath, 'analyze_js.js'], [process.execPath, 'analyze_java.js'],
    [process.execPath, 'analyze_cpp.js'], [process.execPath, 'analyze_c.js'], ['python3', 'analyze.py'],
  ];
  const found: string[] = [];
  for (const [bin, script] of runs) {
    let out: string;
    try { out = cp.execFileSync(bin, [path.join(SCRIPTS, script), dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { continue; }
    const graph = JSON.parse(out) as { nodes: any[] };
    found.push(...graph.nodes.filter(n => n.file).map(n => `${relPath(dir, n.file)}::${n.name}::${n.line}`));
  }
  return found.sort();
}

suite('vcs engine — a copy holds the commit\'s bytes, whatever its attributes say', () => {
  const at = useRepo('cograph-attrs-');

  /** A git-lfs server: answers the batch API and serves `payload` as every object. */
  async function lfsServer(payload: string): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        requests.push(`${req.method} ${req.url}`);
        if (req.url?.endsWith('/objects/batch')) {
          const { objects } = JSON.parse(body) as { objects: Array<{ oid: string; size: number }> };
          res.writeHead(200, { 'content-type': 'application/vnd.git-lfs+json' });
          const href = (oid: string) => `http://127.0.0.1:${(server.address() as { port: number }).port}/blob/${oid}`;
          res.end(JSON.stringify({ transfer: 'basic', objects: objects.map(o => ({ ...o, authenticated: true, actions: { download: { href: href(o.oid) } } })) }));
          return;
        }
        res.writeHead(200);
        res.end(payload);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/x.git/info/lfs`, requests, close: () => new Promise(resolve => server.close(() => resolve())) };
  }

  test('REGRESSION: a commit cannot make git-lfs call a server of its choice and write that server\'s bytes', async function () {
    this.timeout(60_000);
    try { cp.execFileSync('git-lfs', ['version'], { stdio: 'ignore' }); } catch { this.skip(); }
    // What `git lfs install` leaves behind, here in the repository so the test needs no global config.
    sh(at.repo, ['config', 'filter.lfs.process', 'git-lfs filter-process']);
    sh(at.repo, ['config', 'filter.lfs.smudge', 'git-lfs smudge -- %f']);
    sh(at.repo, ['config', 'filter.lfs.required', 'true']);
    const injected = 'def injected_by_the_server():\n    pass\n';
    const server = await lfsServer(injected);
    try {
      // git-lfs checks the bytes against the pointer, so the pointer is made from them.
      const oid = crypto.createHash('sha256').update(injected).digest('hex');
      const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${injected.length}\n`;
      const tree = await materializeCommit(at.deps, commitOf(at.repo, {
        '.gitattributes': 'src/evil.py filter=lfs diff=lfs merge=lfs -text\n',
        '.lfsconfig': `[lfs]\n\turl = ${server.url}\n`,
        'src/evil.py': pointer,
      }));
      assert.deepStrictEqual(server.requests, [], 'the copy called nobody');
      assert.strictEqual(fs.readFileSync(path.join(tree.dir, 'src', 'evil.py'), 'utf8'), pointer, 'the commit\'s bytes, not the server\'s');
    } finally { await server.close(); }
  });

  test('a filter of the user\'s git config that a commit selects does not run', async () => {
    sh(at.repo, ['config', 'filter.canary.smudge', 'echo smudged']);
    const text = 'def a():\n    pass\n';
    const tree = await materializeCommit(at.deps, commitOf(at.repo, { '.gitattributes': '*.py filter=canary\n', 'a.py': text }));
    assert.strictEqual(fs.readFileSync(path.join(tree.dir, 'a.py'), 'utf8'), text);
  });

  test('no conversion applies: line endings, ident, encodings, export rules, autocrlf', async () => {
    sh(at.repo, ['config', 'core.autocrlf', 'true']);
    const lf = 'def a():\n    pass  # $Id$\n';
    const latin = Buffer.from([0x23, 0x20, 0xe9, 0x0a]); // not UTF-8: a checkout keeps it, so must the copy
    const tree = await materializeCommit(at.deps, commitOf(at.repo, {
      '.gitattributes': 'eol.py text eol=crlf ident\nwide.py working-tree-encoding=UTF-16LE\nsubst.py export-subst\ngone.py export-ignore\n',
      'eol.py': lf, 'wide.py': lf, 'subst.py': '# $Format:%H$\n', 'gone.py': lf, 'auto.py': lf, 'latin.py': latin,
    }));
    const bytes = (rel: string) => fs.readFileSync(path.join(tree.dir, rel));
    for (const rel of ['eol.py', 'wide.py', 'gone.py', 'auto.py']) { assert.deepStrictEqual(bytes(rel), Buffer.from(lf), rel); }
    assert.deepStrictEqual(bytes('subst.py'), Buffer.from('# $Format:%H$\n'));
    assert.deepStrictEqual(bytes('latin.py'), latin);
  });

  test('REGRESSION: every function sits on the line a CRLF checkout has it on, in every language', async function () {
    this.timeout(60_000);
    const sources: Record<string, string> = {
      'a.py': '# one\n\ndef first():\n    pass\n\n\ndef second():\n    first()\n',
      'b.ts': '// one\n\nexport function first() {}\n\n/* two\n   lines */\nexport function second() { first(); }\n',
      'c.js': '// one\n\nfunction first() {}\n\nfunction second() { first(); }\n',
      'D.java': '// one\n\npublic class D {\n  void first() {}\n\n  void second() { first(); }\n}\n',
      'e.cpp': '// one\n\nint first() { return 1; }\n\nint second() { return first(); }\n',
      'f.c': '/* one */\n\nint third(void) { return 1; }\n\nint fourth(void) { return third(); }\n',
      'g.vue': '<template>\n  <div/>\n</template>\n\n<script>\nfunction first() {}\nexport default { first };\n</script>\n',
      'crlf.py': '# committed with CRLF\r\n\r\ndef fifth():\r\n    pass\r\n',
    };
    const sha = commitOf(at.repo, sources);
    const tree = await materializeCommit(at.deps, sha);
    const checkout = path.join(at.root, 'checkout');
    sh(at.root, ['clone', '--quiet', '-c', 'core.autocrlf=true', at.repo, checkout]);
    assert.ok(fs.readFileSync(path.join(checkout, 'a.py'), 'utf8').includes('\r\n'), 'the checkout really is CRLF');
    assert.ok(!fs.readFileSync(path.join(tree.dir, 'a.py'), 'utf8').includes('\r'), 'and the copy really is not');
    const fromCopy = functionsIn(tree.dir);
    assert.ok(fromCopy.length >= 10, `enough functions to mean something: ${fromCopy.join(', ')}`);
    assert.deepStrictEqual(fromCopy, functionsIn(checkout));
  });

  test('an executable file is copied, without its execute bit', async function () {
    if (process.platform === 'win32') { this.skip(); } // no execute bit there
    const oid = sh(at.repo, ['hash-object', '-w', '--stdin'], 'print(1)\n');
    sh(at.repo, ['update-index', '--add', '--cacheinfo', `100755,${oid},run.py`]);
    sh(at.repo, ['commit', '--quiet', '-m', 'x']);
    const tree = await materializeCommit(at.deps, sh(at.repo, ['rev-parse', 'HEAD']));
    assert.strictEqual(fs.statSync(path.join(tree.dir, 'run.py')).mode & 0o111, 0);
  });

  test('a copy of the previous format is made again: it may hold what a filter wrote', async () => {
    const sha = commitOf(at.repo, { 'a.py': 'def a():\n    pass\n' });
    const first = await materializeCommit(at.deps, sha);
    assert.strictEqual((await materializeCommit(at.deps, sha)).reused, true, 'today\'s format is reused');
    const file = path.join(first.dir, '.cograph-tree.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), format: 2 }));
    assert.strictEqual((await materializeCommit(at.deps, sha)).reused, false);
  });
});

suite('vcs engine — a hostile tree cannot steer the copy', () => {
  const at = useRepo('cograph-hostile-');
  const TEXT = 'def x():\n    pass\n';
  const blob = () => sh(at.repo, ['hash-object', '-w', '--stdin'], TEXT);
  const refused = (e: HeadTreeError) => e instanceof HeadTreeError && e.kind === 'fetch-failed';

  async function assertRefused(sha: string) {
    await assert.rejects(materializeCommit(at.deps, sha), refused);
    assert.ok(!fs.existsSync(treeDir(at.deps, sha)), 'no copy is left');
    assert.deepStrictEqual(listTrees(at.deps.storageDir), []);
  }

  for (const dir of ['..', '.', '.git', '.GIT', 'git~1']) {
    test(`a folder named ${dir} in a tree is refused, as a checkout refuses it`, async () => {
      const inner = rawTree(at.repo, [['100644', 'evil.py', blob()]]);
      await assertRefused(commitOfTree(at.repo, rawTree(at.repo, [['40000', dir, inner], ['100644', 'ok.py', blob()]])));
      assert.deepStrictEqual(allFiles(at.root).filter(n => n === 'evil.py'), [], 'evil.py landed nowhere');
    });
  }

  for (const name of ['a/../../evil.py', '/evil.py']) {
    test(`a tree entry named ${name} is refused`, async () => {
      await assertRefused(commitOfTree(at.repo, rawTree(at.repo, [['100644', name, blob()], ['100644', 'ok.py', blob()]])));
      assert.deepStrictEqual(allFiles(at.root).filter(n => n === 'evil.py'), [], 'evil.py landed nowhere');
    });
  }

  test('one name as a file and as a folder fails the copy by name, in either order', async () => {
    const inner = rawTree(at.repo, [['100644', 'y.py', blob()]]);
    await assertRefused(commitOfTree(at.repo, rawTree(at.repo, [['100644', 'x.py', blob()], ['40000', 'x.py', inner]])));
    await assertRefused(commitOfTree(at.repo, rawTree(at.repo, [['40000', 'x.py', inner], ['100644', 'x.py', blob()]])));
  });

  test('a duplicate entry keeps the later blob, as a checkout does', async () => {
    const other = sh(at.repo, ['hash-object', '-w', '--stdin'], 'def other():\n    pass\n');
    const tree = await materializeCommit(at.deps, commitOfTree(at.repo, rawTree(at.repo, [['100644', 'dup.py', blob()], ['100644', 'dup.py', other]])));
    assert.strictEqual(fs.readFileSync(path.join(tree.dir, 'dup.py'), 'utf8'), 'def other():\n    pass\n');
  });

  test('a file entry that points at a tree, and one whose blob is gone, are refused', async () => {
    const inner = rawTree(at.repo, [['100644', 'y.py', blob()]]);
    await assertRefused(commitOfTree(at.repo, rawTree(at.repo, [['100644', 'x.py', inner]])));
    await assertRefused(commitOfTree(at.repo, rawTree(at.repo, [['100644', 'x.py', 'a'.repeat(40)]])));
  });

  test('a cancel in the middle of a blob leaves nothing behind', async () => {
    const sha = commitOf(at.repo, { 'big.py': `${'#'.repeat(4 * 1024 * 1024)}\n`, 'z.py': TEXT });
    const ac = new AbortController();
    const exec: Exec = (cmd, args, cwd, opts) => defaultExec(cmd, args, cwd, args[0] === 'cat-file'
      ? { ...opts, onStdout: (chunk) => { opts?.onStdout?.(chunk); ac.abort(); } }
      : opts);
    await assert.rejects(materializeCommit({ ...at.deps, exec, signal: ac.signal }, sha), (e: HeadTreeError) => e.kind === 'cancelled');
    assert.ok(!fs.existsSync(treeDir(at.deps, sha)));
    assert.deepStrictEqual(openFilesUnder(sha), [], 'an open file would keep the folder from going on Windows');
  });

  test('the copy keeps its five minutes: large repositories need them', async () => {
    let timeoutMs: number | undefined;
    const exec: Exec = (cmd, args, cwd, opts) => {
      if (args[0] === 'cat-file') { timeoutMs = opts?.timeoutMs; }
      return defaultExec(cmd, args, cwd, opts);
    };
    await materializeCommit({ ...at.deps, exec }, commitOf(at.repo, { 'a.py': TEXT }));
    assert.strictEqual(timeoutMs, 300_000);
  });

  test('a stream that stops early is a failure, not a smaller copy', async () => {
    const sha = commitOf(at.repo, { 'a.py': TEXT, 'b.py': TEXT });
    const exec: Exec = async (cmd, args, cwd, opts) => args[0] === 'cat-file'
      ? { code: 0, stdout: '', stderr: '', notFound: false }
      : defaultExec(cmd, args, cwd, opts);
    await assert.rejects(materializeCommit({ ...at.deps, exec }, sha), (e: HeadTreeError) => refused(e) && e.detail === 'git stopped before the last file');
    assert.ok(!fs.existsSync(treeDir(at.deps, sha)));
  });
});

suite('vcs engine — BlobWriter', () => {
  let dir: string;
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-blobs-')); });
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const OID_A = 'a'.repeat(40);
  const OID_B = 'b'.repeat(40);
  const OID_C = 'c'.repeat(40);
  const answer = (oid: string, bytes: Buffer) => Buffer.concat([Buffer.from(`${oid} blob ${bytes.length}\n`), bytes, Buffer.from('\n')]);
  const files = [{ oid: OID_A, file: 'src/a.py' }, { oid: OID_B, file: 'src/empty.py' }, { oid: OID_C, file: 'deep/er/c.py' }];
  const bodies = [Buffer.from('line\n\nend\n'), Buffer.alloc(0), Buffer.from([0x00, 0x0a, 0xff, 0x0a, 0x0d])];
  const stream = Buffer.concat(files.map((f, i) => answer(f.oid, bodies[i])));

  function assertWritten(at: string) {
    assert.deepStrictEqual(fs.readFileSync(path.join(at, 'src/a.py')), bodies[0]);
    assert.deepStrictEqual(fs.readFileSync(path.join(at, 'src/empty.py')), bodies[1]);
    assert.deepStrictEqual(fs.readFileSync(path.join(at, 'deep/er/c.py')), bodies[2]);
  }

  test('a chunk may end anywhere: split at every byte of the stream', () => {
    for (let cut = 0; cut <= stream.length; cut++) {
      const at = path.join(dir, String(cut));
      const writer = new BlobWriter(at, files);
      writer.push(stream.subarray(0, cut));
      writer.push(stream.subarray(cut));
      assert.ok(writer.complete, `complete at cut ${cut}`);
      assertWritten(at);
    }
  });

  test('one byte at a time', () => {
    const writer = new BlobWriter(dir, files);
    for (let i = 0; i < stream.length; i++) { writer.push(stream.subarray(i, i + 1)); }
    assert.ok(writer.complete);
    assertWritten(dir);
  });

  test('each file is closed when its answer ends: a large commit must not run out of handles', () => {
    const writer = new BlobWriter(dir, files);
    writer.push(stream);
    assert.deepStrictEqual(openFilesUnder(dir), []);
  });

  test('it is complete only once the last answer has closed', () => {
    const writer = new BlobWriter(dir, files);
    writer.push(stream.subarray(0, stream.length - 1));
    assert.strictEqual(writer.complete, false, 'the closing newline of the last answer is missing');
    writer.close();
  });

  test('an answer for another object, or of another type, or a surplus one, throws', () => {
    const push = (text: string, list = files) => () => new BlobWriter(dir, list).push(Buffer.from(text));
    assert.throws(push(`${OID_B} blob 1\nx\n`), /git answered/, 'another object');
    assert.throws(push(`${OID_A} tree 1\nx\n`), /git answered/, 'a tree');
    assert.throws(push(`${OID_A} missing\n`), /git answered/, 'missing');
    assert.throws(push(`${OID_A} blob 1\nx\n`, []), /git answered .* for nothing/, 'nobody asked');
  });

  test('a path that would land outside the copy throws, and writes nothing', () => {
    const inside = path.join(dir, 'copy');
    const out = path.join(dir, 'out.py');
    for (const file of ['../out.py', 'a/../../out.py', out]) {
      assert.throws(() => new BlobWriter(inside, [{ oid: OID_A, file }]).push(answer(OID_A, Buffer.from('x'))), /outside the copy/, file);
    }
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });

  test('a sibling whose name starts like the copy is outside it too', () => {
    const inside = path.join(dir, 'copy');
    assert.throws(() => new BlobWriter(inside, [{ oid: OID_A, file: '../copy-2/x.py' }]).push(answer(OID_A, Buffer.from('x'))), /outside the copy/);
  });

  test('close releases a file in progress, so the folder can go', () => {
    const writer = new BlobWriter(dir, files);
    writer.push(stream.subarray(0, 60));
    writer.close();
    writer.close();
    fs.rmSync(path.join(dir, 'src'), { recursive: true });
  });
});

suite('defaultExec with onStdout', () => {
  const NODE = process.execPath;
  const run = (code: string, opts: Parameters<Exec>[3] = {}) => {
    const chunks: Buffer[] = [];
    const result = defaultExec(NODE, ['-e', code], os.tmpdir(), { onStdout: c => { chunks.push(c); }, ...opts });
    return { chunks, result };
  };

  test('bytes arrive as they are, and stdout stays empty', async () => {
    const { chunks, result } = run('process.stdout.write(Buffer.from([0xff, 0x00, 0x0a, 0xe9]))');
    const res = await result;
    assert.deepStrictEqual(Buffer.concat(chunks), Buffer.from([0xff, 0x00, 0x0a, 0xe9]));
    assert.deepStrictEqual([res.code, res.stdout, res.notFound], [0, '', false]);
  });

  test('a non-zero exit comes back as data, with stderr', async () => {
    const res = await run('process.stderr.write("fatal: nope"); process.exit(3)').result;
    assert.deepStrictEqual([res.code, res.stderr], [3, 'fatal: nope']);
  });

  test('a throw from onStdout kills the child, comes back as its error, and no later chunk is taken', async () => {
    const started = Date.now();
    let calls = 0;
    const res = await defaultExec(NODE, ['-e', 'process.stdout.write("x".repeat(4 * 1024 * 1024)); setTimeout(() => {}, 60000)'], os.tmpdir(), {
      onStdout: () => { calls++; throw new Error('disk full'); },
    });
    assert.deepStrictEqual([res.code, res.stderr, calls], [null, 'disk full', 1]);
    assert.ok(Date.now() - started < 30_000, 'the child did not run on');
  });

  test('a timeout kills the child', async () => {
    const res = await run('setTimeout(() => {}, 60000)', { timeoutMs: 200 }).result;
    assert.strictEqual(res.code, null);
    assert.ok(res.stderr.startsWith('killed by'), res.stderr);
  });

  test('an abort kills the child', async () => {
    const ac = new AbortController();
    const { result } = run('setTimeout(() => {}, 60000)', { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    assert.strictEqual((await result).code, null);
  });

  test('a missing binary is named, and does not reject', async () => {
    const res = await defaultExec('cograph-no-such-binary', [], os.tmpdir(), { onStdout: () => undefined });
    assert.deepStrictEqual([res.code, res.notFound], [null, true]);
  });

  test('a child that exits without reading its stdin does not take the host down', async () => {
    const res = await run('process.exit(0)', { stdin: 'x'.repeat(8 * 1024 * 1024) }).result;
    assert.strictEqual(res.code, 0);
  });
});

suite('vcs engine — a path cannot read outside the tree it names', () => {
  const at = useRepo('cograph-paths-');
  const PLANTED = 'PLANTED_OUTSIDE_THE_TREE';

  for (const [name, separator] of [['a newline', '\n'], ['a carriage return', '\r']] as const) {
    test(`a path with ${name} is left out of the copy, and the rest stays`, async function () {
      if (process.platform === 'win32') { this.skip(); } // NTFS has no such name, and git refuses it
      const planted = path.join(at.root, 'planted.py');
      fs.writeFileSync(planted, `def ${PLANTED}():\n    pass\n`);
      const hostile = `x${separator}${planted.slice(1)}`;
      const log: string[] = [];
      const tree = await materializeCommit({ ...at.deps, log: l => log.push(l) }, commitOf(at.repo, { 'src/app.py': 'def real():\n    pass\n', [hostile]: 'def hidden():\n    pass\n' }));
      assert.strictEqual(tree.files, 1);
      assert.deepStrictEqual(allFiles(tree.dir).filter(n => n.endsWith('.py')), ['app.py']);
      assert.strictEqual(fs.readFileSync(path.join(tree.dir, DECLARED_TRACKED), 'utf8'), 'src/app.py');
      assert.ok(log.some(l => l.includes('1 paths with control characters')), log.join('\n'));
    });
  }

  test('other control characters go too; a tab, a space, a quote and unicode stay', async function () {
    if (process.platform === 'win32') { this.skip(); } // none of the refused names can exist there
    const kept = ['tab\there.py', 'with space.py', 'quo\'te.py', 'ünï.py'];
    const refused = ['bell\u0007.py', 'del\u007f.py', 'next\u0085.py'];
    const text = 'def a():\n    pass\n';
    const tree = await materializeCommit(at.deps, commitOf(at.repo, Object.fromEntries([...kept, ...refused].map(n => [n, text]))));
    assert.deepStrictEqual(allFiles(tree.dir).filter(n => n.endsWith('.py')).sort(), [...kept].sort());
  });

  /** One function inside the root and one outside it, for one language. */
  const LANGUAGES: Array<[script: string, ext: string, source: (fn: string) => string]> = [
    ['analyze.py', 'py', fn => `def ${fn}():\n    pass\n`],
    ['analyze_ts.js', 'ts', fn => `export function ${fn}() {}\n`],
    ['analyze_js.js', 'js', fn => `function ${fn}() {}\n`],
    ['analyze_java.js', 'java', fn => `class K { void ${fn}() {} }\n`],
    ['analyze_cpp.js', 'cpp', fn => `int ${fn}() { return 1; }\n`],
    ['analyze_c.js', 'c', fn => `int ${fn}(void) { return 1; }\n`],
  ];

  for (const [script, ext, source] of LANGUAGES) {
    test(`${script} refuses a listed path outside its root, in any spelling`, function () {
      this.timeout(30_000);
      const workspace = path.join(at.root, 'ws');
      fs.mkdirSync(path.join(workspace, '..data'), { recursive: true });
      fs.writeFileSync(path.join(workspace, `inside.${ext}`), source('insideFn'));
      fs.writeFileSync(path.join(workspace, '..data', `dotted.${ext}`), source('dottedFn'));
      const sibling = `${workspace}-sibling`;
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(sibling, `prefix.${ext}`), source('prefixFn'));
      fs.writeFileSync(path.join(at.root, `outside.${ext}`), source('outsideFn'));
      const list = path.join(at.root, 'list.txt');
      fs.writeFileSync(list, [
        path.join(workspace, `inside.${ext}`),
        path.join(workspace, '..data', `dotted.${ext}`),
        path.join(at.root, `outside.${ext}`),
        `${workspace}${path.sep}..${path.sep}outside.${ext}`,
        path.join(sibling, `prefix.${ext}`),
      ].join('\n'));
      const bin = script === 'analyze.py' ? 'python3' : process.execPath;
      let out: string;
      try {
        out = cp.execFileSync(bin, [path.join(SCRIPTS, script), workspace, '--files', list], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (err) {
        if (bin === 'python3' && (err as NodeJS.ErrnoException).code === 'ENOENT') { this.skip(); }
        throw err;
      }
      const names = (JSON.parse(out) as { nodes: any[] }).nodes.map(n => n.name).sort();
      assert.deepStrictEqual(names, ['dottedFn', 'insideFn'], 'inside the root, a name that merely starts with dots included');
    });
  }
});
