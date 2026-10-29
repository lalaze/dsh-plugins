import React, { useState, type ComponentType } from 'react';
import { UsageDialog } from './dialog.js';
import { ui, useLocale } from './i18n.js';
import { savePreferences, usePreferences } from './preferences.js';

// DSH's settings rows: a 16px section title, hairline-separated rows with a 14px title and a 12px hint,
// its monochrome switch and its small outlined button.
const CSS = `.us-settings{display:flex;flex-direction:column;gap:4px;max-width:720px;color:var(--dsw-alias-label-primary,inherit);font-family:var(--dsw-font-family,inherit);font-size:14px;line-height:22px}
.us-settings *{box-sizing:border-box}
:where(.us-settings) :is(h2,p){margin:0}
.us-settings h2{font-size:16px;line-height:24px;font-weight:500}
.us-settings-intro{margin-top:2px;color:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 58%,transparent));font-size:13px;line-height:20px}
.us-settings-row{display:flex;justify-content:space-between;align-items:center;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent))}
.us-settings-row:last-child{border-bottom:0}
.us-settings-title{font-size:14px;line-height:20px}
.us-settings-hint{margin-top:4px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent));font-size:12px;line-height:18px}
.us-settings-button{flex:none;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 16%,transparent));border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.us-settings-button:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 7%,transparent))}
.us-settings-toggle{flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 18%,transparent));cursor:pointer}
.us-settings-toggle span{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform .12s ease}
.us-settings-toggle[aria-checked=true]{background:var(--dsw-alias-brand-primary,CanvasText)}
.us-settings-toggle[aria-checked=true] span{background:var(--dsw-alias-label-primary-foreground,Canvas);transform:translateX(16px)}
.us-settings button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}
@media(prefers-reduced-motion:reduce){.us-settings-toggle span{transition:none}}`;

/** Usage statistics settings. The statistics themselves open in a modal window, here or from the header pill. */
export function UsageSettings({ details }: { details: ComponentType }) {
  useLocale();
  const { headerBadge } = usePreferences();
  const [open, setOpen] = useState(false);
  return <section className="us-settings" aria-label={ui("Usage statistics")}><style>{CSS}</style>
    <header><h2>{ui("Usage statistics")}</h2><p className="us-settings-intro">{ui("Model usage from DSH and remote agents")}</p></header>
    <div className="us-settings-list">
      <div className="us-settings-row"><div><div className="us-settings-title">{ui("Show today's usage in the conversation header")}</div>
        <p className="us-settings-hint">{ui("Click it to open the full statistics. Applies to this device only.")}</p></div>
        <button type="button" className="us-settings-toggle" role="switch" aria-checked={headerBadge} aria-label={ui("Show today's usage in the conversation header")} onClick={() => savePreferences({ headerBadge: !headerBadge })}><span /></button></div>
      <div className="us-settings-row"><div><div className="us-settings-title">{ui("Usage statistics")}</div>
        <p className="us-settings-hint">{ui("Trends, breakdowns and details by provider, workspace, model and host, with CSV export.")}</p></div>
        <button type="button" className="us-settings-button" aria-haspopup="dialog" onClick={() => setOpen(true)}>{ui("Open")}</button></div>
      <div className="us-settings-row"><div><div className="us-settings-title">{ui("Stored locally")}</div>
        <p className="us-settings-hint">{ui("Only calls from this DSH instance are recorded, on this computer. Nothing is uploaded.")}</p></div></div>
    </div>
    {open && <UsageDialog Details={details} onClose={() => setOpen(false)} />}
  </section>;
}
