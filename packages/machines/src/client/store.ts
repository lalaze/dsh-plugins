/**
 * What the page knows: the serving host's machine list and attention board (both read from absolute paths, so a page
 * opened through a mount reads the host that serves it), and the restart status of the machine on screen.
 */
import { useSyncExternalStore } from 'react';
import type { AttentionNotice, AttentionState } from '../attention-board.js';
import type { MachineInfo, MachinesAnswer } from '../model.js';
import { mountedId, mountPrefix } from '../rewrite.js';
import type { RestartStatus } from '../restart/service.js';
import { SseParser } from '../sse.js';

/** The board's key for the serving host. */
export const SELF = 'self';

/** The machine this page shows: a mount id, or {@link SELF} for the serving host. */
export const onScreen = (): string => mountedId(location.pathname) ?? SELF;

/** Path of a route on the machine this page shows (through its mount on a mounted page). */
export const onScreenPath = (path: string): string => {
  const id = mountedId(location.pathname);
  return id ? `${mountPrefix(id)}${path}` : path;
};

interface State {
  answer?: MachinesAnswer;
  error?: string;
  attention: AttentionState;
  attentionUp: boolean;
  restart?: RestartStatus;
  /** The machine on screen did not answer its restart status (it is restarting, or gone). */
  restartUnreachable: boolean;
}

let state: State = { attention: {}, attentionUp: false, restartUnreachable: false };
const listeners = new Set<() => void>();
const set = (change: Partial<State>) => { state = { ...state, ...change }; for (const listener of [...listeners]) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useStore = <T>(select: (value: State) => T): T => useSyncExternalStore(subscribe, () => select(state));
export const snapshot = () => state;

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  if (!res.ok) throw new Error((body as { error?: string } | undefined)?.error || text.trim() || `HTTP ${res.status}`);
  return body as T;
}

export async function loadMachines(): Promise<void> {
  try { set({ answer: await json<MachinesAnswer>('/dsh-machines/peers'), error: undefined }); } catch (error) { set({ error: (error as Error).message }); }
}

export const machineList = (): MachineInfo[] => state.answer?.machines ?? [];

/** The board as one event stream, reconnecting; each notice also goes to `onNotice`. */
export function followAttention(onNotice: (notice: AttentionNotice) => void): () => void {
  let stopped = false;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = 1_000;
  const connect = async () => {
    controller = new AbortController();
    try {
      const res = await fetch('/dsh-machines/attention', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'text/event-stream' }, signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      delay = 1_000;
      const parser = new SseParser(({ event, data }) => {
        try {
          if (event === 'state') set({ attention: JSON.parse(data) as AttentionState, attentionUp: true });
          else if (event === 'notice') onNotice(JSON.parse(data) as AttentionNotice);
        } catch { /* skip a malformed event */ }
      });
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(value);
      }
    } catch { /* reconnect below */ }
    set({ attentionUp: false });
    if (stopped) return;
    timer = setTimeout(() => void connect(), delay);
    delay = Math.min(delay * 2, 30_000);
  };
  void connect();
  return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
}

export function markSeen(machine: string): void {
  if (!(state.attention[machine]?.finished.length)) return;
  void json('/dsh-machines/attention/seen', { method: 'POST', body: JSON.stringify({ machine }) }).catch(() => undefined);
}

/** The restart status of the machine on screen. */
export async function loadRestart(): Promise<RestartStatus | undefined> {
  try {
    const restart = await json<RestartStatus>(onScreenPath('/dsh-machines/restart'));
    set({ restart, restartUnreachable: false });
    return restart;
  } catch {
    set({ restartUnreachable: true });
    return undefined;
  }
}

export async function requestRestart(action: 'now' | 'idle' | 'cancel'): Promise<void> {
  await json(onScreenPath('/dsh-machines/restart'), { method: 'POST', body: JSON.stringify({ action }) });
  await loadRestart();
  // The watcher follows a restart closely from now on.
  window.dispatchEvent(new Event('dsh-machines:restart'));
}
