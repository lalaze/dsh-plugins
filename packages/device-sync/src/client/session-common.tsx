import React from 'react'
import type { CommandResult, MirrorSessionView, OutboxItem } from '../shared/protocol.js'
import { ago, ui } from './i18n.js'

export type Delivery = { result?: CommandResult; held?: OutboxItem }
export const deliveryMessage = (value: Delivery) => value.held ? ui('Held here. Send it explicitly from Pending requests when ready.') : value.result ? ui('Request delivered.') : ui('No delivery confirmation. Retry with the same request ID.')

export function SessionFacts({ session }: { session: MirrorSessionView }) {
  return <p className="dsy-hint"><span className="dsy-dot" style={{ display: 'inline-block' }} data-state={session.state} /> {ui(session.state === 'running' ? 'Running' : session.state === 'waiting' ? 'Waiting' : 'Idle')} · {ago(session.updatedAt)}{session.archived && <> · {ui('Archived')}</>}{session.removed && <> · {ui('Deleted on the other machine')}</>}{session.hidden && <> · {ui('Hidden here')}</>}</p>
}
