import React, { useMemo, useRef, useState } from 'react';
import { endOf, parseGoals, serializeGoals, tally, type GoalItem } from '../goals.js';
import { ui } from './i18n.js';

type End = 'enter' | 'leave' | 'cancel';
/** Long enough for a goal; a goal that needs more is a paragraph for Progress. */
const LINE_LIMIT = 300;
/** Enter that picks a candidate in a Chinese or Japanese input method is not the end of the line. */
const composing = (event: React.KeyboardEvent) => event.nativeEvent.isComposing || event.keyCode === 229;

/** One line being typed. Answers once, however it ends: Enter, leaving the field, or Escape. */
function LineInput({ initial, label, onDone }: { initial: string; label: string; onDone(text: string, how: End): void }) {
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

/** The line at the bottom that is always there: type a goal, press Enter, type the next. */
function NewGoal({ first, onAdd }: { first: boolean; onAdd(text: string): void }) {
  const [text, setText] = useState('');
  const add = () => { const line = text.trim(); setText(''); if (line) onAdd(line); };
  return <div className="ps-goal ps-goal-new">
    <span className="ps-goal-plus" aria-hidden="true">+</span>
    <input className="ps-goal-input" aria-label={ui('Add a goal')} placeholder={ui(first ? 'Add a goal: what this milestone has to deliver' : 'Add a goal…')} value={text} maxLength={LINE_LIMIT}
      onChange={event => setText(event.target.value)} onBlur={add}
      onKeyDown={event => { if (event.key === 'Enter' && !composing(event)) { event.preventDefault(); add(); } }} />
  </div>;
}

/**
 * The Goal field as a list to tick off: goals, each with the steps it breaks down into. Every change is handed up as the
 * whole field's text at once, a Markdown task list (see goals.ts), so an agent reading the file sees the same boxes.
 * @param value - the field's text.
 */
export function GoalList({ value, onChange }: { value: string; onChange(text: string): void }) {
  const items = useMemo(() => parseGoals(value), [value]);
  /** The line being typed: an item's text, or a new step that goes in before `items[at]`. */
  const [editing, setEditing] = useState<{ at: number; fresh: boolean; key: number } | undefined>();
  /** The goal whose removal, steps and all, waits for a second click. */
  const [confirming, setConfirming] = useState<number | undefined>();
  const keys = useRef(0);
  const apply = (next: GoalItem[]) => onChange(serializeGoals(next));
  const change = (index: number, patch: Partial<GoalItem>) => apply(items.map((item, at) => at === index ? { ...item, ...patch } : item));
  const remove = (index: number) => {
    const end = endOf(items, index);
    if (end > index + 1 && confirming !== index) { setConfirming(index); return; }
    setConfirming(undefined);
    apply([...items.slice(0, index), ...items.slice(end)]);
  };

  const step = (at: number) => <li key={`new-${editing!.key}`} className="ps-goal" data-depth={1} style={{ '--ps-depth': 1 } as React.CSSProperties}>
    <input type="checkbox" disabled aria-hidden="true" />
    <LineInput initial="" label={ui('Add a step')} onDone={(text, how) => {
      if (!text || how === 'cancel') { setEditing(undefined); return; }
      apply([...items.slice(0, at), { depth: 1, done: false, text }, ...items.slice(at)]);
      // Enter goes on to the next step.
      setEditing(how === 'enter' ? { at: at + 1, fresh: true, key: ++keys.current } : undefined);
    }} />
  </li>;
  const fresh = editing?.fresh ? Math.min(editing.at, items.length) : -1;

  return <>
    <ul className="ps-goals">
      {items.map((item, index) => {
        const steps = item.depth === 0 && item.done !== undefined ? tally(items, index) : undefined, under = endOf(items, index) - index - 1;
        return <React.Fragment key={index}>
          {fresh === index && step(index)}
          <li className="ps-goal" data-depth={item.depth} data-done={item.done ? '' : undefined} style={{ '--ps-depth': item.depth } as React.CSSProperties}>
            {item.done === undefined
              ? <button type="button" className="ps-goal-box" title={ui('Make it a to-do')} aria-label={ui('Make it a to-do')} onClick={() => change(index, { done: false })} />
              : <input type="checkbox" checked={item.done} aria-label={item.text} onChange={() => change(index, { done: !item.done })} />}
            {editing && !editing.fresh && editing.at === index
              ? <LineInput key={editing.key} initial={item.text} label={ui('Edit')} onDone={(text, how) => {
                setEditing(undefined);
                if (how === 'cancel' || text === item.text) return;
                // An emptied line is removed, unless steps hang under it.
                if (text) change(index, { text });
                else if (!under) remove(index);
              }} />
              : <button type="button" className="ps-goal-text" onClick={() => { setConfirming(undefined); setEditing({ at: index, fresh: false, key: ++keys.current }); }}>{item.text}</button>}
            {steps && steps.total > 0 && <span className="ps-goal-count">{steps.done}/{steps.total}</span>}
            {item.depth === 0 && item.done !== undefined && <button type="button" className="ps-icon" title={ui('Add a step')} aria-label={ui('Add a step')}
              onClick={() => { setConfirming(undefined); setEditing({ at: endOf(items, index), fresh: true, key: ++keys.current }); }}>+</button>}
            {confirming === index
              ? <button type="button" className="ps-button ps-goal-confirm" autoFocus onBlur={() => setConfirming(undefined)} onClick={() => remove(index)}>{ui('Delete it with its {count} steps?', { count: under })}</button>
              : <button type="button" className="ps-icon" title={ui('Delete')} aria-label={ui('Delete')} onClick={() => remove(index)}>×</button>}
          </li>
        </React.Fragment>;
      })}
      {fresh === items.length && step(items.length)}
    </ul>
    <NewGoal first={!items.length} onAdd={text => apply([...items, { depth: 0, done: false, text }])} />
  </>;
}
