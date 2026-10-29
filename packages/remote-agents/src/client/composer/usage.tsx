import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { PROVIDER_LABELS, type AccountUsage, type TokenUsage, type TokenUsageBreakdown, type UsageReport } from '../../core/domain.js';
import { api } from '../api.js';
import { localizeError, ui, useLocale } from '../i18n.js';

export interface Selection { provider: string; model: string; reasoningEffort?: string }
interface ModelStore { getSnapshot(): { current: Selection | null } | undefined; subscribe(listener: () => void): () => void }
export interface ModelDirectories { directoryFor(sessionId: string): { store: ModelStore; select?(selection: Selection): Promise<unknown> } }

const POLL_MS = 5000, CLOSE_DELAY_MS = 150;
/** CLIs whose account reports plan limits through its own protocol. */
const ACCOUNT_PROVIDERS = new Set(['codex', 'claude']);
const remote = (provider: string) => provider === 'remote-cli' || provider.startsWith('remote-cli-');

// The picker's directory knows the model a session uses, including a new session's choice before it sends.
let directories: ModelDirectories | undefined;
const directoryListeners = new Set<() => void>();
export const setModelDirectories = (value: ModelDirectories | undefined) => { directories = value; for (const listener of directoryListeners) listener(); };
/** Switch a conversation's model through DSH's own selector, as a pick in the model menu would. */
export async function selectModel(sessionId: string, selection: Selection): Promise<void> {
  const directory = directories?.directoryFor(sessionId);
  if (!directory?.select) throw new Error('Model selection is unavailable');
  await directory.select(selection);
}
const subscribeDirectories = (listener: () => void) => { directoryListeners.add(listener); return () => { directoryListeners.delete(listener); }; };
export function useCurrentModel(sessionId: string | undefined): Selection | null {
  const resolver = useSyncExternalStore(subscribeDirectories, () => directories);
  const store = useMemo(() => {
    if (!resolver || !sessionId) return undefined;
    try { return resolver.directoryFor(sessionId).store; } catch { return undefined; }
  }, [resolver, sessionId]);
  const subscribe = useCallback((listener: () => void) => store?.subscribe(listener) ?? (() => {}), [store]);
  return useSyncExternalStore(subscribe, () => store?.getSnapshot()?.current ?? null);
}

export function formatTokens(value: number): string {
  const trim = (n: number) => String(Number(n.toFixed(1)));
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${value < 10_000 ? trim(value / 1000) : Math.round(value / 1000)}k`;
  return `${trim(value / 1_000_000)}m`;
}
/** Compact time until a reset, as in `resets 4h`. */
export function formatReset(at: string, now = Date.now()): string | undefined {
  const minutes = (Date.parse(at) - now) / 60_000;
  if (!Number.isFinite(minutes)) return;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}
const contextLevel = (percent: number | null) => percent === null ? 'normal' : percent > 90 ? 'error' : percent >= 70 ? 'warning' : 'normal';
const remainingLevel = (left: number) => left < 10 ? 'error' : left < 30 ? 'warning' : 'normal';

// The host's 12px gap plus this button's and the model trigger's padding left a hole before the model picker.
const styles = `
.ra-usage{display:inline-flex;flex:none;margin-right:-8px;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);outline:none;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer}
.ra-usage:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.ra-usage:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.ra-usage svg{width:16px;height:16px;overflow:visible}
.ra-usage-track{fill:none;stroke:var(--dsw-alias-border-l3,rgba(127,127,127,.35));stroke-width:2}
.ra-usage-progress{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;transition:stroke-dashoffset .3s ease}
.ra-usage[data-level=warning]{color:var(--dsw-alias-state-warn-primary,#f5a524)}
.ra-usage[data-level=error]{color:var(--dsw-alias-state-error-primary,#e5484d)}
.ra-usage-card{position:fixed;z-index:2147483000;box-sizing:border-box;width:300px;max-width:calc(100vw - 24px);overflow-y:auto;padding:16px;border-radius:14px;background:var(--dsw-alias-bg-layer-3,#26272b);color:var(--dsw-alias-label-primary,#eee);box-shadow:var(--dsw-elevation-prominent,0 0 0 1px rgba(127,127,127,.25),0 8px 24px rgba(0,0,0,.3));font-size:13px;line-height:1.45}
.ra-usage-card p{margin:0}
.ra-usage-title{font-size:15px;font-weight:500}
.ra-usage-value{margin-top:6px;font-size:15px}
.ra-usage-muted{color:var(--dsw-alias-label-secondary,#999)}
.ra-usage-summary .ra-usage-muted{margin-top:4px}
.ra-usage-account{display:grid;gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}
.ra-usage-cache{display:grid;gap:6px;margin-top:14px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}
.ra-usage-cache-toggle{display:flex;align-items:center;gap:8px;width:100%;margin:-4px 0;padding:4px 0;border:none;border-radius:6px;outline:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ra-usage-cache-toggle:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.ra-usage-cache-toggle>.ra-usage-muted{margin-left:auto}
.ra-usage-cache-toggle svg{flex:none;width:14px;height:14px;color:var(--dsw-alias-label-secondary,#999);transition:transform .15s ease}
.ra-usage-cache-toggle[aria-expanded=true] svg{transform:rotate(180deg)}
.ra-usage-cache details>summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#999)}
.ra-usage-cache details[open]>summary{margin-bottom:6px}
.ra-usage-head{display:flex;align-items:center;gap:8px;min-width:0}
.ra-usage-provider{font-size:15px;font-weight:500}
.ra-usage-chip{padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.18));color:var(--dsw-alias-label-secondary,#aaa);font-size:12px;white-space:nowrap}
.ra-usage-refresh{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin-left:auto;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#999);cursor:pointer}
.ra-usage-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.ra-usage-refresh:disabled{cursor:default;opacity:.6}
.ra-usage-refresh[data-busy] svg{animation:ra-usage-spin 1s linear infinite}
.ra-usage-refresh svg{width:15px;height:15px}
@keyframes ra-usage-spin{to{transform:rotate(360deg)}}
.ra-usage-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.ra-usage-row strong{font-weight:500}
.ra-usage-bar{height:5px;margin-top:6px;overflow:hidden;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.2))}
.ra-usage-bar>span{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-state-success-primary,#4caf50)}
.ra-usage-bar[data-level=warning]>span{background:var(--dsw-alias-state-warn-primary,#f5a524)}
.ra-usage-bar[data-level=error]>span{background:var(--dsw-alias-state-error-primary,#e5484d)}
.ra-usage-error{color:var(--dsw-alias-state-error-primary,#e5484d)}
.ra-usage-email{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;
export function installUsageStyles(): () => void {
  if (typeof document === 'undefined') return () => {};
  const style = document.createElement('style'); style.dataset.remoteUsage = ''; style.textContent = styles;
  document.head.append(style); return () => style.remove();
}

/** Context polling is a local read; it pauses while the window is hidden. */
function useContextReport(sessionId: string | undefined, route: string | undefined): UsageReport | null {
  const [report, setReport] = useState<UsageReport | null>(null);
  useEffect(() => {
    setReport(null);
    if (!sessionId || !route) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    const load = async () => {
      if (document.visibilityState !== 'hidden') {
        controller = new AbortController();
        try {
          const next = await api<UsageReport | null>('usage', { sessionId, model: route }, controller.signal);
          if (!stopped) setReport(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        } catch { /* Keep the last value; the next poll retries. */ }
      }
      if (!stopped) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [sessionId, route]);
  return report;
}

function RefreshIcon() {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" /></svg>;
}
/** Share of input tokens served from cache, or undefined when the report cannot support one. */
function hitRate(usage?: TokenUsageBreakdown): string | undefined {
  const input = usage?.inputTokens, read = usage?.cachedInputTokens;
  const ratio = input !== undefined && input > 0 && read !== undefined && read <= input ? read / input * 100 : undefined;
  return ratio === undefined ? undefined : ratio > 0 && ratio < 0.1 ? '<0.1%' : `${Number(ratio.toFixed(1))}%`;
}
function TokenBreakdown({ usage }: { usage?: TokenUsageBreakdown }) {
  const token = (value: number | undefined) => <span title={value === undefined ? undefined : String(value)}>{value === undefined ? ui('Unknown') : formatTokens(value)}</span>;
  return <>
    <div className="ra-usage-row"><span className="ra-usage-muted">{ui('Input tokens')}</span>{token(usage?.inputTokens)}</div>
    <div className="ra-usage-row"><span className="ra-usage-muted">{ui('Cache read')}</span>{token(usage?.cachedInputTokens)}</div>
    <div className="ra-usage-row"><span className="ra-usage-muted">{ui('Cache write')}</span>{token(usage?.cacheWriteInputTokens)}</div>
    <div className="ra-usage-row"><span className="ra-usage-muted">{ui('Cache hit rate')}</span><span>{hitRate(usage) ?? ui('Unknown')}</span></div>
    <div className="ra-usage-row"><span className="ra-usage-muted">{ui('Output tokens')}</span>{token(usage?.outputTokens)}</div>
  </>;
}
// The card unmounts whenever it closes, so the fold is remembered for the page instead.
let cacheExpanded = false;
/** Folded to its hit rate; the breakdown opens on click. */
export function CacheSection({ usage, expanded: initial = cacheExpanded }: { usage?: TokenUsage; expanded?: boolean }) {
  const [expanded, setExpanded] = useState(initial);
  const rate = hitRate(usage?.last);
  const toggle = () => { cacheExpanded = !expanded; setExpanded(cacheExpanded); };
  return <section className="ra-usage-cache" aria-label={ui('Prompt cache')}>
    <button type="button" className="ra-usage-cache-toggle" aria-expanded={expanded} onClick={toggle}>
      <span className="ra-usage-title">{ui('Prompt cache')}</span>
      <span className="ra-usage-muted">{rate === undefined ? ui('Unknown') : ui('{percent} hit', { percent: rate })}</span>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {expanded && <>
      <p className="ra-usage-muted">{ui('Latest reported model request')}</p>
      <TokenBreakdown usage={usage?.last} />
      {usage?.total && <details><summary>{ui('Thread total')}</summary><TokenBreakdown usage={usage.total} /></details>}
    </>}
  </section>;
}
function AccountSection({ provider, account, loading, refresh }: { provider: string; account?: AccountUsage; loading: boolean; refresh: () => void }) {
  return <section className="ra-usage-account" aria-label={ui('Plan usage')}>
    <div className="ra-usage-head">
      <span className="ra-usage-provider">{PROVIDER_LABELS[provider] ?? provider}</span>
      {account?.plan && <span className="ra-usage-chip">{account.plan}</span>}
      <button type="button" className="ra-usage-refresh" aria-label={ui('Refresh usage')} title={ui('Refresh usage')} disabled={loading} data-busy={loading ? '' : undefined} onClick={refresh}><RefreshIcon /></button>
    </div>
    {account?.error ? <p className="ra-usage-error" role="alert">{localizeError(account.error)}</p>
      : !account ? <p className="ra-usage-muted">{ui('Checking usage…')}</p>
      : !account.windows.length && <p className="ra-usage-muted">{ui('This account does not report plan limits.')}</p>}
    {account?.windows.map(window => {
      const left = Math.round(100 - window.usedPercent), reset = window.resetsAt ? formatReset(window.resetsAt) : undefined;
      return <div key={window.id}>
        <div className="ra-usage-row"><span className="ra-usage-muted">{ui(window.label)}</span>
          <span><strong>{ui('{percent}% left', { percent: left })}</strong>{reset && <span className="ra-usage-muted"> · {ui('resets {time}', { time: reset })}</span>}</span></div>
        <div className="ra-usage-bar" data-level={remainingLevel(left)} role="meter" aria-label={ui(window.label)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left}><span style={{ width: `${Math.max(0, Math.min(100, left))}%` }} /></div>
      </div>;
    })}
    {account?.extraUsage !== undefined && <div className="ra-usage-row"><span className="ra-usage-muted">{ui('Extra usage')}</span><span>{ui(account.extraUsage ? 'Enabled' : 'Disabled')}</span></div>}
    {account?.credits && <div className="ra-usage-row"><span className="ra-usage-muted">{ui('Credits')}</span><span>{ui(account.credits)}</span></div>}
    {account?.email && <p className="ra-usage-muted ra-usage-email" title={account.email}>{account.email}</p>}
  </section>;
}

/** Paseo-style context ring for a conversation that uses a remote CLI; plan limits open on hover. */
export function UsageRing({ sessionId }: { sessionId?: string }) {
  useLocale();
  const current = useCurrentModel(sessionId);
  const route = current && remote(current.provider) ? current.model : undefined;
  const report = useContextReport(sessionId, route);
  const [open, setOpen] = useState(false), [pinned, setPinned] = useState(false);
  const [account, setAccount] = useState<{ key: string; value?: AccountUsage; loading: boolean }>();
  const button = useRef<HTMLButtonElement>(null), card = useRef<HTMLDivElement>(null), closing = useRef<ReturnType<typeof setTimeout>>();
  const [position, setPosition] = useState<{ left: number; bottom: number }>();
  const key = `${sessionId}\0${route}`;
  const loadAccount = useCallback((refresh: boolean) => {
    if (!sessionId || !route) return;
    setAccount(previous => ({ key, value: previous?.key === key ? previous.value : undefined, loading: true }));
    void api<UsageReport | null>('usage', { sessionId, model: route, account: true, refresh }).then(next => {
      setAccount(previous => previous?.key === key ? { key, value: next?.account, loading: false } : previous);
    }).catch(error => {
      setAccount(previous => previous?.key === key ? { key, value: { provider: '', windows: [], checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }, loading: false } : previous);
    });
  }, [key, sessionId, route]);
  const reportsAccount = !!report && ACCOUNT_PROVIDERS.has(report.provider);
  useEffect(() => { if (open && reportsAccount) loadAccount(false); }, [open, reportsAccount, loadAccount]);
  useEffect(() => { setOpen(false); setPinned(false); }, [key]);
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const place = () => {
      const rect = button.current!.getBoundingClientRect(), width = Math.min(300, window.innerWidth - 24);
      setPosition({ left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), bottom: window.innerHeight - rect.top + 8 });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !button.current?.contains(event.target as Node) && !card.current?.contains(event.target as Node)) { setOpen(false); setPinned(false); }
    };
    document.addEventListener('keydown', dismiss, true); document.addEventListener('pointerdown', dismiss, true);
    return () => { document.removeEventListener('keydown', dismiss, true); document.removeEventListener('pointerdown', dismiss, true); };
  }, [open]);
  useEffect(() => () => clearTimeout(closing.current), []);
  if (!report) return null;
  const context = report.context, percent = context ? Math.round(Math.min(100, (context.used / context.max) * 100)) : null;
  const radius = 6, circumference = 2 * Math.PI * radius;
  const show = () => { clearTimeout(closing.current); setOpen(true); };
  const hide = () => { if (pinned) return; clearTimeout(closing.current); closing.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS); };
  const label = percent === null ? ui('Context window usage is not reported yet') : ui('Context window {percent}% used', { percent });
  const value = account?.key === key ? account : undefined;
  return <>
    <button ref={button} type="button" className="ra-usage" data-level={contextLevel(percent)} aria-label={label} aria-expanded={open} aria-haspopup="dialog"
      onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={event => { if (!card.current?.contains(event.relatedTarget as Node)) hide(); }}
      onClick={() => { if (pinned) { setPinned(false); setOpen(false); } else { setPinned(true); show(); } }}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="ra-usage-track" cx="8" cy="8" r={radius} />
        {percent !== null && <circle className="ra-usage-progress" cx="8" cy="8" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - percent / 100)} transform="rotate(-90 8 8)" />}
      </svg>
    </button>
    {open && position && createPortal(<div ref={card} className="ra-usage-card" role="dialog" aria-label={ui('Context window')} style={{ left: position.left, bottom: position.bottom, maxHeight: `calc(100vh - ${position.bottom + 12}px)` }} onMouseEnter={show} onMouseLeave={hide}>
      <section className="ra-usage-summary">
        <p className="ra-usage-title">{ui('Context window')}</p>
        {context && percent !== null ? <>
          <p className="ra-usage-value">{ui('{percent}% used', { percent })}</p>
          <p className="ra-usage-muted">{ui('{used} / {max} tokens', { used: formatTokens(context.used), max: formatTokens(context.max) })}</p>
        </> : <p className="ra-usage-muted">{ui('Shown after the remote CLI reports it.')}</p>}
      </section>
      {reportsAccount && <CacheSection usage={report.tokenUsage} />}
      {reportsAccount && <AccountSection provider={report.provider} account={value?.value} loading={value?.loading ?? true} refresh={() => loadAccount(true)} />}
    </div>, document.body)}
  </>;
}
