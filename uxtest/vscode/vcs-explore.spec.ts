// Tier B exploration of the Version Control view (session-262): the real extension in real VS Code, used as a
// person would, with a screenshot after every action. Not a pass/fail checklist: the question is whether a person can
// tell at a glance which tree they are looking at.
//   UXTEST_EXT_ROOT=<s262 checkout> UXTEST_REPOS=<abs path of a GitHub clone> npm run uxtest:vscode -- --grep vcs-explore
// UXTEST_VCS_STAGE selects how far to go (1 = open a PR, 2 = + leave / reopen, 3 = + cancels / offline / clear).
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import type { Frame, Page } from '@playwright/test';
import { launchVsCode } from './launch';
import { execFileSync } from 'child_process';
import { frameHittable, frameSetSlider, runCommand, waitForGraph } from './drive';
import { SEL } from '../selectors';

const repo = process.env.UXTEST_REPOS ?? '';
const STAGE = Number(process.env.UXTEST_VCS_STAGE ?? 1);

/** The PR panel's webview: the one carrying the banner. */
async function prFrame(page: Page): Promise<Frame | null> {
  for (const f of page.frames()) {
    if (!f.url().startsWith('vscode-webview://')) { continue; }
    if (await f.evaluate(() => !!document.getElementById('pr-view-banner')).catch(() => false)) { return f; }
  }
  return null;
}

/** Banner geometry against its own viewport: is every part visible, does it cover the controls? */
async function bannerGeometry(f: Frame): Promise<unknown> {
  return f.evaluate(() => {
    const b = document.getElementById('pr-view-banner');
    if (!b) { return null; }
    const r = (el: Element) => { const x = el.getBoundingClientRect(); return { x: Math.round(x.left), y: Math.round(x.top), w: Math.round(x.width), right: Math.round(x.right) }; };
    const ctl = document.querySelector('#top-left-controls');
    const covered: string[] = [];
    for (const el of [...document.querySelectorAll('#top-left-controls button, #top-left-controls label, #top-left-controls input')]) {
      const x = el.getBoundingClientRect(); if (!x.width) { continue; }
      const hit = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
      if (hit && b.contains(hit)) { covered.push((el.textContent || (el as HTMLInputElement).id || el.tagName).trim().slice(0, 30)); }
    }
    return { viewportW: window.innerWidth, banner: r(b), parts: [...b.children].map(c => ({ cls: c.className || c.tagName, text: (c.textContent || '').trim().slice(0, 60), ...r(c) })),
      controls: ctl ? r(ctl) : null, controlsCoveredByBanner: covered };
  });
}

async function sidebarFrame(page: Page): Promise<Frame | null> {
  for (const f of page.frames()) {
    if (!f.url().startsWith('vscode-webview://')) { continue; }
    if (await f.evaluate(() => !!document.querySelector('.vcs-pr, .vcs-empty, .vcs-line')).catch(() => false)) { return f; }
  }
  return null;
}

/** Everything a person could read without scrolling: tab titles, notifications, status bar. */
async function chrome(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tabs-container .tab')].map(t => ((t.getAttribute('aria-label') || t.textContent || '').trim()) + (t.classList.contains('active') ? ' [active]' : '')),
    notifications: [...document.querySelectorAll('.notification-toast .notification-list-item-message')].map(n => (n.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
    status: [...document.querySelectorAll('.statusbar-item')].map(s => (s.textContent || '').trim()).filter(Boolean).slice(0, 12),
  }));
}

async function notifTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('.notification-toast .notification-list-item-message')].map(n => (n.textContent || '').replace(/\s+/g, ' ').trim()));
}

test('vcs-explore', async () => {
  test.setTimeout(30 * 60 * 1000);
  const s = await launchVsCode(repo, 'vcs-explore');
  const { page, outDir } = s;
  const shots = path.join(outDir, 'shots'); fs.mkdirSync(shots, { recursive: true });
  const notes: Record<string, unknown>[] = [];
  let n = 0;
  const shot = async (what: string, extra: Record<string, unknown> = {}): Promise<void> => {
    const file = `${String(++n).padStart(2, '0')}-${what.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
    await page.screenshot({ path: path.join(shots, file) });
    notes.push({ n, what, file, ...await chrome(page), ...extra });
    fs.writeFileSync(path.join(outDir, 'notes.json'), JSON.stringify(notes, null, 2));
  };
  try {
    await page.waitForTimeout(3000);
    await runCommand(page, 'CoGraph: Visualize Project');
    await waitForGraph(s.graphFrame, 180000, true);
    await page.waitForTimeout(2500);
    await shot('main graph open');

    // The CoGraph activity-bar container holds the sidebar webview (PR list).
    await page.locator('.activitybar [aria-label*="CoGraph" i], .activitybar [aria-label*="Cograph" i]').first().click();
    let side: Frame | null = null;
    for (let i = 0; i < 40 && !side; i++) { await page.waitForTimeout(500); side = await sidebarFrame(page); }
    await page.waitForTimeout(2000);
    await shot('sidebar open', { sidebarFound: !!side });
    if (!side) { throw new Error('no sidebar webview with the PR list'); }

    // Open PR #69 and watch the progress notification, sampling what it says.
    const t0 = Date.now();
    await side.locator('.vcs-pr[data-number="69"]').click();
    const phases: string[] = [];
    for (let i = 0; i < 240; i++) {
      const c = await chrome(page) as { tabs: string[]; notifications: string[] };
      const msg = c.notifications.join(' | ');
      if (msg && phases[phases.length - 1] !== msg) { phases.push(msg); if (phases.length <= 6) { await shot(`progress ${phases.length}`); } }
      if (c.tabs.some(t => /PR #69/.test(t))) { break; }
      await page.waitForTimeout(500);
    }
    const openMs = Date.now() - t0;
    await page.waitForTimeout(3000);
    await shot('pr 69 open', { openMs, phases });
    if (STAGE === 6) {
      // ── Stage 6: re-drive what b19885c changed (B read-only by construction + fingerprint, A banner, C popup, wording). ──
      const step = async (what: string, fn: () => Promise<Record<string, unknown>>): Promise<void> => {
        try { await shot(what, await fn()); } catch (err) { await shot(`${what} FAILED`, { error: String(err).slice(0, 400) }); }
      };
      const activeTab = () => page.evaluate(() => {
        const t = document.querySelector('.editor-group-container.active .tabs-container .tab.active');
        const grp = document.querySelector('.editor-group-container.active');
        const ov = grp?.querySelector('.monaco-editor .monaco-editor-overlaymessage');
        const first = grp?.querySelector('.monaco-editor .view-lines .view-line')?.textContent || '';
        const crumbs = [...(grp?.querySelectorAll('.breadcrumbs-control .monaco-breadcrumb-item') || [])].map(e => (e.textContent || '').trim()).join(' > ');
        return t ? { label: t.getAttribute('aria-label') || '', title: t.getAttribute('title') || '', html: t.innerHTML.includes('lock'), dirty: t.classList.contains('dirty'),
          description: (t.querySelector('.label-description')?.textContent || '').trim(), overlay: (ov?.textContent || '').trim(), firstLine: first.slice(0, 60), crumbs: crumbs.slice(0, 160),
          lockIcon: !!t.querySelector('[class*="lock"]') } : null;
      });
      const zoomToSlot = async (f: Frame): Promise<{ x: number; y: number } | null> => {
        for (let i = 0; i < 12 && !(await frameHittable(f, '#graph g.file-slot .file-slot-shape', 230)); i++) {
          const c = await frameHittable(f, '#graph g.frame .folder-bubble-shape', 230);
          if (c) { await page.mouse.move(c.x, c.y); await page.mouse.wheel(0, -300); await page.waitForTimeout(250); }
        }
        return frameHittable(f, '#graph g.file-slot .file-slot-shape', 230);
      };
      const tryEdit = async (label: string): Promise<Record<string, unknown>> => {
        const f = await prFrame(page); if (!f) { throw new Error('no PR panel'); }
        const slot = await zoomToSlot(f); if (!slot) { throw new Error('no hittable slot'); }
        await page.mouse.dblclick(slot.x, slot.y); await page.waitForTimeout(2500);
        const opened = await activeTab();
        await page.keyboard.type('x'); await page.waitForTimeout(700);
        const typed = await activeTab();
        const pf = await prFrame(page);
        await shot(`B ${label}: right after typing`, { typed, banner: pf ? await bannerGeometry(pf) : null });
        const writeable: Record<string, unknown> = {};
        for (const cmd of ['File: Set Active Editor Writeable in Session', 'File: Toggle Active Editor Read-only in Session', 'File: Reset Active Editor Read-only in Session']) {
          try { await runCommand(page, cmd); await page.waitForTimeout(500); await page.keyboard.press('Escape'); } catch (e) { writeable[cmd] = 'not available: ' + String(e).slice(0, 80); continue; }
          await page.keyboard.type('y'); await page.waitForTimeout(600);
          writeable[cmd] = await activeTab();
        }
        await runCommand(page, 'View: Revert and Close Editor').catch(() => undefined);
        await page.waitForTimeout(800);
        return { label, opened, afterTyping: typed, afterWriteableCommands: writeable };
      };
      await step('B: open a copy file, try to edit and to make it writeable', () => tryEdit('fresh open'));
      // Reproduce the race path: leave, open #70, open #69 again, then open a copy file (it lands in a third group).
      await step('B: same after leave + #70 + #69 (the race path)', async () => {
        await side.getByRole('button', { name: 'Leave pull request' }).click(); await page.waitForTimeout(1500);
        for (const num of [70, 69]) { await side.locator(`.vcs-pr[data-number="${num}"]`).click(); for (let i = 0; i < 120; i++) { if ((await chrome(page) as { tabs: string[] }).tabs.some(t => t.includes(`PR #${num}`))) { break; } await page.waitForTimeout(250); } await page.waitForTimeout(2000); }
        return tryEdit('after leave/reopen');
      });

      // A: banner geometry at the split width.
      await step('A: banner at split width', async () => { const f = await prFrame(page); return { banner: f ? await bannerGeometry(f) : null }; });

      // C: popup in the head panel refuses edits outright.
      await step('C: popup in the head panel', async () => {
        const g = await prFrame(page); if (!g) { throw new Error('no PR panel'); }
        await page.locator('.tabs-container .tab', { hasText: 'PR #69' }).first().click().catch(() => undefined);
        await frameSetSlider(g, SEL.detailSlider.css, 1).catch(() => undefined); await page.waitForTimeout(1500);
        for (let i = 0; i < 15 && !(await frameHittable(g, '#graph circle.regular-node', 230)); i++) {
          const c = (await frameHittable(g, '#graph g.file-slot .file-slot-shape', 230)) || (await frameHittable(g, '#graph g.frame .folder-bubble-shape', 230));
          if (c) { await page.mouse.move(c.x, c.y); await page.mouse.wheel(0, -300); await page.waitForTimeout(250); }
        }
        const node = await frameHittable(g, '#graph circle.regular-node', 230); if (!node) { throw new Error('no function node'); }
        await page.mouse.click(node.x, node.y); await page.waitForTimeout(1500);
        const ta = g.locator('.func-card .func-source-textarea').first();
        const info = await ta.evaluate(el => ({ readOnly: (el as HTMLTextAreaElement).readOnly, title: el.getAttribute('title') || '', value: (el as HTMLTextAreaElement).value.slice(0, 40) }));
        await ta.click().catch(() => undefined); await page.keyboard.type('zzz'); await page.waitForTimeout(400);
        const after = await ta.evaluate(el => (el as HTMLTextAreaElement).value.slice(0, 40));
        await page.keyboard.press('Escape');
        return { textarea: info, valueAfterTyping: after, changed: after !== info.value, prTabs: (await chrome(page) as { tabs: string[] }).tabs };
      });

      // (2) Edit a finished copy from OUTSIDE VS Code, then reopen: the fingerprint must discard and re-copy.
      await step('2: outside edit of the copy, then reopen', async () => {
        const MARK = 'uxtestInjectedFromOutside';
        const root = path.join(s.userDataDir, 'User', 'globalStorage');
        const find = (dir: string, depth = 0): string | null => { if (depth > 6 || !fs.existsSync(dir)) { return null; }
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name.startsWith('23834be') && fs.existsSync(path.join(p, 'src', 'webview', 'funcSave.js'))) { return p; } const r = find(p, depth + 1); if (r) { return r; } } } return null; };
        const tree = find(root); if (!tree) { throw new Error('PR #69 head copy not found under globalStorage'); }
        const target = path.join(tree, 'src', 'webview', 'funcSave.js');
        await side.getByRole('button', { name: 'Leave pull request' }).click(); await page.waitForTimeout(1500);
        execFileSync('sh', ['-c', `printf '\\nfunction ${MARK}() { return 42; }\\n' >> "$0"`, target]);
        const injected = fs.readFileSync(target, 'utf8').includes(MARK);
        const t = Date.now();
        await side.locator('.vcs-pr[data-number="69"]').click();
        const phases: string[] = [];
        for (let i = 0; i < 240; i++) { const m = await notifTexts(page); for (const x of m) { if (!phases.includes(x)) { phases.push(x); } }
          if ((await chrome(page) as { tabs: string[] }).tabs.some(x => x.includes('PR #69'))) { break; } await page.waitForTimeout(150); }
        await page.waitForTimeout(2500);
        const g = await prFrame(page);
        const inGraph = g ? await g.evaluate(`JSON.stringify((state.graphData && state.graphData.nodes) || []).includes(${JSON.stringify(MARK)})`) : null;
        const stillOnDisk = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').includes(MARK) : 'file gone';
        return { tree: tree.replace(root, '<globalStorage>'), injectedBeforeReopen: injected, reopenMs: Date.now() - t, phases, injectedFunctionInHeadGraph: inGraph, markerStillInCopyAfterReopen: stillOnDisk };
      });

      // (5) Wording: cancel before the copy, cancel after it, then Clear.
      for (const [phase, label] of [['fetching the pull request', 'before copy'], ['analysing the pull request', 'after copy']] as const) {
        await step(`5: cancel ${label}`, async () => {
          await runCommand(page, 'CoGraph: Clear pull-request trees'); await page.waitForTimeout(1500);
          await runCommand(page, 'Notifications: Clear All Notifications').catch(() => undefined);
          await side.locator('.vcs-pr[data-number="74"]').click();
          let hit = false;
          for (let i = 0; i < 400 && !hit; i++) {
            if ((await notifTexts(page)).some(m => m.includes(phase))) { await page.locator('.notification-toast').filter({ hasText: phase }).getByRole('button', { name: 'Cancel' }).first().click(); hit = true; }
            await page.waitForTimeout(60);
          }
          await page.waitForTimeout(2500);
          const row = await side.locator('.vcs-pr[data-number="74"] .vcs-line').innerText().catch(() => '');
          await runCommand(page, 'Notifications: Clear All Notifications').catch(() => undefined);
          await runCommand(page, 'CoGraph: Clear pull-request trees'); await page.waitForTimeout(2000);
          return { cancelClicked: hit, rowLine: row, clearSays: await notifTexts(page) };
        });
      }

      // (3) the offline fallback banner.
      await step('A: offline fallback banner', async () => {
        execFileSync('git', ['config', 'core.sshCommand', '/bin/false'], { cwd: s.workspace });
        await runCommand(page, 'Notifications: Clear All Notifications').catch(() => undefined);
        await side.locator('.vcs-pr[data-number="73"]').click(); await page.waitForTimeout(6000);
        await side.getByRole('button', { name: 'Show in the current checkout instead' }).click(); await page.waitForTimeout(5000);
        execFileSync('git', ['config', '--unset', 'core.sshCommand'], { cwd: s.workspace });
        const f = await prFrame(page);
        return { tabs: (await chrome(page) as { tabs: string[] }).tabs, banner: f ? await bannerGeometry(f) : null };
      });
      return;
    }
    if (STAGE === 5) {
      // ── Stage 5: is the PR copy read-only every time, and from the first moment? ──
      const f = await prFrame(page); if (!f) { throw new Error('no PR panel'); }
      for (let i = 0; i < 12 && !(await frameHittable(f, '#graph g.file-slot .file-slot-shape', 330)); i++) {
        const c = await frameHittable(f, '#graph g.frame .folder-bubble-shape', 330);
        if (c) { await page.mouse.move(c.x, c.y); await page.mouse.wheel(0, -300); await page.waitForTimeout(250); }
      }
      const tabState = () => page.evaluate(() => { const t = document.querySelector('.editor-group-container.active .tabs-container .tab.active'); return t ? { label: t.getAttribute('aria-label') || '', lock: !!t.querySelector('.codicon-lock, .codicon-lock-small'), dirty: t.classList.contains('dirty') } : null; });
      for (let round = 1; round <= 4; round++) {
        const slot = await frameHittable(f, '#graph g.file-slot .file-slot-shape', 330);
        if (!slot) { await shot(`round ${round}: no slot`); break; }
        await page.mouse.dblclick(slot.x, slot.y);
        const samples: unknown[] = [];
        for (const ms of [300, 700, 1500, 2500]) { await page.waitForTimeout(ms - (samples.length ? [300, 700, 1500, 2500][samples.length - 1] : 0)); samples.push({ atMs: ms, ...(await tabState()) }); }
        await page.keyboard.type('x');
        await page.waitForTimeout(600);
        const afterTyping = await tabState();
        await shot(`round ${round}: open pr copy, type`, { samples, afterTyping });
        // undo + close without saving
        await page.keyboard.press('Control+z');
        await runCommand(page, 'View: Revert and Close Editor').catch(() => undefined);
        await page.waitForTimeout(1000);
        await page.locator('.tabs-container .tab', { hasText: 'PR #69' }).first().click().catch(() => undefined);
        await page.waitForTimeout(800);
      }
      return;
    }
    if (STAGE === 4) {
      // ── Stage 4: is the PR tree's copy writable, and does a saved edit survive into the next open? ──
      const f = await prFrame(page); if (!f) { throw new Error('no PR panel'); }
      for (let i = 0; i < 12 && !(await frameHittable(f, '#graph g.file-slot .file-slot-shape', 330)); i++) {
        const c = await frameHittable(f, '#graph g.frame .folder-bubble-shape', 330);
        if (c) { await page.mouse.move(c.x, c.y); await page.mouse.wheel(0, -300); await page.waitForTimeout(250); }
      }
      const slot = await frameHittable(f, '#graph g.file-slot .file-slot-shape', 330);
      if (!slot) { throw new Error('no hittable file slot'); }
      await page.mouse.dblclick(slot.x, slot.y);
      await page.waitForTimeout(2500);
      const crumbs = await page.evaluate(() => [...document.querySelectorAll('.breadcrumbs-control .monaco-breadcrumb-item')].map(e => (e.textContent || '').trim()).join(' > '));
      const MARK = '// UXTEST EDIT IN PR TREE';
      const storage = path.join(s.userDataDir, 'User', 'globalStorage');
      const grep = (dir: string): string[] => { const out: string[] = []; if (!fs.existsSync(dir)) { return out; }
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name);
          if (e.isDirectory()) { out.push(...grep(p)); } else if (e.isFile() && fs.statSync(p).size < 2e6 && fs.readFileSync(p, 'utf8').includes(MARK)) { out.push(p); } } return out; };
      const wsHits = (): string[] => execFileSync('git', ['grep', '-l', MARK], { cwd: s.workspace, encoding: 'utf8' }).toString().split('\n').filter(Boolean);
      await page.keyboard.press('Control+Home');
      await page.keyboard.type('// UXTEST EDIT IN PR TREE\n');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+s');
      await page.waitForTimeout(2000);
      let ws: string[] = []; try { ws = wsHits(); } catch { ws = []; }
      const inCache = grep(storage).map(p => p.replace(storage, '<globalStorage>'));
      await shot('edit + save in the pr tree copy', { crumbs: crumbs.slice(0, 300), savedIntoPrCache: inCache, savedIntoWorkspace: ws, notifications: await notifTexts(page) });
      // Leave and reopen #69: is the edited tree reused?
      await side.getByRole('button', { name: 'Leave pull request' }).click().catch(() => undefined);
      await page.waitForTimeout(1500);
      await side.locator('.vcs-pr[data-number="69"]').click();
      await page.waitForTimeout(6000);
      await shot('reopen 69 after the edit', { editedFilesInCacheAfterReopen: grep(storage).map(p => p.replace(storage, '<globalStorage>')) });
      // Function popup in the PR panel: zoom deep into a slot until a function node is hittable.
      const g = await prFrame(page);
      if (g) {
        await frameSetSlider(g, SEL.detailSlider.css, 1).catch(() => undefined);
        await page.waitForTimeout(1500);
        for (let i = 0; i < 15 && !(await frameHittable(g, '#graph circle.regular-node', 330)); i++) {
          const c = (await frameHittable(g, '#graph g.file-slot .file-slot-shape', 330)) || (await frameHittable(g, '#graph g.frame .folder-bubble-shape', 330));
          if (c) { await page.mouse.move(c.x, c.y); await page.mouse.wheel(0, -300); await page.waitForTimeout(250); }
        }
        const node = await frameHittable(g, '#graph circle.regular-node', 330);
        if (node) {
          await page.mouse.click(node.x, node.y); await page.waitForTimeout(1500);
          const ta = g.locator('.func-card .func-source-textarea').first();
          const ro = await ta.evaluate(el => (el as HTMLTextAreaElement).readOnly).catch(() => null);
          if (ro === false) { await ta.click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\n// popup edit'); await page.keyboard.press('Control+s'); await page.waitForTimeout(2500); }
          const popupText = await g.evaluate(() => (document.querySelector('.func-card')?.textContent || '').replace(/\s+/g, ' ').slice(0, 600));
          await shot('popup save in the pr panel', { textareaReadOnly: ro, popupText, notifications: await notifTexts(page) });
        } else { await shot('popup: no function node reachable', {}); }
      }
      return;
    }
    if (STAGE < 2) { return; }

    // ── Stage 2 ─────────────────────────────────────────────────────────────
    const pr = await prFrame(page);
    if (!pr) { throw new Error('no PR panel webview'); }
    // Which folders opened, against the PR's changed files (gh, the same source the view uses).
    const files = JSON.parse(execFileSync('gh', ['pr', 'view', '69', '--json', 'files'], { cwd: s.workspace, encoding: 'utf8' })).files.map((f: { path: string }) => f.path) as string[];
    const opened = await pr.evaluate('[...(state.expandedFolders || [])].map(String)') as string[];
    const rel = (p: string): string => p.replace(/\\/g, '/').replace(/^.*?\/(src|scripts|uxtest|media|out)\//, '$1/');
    const changedDirs = [...new Set(files.flatMap(f => { const parts = f.split('/').slice(0, -1); return parts.map((_, i) => parts.slice(0, i + 1).join('/')); }))].sort();
    await shot('pr 69 banner + folders', { banner: await bannerGeometry(pr), changedFiles: files, changedDirs, openedFolders: opened.map(rel).sort() });

    // Leave from the sidebar (the banner's Leave may be off-screen at split width: measured above).
    const t1 = Date.now();
    await side.getByRole('button', { name: 'Leave pull request' }).click();
    await page.waitForTimeout(2500);
    await shot('after leave', { leaveMs: Date.now() - t1 });

    // #70, then #69 again: the second open of #69 should be fast (analyses cached).
    for (const num of [70, 69]) {
      const t = Date.now();
      await side.locator(`.vcs-pr[data-number="${num}"]`).click();
      for (let i = 0; i < 240; i++) {
        const c = await chrome(page) as { tabs: string[] };
        if (c.tabs.some(x => new RegExp(`PR #${num}`).test(x))) { break; }
        await page.waitForTimeout(250);
      }
      await page.waitForTimeout(2000);
      await shot(`pr ${num} open (second round)`, { openMs: Date.now() - t - 2000 });
    }
    if (STAGE < 3) { return; }

    // ── Stage 3 ─────────────────────────────────────────────────────────────
    const attempt = async (what: string, fn: () => Promise<Record<string, unknown> | void>): Promise<void> => {
      try { const extra = await fn(); await shot(what, extra || {}); }
      catch (err) { await shot(`${what} FAILED`, { error: String(err).slice(0, 400) }); }
    };
    const notifText = async (): Promise<string[]> => (await chrome(page) as { notifications: string[] }).notifications;
    const dismissNotifications = async (): Promise<void> => { await runCommand(page, 'Notifications: Clear All Notifications').catch(() => undefined); };

    // (a) read-only: double-click a file slot in the PR panel; then type into the editor that opens.
    await attempt('slot double-click opens file', async () => {
      const f = await prFrame(page); if (!f) { throw new Error('no PR panel'); }
      const before = (await chrome(page) as { tabs: string[] }).tabs;
      // zoom into the first changed folder's frame until slots are hittable
      for (let i = 0; i < 12 && !(await frameHittable(f, '#graph g.file-slot .file-slot-shape', 330)); i++) {
        const c = await frameHittable(f, '#graph g.frame .folder-bubble-shape', 330);
        if (c) { await page.mouse.move(c.x, c.y); await page.mouse.wheel(0, -300); await page.waitForTimeout(250); }
      }
      const slot = await frameHittable(f, '#graph g.file-slot .file-slot-shape', 330);
      if (!slot) { throw new Error('no hittable file slot'); }
      await page.mouse.dblclick(slot.x, slot.y);
      await page.waitForTimeout(2500);
      const tabs = (await chrome(page) as { tabs: string[] }).tabs;
      await page.keyboard.type('x');
      await page.waitForTimeout(800);
      const after = await chrome(page) as { tabs: string[]; notifications: string[] };
      const readonlyHint = await page.evaluate(() => [...document.querySelectorAll('.editor-instance .monaco-editor, .tab.active')].map(e => e.getAttribute('aria-label') || '').join(' | ').slice(0, 300));
      return { tabsBefore: before, tabsAfterOpen: tabs, tabsAfterTyping: after.tabs, notifications: after.notifications, readonlyHint };
    });
    await page.keyboard.press('Escape');

    // (b) a function-popup save in the PR panel: should be refused with a sentence.
    await attempt('popup save in pr panel', async () => {
      const f = await prFrame(page); if (!f) { throw new Error('no PR panel'); }
      await page.locator('.tabs-container .tab', { hasText: 'PR #69' }).first().click().catch(() => undefined);
      const node = await frameHittable(f, '#graph circle.regular-node', 330);
      if (!node) { throw new Error('no hittable function node'); }
      await page.mouse.click(node.x, node.y);
      await page.waitForTimeout(1500);
      const ta = f.locator('.func-card .func-source-textarea').first();
      const readOnly = await ta.evaluate(el => (el as HTMLTextAreaElement).readOnly).catch(() => null);
      let typed = false;
      if (readOnly === false) { await ta.click(); await page.keyboard.press('Control+End'); await page.keyboard.type('\n# edit in a PR tree'); await page.keyboard.press('Control+s'); typed = true; await page.waitForTimeout(2000); }
      const popupText = await f.evaluate(() => (document.querySelector('.func-card')?.textContent || '').replace(/\s+/g, ' ').slice(0, 500));
      return { textareaReadOnly: readOnly, typedAndSaved: typed, popupText, notifications: await notifText() };
    });
    await page.keyboard.press('Escape');
    await side.getByRole('button', { name: 'Leave pull request' }).click().catch(() => undefined);
    await page.waitForTimeout(1500);

    // (c) Cancel in each phase, after clearing the cache so every phase really runs; then Clear reports what is left.
    const PHASES = ['fetching the pull request', 'analysing the pull request', 'fetching its base', 'analysing the base'];
    for (const phase of PHASES) {
      await attempt(`cancel during "${phase}"`, async () => {
        await runCommand(page, 'CoGraph: Clear pull-request trees'); await page.waitForTimeout(1500); await dismissNotifications();
        await side.locator('.vcs-pr[data-number="74"]').click();
        let hit = false; const seen: string[] = [];
        for (let i = 0; i < 400 && !hit; i++) {
          const msgs = await notifText();
          for (const m of msgs) { if (!seen.includes(m)) { seen.push(m); } }
          if (msgs.some(m => m.includes(phase))) {
            await page.locator('.notification-toast').filter({ hasText: phase }).getByRole('button', { name: 'Cancel' }).first().click();
            hit = true;
          }
          if ((await chrome(page) as { tabs: string[] }).tabs.some(t => /PR #74/.test(t))) { break; }
          await page.waitForTimeout(60);
        }
        await page.waitForTimeout(2500);
        const tabs = (await chrome(page) as { tabs: string[] }).tabs;
        const row = await side.locator('.vcs-pr[data-number="74"]').innerText().catch(() => '');
        await dismissNotifications();
        await runCommand(page, 'CoGraph: Clear pull-request trees'); await page.waitForTimeout(2000);
        const clearSays = await notifText();
        if (tabs.some(t => /PR #74/.test(t))) { await side.getByRole('button', { name: 'Leave pull request' }).click().catch(() => undefined); }
        return { phase, cancelClicked: hit, phasesSeen: seen, tabsAfter: tabs, rowText: row.replace(/\s+/g, ' ').slice(0, 300), clearSays };
      });
      await dismissNotifications();
    }

    // (d) offline: git cannot reach the remote (ssh fails), gh's HTTPS API still lists PRs.
    await attempt('offline open', async () => {
      execFileSync('git', ['config', 'core.sshCommand', '/bin/false'], { cwd: s.workspace });
      await runCommand(page, 'CoGraph: Clear pull-request trees'); await page.waitForTimeout(1500); await dismissNotifications();
      await side.locator('.vcs-pr[data-number="73"]').click();
      await page.waitForTimeout(6000);
      const row = await side.locator('.vcs-pr[data-number="73"]').innerText().catch(() => '');
      return { rowText: row.replace(/\s+/g, ' ').slice(0, 400), tabs: (await chrome(page) as { tabs: string[] }).tabs };
    });
    await attempt('offline: show in current checkout', async () => {
      await side.getByRole('button', { name: 'Show in the current checkout instead' }).click();
      await page.waitForTimeout(5000);
      const main = await (async () => { for (const f of page.frames()) { if (await f.evaluate(() => !!document.getElementById('pr-view-banner')).catch(() => false)) { return f; } } return null; })();
      return { tabs: (await chrome(page) as { tabs: string[] }).tabs, banner: main ? await bannerGeometry(main) : null };
    });
    execFileSync('git', ['config', '--unset', 'core.sshCommand'], { cwd: s.workspace });
  } finally {
    await s.close();
  }
});
