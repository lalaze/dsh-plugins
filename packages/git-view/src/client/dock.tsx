import { useEffect, useRef } from 'react';
import { registerComposer, type InputActions } from './composer.js';

/** What DSH's `conversation.input.dock` slot passes to its entries. */
export interface DockProps { sessionId?: string; inputActions?: InputActions; useInput?: <T>(select: (state: { draft: string }) => T) => T }

/** Shows nothing; lends the conversation's composer to the Git view's "send to chat" actions. */
export function ComposerBridge({ sessionId, inputActions, useInput }: DockProps) {
  const draft = useInput?.(state => state.draft) ?? '', latest = useRef(draft);
  latest.current = draft;
  useEffect(() => sessionId && inputActions ? registerComposer(sessionId, { actions: inputActions, draft: () => latest.current }) : undefined, [sessionId, inputActions]);
  return null;
}
