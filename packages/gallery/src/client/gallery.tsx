import { ui, useLocale, formatLocale } from './i18n.js';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { MARKETS, currentWallpaper, protectedWallpaper, type Market, type Wallpaper } from '../domain.js';
import { type GalleryController } from './controller.js';
import { styles } from './styles.js';

type IconKind = 'gallery' | 'refresh' | 'upload' | 'search' | 'check' | 'trash' | 'close' | 'left' | 'right' | 'download' | 'plus' | 'minus';
export function Icon({ kind = 'gallery', size = 16 }: { kind?: IconKind; size?: number }) {
  const paths: Record<IconKind, React.ReactNode> = {
    gallery: <><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="16" cy="8" r="2" /><path d="m3 17 6-7 6 7 3-3 3 3" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.2 6.2A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.8 5.8" /></>,
    upload: <><path d="M12 16V3m-4 4 4-4 4 4M4 16v5h16v-5" /></>, search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    check: <path d="m5 12 4 4L19 6" />, trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />, left: <path d="m15 5-7 7 7 7" />, right: <path d="m9 5 7 7-7 7" />,
    download: <path d="M12 3v13m-4-4 4 4 4-4M4 17v4h16v-4" />, plus: <path d="M12 5v14M5 12h14" />, minus: <path d="M5 12h14" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}
function useImage(controller: GalleryController, id?: string) {
  const [image, setImage] = useState<{ id: string; url: string; type: string }>();
  useEffect(() => {
    if (!id) return;
    let cancelled = false; let url: string | undefined;
    void controller.storage.image(id).then(blob => {
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob); setImage({ id, url, type: blob.type });
    }, error => { if (!cancelled) controller.reportError(error); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [controller, id]);
  return image?.id === id ? image : undefined;
}

function Card({ controller, entry, current, disabled, protected: locked, onPreview }: {
  controller: GalleryController; entry: Wallpaper; current: boolean; disabled: boolean; protected: boolean; onPreview(): void;
}) {
  useLocale();
  const image = useImage(controller, entry.id);
  return <article className="gg-card" data-current={current} aria-label={entry.title}>
    <button className="gg-card-preview" aria-label={ui("Preview {0}", { 0: entry.title })} onClick={onPreview} disabled={!image}>
      {image ? <img src={image.url} alt={entry.title} loading="lazy" /> : <span>{ui("Loading image…")}</span>}
    </button>
    {current && <span className="gg-card-badge"><Icon kind="check" size={11} />{ui("Current background")}</span>}
    <div className="gg-card-info"><strong>{entry.title}</strong><p className="gg-card-date">{entry.date.slice(0, 10)}</p><p className="gg-card-copyright">{entry.source === "local" ? ui("Local uploads") : entry.copyright}</p></div>
    <div className="gg-card-actions">
      <button onClick={() => void controller.select(entry.id)} disabled={disabled || current} aria-label={ui("Set {0} as background", { 0: entry.title })}>{current ? ui("In use") : ui("Use")}</button>
      <button onClick={() => void controller.remove(entry.id)} disabled={disabled || locked} aria-label={ui("Delete {0}", { 0: entry.title })} title={locked ? ui("Switch backgrounds first; the latest daily wallpaper is kept") : ui("Delete from this device's gallery")}>{ui("Delete")}</button>
    </div>
  </article>;
}

function Lightbox({ controller, entries, id, onNavigate, onClose }: {
  controller: GalleryController; entries: Wallpaper[]; id: string; onNavigate(id: string): void; onClose(): void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const closePreview = useRef(onClose); closePreview.current = onClose;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const index = entries.findIndex(e => e.id === id); const entry = entries[index];
  const image = useImage(controller, id); const [zoom, setZoom] = useState(1);
  const active = snapshot.preferences.enabled && currentWallpaper(snapshot)?.id === id;
  useEffect(() => {
    const node = dialog.current; if (!node) return;
    const previous = document.activeElement;
    node.showModal();
    const holdModalKeys = (event: KeyboardEvent) => {
      if (!node.open || !['Escape', 'Tab'].includes(event.key)) return;
      // Applying an image can disable the focused action, leaving focus on body.
      // Capture these keys there too, before the host Settings layer handles them.
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); closePreview.current(); }
      // Native dialog modality owns the default Tab traversal.
    };
    document.addEventListener('keydown', holdModalKeys, true);
    return () => {
      document.removeEventListener('keydown', holdModalKeys, true); node.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => { setZoom(1); }, [id]);
  const navigate = (direction: number) => { const next = entries[index + direction]; if (next) onNavigate(next.id); };
  if (!entry) return null;
  return createPortal(<dialog className="gg-lightbox" ref={dialog} aria-label={ui("Image preview: {0}", { 0: entry.title })}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
      // The host Settings dialog owns document-level Escape and Tab handlers.
      // Keep those keys in this native dialog so closing a preview keeps Settings open.
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); navigate(1); }
    }}>
    <style>{styles}</style>
    <div className="gg-lightbox-inner">
      <header className="gg-lightbox-head"><div><strong>{entry.title}</strong><span>{entry.date.slice(0, 10)} · {index + 1} / {entries.length}</span></div><div className="gg-actions">
        <div className="gg-lightbox-zoom"><button className="gg-icon-button" aria-label={ui("Zoom out")} disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z - 0.25))}><Icon kind="minus" /></button><span>{Math.round(zoom * 100)}%</span><button className="gg-icon-button" aria-label={ui("Zoom in")} disabled={zoom >= 3} onClick={() => setZoom(z => Math.min(3, z + 0.25))}><Icon kind="plus" /></button></div>
        <button className="gg-icon-button" aria-label={ui("Close preview")} autoFocus onClick={onClose}><Icon kind="close" /></button>
      </div></header>
      <div className="gg-lightbox-view">
        <button className="gg-icon-button gg-lightbox-nav gg-lightbox-prev" aria-label={ui("Previous image")} disabled={index <= 0} onClick={() => navigate(-1)}><Icon kind="left" /></button>
        {image ? <div className="gg-lightbox-canvas" style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}><img src={image.url} alt={entry.title} /></div> : <span role="status">{ui("Loading image…")}</span>}
        <button className="gg-icon-button gg-lightbox-nav gg-lightbox-next" aria-label={ui("Next image")} disabled={index >= entries.length - 1} onClick={() => navigate(1)}><Icon kind="right" /></button>
      </div>
      <footer className="gg-lightbox-bottom"><div><p>{entry.source === "local" ? ui("Local uploads") : entry.copyright}</p>{entry.copyrightUrl && <a href={entry.copyrightUrl} target="_blank" rel="noopener noreferrer">{ui("View Bing image source ↗")}</a>}</div><div className="gg-actions">
        {image && <a className="gg-button" href={image.url} download={`${entry.title.replace(/[\\/:*?"<>|]/g, '_')}.${image.type === 'image/webp' ? 'webp' : image.type === 'image/png' ? 'png' : 'jpg'}`}><Icon kind="download" />{ui("Save image")}</a>}
        <button className="gg-button gg-primary" disabled={snapshot.busy || active || !image} onClick={() => void controller.select(id)}><Icon kind="check" />{active ? ui("Currently in use") : ui("Set as DSH background")}</button>
      </div></footer>
    </div>
  </dialog>, document.body);
}

export function GalleryPage({ controller }: { controller: GalleryController }) {
  useLocale();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { entries, preferences, loading, busy, error } = snapshot;
  const [filter, setFilter] = useState<'all' | 'bing' | 'local'>('all'); const [search, setSearch] = useState('');
  const [visible, setVisible] = useState(24); const [preview, setPreview] = useState<string>(); const upload = useRef<HTMLInputElement>(null);
  const current = currentWallpaper(snapshot); const currentImage = useImage(controller, current?.id);
  const displayed = entries.filter(e => (filter === 'all' || e.source === filter) && `${e.title} ${e.copyright} ${e.date}`.toLowerCase().includes(search.toLowerCase()));
  useEffect(() => { setVisible(24); }, [filter, search]);
  const activeId = preferences.enabled ? current?.id : undefined;
  return <section className="dsh-gallery" aria-label={ui("Gallery")}><style>{styles}</style>
    <header className="gg-header"><div className="gg-heading"><span className="gg-mark"><Icon size={25} /></span><div><h2>{ui("Gallery")}</h2><p className="gg-hint">{ui("A new view for DSH")}</p></div></div><div className="gg-actions">
      <button className="gg-button" disabled={busy || loading} onClick={() => upload.current?.click()}><Icon kind="upload" />{ui("Upload images")}</button>
      <button className="gg-button" disabled={busy || loading} onClick={() => void controller.refresh()}><span className={busy ? 'gg-spin' : undefined}><Icon kind="refresh" /></span>{busy ? ui("Working…") : ui("Update wallpapers")}</button>
    </div></header>
    <input className="gg-hidden-input" type="file" ref={upload} aria-label={ui("Upload local images")} accept="image/jpeg,image/png,image/webp" multiple onChange={event => {
      const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = '';
      if (files.length) void controller.upload(files);
    }} />
    {error && <div className="gg-notice" role="alert"><span>{ui(error)}</span><button className="gg-button" disabled={busy} onClick={() => void controller.refresh()}>{ui("Retry update")}</button></div>}
    <section className="gg-settings" aria-label={ui("Background settings")}>
      <div className="gg-setting-main"><div><div className="gg-setting-title">{ui("Use gallery background")}</div><p className="gg-hint">{ui("Show wallpapers in chat and the sidebar. Settings apply to this device only.")}</p></div><button className="gg-toggle" role="switch" aria-label={ui("Use gallery background")} aria-checked={preferences.enabled} disabled={loading || busy} onClick={() => void controller.enable(!preferences.enabled)}><span /></button></div>
      {current && <div className="gg-current">{currentImage && <img className="gg-current-image" src={currentImage.url} alt={ui("Current wallpaper")} />}<div className="gg-current-copy"><span className="gg-status"><i />{preferences.selectedId ? ui("Pinned wallpaper") : ui("Daily updates")}{!preferences.enabled ? ui(" · Background off") : ''}</span><strong>{current.title}</strong><p>{preferences.selectedId ? ui("New wallpapers are still saved without replacing this image.") : ui("{0} · Bing daily selection", { 0: current.date.slice(0, 10) })}</p></div><button className="gg-button" disabled={busy} onClick={() => void (preferences.selectedId ? controller.resumeDaily() : controller.select(current.id))}>{preferences.selectedId ? ui("Resume daily") : ui("Pin this image")}</button></div>}
      <details className="gg-appearance"><summary className="gg-hint" style={{ padding: '0 16px 12px', cursor: 'pointer' }}>{ui("Appearance and region")}</summary><div className="gg-controls">
        <PreferenceSlider controller={controller} label={ui("Image opacity")} name="opacity" value={preferences.opacity} max={100} unit="%" disabled={loading} />
        <PreferenceSlider controller={controller} label={ui("Background blur")} name="blur" value={preferences.blur} max={24} unit="px" disabled={loading} />
        <label className="gg-region"><span>{ui("Bing image region")}</span><select aria-label={ui("Bing image region")} value={preferences.market} disabled={busy || loading} onChange={event => void controller.changeMarket(event.target.value as Market)}>{Object.entries(MARKETS).map(([market, label]) => <option value={market} key={market}>{ui(label)}</option>)}</select></label>
      </div></details>
    </section>
    <div className="gg-library-head"><nav className="gg-tabs" aria-label={ui("Image source")}>{([['all', ui("All images")], ['bing', ui("Bing daily")], ['local', ui("Local uploads")]] as const).map(([value, label]) => <button className="gg-tab" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<small>{value === 'all' ? entries.length : entries.filter(e => e.source === value).length}</small></button>)}</nav><label className="gg-search"><Icon kind="search" size={14} /><input aria-label={ui("Search images")} type="search" placeholder={ui("Search images")} value={search} onChange={event => setSearch(event.target.value)} /></label></div>
    {loading && <div className="gg-loading" role="status">{ui("Loading local gallery…")}</div>}
    {!loading && busy && <div className="gg-loading" role="status">{ui("Processing images. Please wait…")}</div>}
    {!loading && displayed.length > 0 && <div className="gg-grid">{displayed.slice(0, visible).map(entry => <Card key={entry.id} controller={controller} entry={entry} current={activeId === entry.id} disabled={busy} protected={protectedWallpaper(snapshot, entry.id)} onPreview={() => setPreview(entry.id)} />)}</div>}
    {!loading && displayed.length === 0 && <div className="gg-empty" role="status"><Icon size={34} /><h3>{search ? ui("No matching images") : filter === 'local' ? ui("No local images yet") : ui("Keep your favorite views here")}</h3><p>{search ? ui("Try another name or date.") : ui("Get the last 8 days of Bing wallpapers or upload your own images as DSH backgrounds.")}</p>{!search && <button className="gg-button" disabled={busy} onClick={() => filter === 'local' ? upload.current?.click() : void controller.refresh()}>{filter === 'local' ? ui("Upload images") : ui("Get Bing wallpapers")}</button>}</div>}
    {displayed.length > visible && <div className="gg-more"><button className="gg-button" onClick={() => setVisible(n => n + 24)}>{ui("Load more · {0} remaining", { 0: displayed.length - visible })}</button></div>}
    <footer className="gg-footer"><span>{ui("Images stay on this device. Clearing app or site data deletes the gallery.")}</span>{preferences.lastSyncAt > 0 && <span>{ui("Updated")} {new Date(preferences.lastSyncAt).toLocaleString(formatLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}</footer>
    {preview && displayed.some(e => e.id === preview) && <Lightbox controller={controller} entries={displayed} id={preview} onNavigate={setPreview} onClose={() => setPreview(undefined)} />}
  </section>;
}

function PreferenceSlider({ controller, label, name, value, max, unit, disabled }: {
  controller: GalleryController; label: string; name: 'opacity' | 'blur'; value: number; max: number; unit: string; disabled: boolean;
}) {
  const scale = name === 'opacity' ? 100 : 1;
  const [draft, setDraft] = useState(Math.round(value * scale));
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { setDraft(Math.round(value * scale)); }, [value, scale]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <label className="gg-range"><span>{label}<output>{draft}{unit}</output></span><input aria-label={label} type="range" min="0" max={max} step="1" value={draft} disabled={disabled} onChange={event => {
    const next = Number(event.target.value); setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void controller.update({ [name]: next / scale }); }, 120);
  }} /></label>;
}
