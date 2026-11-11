/** Image previews as object URLs: a few requests at a time, kept while they fit a budget, dropped when nobody shows them. */
import { useEffect, useState } from 'react';
import { IMAGE_TYPES, extensionOf, type Asset } from '../domain.js';
import { imageBytes } from './api.js';

/** Grid cells do not download images larger than this; the detail pane still does. */
export const THUMB_LIMIT = 6 * 1024 * 1024;
const BUDGET = 160 * 1024 * 1024, CONCURRENCY = 6;

interface Job { key: string; sessionId: string; path: string; waiters: Set<(url: string | null) => void>; controller?: AbortController }
const ready = new Map<string, { url: string; bytes: number }>(), jobs = new Map<string, Job>(), queue: Job[] = [];
let held = 0, active = 0;

function keep(key: string, url: string, bytes: number) {
  ready.set(key, { url, bytes }); held += bytes;
  // Oldest first. A dropped URL may still be on screen; its image keeps the pixels it already decoded.
  for (const [old, entry] of ready) {
    if (held <= BUDGET || old === key) break;
    ready.delete(old); held -= entry.bytes; URL.revokeObjectURL(entry.url);
  }
}
function pump() {
  while (active < CONCURRENCY && queue.length) {
    // Newest first: after a fast scroll, the cells now on screen load before those that scrolled past.
    const job = queue.pop()!;
    if (!job.waiters.size) { jobs.delete(job.key); continue; }
    active++;
    job.controller = new AbortController();
    imageBytes(job.sessionId, job.path, job.controller.signal).then(bytes => {
      const url = URL.createObjectURL(new Blob([bytes], { type: IMAGE_TYPES[extensionOf(job.path)] ?? 'application/octet-stream' }));
      keep(job.key, url, bytes.byteLength);
      return url;
    }, () => null).then(url => {
      active--; jobs.delete(job.key);
      for (const waiter of job.waiters) waiter(url);
      pump();
    });
  }
}
function request(sessionId: string, asset: Asset, done: (url: string | null) => void): () => void {
  const key = `${sessionId}\n${asset.path}\n${asset.mtimeMs}\n${asset.size}`;
  let existing = jobs.get(key);
  if (!existing) { jobs.set(key, existing = { key, sessionId, path: asset.path, waiters: new Set() }); queue.push(existing); }
  const job = existing;
  job.waiters.add(done);
  pump();
  return () => {
    job.waiters.delete(done);
    if (!job.waiters.size) job.controller?.abort();
  };
}
const cached = (sessionId: string, asset: Asset) => {
  const key = `${sessionId}\n${asset.path}\n${asset.mtimeMs}\n${asset.size}`, entry = ready.get(key);
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
