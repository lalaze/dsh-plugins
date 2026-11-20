import React, { useEffect, useRef, useState } from 'react';
import { useLocale } from '@dsh-plugins/i18n/react';
import { FIELDS, FIELD_LIMIT, type Facts, type Field, type Fields, type StatusAnswer } from '../domain.js';
import { saveStatus, StatusRequestError } from './api.js';
import { activeLocale, formatLocale, i18n, localizeError, ui } from './i18n.js';
import { standingRule, updateRequest } from './prompt.js';
import { put, refresh, useStatus } from './status.js';
import { styles } from './styles.js';
import { clearTabDot, setTabDot } from './tab-dot.js';

const LABEL: Record<Field, string> = { goal: 'Goal', progress: 'Progress', blockers: 'Blockers', next: 'Next' };
const HINT: Record<Field, string> = {
  goal: 'What this milestone has to deliver',
  progress: 'What is done and what is under way, with the branch',
  blockers: 'What it is stuck on and who it waits for: you, an agent or someone outside',
  next: 'One instruction an agent could carry out as it stands',
};

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['day', 86_400], ['hour', 3600], ['minute', 60]];
/** "3 days ago", in the page's language. */
export function ago(at: number, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000), format = new Intl.RelativeTimeFormat(formatLocale(), { numeric: 'auto' });
  for (const [unit, size] of UNITS) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(Math.min(0, Math.round(seconds / 60)), 'minute');
}

async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* plain HTTP has no clipboard API */ }
  const area = document.createElement('textarea');
  area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.append(area); area.select();
  try { document.execCommand?.('copy'); } finally { area.remove(); }
}

const Fact = ({ label, warn, children }: { label: string; warn?: boolean; children: React.ReactNode }) =>
  <div className="ps-fact" data-tone={warn ? 'warn' : undefined}><dt>{ui(label)}</dt><dd>{children}</dd></div>;

function FactList({ facts, answer }: { facts?: Facts; answer: StatusAnswer }) {
  const talks = answer.conversations;
  if (!facts && !talks?.count) return null;
  return <dl className="ps-facts">
    {facts && <>
      <Fact label="Branch">{facts.branch ?? ui('detached')}</Fact>
      <Fact label="Uncommitted" warn={facts.dirty > 0}>{facts.dirty}</Fact>
      <Fact label="Unpushed" warn={!!facts.unpushed}>{facts.unpushed ?? ui('no remote')}</Fact>
      <Fact label="Worktrees">{facts.worktrees}</Fact>
      <Fact label="Stashes" warn={facts.stashes > 0}>{facts.stashes}</Fact>
      {facts.lastCommit !== undefined && <Fact label="Last commit">{ago(facts.lastCommit)}</Fact>}
    </>}
    {!!talks?.count && <Fact label="Conversations">{talks.count}{talks.lastActive !== undefined && <small> · {ui('last active {when}', { when: ago(talks.lastActive) })}</small>}</Fact>}
  </dl>;
}

export interface PanelProps {
  sessionId?: string;
  /** Puts text into the conversation's input without sending it; answers false when nothing took it. */
  sendToChat?(sessionId: string, text: string): Promise<boolean>;
}

/**
 * The Status view of a conversation: what its project is for, how far it is, what blocks it and what comes next, beside
 * what Git says. The four texts are a file on the DSH host that agents edit too, so an edit here is held against the
 * revision it started from, and a change from elsewhere is shown instead of being overwritten.
 */
export function StatusPanel({ sessionId, sendToChat }: PanelProps) {
  useLocale(i18n);
  const { answer, error } = useStatus(sessionId, 'fast');
  /** The edit in progress and the revision it began from; undefined while only reading. */
  const [draft, setDraft] = useState<{ fields: Fields; base: string } | undefined>();
  const [saving, setSaving] = useState(false), [failure, setFailure] = useState(''), [said, setSaid] = useState('');
  useEffect(() => { setDraft(undefined); setFailure(''); setSaid(''); }, [sessionId]);
  const note = (body: React.ReactNode) => <section className="ps-root"><style>{styles}</style><div className="ps-note">{body}</div></section>;
  if (!sessionId) return note(ui('Open a conversation to see the status of its project.'));
  if (!answer) return note(error
    ? <><p role="alert">{ui(error)}</p><p><button type="button" className="ps-button" onClick={() => { void refresh(sessionId); }}>{ui('Retry')}</button></p></>
    : ui('Reading the status…'));

  const { project, facts, file } = answer, language = activeLocale();
  const conflict = draft !== undefined && draft.base !== answer.revision;
  const save = async () => {
    if (!draft) return;
    setSaving(true); setFailure('');
    try {
      put(sessionId, await saveStatus(sessionId, draft.fields, draft.base, language));
      setDraft(undefined);
    } catch (problem) {
      // Someone wrote meanwhile: the new revision shows the notice, and the draft stays.
      if (problem instanceof StatusRequestError && problem.status === 409) await refresh(sessionId);
      else setFailure(localizeError(problem));
    } finally { setSaving(false); }
  };
  const askAgent = async () => {
    if (!file || !sendToChat) return;
    setSaid((await sendToChat(sessionId, updateRequest(file, language)))
      ? ui('The request is in the conversation’s input; send it when you are ready.')
      : ui('The conversation’s input did not take the text. Open its Chat view and try again.'));
  };
  const copyRule = async () => { if (file) { await copyText(standingRule(file, language)); setSaid(ui('Copied')); } };

  return <section className="ps-root"><style>{styles}</style><div className="ps-page">
    <header className="ps-head">
      <h2 className="ps-name">{project.name}</h2>
      <span className="ps-updated">{answer.updatedAt === undefined ? ui('Not written yet') : ui('Updated {when}', { when: ago(answer.updatedAt) })}</span>
    </header>
    <p className="ps-path">{project.root}{project.machine && <> · {ui('on {machine}', { machine: project.machine })}</>}{!project.git && <> · {ui('Not in a Git repository')}</>}</p>
    <FactList facts={facts} answer={answer} />
    {answer.factsError && <div className="ps-alert"><p>{ui(answer.factsError)}</p></div>}
    {error && <div className="ps-alert" data-tone="error" role="alert"><p>{ui(error)}</p></div>}
    {conflict && <div className="ps-alert" role="alert">
      <p><strong>{ui('The status changed while you were editing')}</strong></p>
      <p>{ui('Your text is kept below. Load the new status to see what changed; that discards your edits.')}</p>
      <p><button type="button" className="ps-button" onClick={() => { setDraft(undefined); setFailure(''); }}>{ui('Load the new status')}</button></p>
    </div>}
    <div className="ps-fields">
      {FIELDS.map(field => {
        const value = draft ? draft.fields[field] : answer.fields[field];
        return <section key={field} className="ps-field" data-field={field} data-filled={answer.fields[field].trim() ? '' : undefined}>
          <h3>{ui(LABEL[field])}</h3>
          {draft
            ? <><p className="ps-hint">{ui(HINT[field])}</p>
              <textarea className="ps-area" aria-label={ui(LABEL[field])} maxLength={FIELD_LIMIT} rows={Math.min(12, Math.max(3, value.split('\n').length + 1))} value={value} disabled={saving}
                onChange={event => setDraft({ ...draft, fields: { ...draft.fields, [field]: event.target.value } })} /></>
            : value.trim() ? <p className="ps-text">{value}</p> : <p className="ps-empty">{ui(HINT[field])}</p>}
        </section>;
      })}
    </div>
    {failure && <div className="ps-alert" data-tone="error" role="alert"><p>{failure}</p></div>}
    <div className="ps-actions">
      {draft ? <>
        <button type="button" className="ps-button" data-primary disabled={saving || conflict} onClick={() => { void save(); }}>{ui(saving ? 'Saving…' : 'Save')}</button>
        <button type="button" className="ps-button" disabled={saving} onClick={() => { setDraft(undefined); setFailure(''); }}>{ui('Cancel')}</button>
      </> : <>
        <button type="button" className="ps-button" data-primary onClick={() => { setSaid(''); setDraft({ fields: { ...answer.fields }, base: answer.revision }); }}>{ui('Edit')}</button>
        <button type="button" className="ps-button" disabled={!file || !sendToChat} onClick={() => { void askAgent(); }}>{ui('Ask the agent to update')}</button>
        <span className="ps-spacer" />
        <button type="button" className="ps-button" disabled={!file} onClick={() => { void copyRule(); }}>{ui('Copy the rule for AGENTS.md')}</button>
      </>}
    </div>
    {said && <p className="ps-said" role="status">{said}</p>}
    {!file && project.machine && <p className="ps-said">{ui('The status is kept on this computer, where an agent on {machine} cannot open it. Edit it here.', { machine: project.machine })}</p>}
    {(file || answer.more) && <footer className="ps-foot">
      {file && <div>{ui('Status file')}: <code>{file}</code></div>}
      {answer.more && <div>{ui('The file has other sections too; they are kept as they are.')}</div>}
    </footer>}
  </div></section>;
}

/** Renders nothing. Marks the Status tab while the conversation's project has a blocker written down. */
export function TabMark({ sessionId }: { sessionId?: string }) {
  useLocale(i18n);
  const { answer } = useStatus(sessionId, 'slow'), owner = useRef(Symbol('project-status')), label = ui('Status');
  const blocked = !!answer?.fields.blockers.trim();
  useEffect(() => {
    const who = owner.current;
    setTabDot(who, label, blocked);
    return () => clearTabDot(who);
  }, [label, blocked]);
  return null;
}
