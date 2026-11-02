import React from 'react'
import type { SessionEntry } from '../../src/shared/protocol.js'
import type { ConnectionState } from './hub-client.js'
import { ui } from './i18n.js'

export type Status = 'running' | 'waiting' | 'done' | 'idle'

/** Waiting for an answer, running, finished with something not yet seen, or idle. */
export function statusOf(entry: SessionEntry, seen: number): Status {
  if (entry.state === 'waiting' || entry.pending.length > 0) return 'waiting'
  if (entry.state === 'running') return 'running'
  return seen >= 0 && entry.lastSeq > seen ? 'done' : 'idle'
}

const LABELS: Record<Status, string> = { running: 'Running', waiting: 'Needs you', done: 'Done', idle: 'Idle' }

export function StatusDot({ status }: { status: Status }) {
  return <span className="dot" data-status={status} role="img" aria-label={ui(LABELS[status])} />
}

export function ConnectionBadge({ state, error, name }: { state: ConnectionState; error?: string; name: string }) {
  const label = state === 'online' ? ui('Connected') : state === 'connecting' ? ui('Connecting…') : state === 'unpaired' ? ui('Not paired') : ui('Offline')
  return <span className="connection" data-state={state} title={error ? ui(error) : undefined}>
    <span className="dot" data-status={state === 'online' ? 'idle-ok' : state === 'connecting' ? 'running' : 'offline'} />{name} · {label}
  </span>
}

export const requestId = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`)
