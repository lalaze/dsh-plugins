import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { localizeError, ui, useLocale } from '../i18n.js';
import { selectModel, useCurrentModel } from './usage.js';

const CODEX = 'remote-cli-codex';
const styles = `.ra-fast{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);outline:none;background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,currentColor));cursor:pointer}
.ra-fast:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,currentColor)}
.ra-fast:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.ra-fast[aria-pressed=true]{color:#e5a00d}
.ra-fast[aria-pressed=true] path{fill:currentColor}
.ra-fast:disabled{cursor:default;opacity:.5}
.ra-fast svg{width:16px;height:16px}`;
/** A Codex chat model route without a saved speed tier: `<project>/<cli>/<model>`. */
const baseRoute = (route: string) => route.split('/').slice(0, 3).join('/');

interface Speed { key: string; available: boolean; enabled: boolean }

/**
 * The composer's lightning switch for Codex: on, the conversation's next turns use the model's Fast speed.
 * It is shown only for Codex models that offer Fast. A conversation still on an old Fast menu row moves to
 * the model's single row with the switch on.
 */
export function FastToggle({ sessionId }: { sessionId?: string }) {
  useLocale();
  const selection = useCurrentModel(sessionId);
  const route = sessionId && selection?.provider === CODEX ? selection.model : undefined;
  const key = sessionId && route ? `${sessionId}\n${baseRoute(route)}` : '';
  const [speed, setSpeed] = useState<Speed>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const migrated = useRef('');
  useEffect(() => {
    if (!key || !sessionId || !route) { setSpeed(undefined); return; }
    let alive = true; setError('');
    void (async () => {
      const value = await api<{ available: boolean; enabled: boolean }>('chatSpeed', { sessionId, model: route });
      if (!alive) return;
      // Old conversations picked a separate Fast row; carry that choice over to the switch.
      if (route !== baseRoute(route) && migrated.current !== key) {
        migrated.current = key;
        if (value.available && !value.enabled) await api('setChatSpeed', { sessionId, fast: true });
        await selectModel(sessionId, { provider: selection!.provider, model: baseRoute(route), ...(selection!.reasoningEffort ? { reasoningEffort: selection!.reasoningEffort } : {}) });
        if (alive) setSpeed({ key, available: value.available, enabled: value.available || value.enabled });
        return;
      }
      setSpeed({ key, ...value });
    })().catch(() => { if (alive) setSpeed(undefined); });
    return () => { alive = false; };
  }, [key]);
  if (!speed || speed.key !== key || !speed.available) return null;
  const toggle = async () => {
    const next = !speed.enabled;
    setSaving(true); setError(''); setSpeed({ ...speed, enabled: next });
    try { await api('setChatSpeed', { sessionId, fast: next }); }
    catch (e) { setSpeed(speed); setError(localizeError(e instanceof Error ? e.message : String(e))); }
    finally { setSaving(false); }
  };
  const label = speed.enabled ? ui('Fast is on: faster replies that use more of your plan. Applies from the next message.') : ui('Fast is off. Turn it on for faster replies that use more of your plan.');
  const title = error ? `${ui('Could not change Fast')}: ${error}` : label;
  return <><style>{styles}</style>
    <button type="button" className="ra-fast" aria-pressed={speed.enabled} aria-label={ui('Fast')} title={title} disabled={saving} onClick={() => void toggle()}>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><path d="M9.2 1.5 3.5 9h4l-.7 5.5L12.5 7h-4l.7-5.5Z" /></svg>
    </button>
  </>;
}
