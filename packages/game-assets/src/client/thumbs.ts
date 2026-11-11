/**
 * Image previews as object URLs. Thumbnails go to the host in batches, which a remote workspace answers in one run on
 * its machine; they are kept while they fit a budget and not fetched at all once nobody shows them any more.
 */
import { useEffect, useState } from 'react';
import { IMAGE_BATCH, IMAGE_TYPES, extensionOf, type Asset } from '../domain.js';
import { imageBatch, imageBytes } from './api.js';

/** Grid cells do not download images larger than this; the detail pane still does. */
export const THUMB_LIMIT = 6 * 1024 * 1024;
const BUDGET = 160 * 1024 * 1024;
/** One batch: at most this many images and about this many bytes, as their sizes in the scan add up. */
const BATCH_COUNT = 32, BATCH_BYTES = 6 * 1024 * 1024;
/** Requests in flight at once: batches and single large images together. */
const CONCURRENCY = 3;

interface Job { key: string; sessionId: string; asset: Asset; waiters: Set<(url: string | null) => void>; controller?: AbortController }
const ready = new Map<string, { url: string; bytes: number }>(), jobs = new Map<string, Job>(), queue: Job[] = [];
let held = 0, active = 0, scheduled = false;

const keyOf = (sessionId: string, asset: Asset) => `${sessionId}\n${asset.path}\n${asset.mtimeMs}\n${asset.size}`;
function keep(key: string, url: string, bytes: number) {
  ready.set(key, { url, bytes }); held += bytes;
  // Oldest first. A dropped URL may still be on screen; its image keeps the pixels it already decoded.
  for (const [old, entry] of ready) {
    if (held <= BUDGET || old === key) break;
    ready.delete(old); held -= entry.bytes; URL.revokeObjectURL(entry.url);
  }
}
function finish(job: Job, bytes: Uint8Array | undefined) {
  let url: string | null = null;
  if (bytes) {
    url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: IMAGE_TYPES[extensionOf(job.asset.path)] ?? 'application/octet-stream' }));
    keep(job.key, url, bytes.byteLength);
  }
  jobs.delete(job.key);
  for (const waiter of job.waiters) waiter(url);
}
function decode(base64: string): Uint8Array {
  const text = atob(base64), bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
/** A large image on its own, which aborts once nobody waits for it. */
function single(job: Job): Promise<void> {
  job.controller = new AbortController();
  return imageBytes(job.sessionId, job.asset.path, job.controller.signal).then(bytes => finish(job, new Uint8Array(bytes)), () => finish(job, undefined));
}
async function batch(group: Job[]): Promise<void> {
  try {
    const { images } = await imageBatch(group[0].sessionId, group.map(job => job.asset.path));
    const byPath = new Map(images.map(answer => [answer.path, answer]));
    const again: Job[] = [];
    for (const job of group) {
      const answer = byPath.get(job.asset.path);
      if (answer?.data !== undefined) finish(job, decode(answer.data));
      else if (answer?.status === 413) again.push(job); else finish(job, undefined);
    }
    // The answer was full; these wait for another turn.
    queue.unshift(...again);
  } catch { for (const job of group) finish(job, undefined); }
}
/** The next request: the newest wanted job, so cells now on screen load before those scrolled past, with others of its conversation. */
function next(): Promise<void> | undefined {
  let job: Job | undefined;
  while ((job = queue.pop()) && !job.waiters.size) jobs.delete(job.key);
  if (!job) return undefined;
  if (job.asset.size > BATCH_BYTES) return single(job);
  const group = [job];
  let bytes = job.asset.size;
  for (let i = queue.length - 1; i >= 0 && group.length < Math.min(BATCH_COUNT, IMAGE_BATCH); i--) {
    const other = queue[i];
    if (!other.waiters.size) { queue.splice(i, 1); jobs.delete(other.key); continue; }
    if (other.sessionId !== job.sessionId || other.asset.size > BATCH_BYTES || bytes + other.asset.size > BATCH_BYTES) continue;
    queue.splice(i, 1); group.push(other); bytes += other.asset.size;
  }
  return batch(group);
}
function pump() {
  scheduled = false;
  while (active < CONCURRENCY) {
    const running = next();
    if (!running) return;
    active++;
    void running.finally(() => { active--; schedule(); });
  }
}
/** Waits until the cells of one render have all asked, so they go out together. */
function schedule() { if (!scheduled) { scheduled = true; queueMicrotask(pump); } }

function request(sessionId: string, asset: Asset, done: (url: string | null) => void): () => void {
  const key = keyOf(sessionId, asset);
  let existing = jobs.get(key);
  if (!existing) { jobs.set(key, existing = { key, sessionId, asset, waiters: new Set() }); queue.push(existing); }
  const job = existing;
  job.waiters.add(done);
  schedule();
  return () => {
    job.waiters.delete(done);
    if (!job.waiters.size) job.controller?.abort();
  };
}
const cached = (sessionId: string, asset: Asset) => {
  const key = keyOf(sessionId, asset), entry = ready.get(key);
  // Touch, so what is on screen is the last to be dropped.
  if (entry) { ready.delete(key); ready.set(key, entry); }
  return entry?.url;
};

/** The image's object URL; undefined while it loads, null when it failed or is larger than `limit`. */
export function useImage(sessionId: string, asset: Asset, limit: number): string | null | undefined {
  const [state, setState] = useState<{ asset: Asset; url: string | null | undefined }>(() => ({ asset, url: cached(sessionId, asset) }));
  const current = state.asset === asset ? state.url : cached(sessionId, asset);
  useEffect(() => {
    if (asset.size > limit) { setState({ asset, url: null }); return; }
    const url = cached(sessionId, asset);
    setState({ asset, url });
    if (url) return;
    return request(sessionId, asset, loaded => setState({ asset, url: loaded }));
  }, [sessionId, asset, limit]);
  return current;
}
