import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from '@dsh-plugins/i18n/react';
import { ROOT_FOLDER, type Asset, type FolderRule, type ScanResult } from '../domain.js';
import { configureFolders, moveAssets, noteAsset, scanWorkspace, tagAssets } from './api.js';
import { RetireDialog, SendDialog, TagDialog } from './dialogs.js';
import { Detail } from './detail.js';
import { Grid } from './grid.js';
import { i18n, localizeError, ui } from './i18n.js';
import { chooseProject, useProject } from './projects.js';
import { UNTAGGED, USAGE_FILTERS, buildTree, filterAssets, formatBytes, sameName, sortAssets, tagCounts, usageCounts, type Filter, type Sort, type UsageFilter } from './model.js';
import { styles } from './styles.js';
import { FolderSettings, Tree, Versions } from './views.js';

const FILTER_LABEL: Record<UsageFilter, string> = { all: 'All', used: 'In use', maybe: 'Maybe', unused: 'Unreferenced', dup: 'Duplicates', retired: 'Retired' };
const SIZES = [64, 96, 144] as const;
/** Below this width the folder tree and the detail pane lie over the grid instead of beside it. */
const NARROW = 760;
/** The last scan of each conversation, so coming back to the tab shows it at once. */
const scans = new Map<string, ScanResult>();

const PATHS = {
  tree: 'M2.5 3.5h4l1.5 1.5h5.5v7.5h-11z', copy: 'M5.5 5.5h7v8h-7zM3.5 10.5v-8h7', folders: 'M3 4h10M3 8h10M3 12h10M6 2.8v2.4M10 6.8v2.4M5 10.8v2.4',
  check: 'M2.5 2.5h11v11h-11zM5 8.2l2.2 2.2L11.2 6',
  rescan: 'M13 3v3.5H9.5M3 13V9.5h3.5M4.2 6A4.5 4.5 0 0 1 12.6 5.7M11.8 10A4.5 4.5 0 0 1 3.4 10.3', size: 'M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z',
} as const;
const Tool = ({ label, icon, ...props }: { label: string; icon: keyof typeof PATHS } & React.ButtonHTMLAttributes<HTMLButtonElement>) =>
  <button type="button" className="ga-tool" title={label} aria-label={label} {...props}>
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[icon]} /></svg>
  </button>;

async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* plain HTTP has no clipboard API */ }
  const area = document.createElement('textarea');
  area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.append(area); area.select();
  try { document.execCommand?.('copy'); } finally { area.remove(); }
}

export interface PanelProps {
  sessionId?: string;
  /** Opens a workspace file beside the conversation. */
  openFile?(sessionId: string, path: string, line?: number): void;
  /** Adds text to the conversation's chat input; answers false when the host could not take it. */
  sendToChat?(sessionId: string, text: string): Promise<boolean>;
}

/** The Assets tab of a conversation: every image of its workspace, and whether the code still uses it. */
export function AssetsPanel({ sessionId, openFile, sendToChat }: PanelProps) {
  useLocale(i18n);
  const { status, failed } = useProject(sessionId), [error, setError] = useState('');
  const note = (body: React.ReactNode) => <section className="ga-root"><style>{styles}</style><div className="ga-note">{body}</div></section>;
  if (!sessionId) return note(ui('Open a conversation to see the images of its workspace.'));
  // The tab is registered for every conversation at once; beside a game project, another workspace may be on screen too.
  if (status && !status.game && status.mode === 'games' && status.root !== null) return note(<>
    <p>{ui('“{name}” does not look like a game project, so its images are not scanned.', { name: status.root })}</p>
    <p><button type="button" className="ga-button" onClick={() => { void chooseProject(sessionId, true).catch(e => setError(localizeError(e))); }}>{ui('Show assets for this workspace')}</button></p>
    {error && <p role="alert">{error}</p>}
  </>);
  // Without an answer the scan still runs and reports what is wrong itself.
  if (!status && !failed) return note(null);
  return <Workspace key={sessionId} sessionId={sessionId} openFile={openFile} sendToChat={sendToChat} />;
}

type DialogKind = 'retire' | 'tag' | 'send';

function Workspace({ sessionId, openFile, sendToChat }: { sessionId: string; openFile?: PanelProps['openFile']; sendToChat?: PanelProps['sendToChat'] }) {
  const [result, setResult] = useState(scans.get(sessionId)), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [view, setView] = useState<'browse' | 'versions'>('browse');
  const [filter, setFilter] = useState<Filter>({ query: '', usage: 'all', folder: '', tag: '' });
  const [sort, setSort] = useState<Sort>('path'), [size, setSize] = useState<number>(SIZES[1]);
  const [selected, setSelected] = useState<string>(), [settings, setSettings] = useState(false), [notice, setNotice] = useState('');
  const [narrow, setNarrow] = useState(false), [treeOpen, setTreeOpen] = useState<boolean>();
  /** Images picked for an action, and the dialog that acts on some images: the picked ones, a version's, or the one in the detail pane. */
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set()), [dialog, setDialog] = useState<{ kind: DialogKind; paths: string[] }>();
  const root = useRef<HTMLElement>(null), alive = useRef(true), lastChecked = useRef<string>();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => {
    const element = root.current!;
    const measure = () => setNarrow(element.clientWidth > 0 && element.clientWidth < NARROW);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const adopt = useCallback((next: ScanResult) => { scans.set(sessionId, next); if (alive.current) setResult(next); }, [sessionId]);
  const run = useCallback(async (task: () => Promise<ScanResult>) => {
    setBusy(true); setError('');
    try { adopt(await task()); return true; }
    catch (e) { if (alive.current) setError(localizeError(e)); return false; } finally { if (alive.current) setBusy(false); }
  }, [adopt]);
  useEffect(() => { if (!scans.has(sessionId)) void run(() => scanWorkspace(sessionId, false)); }, [sessionId, run]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const assets = result?.assets ?? [];
  const counts = useMemo(() => usageCounts(assets, filter), [assets, filter]);
  const tree = useMemo(() => buildTree(assets, filter), [assets, filter.query, filter.usage, filter.tag]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = useMemo(() => sortAssets(filterAssets(assets, filter), sort), [assets, filter, sort]);
  const twinsOf = useMemo(() => sameName(assets), [assets]);
  const tags = useMemo(() => tagCounts(assets), [assets]), tagNames = useMemo(() => tags.map(([tag]) => tag), [tags]);
  const chosen = useMemo(() => selected ? assets.find(asset => asset.path === selected) : undefined, [assets, selected]);
  const picked = useMemo(() => assets.filter(asset => checked.has(asset.path)), [assets, checked]);
  const subject = useMemo(() => { const paths = new Set(dialog?.paths); return assets.filter(asset => paths.has(asset.path)); }, [assets, dialog]);
  const bytes = useMemo(() => items.reduce((sum, asset) => sum + asset.size, 0), [items]);
  const shelf = filter.usage === 'retired';

  const select = useCallback((path: string) => setSelected(path), []);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  /** Checks or unchecks one image; with Shift, everything from the image checked before to this one is checked. */
  const check = useCallback((path: string, range: boolean) => {
    const list = itemsRef.current, from = range && lastChecked.current ? list.findIndex(asset => asset.path === lastChecked.current) : -1, to = list.findIndex(asset => asset.path === path);
    setChecked(old => {
      const next = new Set(old);
      if (from >= 0 && to >= 0) for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(list[i].path);
      else if (!next.delete(path)) next.add(path);
      return next;
    });
    lastChecked.current = path;
  }, []);
  const clearChecked = () => { setChecked(new Set()); lastChecked.current = undefined; };
  /** Live and retired images are acted on differently, so a selection does not survive moving between them. */
  const changeFilter = (next: Filter) => { if ((next.usage === 'retired') !== shelf) clearChecked(); setFilter(next); };
  /** Shows an image that the current filter may hide, such as another copy picked in the detail pane. */
  const reveal = (path: string) => {
    if (!items.some(asset => asset.path === path)) changeFilter({ query: '', usage: assets.find(asset => asset.path === path)?.retired ? 'retired' : 'all', folder: '', tag: '' });
    setSelected(path);
  };
  const copy = (text: string, message: string) => { void copyText(text).then(() => { if (alive.current) setNotice(message); }, () => {}); };
  const showTree = treeOpen ?? !narrow;
  const codeFolders = result?.folders.filter(folder => folder.code && folder.codeFiles).map(folder => folder.name === ROOT_FOLDER ? ui('(workspace root)') : folder.name) ?? [];
  const applyFolders = (rules: Record<string, FolderRule>, retireDir: string) => {
    void run(() => configureFolders(sessionId, rules, retireDir === result?.retireDir ? undefined : retireDir)).then(ok => { if (ok && alive.current) { setSettings(false); setSelected(undefined); clearChecked(); setFilter(old => ({ ...old, folder: '' })); } });
  };

  /** Retires or restores images, then shows the workspace as the host now finds it. Images that did not move are named. */
  const move = (action: 'retire' | 'restore', paths: string[]) => {
    let report = '';
    void run(async () => {
      const answer = await moveAssets(sessionId, action, paths);
      if (answer.failed.length) report = ui('{count} images were left where they are. {path}: {error}', { count: answer.failed.length, path: answer.failed[0].path, error: ui(answer.failed[0].error) });
      if (alive.current && answer.moved) setNotice(ui(action === 'retire' ? 'Retired {count} images' : 'Restored {count} images', { count: answer.moved }));
      return answer.scan;
    }).then(ok => {
      if (!alive.current) return;
      if (ok) { setDialog(undefined); clearChecked(); setSelected(undefined); }
      if (report) setError(report);
    });
  };
  /** Tags and notes are saved at once and shown without another scan. */
  const patch = (change: (asset: Asset) => Asset) => { const current = scans.get(sessionId); if (current) adopt({ ...current, assets: current.assets.map(change) }); };
  const tag = (paths: string[], add: string[], remove: string[]) => {
    setBusy(true); setError('');
    tagAssets(sessionId, paths, add, remove).then(answer => patch(asset => {
      if (!(asset.path in answer.tags)) return asset;
      const { tags: _old, ...rest } = asset, next = answer.tags[asset.path];
      return next.length ? { ...rest, tags: next } : rest;
    }), e => { if (alive.current) setError(localizeError(e)); }).finally(() => { if (alive.current) setBusy(false); });
  };
  const note = (path: string, text: string) => {
    noteAsset(sessionId, path, text).then(answer => patch(asset => {
      if (asset.path !== path) return asset;
      const { note: _old, ...rest } = asset;
      return answer.note ? { ...rest, note: answer.note } : rest;
    }), e => { if (alive.current) setError(localizeError(e)); });
  };
  /** Hands the request to the chat input; a host that cannot take it gets it on the clipboard instead. */
  const send = (text: string) => {
    setDialog(undefined);
    void (sendToChat ? sendToChat(sessionId, text) : Promise.resolve(false)).then(taken => taken ? (alive.current && setNotice(ui('Added to the chat input'))) : copy(text, ui('Copied. Paste it into the chat input.')));
  };
  const pickedPaths = () => picked.map(asset => asset.path);
  const allShown = items.length > 0 && items.every(asset => checked.has(asset.path));

  return <section className="ga-root" ref={root} data-narrow={narrow || undefined} aria-label={ui('Assets')} aria-busy={busy}><style>{styles}</style>
    <header className="ga-bar">
      <div className="ga-seg" role="tablist">
        <button type="button" role="tab" aria-selected={view === 'browse'} onClick={() => setView('browse')}>{ui('Browse')}</button>
        <button type="button" role="tab" aria-selected={view === 'versions'} onClick={() => setView('versions')}>{ui('Versions')}{!!result?.families.length && <span className="ga-count">{result.families.length}</span>}</button>
      </div>
      {view === 'browse' && <>
        <Tool label={ui('Folders')} icon="tree" aria-pressed={showTree} onClick={() => setTreeOpen(!showTree)} />
        <input type="search" className="ga-search" placeholder={ui('Search by name, path or tag')} aria-label={ui('Search by name, path or tag')} value={filter.query} onChange={event => setFilter({ ...filter, query: event.target.value })} />
        <div className="ga-chips" role="group" aria-label={ui('Usage')}>
          {USAGE_FILTERS.filter(usage => usage !== 'retired' || counts.retired > 0 || shelf).map(usage => <button key={usage} type="button" className="ga-chip" data-usage={usage} aria-pressed={filter.usage === usage} onClick={() => changeFilter({ ...filter, usage, folder: (usage === 'retired') === shelf ? filter.folder : '' })}>
            {usage !== 'all' && usage !== 'dup' && <i className="ga-dot" />}{ui(FILTER_LABEL[usage])}<span className="ga-count">{counts[usage]}</span>
          </button>)}
        </div>
      </>}
      <span className="ga-tools">
        {view === 'browse' && <>
          {tags.length > 0 && <select className="ga-select" aria-label={ui('Tag')} value={filter.tag ?? ''} onChange={event => setFilter({ ...filter, tag: event.target.value })}>
            <option value="">{ui('All tags')}</option>
            {tags.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}
            <option value={UNTAGGED}>{ui('Untagged')}</option>
          </select>}
          <select className="ga-select" aria-label={ui('Sort')} value={sort} onChange={event => setSort(event.target.value as Sort)}>
            <option value="path">{ui('By folder')}</option><option value="size">{ui('Largest file first')}</option><option value="pixels">{ui('Largest picture first')}</option>
          </select>
          <Tool label={ui('Thumbnail size')} icon="size" onClick={() => setSize(SIZES[(SIZES.indexOf(size as typeof SIZES[number]) + 1) % SIZES.length])} />
          <Tool label={ui(allShown ? 'Clear the selection' : 'Select the {count} images shown', { count: items.length })} icon="check" aria-pressed={allShown} disabled={!items.length}
            onClick={() => allShown ? clearChecked() : setChecked(new Set([...checked, ...items.map(asset => asset.path)]))} />
          <Tool label={ui('Copy the paths of the {count} images shown', { count: items.length })} icon="copy" disabled={!items.length}
            onClick={() => copy(items.map(asset => asset.path).join('\n'), ui('Copied {count} paths', { count: items.length }))} />
        </>}
        <Tool label={ui('Folders to scan')} icon="folders" disabled={!result} onClick={() => setSettings(true)} />
        <Tool label={ui('Scan again')} icon="rescan" disabled={busy} onClick={() => void run(() => scanWorkspace(sessionId, true))} />
      </span>
    </header>
    {error && <div className="ga-banner" data-tone="error" role="alert">{error}</div>}
    {result?.truncated && <div className="ga-banner" data-tone="warn" role="status">{ui('This workspace has more files than one scan reads. Switch off folders you do not need under “Folders to scan”.')}</div>}
    {picked.length > 0 && view === 'browse' && <div className="ga-selbar" role="toolbar" aria-label={ui('Selection')}>
      <b>{ui('{count} selected', { count: picked.length })}</b>
      <button type="button" className="ga-button" onClick={clearChecked}>{ui('Clear')}</button>
      <span className="ga-tools">
        <button type="button" className="ga-button" onClick={() => setDialog({ kind: 'tag', paths: pickedPaths() })}>{ui('Tag…')}</button>
        {shelf ? <button type="button" className="ga-button" disabled={busy || !picked.some(asset => asset.origin)} onClick={() => move('restore', picked.filter(asset => asset.origin).map(asset => asset.path))}>{ui('Restore')}</button>
          : <button type="button" className="ga-button" disabled={busy} onClick={() => setDialog({ kind: 'retire', paths: pickedPaths() })}>{ui('Retire…')}</button>}
        <button type="button" className="ga-button" onClick={() => setDialog({ kind: 'send', paths: pickedPaths() })}>{ui('Ask the agent…')}</button>
      </span>
    </div>}
    <div className="ga-main">
      {!result ? !error && <p className="ga-note" role="status">{ui('Scanning the workspace…')}</p>
        : view === 'versions' ? <Versions families={result.families} onShow={path => { changeFilter({ query: '', usage: 'all', folder: path, tag: '' }); setSelected(undefined); setView('browse'); }}
            onRetire={path => setDialog({ kind: 'retire', paths: assets.filter(asset => !asset.retired && asset.path.startsWith(`${path}/`)).map(asset => asset.path) })} />
        : !assets.length ? <p className="ga-note">{ui('No images found in the folders being scanned. Check “Folders to scan”.')}</p>
        : <>
          {showTree && <Tree root={tree} selected={filter.folder} onSelect={folder => { setFilter({ ...filter, folder }); if (narrow) setTreeOpen(false); }} />}
          <Grid sessionId={sessionId} items={items} size={size} selected={selected} checked={checked} onSelect={select} onCheck={check} />
          {chosen && <Detail sessionId={sessionId} asset={chosen} result={result} twins={twinsOf(chosen)} onSelect={reveal} onClose={() => setSelected(undefined)}
            onCopy={text => copy(text, ui('Copied'))} openFile={openFile && ((path, line) => openFile(sessionId, path, line))}
            knownTags={tagNames} onTag={(add, remove) => tag([chosen.path], add, remove)} onNote={text => note(chosen.path, text)}
            onMove={() => chosen.retired ? move('restore', [chosen.path]) : setDialog({ kind: 'retire', paths: [chosen.path] })} />}
        </>}
    </div>
    {result && <footer className="ga-status">
      <span>{busy ? ui('Working…') : notice || (view === 'browse' ? ui('{count} images · {size}', { count: items.length, size: formatBytes(bytes) }) : ui('{count} images · {size}', { count: assets.length, size: formatBytes(assets.reduce((sum, asset) => sum + asset.size, 0)) }))}</span>
      {filter.folder && view === 'browse' && <span className="ga-status-folder" title={filter.folder}>{filter.folder}</span>}
      <span className="ga-status-end" title={ui('Scanned at {time} in {seconds} s', { time: new Date(result.scannedAt).toLocaleTimeString(i18n.formatLocale()), seconds: (result.durationMs / 1000).toFixed(1) })}>
        {codeFolders.length ? ui('References read from {count} files in: {folders}', { count: result.codeFiles, folders: codeFolders.join(', ') }) : ui('No folder is read as code, so nothing counts as in use.')}
      </span>
    </footer>}
    {settings && result && <FolderSettings folders={result.folders} retireDir={result.retireDir} busy={busy} onApply={applyFolders} onClose={() => setSettings(false)}
      onHide={() => { void chooseProject(sessionId, false).catch(e => { if (alive.current) setError(localizeError(e)); }); setSettings(false); }} />}
    {dialog && result && subject.length > 0 && (dialog.kind === 'retire' ? <RetireDialog assets={subject} retireDir={result.retireDir} busy={busy} onConfirm={() => move('retire', subject.map(asset => asset.path))} onClose={() => setDialog(undefined)} />
      : dialog.kind === 'tag' ? <TagDialog assets={subject} known={tagNames} busy={busy} onChange={(add, remove) => tag(subject.map(asset => asset.path), add, remove)} onClose={() => setDialog(undefined)} />
      : <SendDialog assets={subject} onSend={send} onClose={() => setDialog(undefined)} />)}
  </section>;
}
