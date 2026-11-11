import React, { useState } from 'react';
import { ROOT_FOLDER, type Folder, type FolderRule, type VersionFamily } from '../domain.js';
import { ui } from './i18n.js';
import { formatBytes, type TreeNode } from './model.js';

/** The folder tree. Top-level folders start open; a folder on the way to the selected one is always open. */
export function Tree({ root, selected, onSelect }: { root: TreeNode; selected: string; onSelect(path: string): void }) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const open = (node: TreeNode, depth: number) => (selected === node.path || selected.startsWith(`${node.path}/`)) || (depth < 1) !== toggled.has(node.path);
  const toggle = (path: string) => setToggled(old => { const next = new Set(old); if (!next.delete(path)) next.add(path); return next; });
  const row = (node: TreeNode, depth: number): React.ReactNode => {
    const expanded = node.children.length > 0 && open(node, depth);
    return <li key={node.path} role="treeitem" aria-expanded={node.children.length ? expanded : undefined} aria-selected={selected === node.path}>
      <div className="ga-tree-row" data-selected={selected === node.path || undefined} style={{ paddingLeft: 6 + depth * 12 }}>
        {node.children.length
          ? <button type="button" className="ga-caret" aria-label={ui(expanded ? 'Collapse' : 'Expand')} data-open={expanded || undefined} onClick={() => toggle(node.path)}>▸</button>
          : <span className="ga-caret" />}
        <button type="button" className="ga-tree-label" title={node.path} onClick={() => onSelect(node.path)}>{node.label}</button>
        <span className="ga-count">{node.count}</span>
      </div>
      {expanded && <ul role="group">{node.children.map(child => row(child, depth + 1))}</ul>}
    </li>;
  };
  return <nav className="ga-tree" aria-label={ui('Folders')}>
    <ul role="tree">
      <li role="treeitem" aria-selected={selected === ''}>
        <div className="ga-tree-row" data-selected={selected === '' || undefined} style={{ paddingLeft: 6 }}>
          <span className="ga-caret" />
          <button type="button" className="ga-tree-label" onClick={() => onSelect('')}>{ui('All folders')}</button>
          <span className="ga-count">{root.count}</span>
        </div>
      </li>
      {root.children.map(child => row(child, 0))}
    </ul>
  </nav>;
}

/** Sibling versioned folders side by side: how many images of each the code still refers to. */
export function Versions({ families, onShow, onRetire }: { families: VersionFamily[]; onShow(path: string): void; onRetire(path: string): void }) {
  if (!families.length) return <p className="ga-note">{ui('No versioned folders found. Folders that sit beside each other and differ only in a version, such as cast-v1 and cast-v2, are compared here.')}</p>;
  return <div className="ga-versions">
    <p className="ga-dim">{ui('Folders that differ only in a version. A version nothing refers to is a candidate for retiring; one that is partly in use is still live.')}</p>
    {families.map(family => <article key={family.id} className="ga-family">
      <h3>{family.dir && <span className="ga-dim">{family.dir}/</span>}{family.name || ui('(versions)')}</h3>
      <div className="ga-vrows" role="table">
        <div className="ga-vrow ga-vhead" role="row">
          <span role="columnheader">{ui('Version')}</span><span role="columnheader">{ui('Images')}</span><span role="columnheader">{ui('Usage')}</span>
          <span role="columnheader">{ui('In use')}</span><span role="columnheader">{ui('Maybe')}</span><span role="columnheader">{ui('Unreferenced')}</span>
          <span role="columnheader">{ui('Size')}</span><span />
        </div>
        {family.versions.map((version, index) => {
          const unused = version.total - version.used - version.maybe, dead = version.used + version.maybe === 0;
          return <div key={version.label} className="ga-vrow" role="row" data-dead={dead || undefined}>
            <span role="cell" className="ga-vlabel">{version.label}
              {index === family.versions.length - 1 && <b className="ga-tag">{ui('latest')}</b>}
              {dead && <b className="ga-tag" data-tone="warn">{ui('no references')}</b>}
            </span>
            <span role="cell">{version.total}</span>
            <span role="cell" className="ga-usage-bar" aria-hidden="true">
              {version.used > 0 && <i data-usage="used" style={{ flexGrow: version.used }} />}
              {version.maybe > 0 && <i data-usage="maybe" style={{ flexGrow: version.maybe }} />}
              {unused > 0 && <i data-usage="unused" style={{ flexGrow: unused }} />}
            </span>
            <span role="cell">{version.used}</span><span role="cell">{version.maybe}</span><span role="cell">{unused}</span>
            <span role="cell">{formatBytes(version.bytes)}</span>
            <span role="cell" className="ga-vactions"><button type="button" className="ga-button" onClick={() => onShow(version.path)}>{ui('Show')}</button>
              <button type="button" className="ga-button" onClick={() => onRetire(version.path)}>{ui('Retire…')}</button></span>
          </div>;
        })}
      </div>
    </article>)}
  </div>;
}

/** Which top-level folders are listed as images, and which are read as code. Nothing is saved until Apply. */
export function FolderSettings({ folders, retireDir, busy, onApply, onClose, onHide }: { folders: Folder[]; retireDir: string; busy: boolean; onApply(rules: Record<string, FolderRule>, retireDir: string): void; onClose(): void; onHide?(): void }) {
  const [retire, setRetire] = useState(retireDir);
  const [draft, setDraft] = useState<Record<string, FolderRule>>(() => Object.fromEntries(folders.map(folder => [folder.name, { assets: folder.assets, code: folder.code }])));
  const set = (name: string, key: keyof FolderRule, value: boolean) => setDraft(old => ({ ...old, [name]: { ...old[name], [key]: value } }));
  return <div className="ga-overlay" role="dialog" aria-modal="true" aria-label={ui('Folders to scan')} onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="ga-dialog">
      <h3>{ui('Folders to scan')}</h3>
      <p className="ga-dim">{ui('“Images” lists a folder’s pictures. “Code” reads a folder’s code for references: switch it off for build scripts or generator output to see only what the game itself loads.')}</p>
      <div className="ga-folders" role="table">
        <div className="ga-frow ga-vhead" role="row"><span role="columnheader">{ui('Folder')}</span><span role="columnheader">{ui('Images')}</span><span role="columnheader">{ui('Code')}</span></div>
        {folders.map(folder => <div key={folder.name} className="ga-frow" role="row">
          <span role="cell" className="ga-fname">{folder.name === ROOT_FOLDER ? ui('(workspace root)') : folder.name}</span>
          <label role="cell"><input type="checkbox" disabled={!folder.images} checked={draft[folder.name].assets && folder.images > 0} onChange={event => set(folder.name, 'assets', event.target.checked)} /> {folder.images}</label>
          <label role="cell"><input type="checkbox" disabled={!folder.codeFiles} checked={draft[folder.name].code && folder.codeFiles > 0} onChange={event => set(folder.name, 'code', event.target.checked)} /> {folder.codeFiles}</label>
        </div>)}
      </div>
      <label className="ga-field">{ui('Retired images go to')}
        <input className="ga-search" value={retire} maxLength={200} spellCheck={false} onChange={event => setRetire(event.target.value)} />
      </label>
      <p className="ga-actions ga-end">
        {onHide && <button type="button" className="ga-button ga-start" title={ui('Stops showing the Assets tab for this workspace. The plugin’s settings page brings it back.')} onClick={onHide}>{ui('Hide tab for this workspace')}</button>}
        <button type="button" className="ga-button" onClick={onClose}>{ui('Cancel')}</button>
        <button type="button" className="ga-button" data-primary disabled={busy} onClick={() => onApply(draft, retire.trim() || retireDir)}>{ui('Apply and rescan')}</button>
      </p>
    </div>
  </div>;
}
