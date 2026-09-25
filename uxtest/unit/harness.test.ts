import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { renderWebviewHtml, scriptListFromHtml, EXT_ROOT as REPO_ROOT } from '../harness/vscodeStub';
import { resolveStatic, startServer } from '../harness/server';
import { cutPatch, FakeHost, readSourceSlice, type GraphLite } from '../harness/fakeHost';
import { SEL, RUNTIME_ONLY, TIMELINE_ONLY, type SelName } from '../selectors';

const ORIGIN = 'http://127.0.0.1:1';

test.describe('real HTML via the vscode stub', () => {
  test('emits every webview script the builder references, all present on disk', () => {
    const scripts = scriptListFromHtml(renderWebviewHtml(ORIGIN));
    expect(scripts.length).toBeGreaterThan(15);
    // a bundled checkout loads its vendored d3 (dist/webview) first; the webview sources always start with state.js
    expect(scripts.filter(x => x.startsWith('src/webview/'))[0]).toBe('src/webview/state.js');
    expect(scripts).toContain('src/webview/main.js');
    for (const s of scripts) { expect(fs.existsSync(path.join(REPO_ROOT, s)), s).toBe(true); }
    expect(scripts).not.toContain('src/webview/timeline.js');
    expect(scriptListFromHtml(renderWebviewHtml(ORIGIN, { timeline: true }))).toContain('src/webview/timeline.js');
  });

  test('boot config reaches COGRAPH_CONFIG and the CSP names the lab origin', () => {
    const html = renderWebviewHtml(ORIGIN, { engine: 'global', motion: 'dynamic', perf: false });
    expect(html).toContain('"defaultEngine":"global"');
    expect(html).toContain('"defaultMode":"dynamic"');
    expect(html).toContain('"perf":false');
    expect(html).toContain(`style-src 'unsafe-inline' ${ORIGIN}`);
    expect(renderWebviewHtml(ORIGIN)).toContain('"defaultEngine":"shelf"');
  });

  test('selector drift: every required static selector exists in the production HTML', () => {
    const doc = new JSDOM(renderWebviewHtml(ORIGIN, { timeline: true })).window.document;
    const missing: string[] = [];
    for (const name of Object.keys(SEL) as SelName[]) {
      const sel: { css: string; optional?: boolean } = SEL[name];
      if (sel.optional || RUNTIME_ONLY.includes(name)) { continue; }
      if (!doc.querySelector(sel.css)) { missing.push(`${name} (${sel.css})`); }
    }
    expect(missing).toEqual([]);
    const plain = new JSDOM(renderWebviewHtml(ORIGIN)).window.document;
    for (const name of TIMELINE_ONLY) { expect(plain.querySelector(SEL[name].css)).toBeNull(); }
  });
});

test.describe('lab server', () => {
  test('resolveStatic only serves the webview roots', () => {
    expect(resolveStatic('/ext/src/webview/main.js')).toBe(path.join(REPO_ROOT, 'src/webview/main.js'));
    expect(resolveStatic('/ext/dist/webview/d3.min.js')).toBe(path.join(REPO_ROOT, 'dist/webview/d3.min.js'));
    expect(resolveStatic('/ext/src/extension.ts')).toBeNull();
    expect(resolveStatic('/ext/src/webview/../../package.json')).toBeNull();
    expect(resolveStatic('/ext/src/webview/%2e%2e/%2e%2e/package.json')).toBeNull();
    expect(resolveStatic('/ext/src/webview')).toBeNull();
    expect(resolveStatic('/other/main.js')).toBeNull();
  });

  test('serves html, scripts and 404s over http', async () => {
    const server = await startServer();
    try {
      const page = await fetch(server.pageUrl({ engine: 'global' }));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('"defaultEngine":"global"');
      const js = await fetch(`${server.origin}/ext/src/webview/state.js?v=abc`);
      expect(js.headers.get('content-type')).toContain('text/javascript');
      expect(await js.text()).toContain('const state');
      expect((await fetch(`${server.origin}/ext/package.json`)).status).toBe(404);
      expect((await fetch(`${server.origin}/ext/src/webview/nope.js`)).status).toBe(404);
    } finally { await server.close(); }
  });
});

test.describe('fake host', () => {
  const graph: GraphLite = {
    nodes: [
      { id: 'a', file: '/r/x.ts', line: 1 }, { id: 'b', file: '/r/x.ts', line: 9 }, { id: 'c', file: '/r/y.ts', line: 1 },
      { id: 'lib', file: null, line: 0, isLibrary: true }, { id: 'lib2', file: null, line: 0, isLibrary: true },
    ],
    edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'lib' }, { source: 'c', target: 'lib2' }, { source: 'c', target: 'a' }],
    files: ['/r/x.ts', '/r/y.ts'],
  };
  const host = (mode: 'eager' | 'lazy' = 'eager') => new FakeHost({ graph, structure: { root: '/r' }, mode, parseDelayMs: 5 });

  test('cutPatch keeps the files\' nodes, touching edges and reached libraries', () => {
    const p = cutPatch(graph, ['/r/x.ts']);
    expect(p.nodes.map(n => n.id).sort()).toEqual(['a', 'b', 'lib']);
    expect(p.edges).toHaveLength(3);
    expect(cutPatch(graph, []).nodes).toEqual([]);
  });

  test('opening messages differ by mode', () => {
    expect(host().openingMessages().map(r => r.message.type)).toEqual(['structure', 'graph']);
    expect(host('lazy').openingMessages().map(r => r.message.type)).toEqual(['structure', 'analysis-state']);
    expect(host('lazy').backgroundDone().map(r => r.message.type)).toEqual(['graph', 'analysis-state']);
  });

  test('expand-folder / parse-file answer with spinner + patch', async () => {
    const h = host('lazy');
    const replies = await h.onMessage({ type: 'expand-folder', folderPath: '/r', files: ['/r/y.ts'] });
    expect(replies.map(r => r.message.type)).toEqual(['analysis-state', 'graph-patch']);
    expect(replies[1].message).toMatchObject({ parsedFolder: '/r', replacedFiles: ['/r/y.ts'] });
    expect(await h.onMessage({ type: 'expand-folder', folderPath: '/r', files: [] })).toEqual([]);
    const one = await h.onMessage({ type: 'parse-file', filePath: '/r/x.ts' });
    expect(one[1].message.parsedFolder).toBe('/r');
    expect(await h.onMessage({ type: 'parse-file' })).toEqual([]);
  });

  test('subgraph scope: scope goes out first, the graph arrives cut, include/exclude/exit reply like the host', async () => {
    const g: GraphLite = { nodes: [
      { id: 'a', file: '/r/src/a.ts', line: 1 }, { id: 'b', file: '/r/src/deep/b.ts', line: 1 }, { id: 'c', file: '/r/test/c.ts', line: 1 },
      { id: 'lib', file: null, line: 0, isLibrary: true }],
      edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }, { source: 'c', target: 'lib' }], files: ['/r/src/a.ts', '/r/src/deep/b.ts', '/r/test/c.ts'] };
    const h = new FakeHost({ graph: g, structure: { root: '/r' }, mode: 'eager', parseDelayMs: 1, scope: { name: 'S', root: '/r', include: ['src'], exclude: ['test'] } });
    const open = h.openingMessages().map(r => r.message);
    expect(open.map(m => m.type)).toEqual(['subgraph', 'structure', 'graph']);
    expect(open[0]).toMatchObject({ name: 'S', root: '/r', include: ['src'], exclude: ['test'] });
    expect((open[2].data as GraphLite).nodes.map(n => n.id).sort()).toEqual(['a', 'b']);
    // Visualize test/ → subgraph (now including test) + spinner + patch with c and its library
    const inc = await h.onMessage({ type: 'subgraph-include', path: 'test' });
    expect(inc.map(r => r.message.type)).toEqual(['subgraph', 'graph-patch']);
    expect(inc[0].message).toMatchObject({ include: ['src', 'test'], exclude: [] });
    expect((inc[1].message.patch as GraphLite).nodes.map(n => n.id).sort()).toEqual(['c', 'lib']);
    expect(inc[1].message.replacedFiles).toEqual(['/r/test/c.ts']);
    // exclude src → prune patch listing its files
    const exc = await h.onMessage({ type: 'subgraph-exclude', path: 'src' });
    expect(exc.map(r => r.message.type)).toEqual(['subgraph', 'graph-patch']);
    expect(exc[0].message).toMatchObject({ include: ['test'], exclude: ['src'] });
    expect((exc[1].message.replacedFiles as string[]).sort()).toEqual(['/r/src/a.ts', '/r/src/deep/b.ts']);
    expect((exc[1].message.patch as GraphLite).nodes).toEqual([]);
    // exit → scope null + a patch bringing back the files that were out of scope (session-178: not a full graph)
    const exit = await h.onMessage({ type: 'subgraph-exit' });
    expect(exit.map(r => r.message.type)).toEqual(['subgraph', 'graph-patch']);
    expect(exit[0].message).toMatchObject({ name: null, include: [], exclude: [] });
    expect((exit[1].message.replacedFiles as string[]).sort()).toEqual(['/r/src/a.ts', '/r/src/deep/b.ts']);
    expect((exit[1].message.patch as GraphLite).nodes.map(n => n.id).sort()).toEqual(['a', 'b']);
    expect(await h.onMessage({ type: 'subgraph-exit' })).toEqual([]);
    expect(h.scope).toBeNull();
    expect(await h.onMessage({ type: 'subgraph-include', path: 'src' })).toEqual([]); // no scope: nothing to change
    expect(host().openingMessages().map(r => r.message.type)).toEqual(['structure', 'graph']); // unscoped hosts are unchanged
  });

  test('source round-trip never touches disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-'));
    const file = path.join(dir, 'f.py');
    fs.writeFileSync(file, 'line1\ndef f():\n  return 1\n');
    const h = host();
    const first = await h.onMessage({ type: 'get-func-source', file, line: 2, reqId: 7 });
    expect(first[0].message).toMatchObject({ type: 'func-source', reqId: 7, endLine: 4 });
    expect(String(first[0].message.source)).toContain('def f()');
    expect(await h.onMessage({ type: 'save-func-source', file, line: 2, newSource: 'edited' })).toEqual([]);
    expect((await h.onMessage({ type: 'get-func-source', file, line: 2, reqId: 8 }))[0].message.source).toBe('edited');
    expect(fs.readFileSync(file, 'utf8')).toContain('def f()');
    expect(readSourceSlice(file, 1).split('\n')[0]).toBe('line1');
    const crlf = path.join(dir, 'crlf.py');
    fs.writeFileSync(crlf, 'line1\r\ndef g():\r\n  return 2\r\n');
    expect(readSourceSlice(crlf, 2)).toBe('def g():\n  return 2\n'); // no stray \r reaches the webview
    const missing = await h.onMessage({ type: 'get-func-source', file: path.join(dir, 'nope.py'), line: 1, reqId: 9 });
    expect(missing[0].message.error).toBeTruthy();
  });

  test('save, cancel, lib description and record-only messages', async () => {
    const h = host();
    expect((await h.onMessage({ type: 'save-graph', payload: { x: 1 } }))[0].message.type).toBe('clear-dirty');
    expect(h.saved).toHaveLength(1);
    expect((await h.onMessage({ type: 'cancel-analysis' }))[0].message).toMatchObject({ cancelled: true });
    expect((await h.onMessage({ type: 'get-lib-description', reqId: 3 }))[0].message).toMatchObject({ type: 'lib-description', reqId: 3 });
    expect(await h.onMessage({ type: 'navigate', file: '/r/x.ts', line: 1 })).toEqual([]);
    expect(h.posted('navigate')).toHaveLength(1);
    expect(h.log).toHaveLength(4);
  });
});
