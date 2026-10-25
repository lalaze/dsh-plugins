import React, { useState } from 'react';
import { questionsOf, type Permission, type PermissionAnswer } from '../domain.js';
import { ui } from './i18n.js';

export function PermissionCard({ permission, busy, respond }: { permission: Permission; busy: boolean; respond: (answer: PermissionAnswer) => void }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const questions = questionsOf(permission.input);
  const actions = permission.actions ?? [];
  const answers = Object.fromEntries(questions.map(q => [q.header, q.multiple
    ? [...(selected[q.header] ?? []), ...(typed[q.header]?.trim() ? [typed[q.header].trim()] : [])].join(', ')
    : typed[q.header]?.trim() || selected[q.header]?.[0] || '']));
  const complete = questions.every(q => q.optional || !!answers[q.header]);
  const questionForm = permission.kind === 'question' && !actions.length;
  return <section className="ra-permission" aria-label={ui('Awaiting a response')}>
    <h3>{permission.title ?? permission.name}</h3>
    {permission.description && <p>{permission.description}</p>}
    {questionForm && questions.length > 0 ? questions.map(q => <fieldset className="ra-question" key={q.header} disabled={busy}>
      <legend>{q.question}</legend>
      {q.options.map(option => <label className="ra-option" key={option.label}>
        <input type={q.multiple ? 'checkbox' : 'radio'} name={`${permission.id}-${q.header}`} checked={selected[q.header]?.includes(option.label) ?? false} onChange={event => {
          setSelected(previous => ({ ...previous, [q.header]: q.multiple ? event.target.checked ? [...(previous[q.header] ?? []), option.label] : (previous[q.header] ?? []).filter(v => v !== option.label) : [option.label] }));
          if (!q.multiple) setTyped(previous => ({ ...previous, [q.header]: '' }));
        }} />
        <span>{option.label}{option.description && <small>{option.description}</small>}</span>
      </label>)}
      {q.freeText && <textarea aria-label={`${q.header}: ${ui(q.options.length ? 'Other answer' : 'Answer')}`} rows={2} value={typed[q.header] ?? ''} onChange={event => setTyped(previous => ({ ...previous, [q.header]: event.target.value }))} />}
    </fieldset>) : questionForm ? <p>{ui('This CLI returned an unsupported question format.')}</p> : null}
    {(permission.detail || permission.input) && <details><summary>{ui('Details')}</summary><pre>{JSON.stringify(permission.detail ?? permission.input, null, 2)}</pre></details>}
    <div className="ra-actions" style={{ marginTop: 12 }}>
      {actions.map(action => <button key={action.id} className={action.behavior === 'deny' ? 'ra-danger' : 'ra-primary'} disabled={busy} onClick={() => respond({ behavior: action.behavior, selectedActionId: action.id })}>{action.label}</button>)}
      {!actions.length && (!questionForm || questions.length > 0) && <button className="ra-primary" disabled={busy || (questionForm && !complete)} onClick={() => respond({ behavior: 'allow', ...(questionForm ? { answers } : {}) })}>{ui(questionForm ? 'Submit answers' : 'Allow once')}</button>}
      {!actions.some(a => a.behavior === 'deny') && <button className="ra-danger" disabled={busy} onClick={() => respond({ behavior: 'deny' })}>{ui('Deny')}</button>}
    </div>
  </section>;
}
