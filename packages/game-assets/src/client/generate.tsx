/**
 * Generating a picture with an image source: what to draw, with which images as references, then a look at the result
 * beside the image it stands in for before anything is written. Saving puts it at a free path, or in place of that
 * image, which is retired first and can be restored.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { extensionOf, isReference, type Aspect, type Asset, type GeneratedImage, type SaveResult } from '../domain.js';
import { generatePicture, savePicture } from './api.js';
import { Picture } from './grid.js';
import { THUMB_LIMIT, useImage } from './thumbs.js';
import { localizePictureError, ui } from './i18n.js';
import { dirOf, fitScale, nameOf, stemOf } from './model.js';
import { aspectOf, base64Of, blobOf, defaultFit, hasTransparency, mimeOfPath, renderPicture, type FitMode } from './picture.js';
import { KIND_LABEL, SourceSettings, useSources } from './sources.js';

/** `wanted`, or the first numbered variant of it that no listed image has. */
export function freePath(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted;
  const extension = extensionOf(wanted), stem = wanted.slice(0, wanted.length - extension.length - 1);
  for (let n = 2; ; n++) if (!taken.has(`${stem}-${n}.${extension}`)) return `${stem}-${n}.${extension}`;
}
/** Where a picture is offered to be saved: beside the image it redraws, or in the folder being looked at. */
export function suggestedPath(target: Asset | undefined, folder: string, references: readonly Asset[], taken: ReadonlySet<string>): string {
  if (target) return freePath(`${dirOf(target.path) ? `${dirOf(target.path)}/` : ''}${stemOf(target.path)}-redraw.${isReference(target.path) ? extensionOf(target.path) : 'png'}`, taken);
  const dir = folder || (references[0] ? dirOf(references[0].path) : '');
  return freePath(`${dir ? `${dir}/` : ''}generated.png`, taken);
}

const ASPECT_LABEL: Record<Aspect, string> = { square: 'Square', wide: 'Wide', tall: 'Tall' };
const FIT_LABEL: Record<FitMode, string> = { smooth: 'Smooth', pixel: 'Sharp pixels', none: 'Keep the API’s size' };

export interface GenerateProps {
  sessionId: string;
  /** The image the picture stands in for: it is sent first, the picture is sized to it, and it may be replaced. */
  target?: Asset;
  /** Images sent as references, the target among them. */
  references: Asset[];
  /** Every image of the scan, so that a suggested path is free. */
  assets: readonly Asset[];
  /** The folder being looked at, where a new picture goes. */
  folder: string;
  retireDir: string;
  onSaved(result: SaveResult, replaced: boolean): void;
  onClose(): void;
}

interface Result { image: GeneratedImage; blob: Blob; url: string }

/** Tells whether an image has see-through pixels, once its picture has loaded. */
function TransparencyProbe({ sessionId, asset, onResult }: { sessionId: string; asset: Asset; onResult(transparent: boolean): void }) {
  const url = useImage(sessionId, asset, THUMB_LIMIT);
  useEffect(() => {
    if (!url) return;
    let gone = false;
    void hasTransparency(url).then(found => { if (!gone && found !== undefined) onResult(found); });
    return () => { gone = true; };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export function GenerateDialog({ sessionId, target, references: given, assets, folder, retireDir, onSaved, onClose }: GenerateProps) {
  const { answer, error: sourcesError } = useSources();
  const [sourceId, setSourceId] = useState<string>(), [managing, setManaging] = useState(false);
  const [references, setReferences] = useState(() => given.filter(asset => isReference(asset.path)));
  const skipped = given.length - given.filter(asset => isReference(asset.path)).length;
  const [prompt, setPrompt] = useState(() => target ? ui('Redraw this image in the same art style. Keep the subject, the pose and the framing.') : '');
  const [aspect, setAspect] = useState<Aspect>(() => aspectOf(target?.width, target?.height));
  const [transparent, setTransparent] = useState(() => target ? /^(png|webp)$/.test(extensionOf(target.path)) : true), [chosenTransparent, setChosenTransparent] = useState(false);
  const [fit, setFit] = useState<FitMode>(() => defaultFit(target?.width, target?.height));
  const taken = useMemo(() => new Set(assets.map(asset => asset.path)), [assets]);
  const [path, setPath] = useState(() => suggestedPath(target, folder === retireDir || folder.startsWith(`${retireDir}/`) ? '' : folder, given, taken));
  const [running, setRunning] = useState<{ controller: AbortController; started: number }>(), [now, setNow] = useState(Date.now());
  const [result, setResult] = useState<Result>(), [preview, setPreview] = useState<string>(), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const alive = useRef(true);

  const sources = answer?.sources ?? [];
  const source = sources.find(entry => entry.id === sourceId) ?? sources.find(entry => entry.id === answer?.defaultId) ?? sources[0];
  const size = target?.width && target.height ? { width: target.width, height: target.height } : undefined;
  const canReplace = !!target && !target.retired && isReference(target.path);
  /** Gemini draws no transparency; an opaque picture is cropped to fill the original's size rather than padded. */
  const alpha = transparent && source?.kind !== 'gemini';

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Closing the dialog stops a generation that is still running.
  useEffect(() => () => running?.controller.abort(), [running]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);
  // The preview shows the picture as it will be saved, fitted to the original.
  useEffect(() => {
    if (!result) { setPreview(undefined); return; }
    if (fit === 'none' || !size) { setPreview(result.url); return; }
    let url: string | undefined, gone = false;
    renderPicture(result.blob, 'image/png', fit, size, !alpha).then(blob => { if (gone) return; url = URL.createObjectURL(blob); setPreview(url); }, e => { if (!gone) { setPreview(result.url); setError(localizePictureError(e)); } });
    return () => { gone = true; if (url) URL.revokeObjectURL(url); };
  }, [result, fit, alpha, size?.width, size?.height]); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = () => {
    if (!source) return;
    const controller = new AbortController();
    setRunning({ controller, started: Date.now() }); setNow(Date.now()); setError('');
    generatePicture(sessionId, { sourceId: source.id, prompt, references: references.map(asset => asset.path), aspect, transparent: alpha }, controller.signal)
      .then(image => {
        if (!alive.current || controller.signal.aborted) return;
        const blob = blobOf(image.data, image.mediaType);
        setResult({ image, blob, url: URL.createObjectURL(blob) });
      }, e => { if (alive.current && !controller.signal.aborted) setError(localizePictureError(e)); })
      .finally(() => { if (alive.current) setRunning(old => old?.controller === controller ? undefined : old); });
  };
  const stop = () => { running?.controller.abort(); setRunning(undefined); };
  const save = async (replace: boolean) => {
    if (!result) return;
    const where = replace && target ? target.path : path.trim(), type = mimeOfPath(where);
    if (!type) { setError(ui('Save pictures as .png, .webp or .jpg files in a visible folder of the workspace')); return; }
    setSaving(true); setError('');
    try {
      const blob = await renderPicture(result.blob, type, fit, size, !alpha);
      const saved = await savePicture(sessionId, where, await base64Of(blob), replace);
      if (alive.current) onSaved(saved, replace);
    } catch (e) { if (alive.current) { setError(localizePictureError(e)); setSaving(false); } }
  };

  const seconds = running ? Math.max(0, Math.round((now - running.started) / 1000)) : 0;
  /** The new picture is enlarged as the original beside it is, so a small sprite can be compared pixel for pixel. */
  const shown = fit !== 'none' && size ? size : result?.image.width ? { width: result.image.width, height: result.image.height! } : undefined;
  const scale = fitScale(shown?.width, shown?.height, 220);
  const title = target ? ui('Redraw {name}', { name: nameOf(target.path) }) : ui('Generate a picture');
  return <div className="ga-overlay" role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="ga-dialog ga-gen"><h3>{title}</h3>
      {target && !chosenTransparent && /^(png|webp)$/.test(extensionOf(target.path)) && <TransparencyProbe sessionId={sessionId} asset={target} onResult={setTransparent} />}
      {sourcesError && <div className="ga-banner" data-tone="error" role="alert">{sourcesError}</div>}
      {answer && !sources.length ? <>
        <p>{ui('No image source yet. Add an OpenAI-compatible or Gemini API to generate pictures here.')}</p>
        <SourceSettings adding onAdded={setSourceId} />
        <p className="ga-actions ga-end"><button type="button" className="ga-button" onClick={onClose}>{ui('Close')}</button></p>
      </> : <>
        <div className="ga-field">
          <span>{ui('Source')}</span>
          <select className="ga-select ga-grow" aria-label={ui('Source')} disabled={!source || !!running} value={source?.id ?? ''} onChange={event => setSourceId(event.target.value)}>
            {sources.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · {entry.model}</option>)}
          </select>
          <button type="button" className="ga-link" aria-expanded={managing} onClick={() => setManaging(!managing)}>{ui(managing ? 'Hide sources' : 'Manage sources')}</button>
        </div>
        {managing && <SourceSettings />}
        {references.length > 0 && <div className="ga-refpics" aria-label={ui('Reference images')}>
          {references.map(asset => <span key={asset.path} className="ga-refpic" title={asset.path}>
            <span className="ga-twin-thumb"><Picture sessionId={sessionId} asset={asset} box={36} /></span>
            <span className="ga-twin-path">{nameOf(asset.path)}</span>
            <button type="button" className="ga-tool" aria-label={ui('Do not send {name}', { name: nameOf(asset.path) })} disabled={!!running} onClick={() => setReferences(references.filter(other => other !== asset))}>×</button>
          </span>)}
        </div>}
        {skipped > 0 && <p className="ga-dim">{ui('{count} GIF or SVG images are left out: image APIs take PNG, WebP and JPEG.', { count: skipped })}</p>}
        <textarea className="ga-textarea" rows={4} maxLength={8000} aria-label={ui('Prompt')} placeholder={ui('Describe the picture')} value={prompt} disabled={!!running} onChange={event => setPrompt(event.target.value)} />
        <div className="ga-field ga-wrap">
          <div className="ga-seg" role="radiogroup" aria-label={ui('Shape')}>
            {(['square', 'wide', 'tall'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={aspect === value} disabled={!!running} onClick={() => setAspect(value)}>{ui(ASPECT_LABEL[value])}</button>)}
          </div>
          <label className="ga-check-label" title={source?.kind === 'gemini' ? ui('Gemini pictures have no transparent background.') : undefined}>
            <input type="checkbox" checked={alpha} disabled={!!running || source?.kind === 'gemini'} onChange={event => { setTransparent(event.target.checked); setChosenTransparent(true); }} />{ui('Transparent background')}
          </label>
          <span className="ga-tools">
            {running
              ? <><span className="ga-dim" role="status">{ui('Generating… {seconds} s', { seconds })}</span><button type="button" className="ga-button" onClick={stop}>{ui('Stop')}</button></>
              : <button type="button" className="ga-button" data-primary disabled={!source || !prompt.trim() || saving} onClick={generate}>{ui(result ? 'Generate again' : 'Generate')}</button>}
          </span>
        </div>
        {error && <div className="ga-banner" data-tone="error" role="alert">{error}</div>}
        {result && <>
          <div className="ga-compare">
            {target && <figure><div className="ga-preview"><Picture sessionId={sessionId} asset={target} box={220} /></div>
              <figcaption>{ui('Now')}{target.width ? ` · ${target.width} × ${target.height}` : ''}</figcaption></figure>}
            <figure><div className="ga-preview">{preview && <img src={preview} alt={ui('Generated picture')} data-crisp={fit === 'pixel' || (!!scale && fit !== 'smooth') || undefined}
              style={scale && shown ? { width: shown.width * scale, height: shown.height * scale } : undefined} />}</div>
              <figcaption>{ui('New')} · {result.image.width ? `${result.image.width} × ${result.image.height}` : ''}{size && fit !== 'none' ? ` → ${size.width} × ${size.height}` : ''}</figcaption></figure>
          </div>
          <p className="ga-dim">{ui('From {source} · {model} in {seconds} s', { source: result.image.source, model: result.image.model, seconds: Math.round(result.image.ms / 1000) })}{source && ` · ${ui(KIND_LABEL[source.kind])}`}</p>
          {size && <div className="ga-field">
            <span>{ui('Size')}</span>
            <select className="ga-select ga-grow" aria-label={ui('Size')} value={fit} onChange={event => setFit(event.target.value as FitMode)}>
              {(['smooth', 'pixel', 'none'] as const).map(value => <option key={value} value={value}>{value === 'none' ? ui(FIT_LABEL.none) : ui('{width} × {height}, {how}', { width: size.width, height: size.height, how: ui(FIT_LABEL[value]) })}</option>)}
            </select>
          </div>}
          <label className="ga-field"><span>{ui('Save as')}</span><input className="ga-search" spellCheck={false} aria-label={ui('Save as')} value={path} onChange={event => setPath(event.target.value)} /></label>
          {canReplace && <p className="ga-dim">{ui('Replacing retires the current image to “{folder}” first, where Restore brings it back. The new picture keeps the path, so the code still finds it.', { folder: `${retireDir}/` })}</p>}
        </>}
        <p className="ga-actions ga-end">
          <button type="button" className="ga-button" onClick={onClose}>{ui(result ? 'Discard' : 'Cancel')}</button>
          {result && <button type="button" className="ga-button" data-primary={!canReplace || undefined} disabled={saving || !!running || !path.trim()} onClick={() => void save(false)}>{ui('Save as new file')}</button>}
          {result && canReplace && <button type="button" className="ga-button" data-primary disabled={saving || !!running} onClick={() => void save(true)}>{ui('Replace the image')}</button>}
        </p>
      </>}
    </div>
  </div>;
}
