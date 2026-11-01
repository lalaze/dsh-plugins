import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import type { AgentSummary } from '../../core/domain.js';
import { api } from '../api.js';
import { localizeError, ui, useLocale } from '../i18n.js';
import { styles } from '../styles.js';
import { SessionDetail } from './sessions.js';
import { decorateCatalogSlot, isRemoteCatalogId, mergeDelegatedCatalog, pollDelegations, routeCatalogAddress, type CatalogAddress, type CatalogEntry, type CatalogSlots, type CatalogState } from './delegated-model.js';

type SessionsHook = <T>(selector: (state: CatalogState) => T) => T;
export interface DelegatedCatalogProps {
  sessionId: string;
  useSessions: SessionsHook;
  openChild: (address: CatalogAddress) => unknown;
  openChildAside: (address: CatalogAddress) => unknown;
  refreshProjection: (sessionId: string) => unknown;
  [key: string]: unknown;
}
const EMPTY_AGENTS: AgentSummary[] = [];
const identity = (state: CatalogState) => state;
const unchanged = () => {};

function RemoteDetailDialog({ agent, close }: { agent: AgentSummary; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const focused = document.activeElement, element = dialog.current;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    element?.showModal();
    return () => {
      element?.close(); document.body.style.overflow = overflow;
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
    };
  }, []);
  return createPortal(<dialog className="dsh-ra ra-dialog" ref={dialog} aria-label={`${ui('Remote sessions')} · ${agent.title}`} onCancel={event => { event.preventDefault(); close(); }}>
    <style>{styles}</style>
    <div className="ra-dialog-bar"><span>{ui('Remote sessions')} · {ui('Read-only')}</span><button type="button" aria-label={ui('Close remote sessions')} onClick={close}><XIcon size={19} /></button></div>
    <SessionDetail key={agent.id} original={agent} changed={unchanged} readOnly />
  </dialog>, document.body);
}

/** One local read view per mounted parent; nothing is registered in the native sessions store. */
export function DelegatedCatalog({ native: Native, ...props }: DelegatedCatalogProps & { native: React.ComponentType<DelegatedCatalogProps> }) {
  useLocale();
  const nativeState = props.useSessions(identity);
  const [agents, setAgents] = useState(EMPTY_AGENTS), [error, setError] = useState(''), [selected, setSelected] = useState<AgentSummary>();
  const isSubagent = nativeState.byId[props.sessionId]?.origin === 'subagent';
  useEffect(() => {
    if (isSubagent || !props.sessionId || isRemoteCatalogId(props.sessionId)) return;
    return pollDelegations(props.sessionId, {
      request: (sessionId, signal) => api<AgentSummary[]>('delegations', { sessionId }, signal),
      accept: next => { setAgents(next); setError(''); },
      // Keep the last successful list visible on failures; automatic polls keep retrying.
      error: error => setError(error instanceof Error ? error.message : String(error)),
    });
  }, [props.sessionId, isSubagent]);
  const projected = useMemo(() => mergeDelegatedCatalog(nativeState, props.sessionId, agents), [nativeState, props.sessionId, agents]);
  // Subscribe once above, then run the native selectors over a stable memoized read snapshot.
  const useSessions: SessionsHook = useCallback(selector => selector(projected), [projected]);
  const openChild = useCallback((address: CatalogAddress) => routeCatalogAddress(address, props.sessionId, agents, setSelected, props.openChild), [props.sessionId, agents, props.openChild]);
  const openChildAside = useCallback((address: CatalogAddress) => routeCatalogAddress(address, props.sessionId, agents, setSelected, props.openChildAside), [props.sessionId, agents, props.openChildAside]);
  const refreshProjection = useCallback((sessionId: string) => {
    if (!isRemoteCatalogId(sessionId)) return props.refreshProjection(sessionId);
  }, [props.refreshProjection]);
  const current = selected && (agents.find(agent => agent.id === selected.id) ?? selected);
  return <>
    <Native {...props} useSessions={useSessions} openChild={openChild} openChildAside={openChildAside} refreshProjection={refreshProjection} />
    {error && !isSubagent && <span role="alert" title={localizeError(error)} style={{ fontSize: 12, color: 'var(--color-text-danger, #b42318)', maxWidth: 240 }}>{ui('Remote sessions')}: {localizeError(error)}</span>}
    {current && <RemoteDetailDialog agent={current} close={() => setSelected(undefined)} />}
  </>;
}

export function installDelegatedCatalog(slots: CatalogSlots<React.ComponentType<any>>): () => void {
  return decorateCatalogSlot(slots, (original: CatalogEntry<React.ComponentType<any>>) => {
    // Key the parent boundary so old responses, selection, and errors cannot flash in another chat.
    const Wrapped = (props: DelegatedCatalogProps) => <DelegatedCatalog key={props.sessionId} {...props} native={original.component} />;
    return Wrapped;
  });
}
