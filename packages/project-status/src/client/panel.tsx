import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocale } from '@dsh-plugins/i18n/react';
import { FIELD_LIMIT, PARTS, type Change, type Facts, type Goal, type GoalRef, type Part, type StatusAnswer } from '../domain.js';
import { parseGoals, tally } from '../goals.js';
import { changeStatus, StatusRequestError } from './api.js';
import { useField, type FieldEdit, type Text } from './field.js';
import { LineInput, NewLine, TodoList } from './goal-list.js';
import { activeLocale, formatLocale, i18n, localizeError, ui } from './i18n.js';
import { standingRule, updateRequest } from './prompt.js';
import { put, refresh, useStatus } from './status.js';
import { styles } from './styles.js';
import { clearTabDot, setTabDot } from './tab-dot.js';

const LABEL: Record<Part, string> = { progress: 'Progress', blockers: 'Blockers', next: 'Next' };
const HINT: Record<Part, string> = {
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

/** A text that is edited where it stands: it reads as text until it is pointed at, and grows with its lines. */
function TextArea({ edit, label, hint }: { edit: FieldEdit; label: string; hint: string }) {
  const area = useRef<HTMLTextAreaElement>(null);
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
  return <textarea ref={area} className="ps-area" aria-label={label} placeholder={hint} maxLength={FIELD_LIMIT} rows={Math.max(1, edit.value.split('\n').length)} value={edit.value}
    onChange={event => edit.type(event.target.value)} onFocus={() => edit.hold(true)} onBlur={() => { edit.hold(false); edit.commit(); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      // Leaving the text saves it.
      if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) { event.preventDefault(); event.currentTarget.blur(); }
    }} />;
}

const AIM: Text = { change: (value, was) => ({ op: 'aim', value, was }), read: answer => answer.aim };
/** What the project as a whole is for. */
function AimField({ sessionId, server }: { sessionId: string; server: string }) {
  const edit = useField(sessionId, server, AIM);
  return <section className="ps-field" data-field="aim">
    <h3>{ui('Overall goal')}<Saving edit={edit} /></h3>
    <TextArea edit={edit} label={ui('Overall goal')} hint={ui('What the project as a whole is for, in a sentence or two')} />
    <Trouble edit={edit} />
  </section>;
}

/** The goal a reference names in an answer: the nth of that name. */
const goalOf = (answer: StatusAnswer, ref: GoalRef): Goal | undefined => answer.goals.filter(goal => goal.title === ref.title)[ref.nth ?? 0];
const partText = (ref: GoalRef, part: Part | 'steps'): Text => ({ change: (value, was) => ({ op: 'part', goal: ref, part, value, was }), read: answer => goalOf(answer, ref)?.[part] });

/** One of a goal's texts, beside its name. */
function PartRow({ sessionId, goal, part, server }: { sessionId: string; goal: GoalRef; part: Part; server: string }) {
  const edit = useField(sessionId, server, partText(goal, part));
  return <div className="ps-part" data-part={part} data-filled={server.trim() ? '' : undefined}>
    <div className="ps-part-name">{ui(LABEL[part])}<Saving edit={edit} /></div>
    <div className="ps-part-body"><TextArea edit={edit} label={ui(LABEL[part])} hint={ui(HINT[part])} /><Trouble edit={edit} /></div>
  </div>;
}

/** What a goal breaks down into, ticked off as it gets done. */
function TodoRow({ sessionId, goal, server }: { sessionId: string; goal: GoalRef; server: string }) {
  const edit = useField(sessionId, server, partText(goal, 'steps'));
  return <div className="ps-part" data-part="steps">
    <div className="ps-part-name">{ui('To-dos')}<Saving edit={edit} /></div>
    <div className="ps-part-body"><TodoList value={edit.value} onChange={text => edit.commit(text)} /><Trouble edit={edit} /></div>
  </div>;
}

const firstLine = (text: string) => text.trim().split('\n')[0].replace(/^[-*+]\s+(\[[ xX]\]\s*)?/, '');

/**
 * One goal, managed by itself: its name and whether it is reached, and under them its to-dos, how far it is, what blocks
 * it and what comes next. Closed, it is one line that says where it stands.
 */
function GoalCard({ sessionId, goal, at, open, onToggle, act }: { sessionId: string; goal: Goal; at: GoalRef; open: boolean; onToggle(): void; act(change: Change): Promise<void> }) {
  const [renaming, setRenaming] = useState(false), [confirming, setConfirming] = useState(false);
  /** The tick shows at once, and gives way to what the host says when it has answered. */
  const [ticked, setTicked] = useState<boolean | undefined>();
  const done = ticked ?? goal.done;
  const tick = () => { setTicked(!done); void act({ op: 'done', goal: at, value: !done }).finally(() => setTicked(undefined)); };
  const steps = tally(parseGoals(goal.steps)), blocked = !goal.done && !!goal.blockers.trim();
  const written = !!(goal.steps || goal.progress || goal.blockers || goal.next).trim();
  const line = blocked ? ['Blockers', goal.blockers] : goal.next.trim() ? ['Next', goal.next] : goal.progress.trim() ? ['Progress', goal.progress] : undefined;
  return <article className="ps-card" data-open={open ? '' : undefined} data-done={done ? '' : undefined} data-blocked={blocked ? '' : undefined}>
    <header className="ps-card-head">
      <input type="checkbox" checked={done} aria-label={ui('{goal} is reached', { goal: goal.title })} onChange={tick} />
      {renaming
        ? <LineInput initial={goal.title} label={ui('Rename')} onDone={(text, how) => { setRenaming(false); if (how !== 'cancel' && text && text !== goal.title) void act({ op: 'title', goal: at, value: text }); }} />
        // Closed, the whole line opens it; open, the name is there to be typed over.
        : <button type="button" className="ps-card-title" title={open ? ui('Rename') : undefined} onClick={() => open ? setRenaming(true) : onToggle()}>{goal.title}</button>}
      {steps.total > 0 && <span className="ps-goal-count">{steps.done}/{steps.total}</span>}
      <button type="button" className="ps-icon ps-fold" data-open={open ? '' : undefined} aria-expanded={open} title={ui(open ? 'Collapse' : 'Expand')} aria-label={ui(open ? 'Collapse' : 'Expand')} onClick={onToggle}>›</button>
      {confirming
        ? <button type="button" className="ps-button ps-goal-confirm" autoFocus onBlur={() => setConfirming(false)} onClick={() => { void act({ op: 'remove', goal: at }); }}>{ui('Delete it with what is written under it?')}</button>
        : <button type="button" className="ps-icon" title={ui('Delete')} aria-label={ui('Delete')} onClick={() => { if (written) setConfirming(true); else void act({ op: 'remove', goal: at }); }}>×</button>}
    </header>
    {!open && line && <button type="button" className="ps-card-line" data-tone={blocked ? 'warn' : undefined} onClick={onToggle}><span>{ui(line[0])}</span>{firstLine(line[1])}</button>}
    {open && <div className="ps-card-body">
      <TodoRow sessionId={sessionId} goal={at} server={goal.steps} />
      {PARTS.map(part => <PartRow key={part} sessionId={sessionId} goal={at} part={part} server={goal[part]} />)}
    </div>}
  </article>;
}

/** Which goals the user opened or closed, per project, kept in the browser. One never touched is open until it is reached. */
function useOpen(projectId: string): [(key: string, done: boolean) => boolean, (key: string, done: boolean) => void] {
  const store = `dsh-project-status.open.${projectId}`;
  const [chosen, setChosen] = useState<Record<string, boolean>>(() => { try { return JSON.parse(localStorage.getItem(store) ?? '{}') as Record<string, boolean>; } catch { return {}; } });
  const isOpen = (key: string, done: boolean) => chosen[key] ?? !done;
  return [isOpen, (key, done) => {
    const next = { ...chosen, [key]: !isOpen(key, done) };
    setChosen(next);
    try { localStorage.setItem(store, JSON.stringify(next)); } catch { /* private mode: it lasts for this page */ }
  }];
}

/** The project's goals, each a card of its own, and the line that adds one. */
function Goals({ sessionId, answer }: { sessionId: string; answer: StatusAnswer }) {
  const [failure, setFailure] = useState(''), [isOpen, toggle] = useOpen(answer.project.id);
  const act = (change: Change) => {
    setFailure('');
    return changeStatus(sessionId, change, activeLocale()).then(next => put(sessionId, next), async (problem: unknown) => {
      // The goal is no longer as it was shown: the new status says how it is.
      if (problem instanceof StatusRequestError && problem.status === 409) await refresh(sessionId);
      else setFailure(localizeError(problem));
    });
  };
  const seen = new Map<string, number>(), reached = answer.goals.filter(goal => goal.done).length;
  return <section className="ps-goal-cards">
    <h3 className="ps-section">{ui('Goals')}{answer.goals.length > 0 && <span className="ps-count">{reached}/{answer.goals.length}</span>}</h3>
    {answer.goals.map(goal => {
      const nth = seen.get(goal.title) ?? 0, key = `${goal.title}\u0000${nth}`;
      seen.set(goal.title, nth + 1);
      return <GoalCard key={key} sessionId={sessionId} goal={goal} at={{ title: goal.title, nth }} open={isOpen(key, goal.done)} onToggle={() => toggle(key, goal.done)} act={act} />;
    })}
    <div className="ps-card ps-card-new"><NewLine label={ui('Add a goal')} placeholder={ui(answer.goals.length ? 'Add a goal…' : 'Add a goal: each one gets its own to-dos, progress, blockers and next step')} onAdd={title => { void act({ op: 'add', title }); }} /></div>
    {failure && <div className="ps-alert" data-tone="error" role="alert"><p>{failure}</p></div>}
  </section>;
}

export interface PanelProps {
  sessionId?: string;
  /** Puts text into the conversation's input without sending it; answers false when nothing took it. */
  sendToChat?(sessionId: string, text: string): Promise<boolean>;
}

/**
 * The Status view of a conversation: what its project is for, and the goals it is working towards, each with its own
 * to-dos, progress, blockers and next step, beside what Git says. All of it is a file on the DSH host that agents edit
 * too. Each text is edited where it stands and saved by itself (see field.ts), so a change from elsewhere to the same one
 * is shown instead of being overwritten.
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
    {/* What is being typed belongs to one conversation's project: another conversation starts afresh. */}
    <div className="ps-fields" key={sessionId}>
      <AimField sessionId={sessionId} server={answer.aim} />
      <Goals sessionId={sessionId} answer={answer} />
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

/** Renders nothing. Marks the Status tab while a goal of the conversation's project that is not reached has a blocker written down. */
export function TabMark({ sessionId }: { sessionId?: string }) {
  useLocale(i18n);
  const { answer } = useStatus(sessionId, 'slow'), owner = useRef(Symbol('project-status')), label = ui('Status');
  const blocked = !!answer?.goals.some(goal => !goal.done && goal.blockers.trim());
  useEffect(() => {
    const who = owner.current;
    setTabDot(who, label, blocked);
    return () => clearTabDot(who);
  }, [label, blocked]);
  return null;
}
