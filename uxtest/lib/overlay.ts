// Visible cursor, click ripple and step caption, so the recorded video explains
// itself. Everything is pointer-events:none and lives in one host element that
// the metrics ignore (it is outside #graph).
import type { Page } from '@playwright/test';

/** Runs in the page (addInitScript). Self-contained. */
function installOverlay(): void {
  const build = (): void => {
    if (document.getElementById('__ux-overlay')) { return; }
    const host = document.createElement('div');
    host.id = '__ux-overlay';
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:sans-serif';
    const cursor = document.createElement('div');
    cursor.style.cssText = 'position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;'
      + 'border:2px solid #fff;background:rgba(255,80,80,.55);box-shadow:0 0 0 1px rgba(0,0,0,.6);left:-50px;top:-50px;'
      + 'transition:transform .08s ease-out';
    const caption = document.createElement('div');
    caption.style.cssText = 'position:absolute;left:50%;bottom:14px;transform:translateX(-50%);max-width:80%;'
      + 'padding:6px 14px;border-radius:6px;background:rgba(0,0,0,.78);color:#fff;font-size:14px;line-height:1.35;'
      + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none';
    host.append(cursor, caption);
    document.documentElement.appendChild(host);
    document.addEventListener('mousemove', (e) => { cursor.style.left = e.clientX + 'px'; cursor.style.top = e.clientY + 'px'; }, true);
    document.addEventListener('mousedown', () => { cursor.style.transform = 'scale(1.7)'; }, true);
    document.addEventListener('mouseup', () => { cursor.style.transform = 'scale(1)'; }, true);
    (window as unknown as Record<string, unknown>).__uxCaption = (text: string) => {
      caption.textContent = text;
      caption.style.display = text ? 'block' : 'none';
    };
  };
  if (document.documentElement && document.body) { build(); }
  else { document.addEventListener('DOMContentLoaded', build, { once: true }); }
}

export async function attachOverlay(page: Page): Promise<void> {
  await page.addInitScript(installOverlay);
}

export async function setCaption(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const fn = (window as unknown as Record<string, unknown>).__uxCaption as ((s: string) => void) | undefined;
    if (fn) { fn(t); }
  }, text);
}
