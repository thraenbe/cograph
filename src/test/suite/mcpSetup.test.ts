import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { choicesFor, installStableServer, writeTeamConfig } from '../../mcp/setupCommand';
import {
  claudeAddCommand, launchFor, mergeMcpJson, quoteArg, serverEntry, snippet,
} from '../../mcp/setupSnippets';
import { mcpApi, MCP_PROVIDER_ID, registerMcpProvider } from '../../mcp/vscodeRegistration';

const NODE = launchFor('/s/server.js', true, '/ignored');
const ELECTRON = launchFor('/s/server.js', false, '/Apps/Code Helper');

suite('MCP setup snippets', () => {
  test('launchFor: plain node when on PATH, VS Code runtime with ELECTRON_RUN_AS_NODE otherwise', () => {
    assert.deepStrictEqual(NODE, { command: 'node', args: ['/s/server.js'] });
    assert.deepStrictEqual(ELECTRON, { command: '/Apps/Code Helper', args: ['/s/server.js'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  });

  test('claude mcp add: options before the name, everything after -- passed through, quoting per OS', () => {
    assert.strictEqual(claudeAddCommand(NODE, '/w/my repo', 'linux'), "claude mcp add cograph -- node /s/server.js --workspace '/w/my repo'");
    assert.strictEqual(claudeAddCommand(ELECTRON, '/w', 'darwin'),
      "claude mcp add --env ELECTRON_RUN_AS_NODE=1 cograph -- '/Apps/Code Helper' /s/server.js --workspace /w");
    assert.strictEqual(quoteArg('C:\\Program Files\\x', 'win32'), '"C:\\Program Files\\x"');
    assert.strictEqual(quoteArg("it's", 'linux'), `'it'\\''s'`);
  });

  test('serverEntry and snippet: mcpServers shape, optional --workspace, env only when needed', () => {
    assert.deepStrictEqual(serverEntry(NODE, null), { command: 'node', args: ['/s/server.js'] });
    assert.deepStrictEqual(JSON.parse(snippet(serverEntry(ELECTRON, '${workspaceFolder}'))), {
      mcpServers: { cograph: { command: '/Apps/Code Helper', args: ['/s/server.js', '--workspace', '${workspaceFolder}'], env: { ELECTRON_RUN_AS_NODE: '1' } } },
    });
  });

  test('mergeMcpJson keeps other servers and keys, never clobbers without replace, rejects bad JSON', () => {
    const entry = serverEntry(NODE, null);
    const other = JSON.stringify({ mcpServers: { github: { command: 'gh' } }, extra: 1 });
    const added = mergeMcpJson(other, entry, false);
    assert.ok(added.ok && added.status === 'added');
    assert.deepStrictEqual(JSON.parse(added.ok ? added.text : ''), { mcpServers: { github: { command: 'gh' }, cograph: entry }, extra: 1 });
    assert.ok(added.ok && mergeMcpJson(added.text, entry, false).ok, 'same entry again');
    const same = mergeMcpJson(added.ok ? added.text : '', entry, false);
    assert.ok(same.ok && same.status === 'unchanged');
    const differs = JSON.stringify({ mcpServers: { cograph: { command: 'old' } } });
    assert.deepStrictEqual(mergeMcpJson(differs, entry, false), { ok: false, error: 'exists' });
    const replaced = mergeMcpJson(differs, entry, true);
    assert.ok(replaced.ok && replaced.status === 'replaced');
    assert.ok(mergeMcpJson(null, entry, false).ok);
    assert.ok(mergeMcpJson('  ', entry, false).ok);
    assert.match((mergeMcpJson('{oops', entry, false) as { error: string }).error, /not valid JSON/);
    assert.match((mergeMcpJson('[]', entry, false) as { error: string }).error, /not a JSON object/);
    assert.match((mergeMcpJson('{"mcpServers":[]}', entry, false) as { error: string }).error, /"mcpServers"/);
  });
});

suite('MCP VS Code integration', () => {
  let sandbox: sinon.SinonSandbox;
  let tmp: string;
  setup(() => { sandbox = sinon.createSandbox(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-mcpsetup-')); });
  teardown(() => { sandbox.restore(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('mcpApi is undefined on hosts without the API (VS Code < 1.101) and wraps it when present', () => {
    assert.strictEqual(mcpApi({}), undefined);
    assert.strictEqual(mcpApi({ lm: {} }), undefined);
    assert.strictEqual(mcpApi({ lm: { registerMcpServerDefinitionProvider: () => undefined } }), undefined, 'needs the definition class too');
    const register = sinon.stub().returns({ dispose() { /* noop */ } });
    class Def { constructor(...a: unknown[]) { (this as unknown as { a: unknown[] }).a = a; } }
    const api = mcpApi({ lm: { registerMcpServerDefinitionProvider: register }, McpStdioServerDefinition: Def })!;
    api.register('x', { provideMcpServerDefinitions: () => [] });
    assert.ok(register.calledOnceWith('x'));
  });

  test('registerMcpProvider: no-op without the API; with it, one stdio server for the first folder', () => {
    assert.strictEqual(registerMcpProvider('/s/server.js', '1.3.0', undefined), undefined);
    let provider: { provideMcpServerDefinitions(t: unknown): Array<{ args: unknown[]; cwd?: vscode.Uri }> } | undefined;
    class Def { args: unknown[]; cwd?: vscode.Uri; constructor(...a: unknown[]) { this.args = a; } }
    const api = {
      register: (id: string, p: typeof provider) => { assert.strictEqual(id, MCP_PROVIDER_ID); provider = p; return { dispose() { /* noop */ } }; },
      StdioDefinition: Def as never,
    };
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: vscode.Uri.file(tmp) }]);
    const disposable = registerMcpProvider('/s/server.js', '1.3.0', api as never)!;
    const [def] = provider!.provideMcpServerDefinitions(undefined);
    assert.deepStrictEqual(def.args, ['CoGraph', process.execPath, ['/s/server.js', '--workspace', tmp], { ELECTRON_RUN_AS_NODE: '1' }, '1.3.0']);
    assert.strictEqual(def.cwd!.fsPath, vscode.Uri.file(tmp).fsPath);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);
    assert.deepStrictEqual(provider!.provideMcpServerDefinitions(undefined), []);
    disposable.dispose();
  });

  test('installStableServer copies the bundle once, refreshes it on change, and reports a missing bundle', async () => {
    const ext = path.join(tmp, 'ext');
    fs.mkdirSync(path.join(ext, 'dist', 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(ext, 'dist', 'mcp', 'server.js'), 'v1');
    const logs: string[] = [];
    const dest = await installStableServer(ext, path.join(tmp, 'store'), (m) => logs.push(m));
    assert.strictEqual(fs.readFileSync(dest!, 'utf8'), 'v1');
    fs.writeFileSync(path.join(ext, 'dist', 'mcp', 'server.js'), 'v2');
    await installStableServer(ext, path.join(tmp, 'store'), (m) => logs.push(m));
    assert.strictEqual(fs.readFileSync(dest!, 'utf8'), 'v2');
    assert.strictEqual(await installStableServer(path.join(tmp, 'none'), path.join(tmp, 'store'), (m) => logs.push(m)), null);
    assert.deepStrictEqual(logs, ['could not install the MCP server copy']);
  });

  test('writeTeamConfig writes only after the confirm and keeps other servers', async () => {
    const file = path.join(tmp, '.mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { github: { command: 'gh' } } }));
    const info = sandbox.stub(vscode.window, 'showInformationMessage');
    info.onFirstCall().resolves(undefined as never);
    await writeTeamConfig(tmp, NODE);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('cograph'), 'declined → untouched');
    info.reset();
    info.onFirstCall().resolves('Write .mcp.json' as never);
    await writeTeamConfig(tmp, NODE);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(Object.keys(written.mcpServers), ['github', 'cograph']);
  });

  test('writeTeamConfig never touches an invalid .mcp.json', async () => {
    const file = path.join(tmp, '.mcp.json');
    fs.writeFileSync(file, '{broken');
    const err = sandbox.stub(vscode.window, 'showErrorMessage');
    await writeTeamConfig(tmp, NODE);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken');
    assert.match(String(err.firstCall.args[0]), /Nothing was changed/);
  });

  test('choicesFor: four actions, plus an agent-mode note only when VS Code has the API', () => {
    assert.strictEqual(choicesFor(tmp, NODE, 'linux', false).filter((c) => c.run).length, 4);
    const withApi = choicesFor(tmp, NODE, 'linux', true);
    assert.strictEqual(withApi[0].kind, vscode.QuickPickItemKind.Separator);
    assert.strictEqual(withApi.length, 5);
  });

  test('package.json contributes the provider, the command, its activation and the view-title icon', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../../package.json');
    assert.deepStrictEqual(pkg.contributes.mcpServerDefinitionProviders, [{ id: MCP_PROVIDER_ID, label: 'CoGraph' }]);
    assert.ok(pkg.contributes.commands.some((c: { command: string }) => c.command === 'cograph.connectAgent'));
    assert.ok(pkg.activationEvents.includes('onCommand:cograph.connectAgent'));
    assert.ok(pkg.contributes.menus['view/title'].some((m: { command: string; when: string }) =>
      m.command === 'cograph.connectAgent' && m.when === 'view == cograph.savedGraphs'));
  });
});
