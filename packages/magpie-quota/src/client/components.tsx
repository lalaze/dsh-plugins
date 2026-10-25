import { ui, useLocale, formatLocale } from './i18n.js';
import React, { useEffect, useState } from 'react';
import { accountLabel, type AccountQuota, type GatewayQuota, type QuotaWindow } from '../types.js';
import { ProviderIcon, RefreshIcon } from './icons.js';
import { QuotaQuery, refreshKey, useQuota } from './query.js';
import { styles } from './styles.js';

export const tone = (remaining: number | null): string => remaining !== null && remaining <= 10 ? 'danger' : remaining !== null && remaining <= 25 ? 'warning' : 'normal';
const time = (at: string) => new Date(at).toLocaleString(formatLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export function resetLabel(at: string | undefined, now: number): string {
  if (!at) return ui("Reset time unavailable");
  const seconds = Math.ceil((Date.parse(at) - now) / 1000);
  if (seconds <= 0) return ui("Reset time reached; waiting for a new reading");
  const minutes = Math.ceil(seconds / 60);
  return ui("Resets in {0}", { 0: minutes >= 1440 ? ui("{0}d {1}h", { 0: Math.floor(minutes / 1440), 1: Math.floor(minutes % 1440 / 60) }) : minutes >= 60 ? ui("{0}h {1}m", { 0: Math.floor(minutes / 60), 1: minutes % 60 }) : ui("{0}m", { 0: minutes }) });
}
export function useClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}
const windowName = (name: string) => ui(name);
function Meter({ window: w, now }: { window: QuotaWindow; now: number }) {
  useLocale();
  const value = w.unlimited ? '∞' : w.remaining === null ? '—' : `${Number(w.remaining.toFixed(1))}%`;
  const amount = w.limit !== undefined && w.amount !== undefined && w.unit ? ui("Remaining {0} / {1} {2}", { 0: Math.max(0, w.limit - w.amount).toLocaleString(formatLocale(), { maximumFractionDigits: 2 }), 1: w.limit.toLocaleString(formatLocale()), 2: w.unit }) : w.display;
  return <div className="mq-meter">
    <div className="mq-meter-top"><span className="mq-meter-name">{windowName(w.name)}{w.pool ? ` · ${w.pool}` : ''}</span><span className="mq-number" data-tone={tone(w.remaining)}>{value}</span></div>
    {!w.unlimited && w.remaining !== null && <div className="mq-track" role="progressbar" aria-label={ui("{0} remaining quota", { 0: windowName(w.name) })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.remaining}><span className="mq-fill" data-tone={tone(w.remaining)} style={{ width: `${w.remaining}%` }} /></div>}
    <div className="mq-meter-bottom"><span>{amount || (w.unlimited ? ui("Unlimited") : w.remaining === null ? ui("No reading yet") : ui("Remaining quota"))}</span><span title={w.resetsAt ? time(w.resetsAt) : undefined}>{!w.unlimited && resetLabel(w.resetsAt, now)}</span></div>
  </div>;
}
export function AccountCard({ gateway, account, query, now }: { gateway: GatewayQuota; account: AccountQuota; query: QuotaQuery; now: number }) {
  useLocale();
  const state = useQuota(query);
  const key = refreshKey(gateway.id, account.id);
  const seconds = Math.max(0, Math.ceil(((state.cooldowns[key] ?? 0) - now) / 1000));
  const busy = state.refreshing === key;
  const readAt = account.readAt || account.asOf;
  const old = gateway.stale || !!account.asOf || !!account.readDeferred || !!account.error;
  return <>
    <div className="mq-account-head"><span className="mq-provider-mark"><ProviderIcon provider={account.provider} size={20} /></span><div className="mq-account-label"><div className="mq-account-title">{account.name}<span className="mq-tag">{account.plan || (account.kind === 'balance' ? ui("Balance") : ui("Account"))}</span>{account.last && <span className="mq-last" title={ui("Recently served a request")} />}</div><div className="mq-caption">{accountLabel(account)}{account.alias && account.user ? ` · ${account.user}` : ''}</div></div></div>
    {account.error && <div className="mq-notice" role="status">{ui(account.error)}</div>}
    {account.balance && <div className="mq-balance">{account.balance}<span className="mq-caption">  {ui("Balance")}</span></div>}
    {account.windows.map(w => <Meter key={w.id} window={w} now={now} />)}
    {!account.windows.length && !account.balance && <div className="mq-empty">{account.error ? ui("No quota reading available") : ui("Magpie has not provided quota for this account")}</div>}
    {account.until && <div className="mq-caption" style={{ marginBottom: 12 }}>{ui("Plan")} {account.renew === 'auto' ? ui("renews") : account.renew === 'off' ? ui("expires") : ui("valid until")} {time(account.until)}</div>}
    <div className="mq-panel-foot"><div className={`mq-caption${old ? ' mq-stale' : ''}`} title={readAt ? ui("Quota reading time: {0}", { 0: time(readAt) }) : undefined}>{readAt ? `${old ? ui("Last reading") : ui("Read at")} ${time(readAt)}` : ui("No reading time available")}{account.readDeferred && <div>{ui("No refresh requested this time")}</div>}</div>
      <button type="button" className="mq-button" aria-label={ui("Refresh quota for {0}", { 0: accountLabel(account) })} aria-busy={busy || undefined} disabled={!!state.refreshing || seconds > 0 || !account.refreshable} title={!account.refreshable ? ui("Refresh in the Magpie instance that owns this account") : ui("Ask Magpie to refresh this account's quota")} onClick={() => void query.refresh(gateway.id, account.id)}><RefreshIcon />{busy ? ui("Reading…") : seconds ? `${seconds}s` : ui("Refresh")}</button>
    </div>
  </>;
}
export function QuotaDashboard({ query }: { query: QuotaQuery }) {
  useLocale();
  const state = useQuota(query); const now = useClock();
  return <section className="mq mq-page" aria-label={ui("Magpie quota")}><style>{styles}</style>
    <header className="mq-page-head"><div><h2>{ui("Magpie quota")}</h2><p>{ui("Remaining quota and reset times for each account")}</p></div><button type="button" className="mq-button" onClick={() => void query.read(true)} disabled={state.loading || !!state.refreshing}><RefreshIcon />{ui("Reload")}</button></header>
    {state.error && <div className="mq-notice" role="alert">{ui(state.error)}</div>}
    {state.loading && <div className="mq-empty" role="status">{ui("Loading quota…")}</div>}
    {state.report?.gateways.map(gateway => <section key={gateway.id} className="mq-gateway" aria-label={gateway.name}><div className="mq-gateway-head"><ProviderIcon provider="magpie" />{ui(gateway.name)}<span>· {gateway.accounts.length}  {ui("accounts")}</span></div>
      {gateway.error && <div className="mq-notice" role="status">{ui(gateway.error.message)}{gateway.stale && ui("; previous readings are shown below.")}</div>}
      <div className="mq-grid">{gateway.accounts.map(account => <article className="mq-card" key={account.id} aria-label={`${account.name} ${accountLabel(account)}`}><AccountCard gateway={gateway} account={account} query={query} now={now} /></article>)}</div>
      {!gateway.accounts.length && !gateway.error && <div className="mq-empty">{ui("Magpie has not returned any visible account quotas.")}</div>}
    </section>)}
    {!state.loading && state.report?.gateways.length === 0 && <div className="mq-empty">{ui("Magpie is not configured. Add a Magpie provider or specify a provider ID in plugin settings.")}</div>}
    <p className="mq-small">{ui("The icons below the composer show each account's lowest known remaining window percentage. Readings come from Magpie and sync automatically. Account refreshes have a 30-second cooldown.")}</p>
  </section>;
}
