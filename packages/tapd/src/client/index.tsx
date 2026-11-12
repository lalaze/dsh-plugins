import type { LocaleContext } from '@dsh-plugins/i18n';
import { remoteFrom } from '@dsh-plugins/needs';
import { usePluginOffer } from '@dsh-plugins/needs/react';
import React, { useEffect, useRef, useState } from 'react';
import type { PublicSettings } from '../settings.js';
import { installLocale, ui, useLocale } from './i18n.js';

interface Client {
  effect(factory: () => () => void): void;
  get?(name: string): unknown;
  /** Runs `callback` in a scope of its own while the named services are there, and ends that scope when one leaves. */
  inject?(names: string[], callback: (scoped: Client) => void): unknown;
  slots: { inject(name: string, factory: () => unknown): unknown; register(spec: Record<string, unknown>, component: React.FC): unknown };
}
/** Autofix's page, as its client offers it to the plugins that hand bugs in. */
interface AutofixSources { register(id: string, panel: { name: string; Panel: React.ComponentType<{ embedded: true }>; text?(key: string, values?: Record<string, string>): string }): () => void }
const AUTOFIX = 'dsh-autofix';
let host: Client | undefined;
interface Reply { settings?: PublicSettings; connected?: boolean; found?: number; error?: string }
type Note = { kind: 'ok' | 'error'; text: string };
async function call(action: string, body: Record<string, unknown> = {}): Promise<Reply> {
  const response = await fetch('/api/tapd', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-DSH-Tapd': '1' }, body: JSON.stringify({ action, ...body }) });
  let reply: Reply;
  try { reply = await response.json() as Reply; } catch { throw new Error(`HTTP ${response.status}`); }
  if (!response.ok) throw Object.assign(new Error(reply.error || `HTTP ${response.status}`), { reply });
  return reply;
}
// The look of DSH's own settings: what a setting is on the left, its control on the right, in DSH's tokens. The same as dsh-autofix's page.
const CSS = `.td-settings{--td-fill:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 6%,transparent));--td-fill-strong:var(--dsw-alias-interactive-bg-active,color-mix(in srgb,currentColor 11%,transparent));--td-line:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));--td-accent:var(--dsw-alias-state-business-primary,#4176e6);--td-danger:var(--dsw-alias-state-error-primary,#d14343);--td-soft:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 58%,transparent));display:flex;flex-direction:column;max-width:760px;padding-top:14px;color:var(--dsw-alias-label-primary,inherit);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:20px}
.td-settings *{box-sizing:border-box}
:where(.td-settings) :is(h2,h3,p){margin:0}
.td-head{display:flex;justify-content:space-between;align-items:center;gap:16px;min-height:32px}
.td-settings h2{font-size:18px;line-height:26px;font-weight:600}
.td-settings h3{margin-top:32px;font-size:15px;line-height:22px;font-weight:600}
.td-muted{color:var(--td-soft);font-size:12px;line-height:18px}
.td-head+.td-muted{margin-top:4px;font-size:13px;line-height:20px}
.td-error{color:var(--td-danger);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.td-note{display:flex;align-items:center;gap:16px;margin-top:14px;padding:10px 14px;border-radius:12px;background:color-mix(in srgb,#f59e0b 14%,transparent)}
.td-note>div{display:flex;flex:1 1 auto;flex-direction:column;gap:2px;min-width:0}
.td-note>div>span{color:color-mix(in srgb,#d97706 72%,currentColor)}
.td-note>div>small{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}
.td-settings[data-embedded]{max-width:none;padding-top:0}
.td-settings[data-embedded] h3{margin-top:24px}
.td-settings[data-embedded] .td-savebar{position:static;box-shadow:none}
.td-settings input{min-width:0;height:32px;padding:0 10px;border:1px solid transparent;border-radius:10px;background:var(--td-fill);color:inherit;font:inherit;font-size:13px}
.td-settings input:hover{background:var(--td-fill-strong)}
.td-settings input:focus{outline:0;border-color:var(--td-accent);background:transparent}
.td-settings input::placeholder{color:var(--td-soft);opacity:.8}
.td-button{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--td-line);border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.td-button:hover:not(:disabled){background:var(--td-fill)}
.td-button[data-primary]{border-color:transparent;background:var(--dsw-alias-brand-primary,CanvasText);color:var(--dsw-alias-label-primary-foreground,Canvas)}
.td-button[data-primary]:hover:not(:disabled){background:var(--dsw-alias-brand-primary,CanvasText);opacity:.88}
.td-button:disabled{opacity:.45;cursor:default}
.td-settings :is(button,input):focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--td-accent));outline-offset:1px}
.td-settings input:focus-visible{outline:0}
.td-row{display:flex;align-items:center;justify-content:space-between;gap:24px;min-width:0;padding:14px 0;border-bottom:1px solid var(--td-line)}
.td-rows>.td-row:last-child{border-bottom:0}
.td-row-text{display:flex;flex:1 1 auto;flex-direction:column;gap:2px;min-width:0}
.td-row-text>span{font-size:14px;line-height:22px}
.td-row-text>small{font-size:12px;line-height:18px;color:var(--td-soft)}
.td-row-control{display:flex;flex:none;align-items:center;justify-content:flex-end;gap:8px;max-width:60%}
.td-row-control>input{width:220px;max-width:100%}
.td-row[data-stacked]{flex-direction:column;align-items:stretch;gap:8px}
.td-row[data-stacked]>.td-row-control{flex-direction:column;align-items:stretch;max-width:none}
.td-seg{display:inline-flex;gap:2px;padding:2px;border-radius:10px;background:var(--td-fill)}
.td-seg>button{height:28px;padding:0 12px;border:0;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.td-seg>button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-3,Canvas);color:inherit;box-shadow:0 1px 3px rgba(0,0,0,.14)}
.td-switch{position:relative;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--td-fill-strong);cursor:pointer;transition:background .12s}
.td-switch::after{content:'';display:block;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .12s}
.td-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary,CanvasText)}
.td-switch[aria-checked=true]::after{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,Canvas)}
.td-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-height:32px;padding:4px 6px;border:1px solid transparent;border-radius:10px;background:var(--td-fill);cursor:text}
.td-chips:focus-within{border-color:var(--td-accent);background:transparent}
.td-settings .td-chips>input,.td-settings .td-chips>input:hover,.td-settings .td-chips>input:focus{flex:1 1 80px;min-width:80px;height:22px;padding:0 4px;border:0;border-radius:4px;background:transparent}
.td-chip{display:inline-flex;align-items:center;gap:2px;height:22px;padding:0 2px 0 8px;border:1px solid var(--td-line);border-radius:7px;background:var(--dsw-alias-bg-layer-3,Canvas);font-size:12px;line-height:20px;white-space:nowrap}
.td-chip>button,.td-project>button{width:18px;height:18px;padding:0;border:0;border-radius:5px;background:none;color:var(--td-soft);font:inherit;font-size:14px;line-height:16px;cursor:pointer}
.td-chip>button:hover,.td-project>button:hover{background:var(--td-fill-strong);color:inherit}
.td-project{display:flex;align-items:center;gap:8px}
.td-project>input:first-child{flex:0 0 130px;font-variant-numeric:tabular-nums}
.td-project>input:nth-child(2){flex:1 1 0}
.td-project>button{width:28px;height:28px;border-radius:8px;font-size:16px}
.td-row-control>.td-button{align-self:flex-start}
.td-savebar{position:sticky;bottom:12px;z-index:2;display:flex;align-items:center;gap:8px;min-height:50px;margin-top:20px;padding:8px 8px 8px 14px;border:1px solid var(--td-line);border-radius:14px;background:var(--dsw-alias-bg-layer-3,Canvas);box-shadow:0 8px 28px rgba(0,0,0,.16)}
.td-savebar>span{flex:1 1 auto;min-width:0;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.td-savebar[data-kind=error]>span{color:var(--td-danger)}
@media(max-width:560px){.td-note{flex-direction:column;align-items:stretch}.td-row{flex-direction:column;align-items:stretch;gap:8px}.td-row-control{max-width:none;justify-content:flex-start}.td-row-control>input{width:100%}.td-project>input:first-child{flex-basis:96px}}
@media(prefers-reduced-motion:reduce){.td-switch,.td-switch::after{transition:none}}`;

const words = (value: string) => value.split(/[,，\n]/u).map(word => word.trim()).filter(Boolean);
/** One setting: what it is on the left, the control on the right; `stacked` puts a wide control underneath. */
function Row({ title, hint, stacked, children }: { title: string; hint?: string; stacked?: boolean; children: React.ReactNode }) {
  return <div className="td-row" data-stacked={stacked || undefined}>
    <div className="td-row-text"><span>{title}</span>{hint && <small>{hint}</small>}</div>
    <div className="td-row-control">{children}</div>
  </div>;
}
/** A short list of words as removable chips. Enter, a comma or leaving the box adds what was typed. */
function Chips({ label, value, onChange, placeholder }: { label: string; value: readonly string[]; onChange(next: string[]): void; placeholder?: string }) {
  const [draft, setDraft] = useState(''), input = useRef<HTMLInputElement>(null);
  const add = (typed: string) => { const more = words(typed).filter(word => !value.includes(word)); if (more.length) onChange([...value, ...more]); setDraft(''); };
  return <div className="td-chips" onClick={event => { if (event.target === event.currentTarget) input.current?.focus(); }}>
    {value.map(word => <span key={word} className="td-chip">{word}
      <button type="button" aria-label={ui("Remove {0}", { 0: word })} title={ui("Remove {0}", { 0: word })} onClick={() => onChange(value.filter(entry => entry !== word))}>×</button></span>)}
    <input ref={input} aria-label={label} value={draft} placeholder={value.length ? '' : placeholder} spellCheck={false}
      onChange={event => { if (/[,，\n]/u.test(event.target.value)) add(event.target.value); else setDraft(event.target.value); }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); add(draft); }
        else if (event.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
      }}
      onBlur={() => { if (draft.trim()) add(draft); }} />
  </div>;
}

/** Autofix is what these bugs are handed to: without it, the way to get it. `leave` closes the settings, which cover the Plugins page. */
function NeedsAutofix({ leave, settled }: { leave(): void; settled(): void }) {
  const { offer, busy, outcome, run } = usePluginOffer(() => remoteFrom(host), AUTOFIX, settled);
  let plugins: { openBundle(name: string): void; openList(): void } | undefined;
  try { plugins = host?.get?.('pluginNavigation') as typeof plugins; } catch { /* A DSH without a Plugins page. */ }
  const installable = offer?.kind === 'install' || offer?.kind === 'update';
  const says = outcome?.kind === 'restart' ? ui("Installed. It starts the next time DSH starts.")
    : outcome?.kind === 'applied' ? ui("Installed.")
    : outcome?.kind === 'failed' ? ui("It could not be installed: {0}", { 0: outcome.detail })
    : busy ? ui("Installing… this can take a minute.")
    : offer?.kind === 'present' ? ui("It is installed but not running: switch it on in Plugins, or restart DSH.")
    : offer && !installable ? ui("None of your plugin markets offers it: add it on the Plugins page.") : undefined;
  return <div className="td-note" role="status">
    <div><span>{ui("Autofix is not installed or not running, so these bugs have nowhere to go.")}</span>{says && <small>{says}</small>}</div>
    {installable && outcome?.kind !== 'applied' && outcome?.kind !== 'restart' && <button type="button" className="td-button" data-primary disabled={busy} onClick={run}>
      {busy ? ui("Installing…") : offer.kind === 'update' ? ui("Update Autofix") : ui("Install Autofix")}</button>}
    {plugins && offer && (!installable || outcome?.kind === 'failed') && <button type="button" className="td-button" onClick={() => { if (offer.kind === 'present') plugins.openBundle(AUTOFIX); else plugins.openList(); leave(); }}>{ui("Open Plugins")}</button>}
  </div>;
}

/** What the page of its own says if DSH still shows it after the settings moved into Autofix's page. */
function MovedToAutofix() {
  useLocale();
  return <section className="td-settings" aria-label="TAPD"><style>{CSS}</style><header className="td-head"><h2>TAPD</h2></header>
    <p className="td-muted">{ui("These settings are now in Settings → Autofix, under where bugs come from.")}</p></section>;
}

/** TAPD's settings: a page of their own, or `embedded` in Autofix's page under the sources, which has the heading already. */
function TapdSettings({ embedded, close }: { embedded?: boolean; close?(): void }) {
  useLocale();
  const [form, setForm] = useState<PublicSettings>(), [connected, setConnected] = useState(true), [token, setToken] = useState('');
  const [message, setMessage] = useState<Note>(), [busy, setBusy] = useState<'save' | 'test'>(), [dirty, setDirty] = useState(false);
  const load = () => call('state').then(reply => { setForm(reply.settings); setConnected(reply.connected !== false); setToken(''); setDirty(false); }, reason => setMessage({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) }));
  useEffect(() => { void load(); }, []);
  // Autofix installed from this page starts a moment later.
  useEffect(() => {
    if (connected || embedded) return;
    const timer = setInterval(() => { void call('state').then(reply => setConnected(reply.connected !== false), () => undefined); }, 4000);
    return () => clearInterval(timer);
  }, [connected, embedded]);
  useEffect(() => {
    if (message?.kind !== 'ok') return;
    const timer = setTimeout(() => setMessage(undefined), 4000);
    return () => clearTimeout(timer);
  }, [message]);
  if (!form) return <section className="td-settings"><style>{CSS}</style><header className="td-head"><h2>TAPD</h2></header>{message ? <p className="td-error">{message.text}</p> : <p className="td-muted">{ui("Loading…")}</p>}</section>;
  const set = <K extends keyof PublicSettings>(name: K, value: PublicSettings[K]) => { setForm(current => current && { ...current, [name]: value }); setDirty(true); setMessage(undefined); };
  const act = async (kind: 'save' | 'test') => {
    setBusy(kind); setMessage(undefined);
    try {
      const { hasToken: _hasToken, ...rest } = form;
      // A project row without a number is one the person has not filled in yet.
      const reply = kind === 'save' ? await call('save', { settings: { ...rest, workspaces: form.workspaces.filter(workspace => workspace.id.trim()), auth: { ...form.auth, token } } }) : await call('test');
      if (reply.settings) setForm(reply.settings);
      setConnected(reply.connected !== false);
      if (kind === 'save') { setToken(''); setDirty(false); }
      setMessage({ kind: 'ok', text: kind === 'save' ? ui("Saved") : ui("TAPD answered: {0} open bugs under your name.", { 0: String(reply.found ?? 0) }) });
    } catch (reason) { setMessage({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) }); }
    finally { setBusy(undefined); }
  };
  const basic = form.auth.kind === 'basic';
  const project = (index: number, change: Partial<PublicSettings['workspaces'][number]>) => set('workspaces', form.workspaces.map((workspace, at) => at === index ? { ...workspace, ...change } : workspace));
  const test = <button type="button" className="td-button" disabled={!!busy || dirty} title={dirty ? ui("Save first, then test.") : undefined} onClick={() => void act('test')}>{busy === 'test' ? ui("Testing…") : ui("Test the connection")}</button>;
  return <section className="td-settings" aria-label="TAPD" data-embedded={embedded || undefined}><style>{CSS}</style>
    {embedded
      ? <header className="td-head"><p className="td-muted">{ui("The bugs under your TAPD name, handed to Autofix; status and comments are written back from there.")}</p>{test}</header>
      : <><header className="td-head"><h2>TAPD</h2>{test}</header>
        <p className="td-muted">{ui("The bugs under your TAPD name, handed to Autofix; status and comments are written back from there.")}</p></>}
    {!connected && !embedded && <NeedsAutofix leave={() => close?.()} settled={() => void call('state').then(reply => setConnected(reply.connected !== false), () => undefined)} />}

    <h3>{ui("Sign-in")}</h3>
    <div className="td-rows">
      <Row title={ui("Sign-in kind")}>
        <div className="td-seg" role="group" aria-label={ui("Sign-in kind")}>
          <button type="button" aria-pressed={!basic} onClick={() => { if (basic) set('auth', { kind: 'bearer', token: '' }); }}>{ui("Personal access token")}</button>
          <button type="button" aria-pressed={basic} onClick={() => { if (!basic) set('auth', { kind: 'basic', user: '', token: '' }); }}>{ui("API account and password")}</button>
        </div></Row>
      {form.auth.kind === 'basic' && <Row title={ui("API account")}>
        <input aria-label={ui("API account")} value={form.auth.user} autoComplete="off" spellCheck={false} onChange={event => set('auth', { kind: 'basic', user: event.target.value, token: '' })} /></Row>}
      <Row title={basic ? ui("API password") : ui("Access token")} hint={form.hasToken ? ui("One is saved. Leave empty to keep it.") : ui("Kept on this computer, readable only by you.")}>
        <input aria-label={basic ? ui("API password") : ui("Access token")} type="password" value={token} autoComplete="new-password" placeholder={form.hasToken ? '••••••••' : ''} onChange={event => { setToken(event.target.value); setDirty(true); setMessage(undefined); }} /></Row>
      <Row title={ui("API address")}>
        <input aria-label={ui("API address")} value={form.apiBase} spellCheck={false} onChange={event => set('apiBase', event.target.value)} /></Row>
    </div>

    <h3>{ui("Which bugs")}</h3>
    <div className="td-rows">
      <Row title={ui("Your TAPD name")} hint={ui("As TAPD shows it in a bug's current owner.")}>
        <input aria-label={ui("Your TAPD name")} value={form.owner} onChange={event => set('owner', event.target.value)} /></Row>
      <Row stacked title={ui("Statuses to fetch")} hint={ui("API values such as new, reopened, or the names your project shows.")}>
        <Chips label={ui("Statuses to fetch")} value={form.statuses} placeholder="new" onChange={next => set('statuses', next)} /></Row>
      <Row stacked title={ui("TAPD projects")} hint={ui("The number is in the project's address on tapd.cn; the name is for you.")}>
        {form.workspaces.map((workspace, index) => <div key={index} className="td-project">
          <input aria-label={ui("Project number")} value={workspace.id} placeholder={ui("Number")} inputMode="numeric" spellCheck={false} onChange={event => project(index, { id: event.target.value.trim() })} />
          <input aria-label={ui("Project name")} value={workspace.name} placeholder={ui("Name")} onChange={event => project(index, { name: event.target.value })} />
          <button type="button" aria-label={ui("Remove {0}", { 0: workspace.name || workspace.id })} title={ui("Remove {0}", { 0: workspace.name || workspace.id })} onClick={() => set('workspaces', form.workspaces.filter((_, at) => at !== index))}>×</button>
        </div>)}
        <button type="button" className="td-button" onClick={() => set('workspaces', [...form.workspaces, { id: '', name: '' }])}><span aria-hidden="true">+</span>{ui("Add a project")}</button>
      </Row>
    </div>

    <h3>{ui("What is written back")}</h3>
    <div className="td-rows">
      <Row title={ui("Status when a task starts")} hint={ui("Empty leaves the bug's status alone.")}>
        <input aria-label={ui("Status when a task starts")} value={form.inProgressStatus} placeholder="in_progress" spellCheck={false} onChange={event => set('inProgressStatus', event.target.value)} /></Row>
      <Row title={ui("Comment on the bug when a fix is ready")} hint={ui("Says the fix waits for you, before anything is pushed.")}>
        <button type="button" className="td-switch" role="switch" aria-checked={form.commentOnReview} aria-label={ui("Comment on the bug when a fix is ready")} onClick={() => set('commentOnReview', !form.commentOnReview)} /></Row>
      <Row title={ui("Status of an accepted bug")} hint={ui("Written once you accept the fix.")}>
        <input aria-label={ui("Status of an accepted bug")} value={form.doneStatus} placeholder="resolved" spellCheck={false} onChange={event => set('doneStatus', event.target.value)} /></Row>
    </div>

    {(dirty || busy === 'save' || message) && <footer className="td-savebar" data-kind={message?.kind}>
      <span role={message?.kind === 'error' ? 'alert' : 'status'}>{message?.text ?? ui("Unsaved changes")}</span>
      {dirty && <>
        <button type="button" className="td-button" disabled={!!busy} onClick={() => { setMessage(undefined); void load(); }}>{ui("Discard")}</button>
        <button type="button" className="td-button" data-primary disabled={!!busy} onClick={() => void act('save')}>{busy === 'save' ? ui("Saving…") : ui("Save")}</button>
      </>}
    </footer>}
  </section>;
}

export const name = 'dsh-tapd-client';
// The desktop language bridge initializes asynchronously; wait before registering UI.
export const inject = ['slots', 'locale'];
const Embedded = () => <TapdSettings embedded />;
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx as LocaleContext));
  ctx.effect(() => { host = ctx; return () => { if (host === ctx) host = undefined; }; });
  // Inside Autofix's page while that page takes sources' settings. Without it, a page of its own, which says Autofix is missing.
  let hosted = false, redraw: (() => void) | undefined;
  const Page: React.FC<{ close?(): void }> = ({ close }) => {
    const [, set] = useState(0);
    useEffect(() => { redraw = () => set(count => count + 1); return () => { redraw = undefined; }; }, []);
    return hosted ? <MovedToAutofix /> : <TapdSettings close={close} />;
  };
  let section: unknown;
  const show = (wanted: boolean) => {
    if (wanted === (section !== undefined)) return;
    if (wanted) section = ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'tapd', order: 73, label: () => 'TAPD' }, Page as React.FC)) ?? true;
    else { const end = section; section = undefined; if (typeof end === 'function') (end as () => void)(); else (end as { dispose?(): void } | undefined)?.dispose?.(); }
  };
  show(true);
  ctx.effect(() => () => show(false));
  try {
    ctx.inject?.(['autofixSources'], scoped => {
      const sources = scoped.get?.('autofixSources') as AutofixSources | undefined;
      if (!sources) return;
      scoped.effect(() => {
        const remove = sources.register('tapd', { name: 'TAPD', Panel: Embedded, text: (key, values) => ui(key, values) });
        hosted = true; show(false); redraw?.();
        return () => { remove(); hosted = false; show(true); redraw?.(); };
      });
    });
  } catch (error) { console.warn('[dsh-tapd] Could not join the Autofix settings page', error); }
}
