/**
 * Batch redrawing a selection with `h3` (MiniMax-H3-Image on Google Colab), run on the DSH host:
 * boots the VM once, redraws each selected image on its own from itself as the reference, shuts the VM down with
 * `h3 down`, and lets the user compare and save or discard each result before anything is written to the workspace.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  H3_BATCH_LIMIT,
  H3_MADE,
  H3_WORTH_IT,
  extensionOf,
  isBatchRunning,
  isBatchSource,
  isReference,
  type Asset,
  type BatchStatus,
  type GeneratedImage,
  type SaveResult,
  type SpriteSheet,
} from '../domain.js';
import { h3Discard, h3Result, h3Start, h3Status, h3Stop, savePicture } from './api.js';
import { freePath } from './generate.js';
import { Picture } from './grid.js';
import { localizePictureError, ui } from './i18n.js';
import { dirOf, fitScale, nameOf, stemOf } from './model.js';
import { base64Of, blobOf, defaultFit, renderPicture, type FitMode } from './picture.js';
import { prepareSheets, readOriginal, resetSheets, restoredPicture, spriteFit, spriteType } from './sheets.js';

export type BatchFit = 'auto' | FitMode;

type ItemOutcome = { kind: 'saved'; path: string; replaced: boolean } | { kind: 'discarded' };
interface LoadedItem {
  image: GeneratedImage;
  blob: Blob;
  url: string;
}

/** Remembers per-item save/discard choices while the user closes and reopens a finished batch. */
const outcomesByJob = new Map<string, Record<number, ItemOutcome>>();
export function resetBatches(): void {
  outcomesByJob.clear();
  resetSheets();
}

/**
 * The file a finished picture becomes: a sprite sent as a sheet comes back see-through at its own size and colours
 * (GIF stays GIF); other pictures are fitted as before, cropped to fill since h3 draws opaque pictures.
 */
async function finalPicture(sessionId: string, path: string, picture: Blob, sheet: SpriteSheet | undefined, fitChoice: BatchFit, size: { width: number; height: number } | undefined, type: string, keepColours = true): Promise<Blob> {
  if (sheet) {
    const original = await readOriginal(sessionId, path);
    return restoredPicture(picture, sheet, original, spriteFit(fitChoice, original, path), type, keepColours);
  }
  const chosen: FitMode = fitChoice === 'auto' ? defaultFit(size?.width, size?.height) : fitChoice;
  return renderPicture(picture, type, typeof createImageBitmap === 'function' ? chosen : 'none', size, true);
}
export function pendingBatchItems(job: BatchStatus): number {
  const outcomes = outcomesByJob.get(job.id) ?? {};
  return job.items.filter((item, index) => item.status === 'done' && !outcomes[index]).length;
}

/** What booting is at: asking for a GPU, waiting for a free one, or setting up the one it got. */
function bootText(job: BatchStatus, now: number): string {
  const boot = job.boot, elapsed = (since: number) => formatElapsed(Math.round((now - since) / 1000));
  if (boot?.gpu && boot.setupAttempt) return ui('Got a {gpu}; the connection to it dropped, setting up again (attempt {attempt})… {elapsed}', { gpu: boot.gpu, attempt: boot.setupAttempt, elapsed: elapsed(boot.since ?? job.startedAt) });
  if (boot?.gpu) return ui('Got a {gpu}; setting up h3… {elapsed} (~11 min)', { gpu: boot.gpu, elapsed: elapsed(boot.since ?? job.startedAt) });
  const gpus = boot?.gpus?.join(' → ') ?? 'GPU';
  if (boot?.busy) return ui('No {gpus} free yet; h3 asks again every 30 s for up to 10 min, nothing is billed meanwhile · round {round}, {elapsed}', { gpus, round: boot.round ?? 1, elapsed: elapsed(job.startedAt) });
  if (boot?.gpus) return ui('Asking Colab for a GPU ({gpus})… {elapsed}', { gpus, elapsed: elapsed(job.startedAt) });
  return ui('Booting the h3 VM… {elapsed} (~11 min)', { elapsed: elapsed(job.startedAt) });
}

function formatElapsed(seconds: number): string {
  const clean = Math.max(0, seconds);
  if (clean < 60) return ui('{seconds}s', { seconds: clean });
  return ui('{minutes}m {seconds}s', { minutes: Math.floor(clean / 60), seconds: clean % 60 });
}

function BatchComparison({
  sessionId,
  path,
  sheet,
  asset,
  loaded,
  fitChoice,
  keepColours,
}: {
  sessionId: string;
  path: string;
  sheet?: SpriteSheet;
  asset: Asset | undefined;
  loaded: LoadedItem | undefined;
  fitChoice: BatchFit;
  keepColours: boolean;
}) {
  const size = asset?.width && asset.height ? { width: asset.width, height: asset.height } : undefined;
  const fit: FitMode = fitChoice === 'auto' ? defaultFit(size?.width, size?.height) : fitChoice;
  const [preview, setPreview] = useState<string>();

  useEffect(() => {
    if (!loaded) {
      setPreview(undefined);
      return;
    }
    if (!sheet && (fit === 'none' || !size || typeof createImageBitmap !== 'function')) {
      setPreview(loaded.url);
      return;
    }
    let url: string | undefined;
    let gone = false;
    // A sprite previews as the file it would be saved as; other pictures as a PNG fitted like the save.
    finalPicture(sessionId, path, loaded.blob, sheet, fitChoice, size, sheet ? spriteType(path) ?? 'image/png' : 'image/png', keepColours).then(
      blob => {
        if (gone) return;
        url = URL.createObjectURL(blob);
        setPreview(url);
      },
      () => {
        if (!gone) setPreview(loaded.url);
      },
    );
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [loaded, fit, fitChoice, keepColours, sheet, size?.width, size?.height]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = (sheet ? fitChoice !== 'none' : fit !== 'none') && size ? size : loaded?.image.width ? { width: loaded.image.width, height: loaded.image.height! } : undefined;
  const scale = fitScale(shown?.width, shown?.height, 200);

  return (
    <div className="ga-compare">
      {asset && (
        <figure>
          <div className="ga-preview">
            <Picture sessionId={sessionId} asset={asset} box={200} />
          </div>
          <figcaption>
            {ui('Now')}
            {asset.width ? ` · ${asset.width} × ${asset.height}` : ''}
          </figcaption>
        </figure>
      )}
      <figure>
        <div className="ga-preview">
          {preview ? (
            <img
              src={preview}
              alt={ui('Generated picture')}
              data-crisp={fit === 'pixel' || !!sheet || (!!scale && fit !== 'smooth') || undefined}
              style={scale && shown ? { width: shown.width * scale, height: shown.height * scale } : undefined}
            />
          ) : (
            <span className="ga-dim">{ui('Loading picture…')}</span>
          )}
        </div>
        <figcaption>
          {ui('New')}
          {loaded?.image.width ? ` · ${loaded.image.width} × ${loaded.image.height}` : ''}
          {size && (sheet ? fitChoice !== 'none' : fit !== 'none') ? ` → ${size.width} × ${size.height}` : ''}
          {sheet ? ` · ${ui('background removed')}` : ''}
        </figcaption>
      </figure>
    </div>
  );
}

export interface BatchRedrawProps {
  sessionId: string;
  selected: Asset[];
  assets: readonly Asset[];
  retireDir: string;
  initialJob: BatchStatus | null;
  busyElsewhere: boolean;
  onJobChange(job: BatchStatus | null): void;
  onBusyChange?(busy: boolean): void;
  onSaved(result: SaveResult, replaced: boolean): void;
  onCompleted(notice: string): void;
  onClose(): void;
}

export function BatchRedrawDialog({
  sessionId,
  selected: given,
  assets,
  retireDir,
  initialJob,
  busyElsewhere,
  onJobChange,
  onBusyChange,
  onSaved,
  onCompleted,
  onClose,
}: BatchRedrawProps) {
  const retiredCount = useMemo(() => given.filter(asset => asset.retired).length, [given]);
  const nonRefCount = useMemo(() => given.filter(asset => !asset.retired && !isBatchSource(asset.path)).length, [given]);
  const eligible = useMemo(() => given.filter(asset => !asset.retired && isBatchSource(asset.path)), [given]);
  const overLimit = Math.max(0, eligible.length - H3_BATCH_LIMIT);

  const [targets, setTargets] = useState<Asset[]>(() => eligible.slice(0, H3_BATCH_LIMIT));
  const [prompt, setPrompt] = useState(() => ui('Redraw this image in the same art style. Keep the subject, the pose and the framing.'));
  const [confirmedSmall, setConfirmedSmall] = useState(false);
  const [job, setJob] = useState<BatchStatus | null>(() => initialJob);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fitChoice, setFitChoice] = useState<BatchFit>('auto');
  const [keepColours, setKeepColours] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState<Record<number, LoadedItem>>({});
  const [outcomes, setOutcomes] = useState<Record<number, ItemOutcome>>(() => (initialJob ? outcomesByJob.get(initialJob.id) ?? {} : {}));
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  const alive = useRef(true);
  const urlsRef = useRef(new Set<string>());
  const inFlightRef = useRef(new Map<string, Promise<LoadedItem>>());
  const takenRef = useRef(new Set<string>());
  useEffect(() => {
    for (const asset of assets) takenRef.current.add(asset.path);
  }, [assets]);

  const assetsByPath = useMemo(() => new Map(assets.map(asset => [asset.path, asset])), [assets]);

  useEffect(() => {
    alive.current = true;
    const urls = urlsRef.current;
    return () => {
      alive.current = false;
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const updateOutcomes = (jobId: string, next: Record<number, ItemOutcome>) => {
    outcomesByJob.set(jobId, next);
    if (alive.current) setOutcomes(next);
  };

  // Opening or reopening the dialog checks the host at once so busy state and any running job are fresh.
  useEffect(() => {
    let cancelled = false;
    h3Status(sessionId, initialJob?.id).then(answer => {
      if (cancelled || !alive.current) return;
      onBusyChange?.(answer.busy);
      if (initialJob) {
        setJob(answer.job);
        onJobChange(answer.job);
      } else if (answer.job && isBatchRunning(answer.job.phase)) {
        setJob(answer.job);
        onJobChange(answer.job);
      }
    }, () => {});
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Polls progress every 2 seconds while the batch is booting, drawing or shutting down.
  useEffect(() => {
    if (!job || !isBatchRunning(job.phase)) return;
    let cancelled = false;
    const poll = () => {
      h3Status(sessionId, job.id).then(answer => {
        if (cancelled || !alive.current) return;
        if (answer.job) {
          setJob(answer.job);
          onJobChange(answer.job);
        }
      }, () => {});
    };
    const timer = setInterval(poll, 2000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(clock);
    };
  }, [sessionId, job?.id, job?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const ensureLoaded = (jobId: string, index: number): Promise<LoadedItem> => {
    if (loaded[index]) return Promise.resolve(loaded[index]);
    const key = `${jobId}:${index}`;
    const existing = inFlightRef.current.get(key);
    if (existing) return existing;
    const promise = h3Result(sessionId, jobId, index)
      .then(image => {
        const blob = blobOf(image.data, image.mediaType);
        const url = URL.createObjectURL(blob);
        if (!alive.current) {
          URL.revokeObjectURL(url);
          throw new Error('Dialog closed');
        }
        urlsRef.current.add(url);
        const entry: LoadedItem = { image, blob, url };
        setLoaded(old => ({ ...old, [index]: entry }));
        return entry;
      })
      .catch(e => {
        inFlightRef.current.delete(key);
        throw e;
      });
    inFlightRef.current.set(key, promise);
    return promise;
  };

  // Pulls finished pictures one by one as items complete.
  useEffect(() => {
    if (!job) return;
    let cancelled = false;
    void (async () => {
      for (let i = 0; i < job.items.length; i++) {
        if (cancelled || !alive.current) return;
        if (job.items[i].status !== 'done' || outcomes[i] || loaded[i]) continue;
        try {
          await ensureLoaded(job.id, i);
        } catch (e) {
          if (alive.current && !cancelled) setRowErrors(old => ({ ...old, [i]: localizePictureError(e) }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, job, outcomes]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => {
    if (!targets.length || !prompt.trim()) return;
    setStarting(true);
    setError('');
    const paths = targets.map(asset => asset.path);
    prepareSheets(sessionId, paths)
      .then(({ prepared, animated }) => {
        if (!animated.length) return h3Start(sessionId, paths, prompt, prepared);
        // Left out before booting, so the count the user confirmed is never silently smaller.
        if (alive.current) {
          setTargets(old => old.filter(asset => !animated.includes(asset.path)));
          setError(ui('Animated GIFs cannot be redrawn yet and were taken out: {names}. Check the list and start again.', { names: animated.map(nameOf).join(', ') }));
        }
        return undefined;
      })
      .then(started => {
        if (!started) return;
        if (!alive.current) return;
        setNow(Date.now());
        setJob(started);
        setOutcomes(outcomesByJob.get(started.id) ?? {});
        onBusyChange?.(false);
        onJobChange(started);
      }, e => {
        if (!alive.current) return;
        if (e instanceof Error && /another workspace/.test(e.message)) onBusyChange?.(true);
        setError(localizePictureError(e));
      })
      .finally(() => {
        if (alive.current) setStarting(false);
      });
  };

  const stop = () => {
    if (!job) return;
    setStopping(true);
    setError('');
    h3Stop(sessionId, job.id)
      .then(stopped => {
        if (!alive.current) return;
        setJob(stopped);
        onJobChange(stopped);
      }, e => {
        if (alive.current) setError(localizePictureError(e));
      })
      .finally(() => {
        if (alive.current) setStopping(false);
      });
  };

  const performSave = async (
    currentJob: BatchStatus,
    index: number,
    replace: boolean,
    currentOutcomes: Record<number, ItemOutcome>,
  ): Promise<{ saved?: SaveResult; nextOutcomes: Record<number, ItemOutcome> }> => {
    const item = currentJob.items[index];
    try {
      const picture = await ensureLoaded(currentJob.id, index);
      const asset = assetsByPath.get(item.path);
      const size = asset?.width && asset.height ? { width: asset.width, height: asset.height } : undefined;
      const ext = isBatchSource(item.path) ? extensionOf(item.path) : 'png';
      const dir = dirOf(item.path);
      const where = replace ? item.path : freePath(`${dir ? `${dir}/` : ''}${stemOf(item.path)}-redraw.${ext}`, takenRef.current);
      const type = item.sheet ? spriteType(where) : isReference(where) ? spriteType(where) : undefined;
      if (!type) throw new Error(ui('Save pictures as .png, .webp or .jpg files in a visible folder of the workspace'));
      const blob = await finalPicture(sessionId, item.path, picture.blob, item.sheet, fitChoice, size, type, keepColours);
      const saved = await savePicture(sessionId, where, await base64Of(blob), replace, { ...H3_MADE, prompt: currentJob.prompt });
      takenRef.current.add(saved.path);
      const nextOutcomes: Record<number, ItemOutcome> = { ...currentOutcomes, [index]: { kind: 'saved', path: saved.path, replaced: replace } };
      updateOutcomes(currentJob.id, nextOutcomes);
      if (alive.current) {
        setRowErrors(old => {
          const copy = { ...old };
          delete copy[index];
          return copy;
        });
      }
      onSaved(saved, replace);
      return { saved, nextOutcomes };
    } catch (e) {
      if (alive.current) setRowErrors(old => ({ ...old, [index]: localizePictureError(e) }));
      return { nextOutcomes: currentOutcomes };
    }
  };

  const hasPending = (currentJob: BatchStatus, map: Record<number, ItemOutcome>) =>
    currentJob.items.some((item, index) => item.status === 'done' && !map[index]);

  const finishAndCleanup = async (currentJob: BatchStatus, notice?: string) => {
    outcomesByJob.delete(currentJob.id);
    await h3Discard(sessionId, currentJob.id).catch(() => {});
    onJobChange(null);
    if (notice) onCompleted(notice);
    else onClose();
  };

  const saveOne = async (index: number, replace: boolean) => {
    if (!job || saving) return;
    setSaving(true);
    setError('');
    try {
      const { saved, nextOutcomes } = await performSave(job, index, replace, outcomes);
      if (saved && !isBatchRunning(job.phase) && !hasPending(job, nextOutcomes) && !job.downError) {
        const notice = replace && saved.retired
          ? ui('Replaced {path}; the old one is under Earlier versions', { path: saved.path })
          : ui('Saved {path}', { path: saved.path });
        await finishAndCleanup(job, notice);
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const saveAll = async () => {
    if (!job || saving) return;
    setSaving(true);
    setError('');
    let map = outcomes;
    let count = 0;
    let last: SaveResult | undefined;
    let failed = false;
    try {
      for (let i = 0; i < job.items.length; i++) {
        if (job.items[i].status !== 'done' || map[i]) continue;
        const step = await performSave(job, i, true, map);
        map = step.nextOutcomes;
        if (step.saved) {
          count++;
          last = step.saved;
        } else {
          failed = true;
        }
      }
      if (!failed && count > 0 && !isBatchRunning(job.phase) && !hasPending(job, map) && !job.downError) {
        const notice = count === 1 && last
          ? ui('Replaced {path}; the old one is under Earlier versions', { path: last.path })
          : ui('Replaced {count} images; earlier versions are under Earlier versions', { count });
        await finishAndCleanup(job, notice);
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const discardOne = async (index: number) => {
    if (!job) return;
    const nextOutcomes: Record<number, ItemOutcome> = { ...outcomes, [index]: { kind: 'discarded' } };
    updateOutcomes(job.id, nextOutcomes);
    setRowErrors(old => {
      const copy = { ...old };
      delete copy[index];
      return copy;
    });
    if (!isBatchRunning(job.phase) && !hasPending(job, nextOutcomes)) {
      await finishAndCleanup(job);
    }
  };

  const discardAll = async () => {
    if (!job) return;
    setSaving(true);
    try {
      await finishAndCleanup(job);
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const closeDialog = () => {
    // Closing while running or while pictures remain to review keeps the job on the host.
    if (job && !isBatchRunning(job.phase) && !hasPending(job, outcomes)) {
      void finishAndCleanup(job);
      return;
    }
    onClose();
  };

  const title = ui('Batch redraw with h3');
  const smallBatch = targets.length > 0 && targets.length < H3_WORTH_IT;
  const running = job ? isBatchRunning(job.phase) : false;
  const elapsed = job ? Math.round((now - job.startedAt) / 1000) : 0;
  const drawingIndex = job ? job.items.findIndex(item => item.status === 'drawing') : -1;
  const completedCount = job ? job.items.filter(item => item.status !== 'waiting' && item.status !== 'drawing').length : 0;
  const currentStep = job ? (drawingIndex >= 0 ? drawingIndex + 1 : Math.min(job.items.length, completedCount + 1)) : 0;
  const anyDone = job ? job.items.some(item => item.status === 'done') : false;
  const pendingCount = job ? job.items.filter((item, index) => item.status === 'done' && !outcomes[index]).length : 0;

  return (
    <div className="ga-overlay" role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => { if (event.key === 'Escape') closeDialog(); }}>
      <div className="ga-dialog ga-gen ga-batch">
        <h3>{title}</h3>
        {!job ? (
          <>
            <p className="ga-dim">
              {ui('Each image is redrawn on its own from itself as the reference, using the shared prompt below. Nothing is written until you review and save.')}
            </p>
            {targets.length > 0 && (
              <div className="ga-refpics" aria-label={ui('Images to redraw')}>
                {targets.map(asset => (
                  <span key={asset.path} className="ga-refpic" title={asset.path}>
                    <span className="ga-twin-thumb"><Picture sessionId={sessionId} asset={asset} box={36} /></span>
                    <span className="ga-twin-path">{nameOf(asset.path)}</span>
                    <button
                      type="button"
                      className="ga-tool"
                      aria-label={ui('Do not send {name}', { name: nameOf(asset.path) })}
                      disabled={starting}
                      onClick={() => setTargets(targets.filter(other => other !== asset))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {nonRefCount > 0 && (
              <p className="ga-dim">{ui('{count} SVG images are left out: h3 takes PNG, WebP, JPEG and GIF.', { count: nonRefCount })}</p>
            )}
            {targets.some(asset => extensionOf(asset.path) === 'gif') && (
              <p className="ga-dim">{ui('GIF and see-through images go as sprite sheets: the page fills their background with one flat colour for h3 and takes it out again, at the original size and colours.')}</p>
            )}
            {retiredCount > 0 && <p className="ga-dim">{ui('{count} retired images are left out.', { count: retiredCount })}</p>}
            {overLimit > 0 && (
              <p className="ga-dim">{ui('Only the first {limit} images are included: one batch redraws at most {limit}.', { limit: H3_BATCH_LIMIT })}</p>
            )}
            <textarea
              className="ga-textarea"
              rows={4}
              maxLength={8000}
              aria-label={ui('Prompt')}
              placeholder={ui('Describe the picture')}
              value={prompt}
              disabled={starting}
              onChange={event => setPrompt(event.target.value)}
            />
            <p className="ga-dim">
              {ui('Cost: h3 asks Colab for an A100, then a G4, and waits up to 10 min for a free one, which costs nothing; booting then takes ~11 min and ~1.6 CU. h3 down runs automatically when the batch ends.')}
            </p>
            {busyElsewhere && (
              <div className="ga-banner" data-tone="warn" role="alert">
                {ui('h3 is already redrawing a batch for another workspace')}
              </div>
            )}
            {smallBatch && (
              <>
                <div className="ga-banner" data-tone="warn" role="status">
                  {ui('Fewer than {min} images is not cost-effective (~1.6 CU just to boot); consider saving up a larger batch first.', { min: H3_WORTH_IT })}
                </div>
                <div className="ga-field">
                  <label className="ga-check-label">
                    <input
                      type="checkbox"
                      checked={confirmedSmall}
                      disabled={starting}
                      onChange={event => setConfirmedSmall(event.target.checked)}
                    />
                    {ui('Still boot now for {count} images', { count: targets.length })}
                  </label>
                </div>
              </>
            )}
            {error && <div className="ga-banner" data-tone="error" role="alert">{error}</div>}
            <p className="ga-actions ga-end">
              <button type="button" className="ga-button" onClick={onClose}>{ui('Cancel')}</button>
              <button
                type="button"
                className="ga-button"
                data-primary
                disabled={starting || busyElsewhere || !targets.length || !prompt.trim() || (smallBatch && !confirmedSmall)}
                onClick={start}
              >
                {starting
                  ? ui('Starting…')
                  : smallBatch
                    ? ui('Still boot and redraw {count} images', { count: targets.length })
                    : ui('Boot and redraw {count} images', { count: targets.length })}
              </button>
            </p>
          </>
        ) : (
          <>
            {running && (
              <div className="ga-field ga-wrap">
                <span role="status">
                  {job.phase === 'booting'
                    ? bootText(job, now)
                    : job.phase === 'drawing'
                      ? ui('Drawing {current}/{total} · {elapsed}', { current: currentStep, total: job.items.length, elapsed: formatElapsed(elapsed) })
                      : ui('Shutting down the h3 VM (h3 down)…')}
                </span>
                <span className="ga-tools">
                  <button
                    type="button"
                    className="ga-button"
                    data-danger
                    disabled={stopping || job.phase === 'stopping'}
                    onClick={stop}
                  >
                    {stopping || job.phase === 'stopping' ? ui('Stopping…') : ui('Stop and shut down')}
                  </button>
                </span>
              </div>
            )}
            {running && <p className="ga-dim">{ui('Closing this dialog leaves the batch running in the background.')}</p>}
            {job.phase === 'stopped' && anyDone && (
              <p className="ga-dim">{ui('Batch stopped; completed pictures below can still be saved.')}</p>
            )}
            {job.error && <div className="ga-banner" data-tone="error" role="alert">{localizePictureError(job.error)}</div>}
            {job.downError && <div className="ga-banner" data-tone="error" role="alert">{localizePictureError(job.downError)}</div>}
            {error && <div className="ga-banner" data-tone="error" role="alert">{error}</div>}
            {anyDone && (
              <>
                <div className="ga-field">
                  <span>{ui('Size')}</span>
                  <select
                    className="ga-select ga-grow"
                    aria-label={ui('Size')}
                    value={fitChoice}
                    onChange={event => setFitChoice(event.target.value as BatchFit)}
                  >
                    <option value="auto">{ui('Match each image (sharp ≤128 px, smooth otherwise)')}</option>
                    <option value="smooth">{ui('Smooth')}</option>
                    <option value="pixel">{ui('Sharp pixels')}</option>
                    <option value="none">{ui('Keep h3’s size')}</option>
                  </select>
                </div>
                {job.items.some(item => item.sheet) && (
                  <div className="ga-field">
                    <label className="ga-check-label">
                      <input type="checkbox" checked={keepColours} onChange={event => setKeepColours(event.target.checked)} />
                      {ui('Sprites keep their original colours (turn off when the prompt changes colours)')}
                    </label>
                  </div>
                )}
                <p className="ga-dim">
                  {ui('Replacing retires the current image to “{folder}” first, where Restore brings it back. The new picture keeps the path, so the code still finds it.', { folder: `${retireDir}/` })}
                </p>
              </>
            )}
            <div className="ga-batch-list">
              {job.items.map((item, index) => {
                const outcome = outcomes[index];
                const asset = assetsByPath.get(item.path);
                const rowError = rowErrors[index] ?? (item.status === 'failed' && item.error ? localizePictureError(item.error) : undefined);
                return (
                  <div key={item.path} className="ga-batch-item" data-path={item.path}>
                    <div className="ga-batch-head">
                      <span className="ga-twin-path">{item.path}</span>
                      {outcome?.kind === 'saved' ? (
                        <span className="ga-tag" data-tone="ok">
                          {outcome.replaced ? ui('Replaced') : ui('Saved as {path}', { path: outcome.path })}
                        </span>
                      ) : outcome?.kind === 'discarded' ? (
                        <span className="ga-tag">{ui('Discarded')}</span>
                      ) : item.status === 'waiting' ? (
                        <span className="ga-tag">{ui('Waiting')}</span>
                      ) : item.status === 'drawing' ? (
                        <span className="ga-tag" data-tone="tag">{ui('Drawing…')}</span>
                      ) : item.status === 'done' ? (
                        <span className="ga-tag" data-tone="ok">{ui('Ready')}</span>
                      ) : item.status === 'failed' ? (
                        <span className="ga-tag" data-tone="err">{ui('Failed')}</span>
                      ) : (
                        <span className="ga-tag">{ui('Skipped')}</span>
                      )}
                      {item.status === 'done' && !outcome && (
                        <span className="ga-actions">
                          <button type="button" className="ga-button" data-primary disabled={saving} onClick={() => void saveOne(index, true)}>
                            {ui('Replace')}
                          </button>
                          <button type="button" className="ga-button" disabled={saving} onClick={() => void saveOne(index, false)}>
                            {ui('Save as new file')}
                          </button>
                          <button type="button" className="ga-button" disabled={saving} onClick={() => void discardOne(index)}>
                            {ui('Discard')}
                          </button>
                        </span>
                      )}
                    </div>
                    {item.status === 'done' && !outcome && (
                      <BatchComparison sessionId={sessionId} path={item.path} sheet={item.sheet} asset={asset} loaded={loaded[index]} fitChoice={fitChoice} keepColours={keepColours} />
                    )}
                    {rowError && <div className="ga-banner" data-tone="error" role="alert">{rowError}</div>}
                  </div>
                );
              })}
            </div>
            <p className="ga-actions ga-end">
              <button type="button" className="ga-button" onClick={closeDialog}>{ui('Close')}</button>
              {!running && (
                <button type="button" className="ga-button" disabled={saving} onClick={() => void discardAll()}>
                  {ui('Discard all')}
                </button>
              )}
              {!running && pendingCount > 0 && (
                <button type="button" className="ga-button" data-primary disabled={saving} onClick={() => void saveAll()}>
                  {ui('Replace all')}
                </button>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
