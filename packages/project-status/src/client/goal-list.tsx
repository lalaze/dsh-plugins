import React, { useMemo, useRef, useState } from 'react';
import { endOf, parseGoals, serializeGoals, type GoalItem } from '../goals.js';
import { ui } from './i18n.js';

type End = 'enter' | 'leave' | 'cancel';
/** Long enough for a name; what needs more is a paragraph for Progress. */
const LINE_LIMIT = 300;
/** Enter that picks a candidate in a Chinese or Japanese input method is not the end of the line. */
const composing = (event: React.KeyboardEvent) => event.nativeEvent.isComposing || event.keyCode === 229;

/** One line being typed over: a goal's name, or a to-do. Answers once, however it ends: Enter, leaving it, or Escape. */
export function LineInput({ initial, label, onDone }: { initial: string; label: string; onDone(text: string, how: End): void }) {
  const [text, setText] = useState(initial), finished = useRef(false);
  const finish = (how: End) => { if (finished.current) return; finished.current = true; onDone(text.trim(), how); };
  return <input className="ps-goal-input" autoFocus aria-label={label} value={text} maxLength={LINE_LIMIT}
    onChange={event => setText(event.target.value)} onBlur={() => finish('leave')}
    onKeyDown={event => {
      if (composing(event)) return;
      if (event.key === 'Enter') { event.preventDefault(); finish('enter'); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish('cancel'); }
    }} />;
}

/** The line at the end of a list that is always there: type one, press Enter, type the next. */
export function NewLine({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd(text: string): void }) {
  const [text, setText] = useState('');
  const add = () => { const line = text.trim(); setText(''); if (line) onAdd(line); };
  return <div className="ps-goal ps-goal-new">
    <span className="ps-goal-plus" aria-hidden="true">+</span>
    <input className="ps-goal-input" aria-label={label} placeholder={placeholder} value={text} maxLength={LINE_LIMIT}
      onChange={event => setText(event.target.value)} onBlur={add}
      onKeyDown={event => { if (event.key === 'Enter' && !composing(event)) { event.preventDefault(); add(); } }} />
  </div>;
}

/**
 * A goal's to-dos as a list to tick off. Every change is handed up as the whole text at once, a Markdown task list (see
 * goals.ts), so an agent reading the file sees the same boxes. Levels an agent indented are drawn as it wrote them.
 * @param value - the to-dos' text.
 */
export function TodoList({ value, onChange }: { value: string; onChange(text: string): void }) {
  const items = useMemo(() => parseGoals(value), [value]);
  const [editing, setEditing] = useState<number | undefined>();
  /** The to-do whose removal, with what is indented under it, waits for a second click. */
  const [confirming, setConfirming] = useState<number | undefined>();
  const apply = (next: GoalItem[]) => onChange(serializeGoals(next));
  const change = (index: number, patch: Partial<GoalItem>) => apply(items.map((item, at) => at === index ? { ...item, ...patch } : item));
  const remove = (index: number) => {
    const end = endOf(items, index);
    if (end > index + 1 && confirming !== index) { setConfirming(index); return; }
    setConfirming(undefined);
    apply([...items.slice(0, index), ...items.slice(end)]);
  };
  return <>
    {items.length > 0 && <ul className="ps-goals">
      {items.map((item, index) => {
        const under = endOf(items, index) - index - 1;
        return <li key={index} className="ps-goal" data-done={item.done ? '' : undefined} style={{ '--ps-depth': item.depth } as React.CSSProperties}>
          {item.done === undefined
            ? <button type="button" className="ps-goal-box" title={ui('Make it a to-do')} aria-label={ui('Make it a to-do')} onClick={() => change(index, { done: false })} />
            : <input type="checkbox" checked={item.done} aria-label={item.text} onChange={() => change(index, { done: !item.done })} />}
          {editing === index
            ? <LineInput initial={item.text} label={ui('Edit')} onDone={(text, how) => {
              setEditing(undefined);
              if (how === 'cancel' || text === item.text) return;
              // An emptied line is removed, unless others hang under it.
              if (text) change(index, { text });
              else if (!under) remove(index);
            }} />
            : <button type="button" className="ps-goal-text" onClick={() => { setConfirming(undefined); setEditing(index); }}>{item.text}</button>}
          {confirming === index
            ? <button type="button" className="ps-button ps-goal-confirm" autoFocus onBlur={() => setConfirming(undefined)} onClick={() => remove(index)}>{ui('Delete it with the {count} under it?', { count: under })}</button>
            : <button type="button" className="ps-icon" title={ui('Delete')} aria-label={ui('Delete')} onClick={() => remove(index)}>×</button>}
        </li>;
      })}
    </ul>}
    <NewLine label={ui('Add a to-do')} placeholder={ui('Add a to-do…')} onAdd={text => apply([...items, { depth: 0, done: false, text }])} />
  </>;
}
