import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { FILE_LIMIT, type TuiCli } from '@dsh-plugins/remote-core/workspace.js';
import { localizeError, ui, useLocale } from './i18n.js';

/** The part of a browser's DataTransfer this reads, for a drop or a paste alike. */
interface Transfer {
  readonly files: ArrayLike<File>;
  readonly items: ArrayLike<{ readonly kind: string; webkitGetAsEntry?(): { readonly isDirectory?: boolean } | null }>;
  readonly types: readonly string[];
  getData(format: string): string;
}
export interface PickedFiles { files: File[]; folders: string[] }

/** The files of a drop or paste. A folder arrives as a file that cannot be read, so it is told apart here. */
export function pickFiles(transfer: Pick<Transfer, 'files' | 'items'>): PickedFiles {
  const entries = Array.from(transfer.items).filter(item => item.kind === 'file'), picked: PickedFiles = { files: [], folders: [] };
  Array.from(transfer.files).forEach((file, index) => {
    if (entries[index]?.webkitGetAsEntry?.()?.isDirectory) picked.folders.push(file.name); else picked.files.push(file);
  });
  return picked;
}
/**
 * What a paste should upload, if anything. Spreadsheets and word processors copy a picture of the selection beside its
 * text, and the text is what the user means. They also copy rich text, unlike a copied file, whose plain text is its name.
 */
export function pastedFiles(transfer: Transfer): PickedFiles | undefined {
  const picked = pickFiles(transfer);
  if (!picked.files.length && !picked.folders.length) return;
  if (transfer.getData('text/plain') && transfer.types.some(type => type === 'text/html' || type === 'text/rtf')) return;
  return picked;
}
/**
 * The image on the clipboard, for a key that gives no paste event. A copied file offers its icon beside its name, and a
 * spreadsheet a picture beside its text, so only an image without text counts.
 * @returns nothing as well if the browser will not show the clipboard, or does not have this API.
 */
export async function clipboardImage(clipboard: Pick<Clipboard, 'read'> | undefined = navigator.clipboard): Promise<File | undefined> {
  try {
    for (const item of await clipboard?.read() ?? []) {
      if (item.types.includes('text/plain')) continue;
      const type = item.types.find(value => value.startsWith('image/'));
      if (type) return new File([await item.getType(type)], `image.${type.slice(6).replace(/\W.*/, '')}`, { type });
    }
  } catch { /* the caller treats this as an empty clipboard */ }
}
/** A path as a terminal gives a dropped file: escaped for a shell, which both CLIs undo when they look for an image. */
export const terminalPath = (path: string) => path.replace(/[^\p{L}\p{N}\p{M}_./@%+=:,-]/gu, '\\$&');
/** The files Claude Code turns into a placeholder such as `[Image #1]`. It reads them first, so the placeholder comes late. */
const CLAUDE_IMAGE = /\.(?:png|jpe?g|gif|webp)$/i;
/**
 * What to paste for files that are ready together: one paste per file, as neither CLI takes several images in one. Each
 * ends in a space, as a terminal's drop does, so typing can carry on. Codex places its placeholder at once, with a space.
 * Claude Code's comes late, so other files go before images, since it would land after whatever is pasted behind it
 * anyway; and it drops that space, so text coming after an earlier image needs its own.
 * @param afterImage - whether the terminal was last given an image.
 */
export function pastesFor(paths: readonly string[], afterImage: boolean, cli: TuiCli): string[] {
  if (cli === 'codex') return paths.map(path => `${terminalPath(path)} `);
  const images = paths.filter(path => CLAUDE_IMAGE.test(path)), others = paths.filter(path => !CLAUDE_IMAGE.test(path));
  return [...others.map((path, index) => `${!index && afterImage ? ' ' : ''}${terminalPath(path)} `), ...images.map(path => `${terminalPath(path)} `)];
}
/**
 * Presses Ctrl plus a letter in the terminal. It is not a trusted key, so the handlers here let it through. Both halves,
 * as xterm ignores committed input-method text until it has seen a key come back up.
 */
function pressControl(target: EventTarget | null, letter: string): void {
  const init = { key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: true, keyCode: letter.toUpperCase().charCodeAt(0), which: letter.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true };
  target?.dispatchEvent(new KeyboardEvent('keydown', init));
  target?.dispatchEvent(new KeyboardEvent('keyup', init));
}
/** Types into the terminal as a paste would, so an app that asked for bracketed paste receives one. */
export function pasteIntoTerminal(input: HTMLElement, text: string): void {
  const clipboardData = new DataTransfer();
  clipboardData.setData('text/plain', text);
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
}

export interface UploadStatus {
  /** The file being sent, and how many wait behind it. */
  current?: string; waiting: number;
  /** What went wrong, until dismissed or the next upload. */
  errors: readonly string[];
  /** Absolute paths on the machine, until the terminal takes them. */
  paths: readonly string[];
}
const IDLE: UploadStatus = { waiting: 0, errors: [], paths: [] };
interface Queue { files: File[]; controller: AbortController }

/** Files on their way to a TUI conversation. Held outside its view, as the user may switch away while one uploads. */
export class TuiUploads {
  private readonly statuses = new Map<string, UploadStatus>();
  private readonly queues = new Map<string, Queue>();
  private readonly listeners = new Set<() => void>();
  /** @param send - uploads a file and returns its absolute path on the conversation's machine. */
  constructor(private readonly send: (sessionId: string, file: File, signal: AbortSignal) => Promise<string>) {}
  status = (sessionId: string): UploadStatus => this.statuses.get(sessionId) ?? IDLE;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(sessionId: string, change: Partial<UploadStatus>): void {
    this.statuses.set(sessionId, { ...this.status(sessionId), ...change });
    for (const listener of this.listeners) listener();
  }
  add(sessionId: string, { files, folders }: PickedFiles): void {
    const accepted = files.filter(file => file.size <= FILE_LIMIT), queue = this.queues.get(sessionId);
    const errors = [...folders.map(name => ui('Folders cannot be uploaded: {name}', { name })),
      ...files.filter(file => file.size > FILE_LIMIT).map(file => `${file.name}: ${ui('File exceeds the 50 MB transfer limit')}`)];
    if (queue) {
      queue.files.push(...accepted);
      this.patch(sessionId, { waiting: queue.files.length, errors: [...this.status(sessionId).errors, ...errors] });
      return;
    }
    this.patch(sessionId, { errors });
    if (!accepted.length) return;
    const started = { files: accepted, controller: new AbortController() };
    this.queues.set(sessionId, started);
    void this.run(sessionId, started);
  }
  private async run(sessionId: string, queue: Queue): Promise<void> {
    const { signal } = queue.controller;
    for (let file = queue.files.shift(); file && !signal.aborted; file = queue.files.shift()) {
      this.patch(sessionId, { current: file.name, waiting: queue.files.length });
      try {
        const path = await this.send(sessionId, file, signal);
        if (!signal.aborted) this.patch(sessionId, { paths: [...this.status(sessionId).paths, path] });
      } catch (cause) {
        if (!signal.aborted) this.patch(sessionId, { errors: [...this.status(sessionId).errors, `${file.name}: ${localizeError(cause)}`] });
      }
    }
    if (this.queues.get(sessionId) !== queue) return;
    this.queues.delete(sessionId);
    this.patch(sessionId, { current: undefined, waiting: 0 });
  }
  /** Cancels what is still uploading and clears the errors. Paths already uploaded still reach the terminal. */
  close(sessionId: string): void {
    this.queues.get(sessionId)?.controller.abort();
    this.queues.delete(sessionId);
    this.patch(sessionId, { current: undefined, waiting: 0, errors: [] });
  }
  /** The uploaded paths, each handed over once. */
  take(sessionId: string): readonly string[] {
    const { paths } = this.status(sessionId);
    if (paths.length) this.patch(sessionId, { paths: [] });
    return paths;
  }
}
/** Uploads a file through the plugin's route; see workspace/tui-files.ts. */
export async function sendTuiFile(sessionId: string, file: File, signal: AbortSignal): Promise<string> {
  const response = await fetch(`/api/remote-terminals/tui-files?${new URLSearchParams({ sessionId, name: file.name })}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'X-DSH-Remote-Agents': '1', 'X-File-Size': String(file.size) }, body: file, signal,
  });
  const result = await response.json().catch(() => undefined) as { path?: string; error?: string } | undefined;
  if (!response.ok || !result?.path) throw new Error(result?.error ?? ui('File transfer failed ({status})', { status: response.status }));
  return result.path;
}

const INPUT = '.xterm-helper-textarea';
/**
 * Takes files dropped anywhere in the window, as a chat does. DSH keeps its composer mounted and hidden under what replaces
 * it, and that composer listens for drops on the document, so they are stopped before reaching it.
 * @param marker - an element of this conversation: nothing is taken while it is not displayed.
 * @param add - receives what was dropped.
 * @returns whether files are being dragged over the window.
 */
function useFileDrop(marker: React.RefObject<HTMLElement | null>, add: (picked: PickedFiles) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(add);
  latest.current = add;
  useEffect(() => {
    let depth = 0, watchdog: ReturnType<typeof setTimeout> | undefined;
    const end = () => { clearTimeout(watchdog); depth = 0; setDragging(false); };
    // Browsers repeat dragover while a drag hovers. Should the final dragleave go missing, the mask must not stay up.
    const hovering = () => { clearTimeout(watchdog); watchdog = setTimeout(end, 1000); };
    const claim = (event: DragEvent): event is DragEvent & { dataTransfer: DataTransfer } => {
      if (!event.dataTransfer?.types.includes('Files') || !marker.current?.getClientRects().length) return false;
      event.preventDefault(); event.stopPropagation();
      return true;
    };
    const enter = (event: DragEvent) => { if (claim(event)) { depth += 1; setDragging(true); hovering(); } };
    const over = (event: DragEvent) => { if (claim(event)) { event.dataTransfer.dropEffect = 'copy'; hovering(); } };
    const leave = (event: DragEvent) => { if (claim(event)) { depth = Math.max(0, depth - 1); if (!depth) end(); } };
    const drop = (event: DragEvent) => {
      if (!claim(event)) return;
      end();
      latest.current(pickFiles(event.dataTransfer));
      // A drop usually comes from another window. Typing should carry on here.
      document.querySelector<HTMLElement>(`[data-remote-agents-tui] ${INPUT}`)?.focus();
    };
    const listeners = { dragenter: enter, dragover: over, dragleave: leave, drop };
    for (const [type, listener] of Object.entries(listeners)) document.addEventListener(type, listener as EventListener, true);
    window.addEventListener('dragend', end);
    return () => {
      clearTimeout(watchdog);
      for (const [type, listener] of Object.entries(listeners)) document.removeEventListener(type, listener as EventListener, true);
      window.removeEventListener('dragend', end);
    };
  }, [marker]);
  return dragging;
}
/**
 * Takes files pasted into the terminal, and leaves copied text to it.
 * @param root - an element around the terminal.
 * @param add - receives what was pasted.
 */
export function useFilePaste(root: React.RefObject<HTMLElement | null>, add: (picked: PickedFiles) => void): void {
  const latest = useRef(add);
  latest.current = add;
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const paste = (event: ClipboardEvent) => {
      const picked = event.clipboardData ? pastedFiles(event.clipboardData) : undefined;
      if (!picked) return;
      event.preventDefault(); event.stopPropagation();
      latest.current(picked);
    };
    // The CLI's own Ctrl+V reads the clipboard of the remote machine, which is not the one the user copied on. The key
    // goes back to the terminal when there is no image here, so the terminal still sees it. A key sent back is not trusted.
    const key = (event: KeyboardEvent) => {
      if (!event.isTrusted || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || event.key.toLowerCase() !== 'v') return;
      event.preventDefault(); event.stopPropagation();
      if (event.repeat) return;
      const { target } = event;
      void clipboardImage().then(image => {
        if (image) latest.current({ files: [image], folders: [] });
        else pressControl(target, 'v');
      });
    };
    node.addEventListener('paste', paste, true);
    node.addEventListener('keydown', key, true);
    return () => { node.removeEventListener('paste', paste, true); node.removeEventListener('keydown', key, true); };
  }, [root]);
}
/**
 * Waits until the terminal can take input. DSH drops input until then, and coming back to a conversation reports the old
 * state until it has attached again, so this reads the current state rather than a rendered one. The screen arrives just
 * after the terminal turns writable, and with it whether the app asked for bracketed paste, so it waits one more check.
 * @param root - an element around the terminal.
 * @param terminal - DSH's terminal state.
 * @param act - receives the terminal's input, once.
 * @returns stops waiting.
 */
export function whenWritable(root: React.RefObject<HTMLElement | null>, terminal: { getSnapshot(): { writable?: boolean } }, act: (input: HTMLElement) => void): () => void {
  let ready = false;
  const timer = setInterval(() => {
    const input = root.current?.querySelector<HTMLElement>(INPUT);
    const usable = !!input && terminal.getSnapshot().writable !== false;
    if (!ready || !usable) { ready = usable; return; }
    clearInterval(timer);
    act(input);
  }, 150);
  return () => clearInterval(timer);
}
/**
 * Gives the terminal each uploaded file's path, once it can take input.
 * @param terminal - DSH's terminal state.
 */
export function useUploadedPaths(root: React.RefObject<HTMLElement | null>, sessionId: string, uploads: TuiUploads, terminal: { getSnapshot(): { writable?: boolean } }, cli: TuiCli): void {
  const { paths } = useSyncExternalStore(uploads.subscribe, () => uploads.status(sessionId));
  const afterImage = useRef(false);
  useEffect(() => {
    if (!paths.length) return;
    return whenWritable(root, terminal, input => {
      const taken = uploads.take(sessionId);
      for (const text of pastesFor(taken, afterImage.current, cli)) pasteIntoTerminal(input, text);
      afterImage.current = taken.some(path => CLAUDE_IMAGE.test(path));
    });
  }, [root, sessionId, uploads, terminal, paths, cli]);
}

/** Uses DSH's drop mask, so a drop looks the same here as in a chat. */
const dropStyles = `.ra-tui-drop{position:fixed;inset:0;z-index:1000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:0 40px;pointer-events:none;background-color:var(--dsw-alias-bg-mask-drop,rgba(127,127,127,.3));-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);color:var(--dsw-alias-label-primary,#222);text-align:center}
.ra-tui-drop-title{font:var(--dsw-font-l-20,500 20px/1.4 system-ui)}
.ra-tui-drop-hint{font:var(--dsw-font-s-14,14px/1.5 system-ui);color:var(--dsw-alias-label-tertiary,#888)}`;
export const fileStyles = `.ra-tui-files{position:absolute;top:12px;right:12px;z-index:2;box-sizing:border-box;display:flex;align-items:flex-start;gap:6px;max-width:min(440px,calc(100% - 24px));padding:6px 6px 6px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-3,#26272b);color:var(--dsw-alias-label-primary,#eee);box-shadow:var(--dsw-elevation-prominent,0 0 0 1px rgba(127,127,127,.25),0 8px 24px rgba(0,0,0,.3));font-size:13px;line-height:20px}
.ra-tui-files-text{min-width:0;overflow-wrap:anywhere}
.ra-tui-files-error{color:var(--dsw-alias-state-error-primary,#d64545)}
.ra-tui-files-close{flex:none;width:20px;height:20px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#aaa);font-size:15px;line-height:20px;cursor:pointer}
.ra-tui-files-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}`;

/**
 * Where a TUI conversation's composer would be. It stands in for the composer on every tab of the conversation, unlike the
 * terminal, which has only its own, so a file dropped on another tab reaches the terminal too rather than the hidden composer.
 */
export function TuiDropTarget({ sessionId, uploads, cli, icon }: { sessionId: string; uploads: TuiUploads; cli: string; icon: React.ReactNode }) {
  useLocale();
  const marker = useRef<HTMLDivElement>(null);
  const dragging = useFileDrop(marker, picked => uploads.add(sessionId, picked));
  return <div ref={marker}>
    {dragging && createPortal(<div className="ra-tui-drop" role="status">
      <style>{dropStyles}</style>
      {icon}
      <div className="ra-tui-drop-title">{ui('Drop files here to add them to {cli}', { cli })}</div>
      <div className="ra-tui-drop-hint">{ui('They are uploaded to the remote machine and their paths go into the prompt. Up to 50 MB each.')}</div>
    </div>, document.body)}
  </div>;
}
/** What is uploading and what failed: the terminal itself has nowhere to say so. */
export function TuiFileStatus({ sessionId, uploads }: { sessionId: string; uploads: TuiUploads }) {
  useLocale();
  const { current, waiting, errors } = useSyncExternalStore(uploads.subscribe, () => uploads.status(sessionId));
  if (!current && !errors.length) return null;
  const close = ui(current ? 'Cancel upload' : 'Dismiss');
  return <div className="ra-tui-files" role={errors.length ? 'alert' : 'status'}>
    <div className="ra-tui-files-text">
      {current && <div>{waiting ? ui('Uploading {name} and {count} more…', { name: current, count: waiting }) : ui('Uploading {name}…', { name: current })}</div>}
      {errors.map((error, index) => <div key={index} className="ra-tui-files-error">{error}</div>)}
    </div>
    {/* Keeps the focus in the terminal. */}
    <button type="button" className="ra-tui-files-close" aria-label={close} title={close} onMouseDown={event => event.preventDefault()} onClick={() => uploads.close(sessionId)}>×</button>
  </div>;
}
