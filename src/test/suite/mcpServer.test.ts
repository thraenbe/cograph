import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IndexHolder } from '../../mcp/graphIndex';
import { ago, capText, footer } from '../../mcp/format';
import { confine, findWorkspaceRoot, relPath, ToolError } from '../../mcp/paths';
import { parseArgs } from '../../mcp/server';
import { readSlice } from '../../mcp/sourceSlice';
import { NO_ANALYSIS, runTool, TOOLS, type ToolContext } from '../../mcp/tools';
import { makeFixture, type Fixture } from './mcpFixture';

const SERVER = path.resolve(__dirname, '../../../dist/mcp/server.js');

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) { throw new Error(`no tool ${name}`); }
  return t;
}

suite('MCP paths and source slices', () => {
  let fx: Fixture;
  setup(() => { fx = makeFixture(); });
  teardown(() => fx.cleanup());

  test('confine accepts paths inside the root and refuses escapes, including via symlink', () => {
    assert.strictEqual(confine(fx.root, 'src/a.ts'), fx.abs('src/a.ts'));
    assert.strictEqual(confine(fx.root, 'src\\a.ts'), fx.abs('src/a.ts'));
    assert.strictEqual(confine(fx.root, fx.abs('src')), fx.abs('src'));
    assert.strictEqual(confine(fx.root, './'), fx.root);
    assert.strictEqual(confine(fx.root, 'src/not-there.ts'), fx.abs('src/not-there.ts'), 'a missing file can still be named');
    assert.throws(() => confine(fx.root, '../x'), ToolError);
    assert.throws(() => confine(fx.root, os.tmpdir()), /outside the workspace/);
    try {
      fs.symlinkSync(os.tmpdir(), fx.abs('escape'), 'dir');
    } catch { return; } // symlinks may need privileges (Windows CI)
    assert.throws(() => confine(fx.root, 'escape'), /resolves outside/);
  });

  test('relPath is POSIX and keeps foreign absolute paths; findWorkspaceRoot walks up to the cache', () => {
    assert.strictEqual(relPath(fx.root, fx.abs('src/a.ts')), 'src/a.ts');
    assert.strictEqual(relPath(fx.root, fx.root), '.');
    assert.ok(path.isAbsolute(relPath(fx.root, os.tmpdir()).split('/').join(path.sep)));
    assert.strictEqual(findWorkspaceRoot(fx.abs('src')), fx.root);
    assert.strictEqual(findWorkspaceRoot(fx.abs('src'), '..'), fx.root);
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-nocache-'));
    try { assert.strictEqual(findWorkspaceRoot(bare), path.resolve(bare)); } finally { fs.rmSync(bare, { recursive: true }); }
  });

  test('readSlice: brace and indent ends, maxLines cap, eof, and errors as values', () => {
    const js = readSlice(fx.abs('src/a.ts'), 5, { maxLines: 80 });
    assert.ok(js.ok && js.startLine === 5 && js.endLine === 7 && js.endReason === 'detected');
    const py = readSlice(fx.abs('src/b.py'), 1, { maxLines: 80 });
    assert.ok(py.ok && py.endLine === 2 && py.source === 'def run():\n    helper_py()');
    const capped = readSlice(fx.abs('src/a.ts'), 1, { maxLines: 2 });
    assert.ok(capped.ok && capped.endLine === 2 && capped.endReason === 'maxLines');
    const last = readSlice(fx.abs('src/b.py'), 4, { maxLines: 80 });
    assert.ok(last.ok && last.endLine === 5 && last.endReason === 'detected', 'a function closing at EOF is found, not "eof"');
    // funcEnd.ts skips strings, so a "}" inside one no longer ends the slice early (it did with the
    // 1.3.0 brace counter). Slices stay labelled best-effort: the scanner is still a heuristic.
    const quoted = readSlice(fx.abs('src/a.ts'), 9, { maxLines: 80 });
    assert.ok(quoted.ok && quoted.endLine === 12 && quoted.endReason === 'detected', JSON.stringify(quoted));
    fs.writeFileSync(fx.abs('src/broken.ts'), 'function broken() {\n  return 1;\n');
    const unclosed = readSlice(fx.abs('src/broken.ts'), 1, { maxLines: 80 });
    assert.ok(unclosed.ok && unclosed.endReason === 'eof', 'eof now means the scanner found no end');
    assert.deepStrictEqual(readSlice(fx.abs('nope.ts'), 1, { maxLines: 5 }), { ok: false, error: 'cannot read file (ENOENT)' });
    assert.ok(!readSlice(fx.abs('src/a.ts'), 999, { maxLines: 5 }).ok);
  });

  test('ago, capText and footer', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    assert.strictEqual(ago('2026-10-07T11:59:50Z', now), 'just now');
    assert.strictEqual(ago('2026-10-07T11:30:00Z', now), '30 min ago');
    assert.strictEqual(ago('2026-10-07T06:00:00Z', now), '6 h ago');
    assert.strictEqual(ago('2026-10-01T12:00:00Z', now), '6 days ago');
    assert.strictEqual(ago('garbage', now), 'at an unknown time');
    const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const cut = capText(long, 1000);
    assert.ok(cut.length <= 1000 && /output truncated/.test(cut));
    assert.strictEqual(capText('short', 1000), 'short');
    const index = new IndexHolder(fx.root).get()!;
    assert.match(footer(index, { changed: 0, removed: 0 }, now), /unchanged since/);
    assert.match(footer(index, { changed: 2, removed: 1 }, now), /STALE: 3 source file/);
    assert.doesNotMatch(footer(index, null, now), /STALE/);
  });

  test('parseArgs reads --workspace in both spellings', () => {
    assert.deepStrictEqual(parseArgs(['--workspace', '/w']), { workspace: '/w' });
    assert.deepStrictEqual(parseArgs(['--workspace=/w']), { workspace: '/w' });
    assert.deepStrictEqual(parseArgs([]), {});
  });
});

suite('MCP tools', () => {
  let fx: Fixture;
  let ctx: ToolContext;
  let logged: string[];
  setup(() => {
    fx = makeFixture({ annotate: true });
    logged = [];
    ctx = { holder: new IndexHolder(fx.root), now: Date.now, log: (_l, msg) => { logged.push(msg); } };
  });
  teardown(() => fx.cleanup());

  test('every tool answers with text and the freshness footer', () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['find_symbol', { query: 'helper' }], ['get_symbol', { id: 'src/a.ts::helper' }],
      ['callers', { id: 'src/a.ts::leaf', depth: 2 }], ['callees', { id: 'src/a.ts::main', includeLibraries: true }],
      ['impact', { path: 'src/a.ts' }], ['impact', { id: 'src/a.ts::orphan' }], ['overview', {}],
      ['overview', { path: 'src/a.ts' }], ['callers', { id: 'src/a.ts::orphan' }],
    ];
    for (const [name, args] of calls) {
      const r = runTool(tool(name), args, ctx);
      assert.strictEqual(r.isError, false, `${name}: ${r.text}`);
      assert.match(r.text, /CoGraph graph analysed .*unchanged since/, name);
      assert.ok(!r.text.includes(fx.root), `${name} leaks no absolute paths`);
    }
    const get = runTool(tool('get_symbol'), { id: 'src/a.ts::helper' }, ctx).text;
    assert.match(get, /Source src\/a\.ts:5-7 \(best-effort slice, end detected/);
    assert.match(get, /file summary: Entry point and helpers\./);
    assert.match(runTool(tool('callers'), { id: 'src/a.ts::orphan' }, ctx).text, /not proof it is unused/);
    assert.match(runTool(tool('impact'), { id: 'src/a.ts::orphan' }, ctx).text, /check those before assuming it is safe/);
  });

  test('get_symbol warns when the file changed since the analysis', () => {
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(fx.abs('src/a.ts'), later, later);
    assert.match(runTool(tool('get_symbol'), { id: 'src/a.ts::helper' }, ctx).text, /WARNING: this file changed since the analysis/);
    assert.doesNotMatch(runTool(tool('get_symbol'), { id: 'src/a.ts::helper', includeSource: false }, ctx).text, /Source /);
  });

  test('get_symbol never reads source outside the workspace, even when the cache names such a file', () => {
    const index = ctx.holder.get()!;
    const helper = index.byId.get('src/a.ts::helper')!;
    helper.file = os.tmpdir();
    const text = runTool(tool('get_symbol'), { id: 'src/a.ts::helper' }, ctx).text;
    assert.match(text, /Source: unavailable \(file is outside the workspace\)/);
  });

  test('argument mistakes become isError results with a readable message', () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['callers', { id: 'src/nope.ts::f' }, /find_symbol/],
      ['callers', { id: 'src/a.ts::leaf', depth: 9 }, /Invalid arguments: depth/],
      ['impact', {}, /exactly one of id or path/],
      ['impact', { id: 'src/a.ts::leaf', path: 'src' }, /exactly one/],
      ['overview', { path: '../../etc' }, /outside the workspace/],
      ['find_symbol', {}, /Invalid arguments: query/],
    ];
    for (const [name, args, re] of cases) {
      const r = runTool(tool(name), args, ctx);
      assert.ok(r.isError, name);
      assert.match(r.text, re, name);
    }
  });

  test('no cache → guidance, not a crash; unexpected errors are logged and reported', () => {
    const bare = makeFixture({ cache: false });
    try {
      const r = runTool(tool('overview'), {}, { ...ctx, holder: new IndexHolder(bare.root) });
      assert.deepStrictEqual(r, { text: NO_ANALYSIS, isError: true });
    } finally { bare.cleanup(); }
    const broken = { ...tool('overview'), run: () => { throw new Error('boom'); } };
    const r = runTool(broken, {}, ctx);
    assert.ok(r.isError && /Internal error in overview: boom/.test(r.text));
    assert.deepStrictEqual(logged, ['tool failed']);
  });
});

suite('MCP server over stdio', function () {
  this.timeout(30_000);
  let fx: Fixture;
  setup(function () {
    if (!fs.existsSync(SERVER)) { this.skip(); } // built by `npm run bundle` (part of pretest)
    fx = makeFixture();
  });
  teardown(() => fx?.cleanup());

  test('lists six read-only tools and answers a call; stdout carries only protocol frames', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.execPath, args: [SERVER, '--workspace', fx.root],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } as Record<string, string>, stderr: 'pipe',
    });
    const client = new Client({ name: 'cograph-test', version: '0' });
    await client.connect(transport); // a stray stdout line would break the handshake
    try {
      const { tools } = await client.listTools();
      assert.deepStrictEqual(tools.map((t: { name: string }) => t.name), ['find_symbol', 'get_symbol', 'callers', 'callees', 'impact', 'overview']);
      assert.ok(tools.every((t: { annotations?: { readOnlyHint?: boolean } }) => t.annotations?.readOnlyHint === true));
      const ok = await client.callTool({ name: 'callers', arguments: { id: 'src/a.ts::leaf' } });
      assert.match(ok.content[0].text, /src\/a\.ts::helper/);
      const bad = await client.callTool({ name: 'impact', arguments: {} });
      assert.strictEqual(bad.isError, true);
    } finally {
      await client.close();
    }
  });
});
