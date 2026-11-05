import { createI18n, type LocaleContext } from '@dsh-plugins/i18n';
import { useLocale as useI18n } from '@dsh-plugins/i18n/react';
import React, { useCallback, useEffect, useState } from 'react';
import { API_PATH, type EffortOption } from '../shared.js';
import { MAX_ROUNDS } from '../line.js';
import type { CatalogModel, Role, Route } from '../routes.js';
import type { FlowConfig } from '../store.js';
import { zh } from './locales.js';

const i18n = createI18n('dsh-model-flow', zh);
const { ui } = i18n;
const useLocale = () => useI18n(i18n);

const styles = `
.mf-settings{container-type:inline-size;display:flex;flex-direction:column;gap:12px;font-size:13px}
.mf-settings h2{font-size:15px;font-weight:600;margin:0}
.mf-muted{color:var(--color-text-secondary,#6b7280);margin:0;line-height:1.5}
.mf-row{display:grid;grid-template-columns:64px minmax(0,1fr) minmax(0,140px);gap:8px;align-items:center}
.mf-row label{font-weight:500}
.mf-row select,.mf-rounds select{min-width:0;width:100%;height:30px;border:1px solid var(--color-border,#d1d5db);border-radius:6px;background:transparent;color:inherit;padding:0 6px;font:inherit}
.mf-rounds{display:flex;align-items:center;gap:8px}
.mf-rounds select{width:72px}
.mf-status{min-height:18px}
.mf-status[data-tone=error]{color:var(--color-danger,#dc2626)}
.mf-status button{margin-left:8px;font:inherit;background:none;border:1px solid var(--color-border,#d1d5db);border-radius:6px;padding:1px 8px;cursor:pointer;color:inherit}
@container (max-width:380px){.mf-row{grid-template-columns:minmax(0,1fr)}}
`;
const ROLES: readonly { role: Role; label: string; optional?: boolean }[] = [
  { role: 'plan', label: 'Plan', optional: true },
  { role: 'implement', label: 'Implement' },
  { role: 'review', label: 'Review' },
];
const keyOf = (route: Pick<Route, 'provider' | 'model'>) => JSON.stringify([route.provider, route.model]);

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(API_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-DSH-Model-Flow': '1' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : ui('Could not save.'));
  return result as T;
}
function RoleRow({ label, optional, route, models, change }: { label: string; optional?: boolean; route?: Route; models: CatalogModel[]; change(route: Route | undefined): void }) {
  const [efforts, setEfforts] = useState<EffortOption[]>([]);
  useEffect(() => {
    let live = true; setEfforts([]);
    if (route) void post<{ efforts: EffortOption[] }>({ action: 'efforts', provider: route.provider, model: route.model }).then(value => { if (live) setEfforts(value.efforts); }).catch(() => undefined);
    return () => { live = false; };
  }, [route?.provider, route?.model]);
  const groups = new Map<string, CatalogModel[]>();
  for (const model of models) groups.set(model.providerName ?? model.provider, [...groups.get(model.providerName ?? model.provider) ?? [], model]);
  return <div className="mf-row"><label>{ui(label)}</label>
    <select aria-label={`${ui(label)} · ${ui('Model')}`} value={route ? keyOf(route) : ''} onChange={event => {
      const model = models.find(item => keyOf({ provider: item.provider, model: item.id }) === event.target.value);
      change(model ? { provider: model.provider, model: model.id, label: model.name } : undefined);
    }}>
      <option value="">{ui(optional ? 'Skip planning' : 'Choose a model')}</option>
      {route && !models.some(model => keyOf({ provider: model.provider, model: model.id }) === keyOf(route)) && <option value={keyOf(route)}>{route.label}</option>}
      {[...groups].map(([group, items]) => <optgroup key={group} label={group}>{items.map(model => <option key={keyOf({ provider: model.provider, model: model.id })} value={keyOf({ provider: model.provider, model: model.id })}>{model.name}</option>)}</optgroup>)}
    </select>
    <select aria-label={`${ui(label)} · ${ui('Thinking')}`} disabled={!efforts.length} value={route?.effort ?? ''} onChange={event => { if (route) { const { effort: _old, ...rest } = route; change(event.target.value ? { ...rest, effort: event.target.value } : rest); } }}>
      <option value="">{ui('Default thinking')}</option>
      {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.label}</option>)}
    </select>
  </div>;
}
function Settings() {
  useLocale();
  const [data, setData] = useState<{ config: FlowConfig; models: CatalogModel[] } | null>(null), [status, setStatus] = useState<{ text: string; tone?: 'error' } | null>(null), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus({ text: ui('Loading…') });
    void fetch(API_PATH, { credentials: 'same-origin', signal: controller.signal }).then(response => response.json()).then(value => { setData(value); setStatus(null); })
      .catch(() => { if (!controller.signal.aborted) setStatus({ text: ui('Could not load the models.'), tone: 'error' }); });
    return () => controller.abort();
  }, [revision]);
  const save = useCallback(async (config: FlowConfig) => {
    setData(current => current && { ...current, config }); setStatus({ text: ui('Saving…') });
    try { await post({ action: 'save', config }); setStatus({ text: ui('Saved') }); }
    catch (error) { setStatus({ text: error instanceof Error ? error.message : ui('Could not save.'), tone: 'error' }); }
  }, []);
  return <section className="mf-settings" aria-label={ui('Model flow')}><style>{styles}</style>
    <h2>{ui('Model flow')}</h2>
    <p className="mf-muted">{ui('Use /flow <goal> in any conversation. One model plans, one implements, one reviews, and rejected work goes back until it passes or the rounds run out. On a remote machine the same model on that machine is used.')}</p>
    {data && ROLES.map(({ role, label, optional }) => <RoleRow key={role} label={label} optional={optional} route={data.config[role]} models={data.models}
      change={route => { const { [role]: _old, ...rest } = data.config; void save(route ? { ...rest, [role]: route } as FlowConfig : rest as FlowConfig); }} />)}
    {data && <div className="mf-rounds"><label>{ui('Review rounds at most')}</label>
      <select aria-label={ui('Review rounds at most')} value={data.config.rounds} onChange={event => void save({ ...data.config, rounds: Number(event.target.value) })}>
        {Array.from({ length: MAX_ROUNDS }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}</option>)}
      </select></div>}
    {data && <p className="mf-muted">{ui('Planning and review run read-only, so those models cannot change your files.')}</p>}
    <div className="mf-status" role="status" data-tone={status?.tone}>{status?.text}{status?.tone === 'error' && !data && <button type="button" onClick={() => setRevision(value => value + 1)}>{ui('Retry')}</button>}</div>
  </section>;
}
/** The text of the composer an event came from, when it holds a /flow line. */
function typedFlow(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const box = target.closest('textarea, [contenteditable="true"]') as HTMLTextAreaElement | HTMLElement | null;
  const text = box ? ('value' in box ? box.value : box.innerText) : '';
  return /^\s*\/flow\s+\S/u.test(text);
}
const composerOf = (button: Element) => { for (let node = button.parentElement; node; node = node.parentElement) { const box = node.querySelector('textarea, [contenteditable="true"]'); if (box) return box; } return null; };
/**
 * DSH stays on the new-session page after a command, so a flow started there would run out of sight. Once a /flow line
 * is sent, ask which conversation took it and open that one, which also shows a refusal that would otherwise go unseen.
 */
function installOpenAfterCommand(ctx: Client): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const follow = () => {
    clearTimeout(timer);
    let tries = 0;
    const ask = () => {
      tries++;
      void post<{ sessionId: string | null }>({ action: 'lastCommand' }).then(({ sessionId }) => {
        const navigation = ctx.get?.('uiWorkspace') as { openSession?: (id: string) => void } | undefined;
        if (sessionId) navigation?.openSession?.(sessionId);
        else if (tries < 10) timer = setTimeout(ask, 400);
      }).catch(() => undefined);
    };
    timer = setTimeout(ask, 300);
  };
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && typedFlow(event.target)) follow(); };
  const onClick = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (button && button.querySelector('svg') && !button.textContent?.trim() && typedFlow(composerOf(button))) follow();
  };
  document.addEventListener('keydown', onKey, true); document.addEventListener('click', onClick, true);
  return () => { clearTimeout(timer); document.removeEventListener('keydown', onKey, true); document.removeEventListener('click', onClick, true); };
}
interface Client extends Omit<LocaleContext, 'get'> {
  get?(name: string): unknown;
  effect(factory: () => () => void): void;
  slots: { inject(name: string, factory: () => void): unknown; register(spec: Record<string, unknown>, component: React.FC): unknown };
}
export const name = 'dsh-model-flow-client';
export const inject = ['slots', 'locale'];
export function apply(ctx: Client): void {
  ctx.effect(() => i18n.installLocale(ctx as LocaleContext));
  ctx.effect(() => {
    const send = () => { void post({ action: 'locale', locale: i18n.activeLocale() }).catch(() => undefined); };
    send();
    return i18n.subscribe(send);
  });
  ctx.effect(() => installOpenAfterCommand(ctx));
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'model-flow', order: 75, label: () => ui('Model flow') }, Settings));
}
