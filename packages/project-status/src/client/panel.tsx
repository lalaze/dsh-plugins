import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocale } from '@dsh-plugins/i18n/react';
import { FIELD_LIMIT, type Facts, type Field, type StatusAnswer } from '../domain.js';
import { parseGoals, tally } from '../goals.js';
import { useField, type FieldEdit } from './field.js';
import { GoalList } from './goal-list.js';
import { activeLocale, formatLocale, i18n, ui } from './i18n.js';
import { standingRule, updateRequest } from './prompt.js';
import { refresh, useStatus } from './status.js';
import { styles } from './styles.js';
import { clearTabDot, setTabDot } from './tab-dot.js';

type TextName = Exclude<Field, 'goal'>;
const TEXTS: TextName[] = ['progress', 'blockers', 'next'];
const LABEL: Record<TextName, string> = { progress: 'Progress', blockers: 'Blockers', next: 'Next' };
const HINT: Record<TextName, string> = {
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

/** Whether the browser sizes a textarea to its text by itself (`field-sizing`); where it does not, it is done here. */
const SIZES = typeof CSS !== 'undefined' && !!CSS.supports?.('field-sizing', 'content');
function fit(area: HTMLTextAreaElement | null): void {
  if (!area || SIZES) return;
  area.style.height = 'auto';
  // Nothing to measure while the view is hidden; the rows it was given stand until it shows.
  if (area.scrollHeight) area.style.height = `${area.scrollHeight + 2}px`;
}

/** Beside a field's name: that it is being saved, or was a moment ago. */
const Saving = ({ edit }: { edit: FieldEdit }) => edit.saving || edit.saved ? <span className="ps-state" role="status">{ui(edit.saving ? 'Saving…' : 'Saved')}</span> : null;

/** Under a field: a save that failed, or the text someone else wrote into it while the user was typing. */
function Trouble({ edit }: { edit: FieldEdit }) {
  return <>
    {edit.failure && <div className="ps-alert" data-tone="error" role="alert"><p>{edit.failure}</p></div>}
    {edit.theirs !== undefined && <div className="ps-alert" role="alert">
      <p><strong>{ui('This was changed elsewhere while you were editing')}</strong></p>
      <p className="ps-theirs">{edit.theirs || ui('(now empty)')}</p>
      <p className="ps-choice">
        <button type="button" className="ps-button" onClick={edit.takeTheirs}>{ui('Use the new text')}</button>
        <button type="button" className="ps-button" onClick={edit.keepMine}>{ui('Keep mine')}</button>
      </p>
    </div>}
  </>;
}

/** Progress, Blockers or Next: text that is edited where it stands. */
function TextField({ sessionId, field, server }: { sessionId: string; field: TextName; server: string }) {
  const edit = useField(sessionId, field, server), area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => fit(area.current), [edit.value]);
  // The lines wrap anew when the view gets another width, or shows after being hidden.
  useEffect(() => {
    const node = area.current;
    if (!node || SIZES || typeof ResizeObserver === 'undefined') return;
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => { if (node.clientWidth !== width) { width = node.clientWidth; fit(node); } });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <section className="ps-field" data-field={field} data-filled={server.trim() ? '' : undefined}>
    <h3>{ui(LABEL[field])}<Saving edit={edit} /></h3>
    <textarea ref={area} className="ps-area" aria-label={ui(LABEL[field])} placeholder={ui(HINT[field])} maxLength={FIELD_LIMIT} rows={Math.max(1, edit.value.split('\n').length)} value={edit.value}
      onChange={event => edit.type(event.target.value)} onFocus={() => edit.hold(true)} onBlur={() => { edit.hold(false); edit.commit(); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        // Leaving the field saves it.
        if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) { event.preventDefault(); event.currentTarget.blur(); }
      }} />
    <Trouble edit={edit} />
  </section>;
}

/** Goal: goals and their steps, ticked off as they are reached. */
function GoalField({ sessionId, server }: { sessionId: string; server: string }) {
  const edit = useField(sessionId, 'goal', server), count = tally(parseGoals(edit.value));
  return <section className="ps-field" data-field="goal">
    <h3>{ui('Goal')}{count.total > 0 && <span className="ps-count">{count.done}/{count.total}</span>}<Saving edit={edit} /></h3>
    <GoalList value={edit.value} onChange={text => edit.commit(text)} />
    <Trouble edit={edit} />
  </section>;
}

export interface PanelProps {
  sessionId?: string;
  /** Puts text into the conversation's input without sending it; answers false when nothing took it. */
  sendToChat?(sessionId: string, text: string): Promise<boolean>;
}

/**
 * The Status view of a conversation: what its project is for, how far it is, what blocks it and what comes next, beside
 * what Git says. The four are sections of a file on the DSH host that agents edit too. Each is edited where it stands and
 * saved by itself (see field.ts), so a change from elsewhere to the same one is shown instead of being overwritten.
 */
export function StatusPanel({ sessionId, sendToChat }: PanelProps) {
  useLocale(i18n);
  const { answer, error } = useStatus(sessionId, 'fast');
  const [said, setSaid] = useState('');
  useEffect(() => { setSaid(''); }, [sessionId]);
  const note = (body: React.ReactNode) => <section className="ps-root"><style>{styles}</style><div className="ps-note">{body}</div></section>;
  if (!sessionId) return note(ui('Open a conversation to see the status of its project.'));
  if (!answer) return note(error
    ? <><p role="alert">{ui(error)}</p><p><button type="button" className="ps-button" onClick={() => { void refresh(sessionId); }}>{ui('Retry')}</button></p></>
    : ui('Reading the status…'));

  const { project, facts, file } = answer, language = activeLocale();
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
    {/* A field belongs to one conversation's project: another conversation starts them afresh. */}
    <div className="ps-fields" key={sessionId}>
      <GoalField sessionId={sessionId} server={answer.fields.goal} />
      {TEXTS.map(field => <TextField key={field} sessionId={sessionId} field={field} server={answer.fields[field]} />)}
    </div>
    <div className="ps-actions">
      <button type="button" className="ps-button" disabled={!file || !sendToChat} onClick={() => { void askAgent(); }}>{ui('Ask the agent to update')}</button>
      <span className="ps-spacer" />
      <button type="button" className="ps-button" disabled={!file} onClick={() => { void copyRule(); }}>{ui('Copy the rule for AGENTS.md')}</button>
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
