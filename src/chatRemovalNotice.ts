import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** workspaceState key: the notice is shown at most once per workspace. */
export const CHAT_NOTICE_SHOWN_KEY = 'cograph.chatRemovalNoticeShown';

export const CHAT_NOTICE_TEXT =
  'CoGraph: Chat has been removed. Your saved conversations are still on disk in .cograph/chats/.';

/** True when the removed Chat left conversations behind (current or pre-per-graph layout). */
export function hasChatHistory(root: string): boolean {
  const dir = path.join(root, '.cograph');
  return fs.existsSync(path.join(dir, 'chats')) || fs.existsSync(path.join(dir, 'chat.json'));
}

/**
 * Tell a former Chat user, once, that the feature is gone and where their history is.
 * CoGraph never deletes those files. Never throws: a notice must not break activation.
 */
export async function showChatRemovalNotice(root: string | undefined, state: vscode.Memento): Promise<void> {
  try {
    if (!root || state.get<boolean>(CHAT_NOTICE_SHOWN_KEY, false) || !hasChatHistory(root)) { return; }
    await state.update(CHAT_NOTICE_SHOWN_KEY, true);
    void vscode.window.showInformationMessage(CHAT_NOTICE_TEXT);
  } catch {
    /* best-effort: worst case the notice shows again next session */
  }
}
