import React, { useEffect, useRef, useState } from 'react';
import type { Dashboard } from '../../core/domain.js';
import { api } from '../api.js';
import { localizeError, ui } from '../i18n.js';

interface Replica { sessionId: string; sharedId: string; hostId: string; phase: string; version: number; live: boolean; error?: string; pending: boolean; rejected: number; autonomySource?: boolean; enrollmentCancelled?: boolean; pendingFreeze?: { operationId: string; action: string; stage: string }; autonomy?: { imported: boolean; children: string[]; queues: number; schedules: { id: string; title: string; status: string; resumeIntent?: string }[]; goals?: { sessionId: string; adapter: string; phase?: string }[]; receipts: Record<string, { state: string; error?: string }> } }
interface Status { available: boolean; hosts?: string[]; errors?: Record<string, string>; replicas?: Replica[]; sourceRecoveries?: (NonNullable<Replica['autonomy']> & { sessionId: string; hostId: string; phase: string; retainedInput?: number })[] }
interface RecordSummary { id: string; title: string; project: string; version: number; owner: string | null; archived: boolean; deleted: boolean }
interface ProjectMapping { hostId: string; projectKey: string; localDirectory: string }

/** Explicit receiving consent per host and sharing consent per conversation. */
export function NativeSharingSettings({ dashboard, sessionId, sessionTitle, openChat }: { dashboard?: Dashboard; sessionId?: string; sessionTitle?: string; openChat?: (id: string) => void }) {
  const [status, setStatus] = useState<Status>(), [hostId, setHost] = useState(''), [records, setRecords] = useState<RecordSummary[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState('');
  const [mappings, setMappings] = useState<ProjectMapping[]>([]), [projectKey, setProjectKey] = useState(''), [directory, setDirectory] = useState('');
  const [source, setSource] = useState<{ projectKey: string; localDirectory?: string; mappingRequired?: boolean }>();
  const [workQuery, setWorkQuery] = useState<{ sessionId: string; workKey: string; state: string; candidates: string[]; canConfirmAbsent: boolean }>();
  const refreshVersion = useRef(0);
  const enabled = status?.hosts?.includes(hostId) === true;
  const refresh = async () => {
    const version = ++refreshVersion.current;
    const next = await api<Status>('nativeSharing');
    if (hostId && next.hosts?.includes(hostId)) {
      const [catalog, configured, current] = await Promise.all([
        api<RecordSummary[]>('nativeList', { hostId }),
        api<ProjectMapping[]>('nativeMappings', { hostId }),
        sessionId ? api<NonNullable<typeof source>>('nativeSourceProject', { hostId, sessionId }).catch(e => { if (version === refreshVersion.current) setError(String(e.message ?? e)); return undefined; }) : undefined,
      ]);
      if (version !== refreshVersion.current) return;
      setStatus(next); setRecords(catalog); setMappings(configured); setSource(current);
      if (current) setProjectKey(previous => previous || current.projectKey);
    } else if (version === refreshVersion.current) { setStatus(next); setRecords([]); setMappings([]); setSource(undefined); }
  };
  useEffect(() => {
    let stopped = false;
    const update = () => { if (!stopped) void refresh().catch(e => { if (!stopped) setError(String(e.message ?? e)); }); };
    update(); const timer = setInterval(update, 10_000);
    return () => { stopped = true; refreshVersion.current++; clearInterval(timer); };
  }, [hostId, sessionId]);
  const saveMapping = async () => {
    setBusy(true); setError('');
    try {
      const inspected = await api<{ localDirectory: string }>('inspectNativeMapping', { hostId, localDirectory: directory });
      if (!window.confirm(`${ui('Confirm project directory on this machine')}\n${hostId}\n\n${projectKey}\n→ ${inspected.localDirectory}\n\n${ui('Only the runtime directory changes. Project files and credentials are not copied. Active copies must be handed off before remapping.')}`)) return;
      await api('setNativeMapping', { hostId, projectKey, localDirectory: directory, confirmedDirectory: inspected.localDirectory, confirmed: true });
      await refresh();
    } catch (e) { setError(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };
  const run = (action: string, data: Record<string, unknown> = {}) => {
    setBusy(true); setError('');
    void api<any>(action, { hostId, ...data }).then(async result => {
      if (result.sessionId && action === 'nativeOpen') openChat?.(result.sessionId);
      if (action === 'nativeRejected') setSaved(JSON.stringify(result, null, 2));
      if (action === 'nativeLockStatus') setSaved(JSON.stringify(result, null, 2));
      if (action === 'nativeInspectWork' || action === 'nativeReconcileWork') { setSaved(JSON.stringify(result, null, 2)); setWorkQuery({ ...result, sessionId: String(data.sessionId), workKey: String(data.workKey) }); }
      await refresh();
    }, e => setError(String(e.message ?? e))).catch(e => setError(String(e.message ?? e))).finally(() => setBusy(false));
  };
  const receipts = (sessionId: string, values: Record<string, { state: string; error?: string }>) => Object.entries(values).filter(([, receipt]) => !['done','expired'].includes(receipt.state)).map(([key, receipt]) => <div key={key}><p role="alert">{receipt.state}: {key} · {receipt.error}</p><button onClick={() => run('nativeInspectWork', { sessionId, workKey: key })}>{ui('Inspect saved acceptance request')}</button>{['not-accepted','absent'].includes(receipt.state) && <button onClick={() => { if (window.confirm(ui('Explicitly retry this proven unaccepted request?'))) run('nativeRetryWork', { sessionId, workKey: key, confirmed: true }); }}>{ui('Retry proven unaccepted work')}</button>}</div>);
  return <fieldset className="ra-share-list" disabled={busy || !status?.available}>
    <legend>{ui('Ordinary DSH conversations')}</legend>
    <p className="ra-muted">{ui('Off by default. Enable a verified remote host to receive its explicitly shared ordinary conversations. Share the current conversation separately; private chats are never scanned.')}</p>
    <p className="ra-muted">{ui('Sharing closes the original for writing. Continue here creates a linked native copy after the current owner hands off. Local projects require an explicitly confirmed directory on each machine.')}</p>
    {status && !status.available && <p role="status">{ui('The required native session lifecycle and sandbox services are unavailable in this DSH host.')}</p>}
    <select aria-label={ui('Native sharing host')} value={hostId} onChange={e => { refreshVersion.current++; setHost(e.target.value); setProjectKey(''); setDirectory(''); setSource(undefined); setMappings([]); setRecords([]); setError(''); }}>
      <option value="">{ui('Select a host')}</option>
      {dashboard?.hosts.map(host => <option key={host.id} value={host.id}>{host.label}</option>)}
    </select>
    <label><input type="checkbox" checked={enabled} disabled={!hostId} onChange={e => run('setNativeSharing', { enabled: e.target.checked })} /><span>{ui('Share ordinary conversations between DSH instances')}</span></label>
    {enabled && <>
      <p>{ui('Source project')}: <code>{source?.projectKey ?? '—'}</code>{source?.localDirectory && <> · {ui('Local directory')}: <code>{source.localDirectory}</code></>}</p>
      {source?.mappingRequired && <p role="status">{ui('Project mapping required before sharing this local conversation.')}</p>}
      <div className="ra-native-record">
        <label>{ui('Source project key')}<input aria-label={ui('Source project key')} value={projectKey} onChange={e => setProjectKey(e.target.value)} /></label>
        <label>{ui('Local absolute directory')}<input aria-label={ui('Local absolute directory')} value={directory} onChange={e => setDirectory(e.target.value)} /></label>
        <button disabled={!projectKey || !directory} onClick={() => void saveMapping()}>{ui('Verify and confirm directory')}</button>
        <p className="ra-muted">{ui('Project keys identify the source project; they are never assumed to be paths on this machine. History paths remain unchanged.')}</p>
        {mappings.map(mapping => <p key={mapping.projectKey}><code>{mapping.projectKey}</code> → <code>{mapping.localDirectory}</code><button onClick={() => { setProjectKey(mapping.projectKey); setDirectory(mapping.localDirectory); }}>{ui('Edit mapping')}</button></p>)}
      </div>
      <p>{sessionTitle ?? ui('Current conversation')} · <code>{sessionId ?? '—'}</code></p>
      <button disabled={!sessionId} onClick={() => {
        if (window.confirm(`${sessionTitle ?? ui('Current conversation')}\n${sessionId}\n\n${ui('Share the full history with this SSH account and close the original for writing? Continuation requires a linked copy.')}`)) run('nativeShare', { sessionId, confirmedSessionId: sessionId, confirmed: true });
      }}>{ui('Share and close current conversation')}</button>
    </>}
    {error && <div role="alert">{localizeError(error)}</div>}
    {Object.entries(status?.errors ?? {}).map(([id, message]) => <p key={id} role="alert">{localizeError(message)}</p>)}
    {enabled && records.filter(r => !r.deleted).map(record => <div key={record.id} className="ra-native-record">
      <strong>{record.title}</strong><p className="ra-muted">{record.project} · v{record.version} · {ui(record.archived ? 'Archived' : record.owner ? 'Owned by a DSH; handoff required' : 'Ready for native continuation')}</p>
      <p>{ui('Local mapping')}: <code>{mappings.find(mapping => mapping.projectKey === record.project)?.localDirectory ?? ui('No local mapping configured')}</code></p>
      <button onClick={() => { setProjectKey(record.project); setDirectory(mappings.find(mapping => mapping.projectKey === record.project)?.localDirectory ?? ''); }}>{ui('Map this project')}</button>
      <button disabled={record.archived} onClick={() => run('nativeOpen', { sharedId: record.id, writing: false })}>{ui('Open native history')}</button>
      <button disabled={record.archived || !!record.owner} onClick={() => run('nativeOpen', { sharedId: record.id, writing: true })}>{ui('Continue here')}</button>
      {record.archived && <button onClick={() => run('nativeRestore', { sharedId: record.id })}>{ui('Restore shared conversation')}</button>}
      <button onClick={() => run('nativeLockStatus', { sharedId: record.id })}>{ui('Inspect registry lock')}</button>
    </div>)}
    {status?.replicas?.filter(replica => replica.hostId === hostId).map(replica => <div key={replica.sessionId} className="ra-native-record">
      <code>{replica.sessionId}</code> · {replica.phase}
      {replica.error && <p role="alert">{localizeError(replica.error)}</p>}
      {replica.phase === 'active' && !replica.live && <p role="status">{ui('Restarted copy: ordinary handoff is blocked. Recovery uses only the last shared checkpoint; the local tail remains separate.')}</p>}
      {replica.pendingFreeze && <div><p role="alert">{ui('Freeze recovery pending; writing is blocked and the original backup is retained.')}</p><button onClick={() => run('nativeHandoff', { sessionId: replica.sessionId, operation: replica.pendingFreeze!.action })}>{ui('Retry saved handoff')}</button><button onClick={() => { if (window.confirm(ui('Roll back this freeze, keeping its work parked and retaining the same remote writer?'))) run('nativeRollbackFreeze', { sessionId: replica.sessionId, confirmed: true }); }}>{ui('Roll back freeze; keep work parked')}</button></div>}
      {replica.phase === 'active' && replica.live && !replica.pendingFreeze && <>
        {replica.autonomy?.imported && <div>
          <p>{ui('Autonomous work imported parked. Resume only after reviewing local permissions and schedule targets.')}</p>
          {!!replica.autonomy.queues && <button onClick={() => { if (window.confirm(ui('Resume retained queued input in its original order?'))) run('nativeResumeAutonomy', { sessionId: replica.sessionId, queues: true, confirmed: true }); }}>{ui('Resume parked input')}</button>}
          {!!replica.autonomy.goals?.some(goal => goal.phase !== 'complete') && <button onClick={() => { if (window.confirm(ui('Resume imported goals with their retained objectives and round budgets?'))) run('nativeResumeAutonomy', { sessionId: replica.sessionId, goals: true, confirmed: true }); }}>{ui('Resume imported goals')}</button>}
          {replica.autonomy.schedules.filter(s => s.status !== 'ended').map(schedule => <button key={schedule.id} onClick={() => { if (window.confirm(`${schedule.title}\n${ui('Enable this imported schedule on this machine?')}`)) run('nativeResumeAutonomy', { sessionId: replica.sessionId, ...(schedule.resumeIntent === 'paused' ? { activatePaused: [schedule.id] } : { schedules: [schedule.id] }), confirmed: true }); }}>{ui(schedule.resumeIntent === 'paused' ? 'Explicitly enable paused schedule' : 'Resume schedule')}: {schedule.title}</button>)}
          {receipts(replica.sessionId, replica.autonomy.receipts)}
        </div>}
        <button onClick={() => run('nativeCheckpoint', { sessionId: replica.sessionId })}>{ui('Sync idle checkpoint')}</button>
        <button onClick={() => run('nativeHandoff', { sessionId: replica.sessionId })}>{ui('Handoff and close this copy')}</button>
        <button onClick={() => run('nativeHandoff', { sessionId: replica.sessionId, operation: 'archive' })}>{ui('Archive shared conversation')}</button>
        <button onClick={() => run('nativeHandoff', { sessionId: replica.sessionId, operation: 'withdraw' })}>{ui('Stop sharing and close this copy')}</button>
        <button onClick={() => { if (window.confirm(ui('Delete shared history on the host? Local copies remain.'))) run('nativeHandoff', { sessionId: replica.sessionId, operation: 'delete' }); }}>{ui('Delete shared history')}</button>
      </>}
      {replica.version === 0 && !replica.enrollmentCancelled ? <>
        <button onClick={() => run('nativeCancel', { sessionId: replica.sessionId })}>{ui(replica.autonomySource ? 'Fence failed enrollment; retain frozen source' : 'Cancel failed enrollment and reopen original')}</button>
        <button onClick={() => run('nativeReconcile', { sessionId: replica.sessionId })}>{ui('Reconcile publication; keep original closed')}</button>
      </>
        : !replica.pendingFreeze && (replica.pending || replica.phase === 'importing' || replica.phase === 'active') && <button onClick={() => {
          if (window.confirm(ui('Recover only the last shared checkpoint? Unpublished local history stays in its closed original and is not included.'))) run('nativeRecover', { sessionId: replica.sessionId, recoverLastCheckpoint: true });
        }}>{ui('Recover last shared checkpoint; keep local log')}</button>}
      {!!replica.rejected && <button onClick={() => run('nativeRejected', { sessionId: replica.sessionId })}>{ui('Show retained rejected input')}</button>}
    </div>)}
    {status?.sourceRecoveries?.filter(recovery => recovery.hostId === hostId).map(recovery => <div key={`source/${recovery.sessionId}`} className="ra-native-record">
      <code>{recovery.sessionId}</code><p>{ui('Frozen source backup retained. Restore the original first; queues, goals and schedules resume only by explicit request.')}</p>
      {recovery.phase !== 'parked' || status.replicas?.some(r => r.sessionId === recovery.sessionId) ? <button onClick={() => {
        if (window.confirm(ui('Restore the fenced local source while keeping all retained work paused?'))) run('nativeRestoreSource', { sessionId: recovery.sessionId, confirmed: true });
      }}>{ui('Restore source; keep work paused')}</button> : <>
        {!!recovery.queues && <button onClick={() => { if (window.confirm(ui('Resume retained queued input in its original order?'))) run('nativeResumeSource', { sessionId: recovery.sessionId, queues: true, confirmed: true }); }}>{ui('Resume parked input')}</button>}
        {!!recovery.goals?.some(goal => goal.phase !== 'complete') && <button onClick={() => { if (window.confirm(ui('Resume imported goals with their retained objectives and round budgets?'))) run('nativeResumeSource', { sessionId: recovery.sessionId, goals: true, confirmed: true }); }}>{ui('Resume imported goals')}</button>}
        {recovery.schedules.filter(s => s.status !== 'ended').map(schedule => <button key={schedule.id} onClick={() => { if (window.confirm(`${schedule.title}\n${ui('Resume this existing source schedule without creating another task?')}`)) run('nativeResumeSource', { sessionId: recovery.sessionId, ...(schedule.resumeIntent === 'paused' ? { activatePaused: [schedule.id] } : { schedules: [schedule.id] }), confirmed: true }); }}>{ui(schedule.resumeIntent === 'paused' ? 'Explicitly enable paused schedule' : 'Resume schedule')}: {schedule.title}</button>)}
      </>}
      {!!recovery.retainedInput && <button onClick={() => run('nativeRejected', { sessionId: recovery.sessionId })}>{ui('Show retained rejected input')}</button>}
      {receipts(recovery.sessionId, recovery.receipts)}
    </div>)}
    {workQuery && <div><p>{workQuery.state}</p>{workQuery.state === 'candidate' && workQuery.candidates.map(id => <button key={id} onClick={() => { if (window.confirm(`${ui('Confirm this unique task matches the saved request, target and creation interval?')}\n${id}`)) run('nativeReconcileWork', { sessionId: workQuery.sessionId, workKey: workQuery.workKey, candidateId: id, confirmed: true }); }}>{ui('Confirm accepted task')}: {id}</button>)}{workQuery.canConfirmAbsent && workQuery.state === 'absent' && <button onClick={() => { if (window.confirm(ui('Confirm proven absence before enabling an explicit retry?'))) run('nativeReconcileWork', { sessionId: workQuery.sessionId, workKey: workQuery.workKey, confirmAbsent: true, confirmed: true }); }}>{ui('Confirm proven absence')}</button>}</div>}
    {saved && <pre>{saved}</pre>}
  </fieldset>;
}
