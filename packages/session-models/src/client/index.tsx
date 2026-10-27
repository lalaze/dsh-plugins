import React, { useSyncExternalStore } from 'react';
import type { LocaleContext } from '@dsh-plugins/i18n';
import { useLocale } from '@dsh-plugins/i18n/react';
import { BRAND_COLORS, CLI_NAMES, iconUrl } from './brands.js';
import { i18n, installLocale, ui } from './i18n.js';
import { installOverlay, type Overlay, type Sessions } from './overlay.js';

interface Client extends LocaleContext {
  effect(factory: () => () => void): void;
  inject?(services: string[], factory: (scoped: Client & { sessions: Sessions }) => void): unknown;
  slots: { inject(name: string, factory: () => void): unknown; register(spec: Record<string, unknown>, component: React.FC<{ sessionId: string }>): unknown };
}

// Hover sections render from the slot registry, outside the `sessions` scope that owns the overlay.
let current: Overlay | undefined;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Exact model under the row's hover card; the row icon only shows the vendor. */
function HoverModel({ sessionId }: { sessionId: string }) {
  useLocale(i18n);
  const badge = useSyncExternalStore(subscribe, () => current?.badge(sessionId));
  if (!badge) return null;
  const style = { '--dsm-icon': iconUrl(badge.brand), '--dsm-hover-color': BRAND_COLORS[badge.brand] ?? '#cfd3d6' } as React.CSSProperties;
  return <div className="dsm-hover">
    <span className="dsm-hover-icon" aria-hidden="true" style={style} />
    <span className="dsm-hover-model">{badge.model}</span>
    {badge.cli && <span className="dsm-hover-cli">{ui('Remote {cli}', { cli: CLI_NAMES[badge.cli] ?? badge.cli })}</span>}
  </div>;
}

export const name = 'dsh-session-models-client';
export const inject = ['slots', 'locale'];
export function apply(ctx: Client): void {
  ctx.effect(() => installLocale(ctx));
  ctx.slots.inject('sidebar.session.row.hover', () => {
    ctx.slots.register({ name: 'sidebar.session.row.hover', id: 'dsh-session-models', order: 50 }, HoverModel);
  });
  ctx.inject?.(['sessions'], scoped => scoped.effect(() => {
    const overlay = installOverlay(document, scoped.sessions);
    const off = overlay.subscribe(notify);
    current = overlay; notify();
    return () => {
      off(); overlay.dispose();
      if (current === overlay) { current = undefined; notify(); }
    };
  }));
}
