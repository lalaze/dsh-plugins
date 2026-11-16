/** The restart hand-off between the running plugin, the detached helper and the next plugin instance. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Launch, Versions, VersionChange } from './target.js';

export type RestartMode = 'now' | 'idle';
export const isRestartMode = (value: unknown): value is RestartMode => value === 'now' || value === 'idle';

/**
 * `waiting`: an idle restart waits for running work. `armed`: the helper is up. `quitting`: DSH was asked to quit.
 * `launching`: DSH is gone and was started again. `back`: the next plugin instance answered. `failed`, `cancelled`.
 */
export type RestartPhase = 'waiting' | 'armed' | 'quitting' | 'launching' | 'back' | 'failed' | 'cancelled';

export interface RestartRecord {
  id: string;
  mode: RestartMode;
  phase: RestartPhase;
  requestedAt: number;
  /** The DSH process that asked; the one that answers must differ. */
  fromPid: number;
  from: Versions;
  log: string;
  helperPid?: number;
  attempts?: number;
  /** A graceful quit timed out and these processes were killed. */
  forced?: number[];
  backAt?: number;
  toPid?: number;
  changes?: VersionChange[];
  error?: string;
}

/** What the helper is told to do. */
export interface HelperJob {
  id: string;
  stateFile: string;
  launch: Launch;
  /** Lets the answer to the request that started the restart get out first. */
  startDelayMs: number;
  /** How long a graceful quit may take before the process is killed. */
  quitTimeoutMs: number;
  /** How long one launch may take to report back. */
  readyTimeoutMs: number;
  attempts: number;
  /** Where a relaunched `dsh web` writes its output. */
  output: string;
}

export function readRecord(file: string): RestartRecord | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as RestartRecord; } catch { return undefined; }
}

/** Atomic: the helper and the plugin read this file while the other writes it. */
export function writeRecord(file: string, record: RestartRecord): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}

/** Update the record only while it is still the given restart. */
export function updateRecord(file: string, id: string, change: (record: RestartRecord) => RestartRecord): RestartRecord | undefined {
  const record = readRecord(file);
  if (record?.id !== id) return undefined;
  const next = change(record);
  writeRecord(file, next);
  return next;
}
