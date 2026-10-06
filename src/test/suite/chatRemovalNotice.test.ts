import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CHAT_NOTICE_SHOWN_KEY, CHAT_NOTICE_TEXT, hasChatHistory, showChatRemovalNotice,
} from '../../chatRemovalNotice';

/** In-memory Memento; `failUpdate` makes update() reject like a broken storage would. */
function makeMemento(initial: Record<string, unknown> = {}, failUpdate = false) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: <T>(key: string, fallback?: T) => (data.has(key) ? data.get(key) as T : fallback),
    update: async (key: string, value: unknown) => {
      if (failUpdate) { throw new Error('storage unavailable'); }
      data.set(key, value);
    },
    keys: () => [...data.keys()],
  } as unknown as vscode.Memento & { data: Map<string, unknown> };
}

suite('chatRemovalNotice', () => {
  let sandbox: sinon.SinonSandbox;
  let tmp: string;
  let info: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-chat-notice-'));
    info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
  });

  teardown(() => {
    sandbox.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeChat(rel: string): string {
    const file = path.join(tmp, '.cograph', ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"sessions":{},"messages":[]}', 'utf8');
    return file;
  }

  test('hasChatHistory: false for a workspace that never used Chat', () => {
    fs.mkdirSync(path.join(tmp, '.cograph'));
    assert.strictEqual(hasChatHistory(tmp), false);
  });

  test('hasChatHistory: true for per-graph chats and for the legacy chat.json', () => {
    writeChat('chats/__default__.json');
    assert.strictEqual(hasChatHistory(tmp), true);
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-chat-legacy-'));
    try {
      fs.mkdirSync(path.join(legacy, '.cograph'));
      fs.writeFileSync(path.join(legacy, '.cograph', 'chat.json'), '[]', 'utf8');
      assert.strictEqual(hasChatHistory(legacy), true);
    } finally {
      fs.rmSync(legacy, { recursive: true, force: true });
    }
  });

  test('shows the notice once, records it, and leaves the chat files untouched', async () => {
    const file = writeChat('chats/My graph.json');
    const state = makeMemento();

    await showChatRemovalNotice(tmp, state);
    await showChatRemovalNotice(tmp, state);

    assert.ok(info.calledOnceWithExactly(CHAT_NOTICE_TEXT), 'notice shown exactly once');
    assert.strictEqual(state.data.get(CHAT_NOTICE_SHOWN_KEY), true);
    assert.ok(fs.existsSync(file), 'saved conversation is never deleted');
  });

  test('silent without chat history, without a workspace, or when already shown', async () => {
    await showChatRemovalNotice(tmp, makeMemento());
    await showChatRemovalNotice(undefined, makeMemento());
    writeChat('chats/__default__.json');
    await showChatRemovalNotice(tmp, makeMemento({ [CHAT_NOTICE_SHOWN_KEY]: true }));
    assert.ok(info.notCalled);
  });

  test('never throws when workspace storage fails', async () => {
    writeChat('chats/__default__.json');
    await showChatRemovalNotice(tmp, makeMemento({}, true));
    assert.ok(info.notCalled, 'no notice when it could not be recorded (it will retry next session)');
  });
});
