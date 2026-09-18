import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildDigestIndex, buildFileDigest, renderFileDigest, blankStrings, leadingComment, MAX_DIGEST_CHARS,
} from '../../graphIntelligence/annotationDigest';
import type { GraphData } from '../../graphProvider';

suite('annotationDigest', () => {
  let root: string;
  let svc: string;
  let util: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-digest-'));
    svc = path.join(root, 'src', 'service.ts');
    util = path.join(root, 'src', 'util.ts');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(svc, [
      '/**',
      ' * Talks to the billing API and retries on failure.',
      ' */',
      "import axios from 'axios';",
      '',
      'export class Billing {',
      '  async charge(user: User, key = "sk-live-SECRET") {',
      '    const SECRET_BODY = "do not leak";',
      '    return axios.post(url, body);',
      '  }',
      '}',
      'export function helper(a: number): number {',
      '  return a;',
      '}',
    ].join('\n'));
    fs.writeFileSync(util, 'export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));\n');
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  function graph(): GraphData {
    return {
      nodes: [
        { id: 'charge', name: 'charge', file: svc, line: 7, language: 'typescript', className: 'Billing' },
        { id: 'helper', name: 'helper', file: svc, line: 12, language: 'typescript' },
        { id: 'sleep', name: 'sleep', file: util, line: 1, language: 'typescript' },
        { id: 'lib', name: 'post', file: null, line: 0, isLibrary: true, libraryName: 'axios' },
      ],
      edges: [
        { source: 'charge', target: 'lib', isLibraryEdge: true },
        { source: 'charge', target: 'sleep' },
        { source: 'charge', target: 'helper' },
      ],
    };
  }

  test('digest carries path, language, LOC, signatures, imports, calls and the leading comment', () => {
    const d = buildFileDigest(root, svc, 'typescript', buildDigestIndex(graph()));
    assert.strictEqual(d.path, 'src/service.ts');
    assert.strictEqual(d.loc, 14);
    assert.deepStrictEqual(d.imports, ['axios']);
    assert.deepStrictEqual(d.calls, ['src/util.ts'], 'same-file calls are not listed');
    assert.strictEqual(d.leadingComment, 'Talks to the billing API and retries on failure.');
    assert.strictEqual(d.symbols.length, 2);
    assert.ok(d.symbols[0].startsWith('Billing.async charge(user: User'));
    assert.strictEqual(d.symbols[1], 'export function helper(a: number): number');
  });

  test('never contains function bodies or string literal contents', () => {
    const text = renderFileDigest(buildFileDigest(root, svc, 'typescript', buildDigestIndex(graph())));
    assert.ok(!text.includes('SECRET'), text);
    assert.ok(!text.includes('do not leak'));
    assert.ok(!text.includes('axios.post'));
    assert.ok(text.includes('key = "…"'));
  });

  test('a file with no parsed functions still gets a digest', () => {
    const empty = path.join(root, 'src', 'types.ts');
    fs.writeFileSync(empty, '// Shared type aliases.\nexport type Id = string;\n');
    const d = buildFileDigest(root, empty, 'typescript', buildDigestIndex(graph()));
    assert.deepStrictEqual(d.symbols, []);
    assert.strictEqual(d.leadingComment, 'Shared type aliases.');
    assert.strictEqual(renderFileDigest(d), '### src/types.ts (typescript, 3 lines)\ncomment: Shared type aliases.');
  });

  test('an unreadable file falls back to names from the graph', () => {
    const gone = path.join(root, 'src', 'gone.ts');
    const g: GraphData = { nodes: [{ id: 'x', name: 'lost', file: gone, line: 3 }], edges: [] };
    const d = buildFileDigest(root, gone, 'typescript', buildDigestIndex(g));
    assert.strictEqual(d.loc, 0);
    assert.deepStrictEqual(d.symbols, ['lost']);
  });

  test('a stale line number falls back to the bare name instead of an unrelated line', () => {
    const g = graph();
    g.nodes[1].line = 9; // points into charge()'s body
    const d = buildFileDigest(root, svc, 'typescript', buildDigestIndex(g));
    assert.ok(d.symbols.includes('helper'));
    assert.ok(!d.symbols.some(s => s.includes('axios.post')));
  });

  test('rendered digest is clamped by dropping symbols', () => {
    const big = path.join(root, 'src', 'big.ts');
    const src = Array.from({ length: 60 }, (_, i) => `export function handlerNumber${i}(request: IncomingRequest, response: OutgoingResponse): Promise<void> {}`);
    fs.writeFileSync(big, src.join('\n'));
    const g: GraphData = {
      nodes: src.map((_, i) => ({ id: `n${i}`, name: `handlerNumber${i}`, file: big, line: i + 1 })),
      edges: [],
    };
    const text = renderFileDigest(buildFileDigest(root, big, 'typescript', buildDigestIndex(g)));
    assert.ok(text.length <= MAX_DIGEST_CHARS, String(text.length));
    assert.match(text, /\(\+\d+ more\)/);
  });

  test('blankStrings handles all quote kinds and escapes', () => {
    assert.strictEqual(blankStrings(`f(a = 'x', b = "y\\"z", c = \`t\`)`), "f(a = '…', b = \"…\", c = `…`)");
  });

  test('leadingComment: line comments, python docstrings, shebang, licence headers', () => {
    assert.strictEqual(leadingComment(['#!/usr/bin/env python', '# Parses args.', '# Second line.', 'import os']), 'Parses args. Second line.');
    assert.strictEqual(leadingComment(['"""Module that loads config.', '', 'More detail."""', 'import os']), 'Module that loads config. More detail.');
    assert.strictEqual(leadingComment(['"""One liner."""', 'x = 1']), 'One liner.');
    assert.strictEqual(leadingComment(["'use strict';", '// Entry point.', 'main();']), 'Entry point.');
    assert.strictEqual(leadingComment(['/* Copyright 2024 Acme. All rights reserved. */', 'code']), '');
    assert.strictEqual(leadingComment(['const x = 1;']), '');
    assert.ok(leadingComment(['// ' + 'a'.repeat(500)]).length <= 300);
  });
});
