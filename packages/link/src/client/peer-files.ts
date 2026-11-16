/**
 * Files given to another machine's page in the desktop window go to that machine.
 *
 * The desktop shell's preload exposes `__DSH_HOST_PATHS__` to every page of `dsh-app://app`, a mounted machine's page
 * included. DSH's composer asks it for a dropped, picked or pasted file's path on disk and, for a file that has one
 * (images aside), writes an `@path` reference instead of uploading it (dsh-client-ui-conversation `addFiles`, 0.2.2).
 * On a mounted page that path is on this computer, which the other machine cannot read. A copy of the file made in the
 * page has no path, so DSH uploads it, and the upload's relative route runs through the mount to the other machine.
 *
 * Drops and the attachment button follow Kivotos' approach (THIRD_PARTY_NOTICES.md); pastes are re-sent the same way,
 * since Chromium lets a script-made paste event carry files. A folder cannot be uploaded: its drop is refused with a
 * note. Outside the desktop window (a browser, a phone) there is no bridge and nothing is installed.
 */
import { mountedId } from '../rewrite.js';

interface HostPaths { pathFor(file: File): string }

/** The desktop preload's bridge; it answers '' for a file with no path on disk. */
export function hostPaths(): HostPaths | undefined {
  const bridge = (globalThis as { __DSH_HOST_PATHS__?: unknown }).__DSH_HOST_PATHS__;
  return typeof bridge === 'object' && bridge !== null && typeof (bridge as HostPaths).pathFor === 'function' ? bridge as HostPaths : undefined;
}

/** DSH's own drag of a file from its Files panel: a file of the page's machine, left alone. */
const DSH_FILE_DRAG = 'application/x-dsh-file';

const pathless = (file: File) => new File([file], file.name, { type: file.type, lastModified: file.lastModified });

function onDisk(paths: HostPaths, files: FileList): boolean {
  for (const file of Array.from(files)) { try { if (paths.pathFor(file)) return true; } catch { /* unknown: leave it */ } }
  return false;
}

/** A transfer with the same text and pathless copies of its files. */
function copyOf(transfer: DataTransfer): DataTransfer {
  const copy = new DataTransfer();
  for (const type of transfer.types) {
    if (type === 'Files') continue;
    try { copy.setData(type, transfer.getData(type)); } catch { /* a type the page may not read */ }
  }
  for (const file of Array.from(transfer.files)) copy.items.add(pathless(file));
  return copy;
}

function carriesDirectory(transfer: DataTransfer): boolean {
  return Array.from(transfer.items).some(item => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory === true);
}

/**
 * @param refuseFolder - tells the user a dropped folder stays here.
 * @returns the cleanup.
 */
export function installPeerFileIntake(refuseFolder: () => void): () => void {
  const paths = hostPaths();
  if (!paths || !mountedId(location.pathname)) return () => undefined;
  const ours = new WeakSet<Event>();

  // Capture listeners on the document run before DSH's own (document bubble, React's root, the editor), so the
  // original never reaches DSH; the copy is the same gesture with files DSH uploads.
  const onDrop = (event: DragEvent) => {
    const transfer = event.dataTransfer;
    if (ours.has(event) || !transfer || !transfer.types.includes('Files') || transfer.types.includes(DSH_FILE_DRAG)) return;
    if (carriesDirectory(transfer)) {
      event.preventDefault(); event.stopImmediatePropagation();
      // DSH clears its drop overlay on its own drop, which this one never reaches, or on leaving the window.
      const left = new DataTransfer();
      left.items.add(new File([], 'none'));
      const leave = new DragEvent('dragleave', { bubbles: true, cancelable: true, clientX: 0, clientY: 0, dataTransfer: left });
      ours.add(leave);
      document.documentElement.dispatchEvent(leave);
      refuseFolder();
      return;
    }
    if (!onDisk(paths, transfer.files)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const forwarded = new DragEvent('drop', { bubbles: true, cancelable: true, composed: true, dataTransfer: copyOf(transfer), clientX: event.clientX, clientY: event.clientY });
    ours.add(forwarded);
    (event.target instanceof EventTarget ? event.target : document).dispatchEvent(forwarded);
  };

  const onPaste = (event: ClipboardEvent) => {
    const clipboard = event.clipboardData;
    if (ours.has(event) || !clipboard || clipboard.files.length === 0 || !onDisk(paths, clipboard.files)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const forwarded = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: copyOf(clipboard) });
    ours.add(forwarded);
    (event.target instanceof EventTarget ? event.target : document).dispatchEvent(forwarded);
  };

  // The attachment button's hidden file input: DSH reads `input.files` in its own change handler, after this one.
  const onChange = (event: Event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.files?.length || !onDisk(paths, input.files)) return;
    const copy = new DataTransfer();
    for (const file of Array.from(input.files)) copy.items.add(pathless(file));
    input.files = copy.files;
  };

  document.addEventListener('drop', onDrop, true);
  document.addEventListener('paste', onPaste, true);
  document.addEventListener('change', onChange, true);
  return () => {
    document.removeEventListener('drop', onDrop, true);
    document.removeEventListener('paste', onPaste, true);
    document.removeEventListener('change', onChange, true);
  };
}
