/**
 * Host-side manager for h3 batch redraw jobs.
 *
 * All callers on the DSH host share one default Colab VM (`h3`), so at most one batch job may run across the entire
 * process. Reference images and 16 MP outputs stay in a host temporary directory rather than in memory, and `h3 down`
 * always runs in `finally` regardless of boot failure, draw failure, user stop or plugin disposal.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { H3_MADE, isBatchRunning, type Aspect, type BatchItemState, type BatchPhase, type BatchStatus, type GeneratedImage } from './domain.js';
import { H3FatalError, down, draw, status, up, type H3Options } from './h3.js';
import { rasterType } from './images.js';
import { AssetError } from './workspace.js';

export const H3_KEEP_MS = 60 * 60_000;

export interface H3BatchOptions extends H3Options {
  /** How long finished results stay on disk before automatic cleanup (default 1 hour). */
  keepMs?: number;
}

export interface BatchRequestItem {
  path: string;
  aspect: Aspect;
  transparent: boolean;
}

interface JobItem {
  path: string;
  aspect: Aspect;
  transparent: boolean;
  refFile: string;
  status: BatchItemState;
  error?: string;
  ms?: number;
  width?: number;
  height?: number;
  outFile?: string;
  mediaType?: string;
}

interface Job {
  id: string;
  sessionId: string;
  phase: BatchPhase;
  startedAt: number;
  prompt: string;
  dir: string;
  items: JobItem[];
  error?: string;
  downError?: string;
  stopping: boolean;
  controller: AbortController;
  finished: Promise<void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const safeFileName = (path: string): string => basename(path).replace(/[^A-Za-z0-9._-]/g, '_') || 'ref.png';

export class H3Batches {
  private readonly jobs = new Map<string, Job>();
  private active: Job | undefined;
  private starting: { sessionId: string; promise: Promise<BatchStatus> } | undefined;
  private disposed = false;

  constructor(private readonly options: H3BatchOptions = {}) {}

  private view(job: Job): BatchStatus {
    return {
      id: job.id,
      sessionId: job.sessionId,
      phase: job.phase,
      startedAt: job.startedAt,
      prompt: job.prompt,
      items: job.items.map(item => ({
        path: item.path,
        status: item.status,
        ...(item.error ? { error: item.error } : {}),
        ...(item.ms !== undefined ? { ms: item.ms } : {}),
        ...(item.width !== undefined ? { width: item.width } : {}),
        ...(item.height !== undefined ? { height: item.height } : {}),
      })),
      ...(job.error ? { error: job.error } : {}),
      ...(job.downError ? { downError: job.downError } : {}),
    };
  }

  /** Returns this session's currently running job when there is one. */
  runningFor(sessionId: string): BatchStatus | undefined {
    return this.active?.sessionId === sessionId ? this.view(this.active) : undefined;
  }

  /** Whether another session is currently booting, running or starting an h3 batch. */
  busyFor(sessionId: string): boolean {
    if (this.active && this.active.sessionId !== sessionId) return true;
    if (this.starting && this.starting.sessionId !== sessionId) return true;
    return false;
  }

  /** Returns the session's current or most recent job, or null when there is none (or `id` no longer matches). */
  status(sessionId: string, id?: string): BatchStatus | null {
    const job = this.jobs.get(sessionId);
    if (!job || (id !== undefined && job.id !== id)) return null;
    return this.view(job);
  }

  /**
   * Starts a batch redraw in the background and returns its initial status at once.
   * Reconnects to the running job when the same session calls again, and refuses with 409 when another session is active
   * or when `h3 status` reports a VM already running.
   */
  async start(
    sessionId: string,
    prompt: string,
    items: readonly BatchRequestItem[],
    readRef: (path: string) => Promise<Buffer>,
  ): Promise<BatchStatus> {
    if (this.disposed) throw new AssetError('h3 batch service is closed', 410);
    if (this.active) {
      if (this.active.sessionId === sessionId) return this.view(this.active);
      throw new AssetError('h3 is already redrawing a batch for another workspace', 409);
    }
    if (this.starting) {
      if (this.starting.sessionId === sessionId) return this.starting.promise;
      throw new AssetError('h3 is already redrawing a batch for another workspace', 409);
    }

    const prepare = async (): Promise<BatchStatus> => {
      const vm = await status(this.options);
      if (vm.running) {
        throw new AssetError('The h3 VM is already running; another agent may be using it', 409);
      }
      if (this.disposed) throw new AssetError('h3 batch service is closed', 410);

      const dir = await mkdtemp(join(tmpdir(), 'dsh-game-assets-h3-'));
      try {
        const refsDir = join(dir, 'refs');
        await mkdir(refsDir, { recursive: true });
        const staged: JobItem[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const data = await readRef(item.path);
          const type = rasterType(data);
          if (type !== 'png' && type !== 'jpeg' && type !== 'webp') {
            throw new AssetError(`${item.path} is not the image its name says`);
          }
          const refFile = join(refsDir, `${i}-${safeFileName(item.path)}`);
          await writeFile(refFile, data);
          staged.push({ path: item.path, aspect: item.aspect, transparent: item.transparent, refFile, status: 'waiting' });
        }
        if (this.disposed) throw new AssetError('h3 batch service is closed', 410);

        const previous = this.jobs.get(sessionId);
        if (previous && !isBatchRunning(previous.phase)) await this.removeJob(previous);

        const job: Job = {
          id: randomUUID(),
          sessionId,
          phase: 'booting',
          startedAt: Date.now(),
          prompt,
          dir,
          items: staged,
          stopping: false,
          controller: new AbortController(),
          finished: Promise.resolve(),
        };
        this.active = job;
        this.jobs.set(sessionId, job);
        job.finished = this.runJob(job);
        return this.view(job);
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
    };

    const promise = prepare().finally(() => {
      if (this.starting?.promise === promise) this.starting = undefined;
    });
    this.starting = { sessionId, promise };
    return promise;
  }

  private async runJob(job: Job): Promise<void> {
    try {
      await up(this.options, job.controller.signal);
      job.phase = 'drawing';
      for (let i = 0; i < job.items.length; i++) {
        if (job.stopping || job.controller.signal.aborted) {
          for (let j = i; j < job.items.length; j++) {
            if (job.items[j].status === 'waiting') job.items[j].status = 'skipped';
          }
          break;
        }
        const entry = job.items[i];
        entry.status = 'drawing';
        const started = Date.now();
        const outDir = join(job.dir, `out-${i}`);
        await mkdir(outDir, { recursive: true });
        try {
          const picture = await draw(
            { prompt: job.prompt, reference: entry.refFile, aspect: entry.aspect, transparent: entry.transparent, outDir },
            this.options,
            job.controller.signal,
          );
          entry.status = 'done';
          entry.ms = Date.now() - started;
          entry.width = picture.width;
          entry.height = picture.height;
          entry.outFile = picture.file;
          entry.mediaType = picture.mediaType;
        } catch (error) {
          if (job.stopping || job.controller.signal.aborted) {
            entry.status = 'skipped';
            for (let j = i + 1; j < job.items.length; j++) {
              if (job.items[j].status === 'waiting') job.items[j].status = 'skipped';
            }
            break;
          }
          entry.status = 'failed';
          entry.ms = Date.now() - started;
          entry.error = error instanceof Error ? error.message : String(error);
          if (error instanceof H3FatalError) {
            job.error = entry.error;
            for (let j = i + 1; j < job.items.length; j++) {
              if (job.items[j].status === 'waiting') job.items[j].status = 'skipped';
            }
            break;
          }
        }
      }
    } catch (error) {
      if (!job.stopping && !job.controller.signal.aborted) {
        job.error = error instanceof Error ? error.message : String(error);
      }
      for (const entry of job.items) {
        if (entry.status === 'waiting' || entry.status === 'drawing') entry.status = 'skipped';
      }
    } finally {
      const stopped = job.stopping;
      const failed = !!job.error;
      job.phase = 'stopping';
      try {
        await down(this.options);
      } catch (error) {
        job.downError = error instanceof Error ? error.message : String(error);
      }
      job.phase = stopped ? 'stopped' : failed ? 'failed' : 'done';
      if (this.active === job) this.active = undefined;
      if (!this.disposed && this.jobs.get(job.sessionId) === job) {
        job.cleanupTimer = setTimeout(() => { void this.removeJob(job); }, this.options.keepMs ?? H3_KEEP_MS);
        job.cleanupTimer.unref?.();
      }
    }
  }

  /** Reads one finished picture of a batch from the temporary directory on demand. */
  async result(sessionId: string, id: string, index: number): Promise<GeneratedImage> {
    const job = this.jobs.get(sessionId);
    if (!job || job.id !== id) throw new AssetError('Batch job not found', 404);
    const entry = job.items[index];
    if (!entry) throw new AssetError('Batch picture not found', 404);
    if (entry.status !== 'done' || !entry.outFile || !entry.mediaType) {
      throw new AssetError('This picture is not ready', 409);
    }
    const data = await readFile(entry.outFile).catch(() => {
      throw new AssetError('Batch picture not found', 404);
    });
    return {
      data: data.toString('base64'),
      mediaType: entry.mediaType,
      ...(entry.width !== undefined ? { width: entry.width, height: entry.height } : {}),
      source: H3_MADE.source,
      model: H3_MADE.model,
      ms: entry.ms ?? 0,
    };
  }

  /** Stops the running job for `sessionId`, waits for `h3 down` to finish, and keeps any completed pictures for review. */
  async stop(sessionId: string, id?: string): Promise<BatchStatus> {
    const job = this.jobs.get(sessionId);
    if (!job || (id !== undefined && job.id !== id)) throw new AssetError('Batch job not found', 404);
    if (isBatchRunning(job.phase)) {
      job.stopping = true;
      for (const item of job.items) {
        if (item.status === 'waiting') item.status = 'skipped';
      }
      job.phase = 'stopping';
      job.controller.abort();
      await job.finished;
    }
    return this.view(job);
  }

  /** Discards a job (stopping it first if still running) and deletes its temporary directory. */
  async discard(sessionId: string, id?: string): Promise<void> {
    const job = this.jobs.get(sessionId);
    if (!job || (id !== undefined && job.id !== id)) return;
    if (isBatchRunning(job.phase)) {
      job.stopping = true;
      job.controller.abort();
      await job.finished;
    }
    await this.removeJob(job);
  }

  private async removeJob(job: Job): Promise<void> {
    clearTimeout(job.cleanupTimer);
    if (this.jobs.get(job.sessionId) === job) this.jobs.delete(job.sessionId);
    await rm(job.dir, { recursive: true, force: true });
  }

  /** Stops any running batch, waits for `h3 down`, and removes all temporary directories. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.starting?.promise.catch(() => {});
    if (this.active) {
      this.active.stopping = true;
      this.active.controller.abort();
      await this.active.finished;
    }
    const all = [...this.jobs.values()];
    this.jobs.clear();
    await Promise.all(all.map(async job => {
      clearTimeout(job.cleanupTimer);
      await rm(job.dir, { recursive: true, force: true });
    }));
  }
}
