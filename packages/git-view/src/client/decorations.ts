import { cwdOf } from './sessions.js';
import { STATUS_COLORS, statusLetter, type StatusCache } from './status.js';

/** A workspace path relative to the tree's root, or undefined outside it. */
function relativeTo(root: string, absolute: string): string | undefined {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, ''), target = absolute.replace(/\\/g, '/');
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : undefined;
}
/** Draws a row's letter and the file name's color; idempotent, so redrawing a drawn row changes nothing. */
function paint(name: HTMLElement, letter: string | undefined, after: boolean): void {
  const near = after ? name.nextElementSibling : name.querySelector(':scope > .gv-deco');
  const badge = near?.classList.contains('gv-deco') ? near as HTMLElement : null;
  // Folders get only their dot; file names take their change's color, as in VS Code.
  const color = letter && letter !== '•' ? letter : undefined;
  if ((name.dataset.gvColor ?? '') !== (color ?? '')) {
    if (color) { name.style.color = STATUS_COLORS[color]; name.dataset.gvColor = color; }
    else { name.style.removeProperty('color'); delete name.dataset.gvColor; }
  }
  if (!letter) { badge?.remove(); return; }
  if (badge?.dataset.letter === letter) return;
  const node = badge ?? document.createElement('span');
  node.className = 'gv-deco'; node.textContent = letter; node.dataset.letter = letter; node.style.color = STATUS_COLORS[letter];
  if (!badge) { if (after) name.after(node); else name.append(node); }
}
const letterFor = (cache: StatusCache, root: string, path: string, kind: string | null) =>
  kind === 'directory' ? (cache.hasChangesUnder(root, path) ? '•' : undefined) : kind === 'file' ? (code => code && statusLetter(code))(cache.codeOf(root, path)) : undefined;

/**
 * Change marks in file lists, as in VS Code's Explorer: a letter after a changed file's name, the name in its color, and
 * a dot on folders holding changes. They follow DSH's Workspace files tree and Remote Agents' remote file list, whose
 * rows name their paths in data attributes, and are redrawn whenever React redraws a row.
 */
export function installDecorations(cache: StatusCache, ensure: (root: string) => void): () => void {
  let frame = 0, stopped = false;
  const pass = () => {
    for (const tree of document.querySelectorAll('[data-files-state="tree"][data-files-root]')) {
      const root = tree.getAttribute('data-files-root');
      if (!root) continue;
      ensure(root);
      for (const row of tree.querySelectorAll('li[data-files-entry][data-files-path]')) {
        const path = relativeTo(root, row.getAttribute('data-files-path')!), button = row.querySelector(':scope > button') ?? row.querySelector(':scope > span');
        const name = (button?.querySelector('span') ?? button) as HTMLElement | null;
        if (path && name) paint(name, letterFor(cache, root, path, row.getAttribute('data-files-entry')), false);
      }
    }
    for (const list of document.querySelectorAll('[data-workspace-session]')) {
      const root = cwdOf(list.getAttribute('data-workspace-session') ?? undefined);
      if (!root) continue;
      ensure(root);
      for (const row of list.querySelectorAll('[data-workspace-path][data-workspace-kind]')) {
        const name = row.querySelector<HTMLElement>('[data-workspace-name]');
        if (name) paint(name, letterFor(cache, root, row.getAttribute('data-workspace-path')!, row.getAttribute('data-workspace-kind')), true);
      }
    }
  };
  const schedule = () => {
    if (stopped || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; try { pass(); } catch (error) { console.warn('Git change marks failed', error); } });
  };
  // Rows only: the marks' own attribute changes do not schedule another pass.
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  const unsubscribe = cache.subscribe(schedule);
  schedule();
  return () => { stopped = true; observer.disconnect(); unsubscribe(); if (frame) cancelAnimationFrame(frame); };
}
