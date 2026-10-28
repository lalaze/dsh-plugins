import React, { useState, type ComponentType } from 'react';
import { UsageDialog } from './dialog.js';
import { ui, useLocale } from './i18n.js';
import { savePreferences, usePreferences } from './preferences.js';

const CSS = `.us-settings{--us-accent:#0b9f83;--us-muted:color-mix(in srgb,currentColor 55%,transparent);--us-line:color-mix(in srgb,currentColor 11%,transparent);box-sizing:border-box;width:100%;max-width:880px;margin:0 auto;padding:28px;display:grid;gap:20px;font-size:13px;line-height:1.5}
.us-settings *{box-sizing:border-box}
.us-settings h2,.us-settings p{margin:0}
.us-settings h2{font-size:24px;font-weight:650;letter-spacing:-.6px}
.us-settings-hint{margin-top:3px!important;color:var(--us-muted);font-size:12px}
.us-settings-list{border:1px solid var(--us-line);border-radius:12px;overflow:hidden}
.us-settings-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:16px}
.us-settings-row+.us-settings-row{border-top:1px solid var(--us-line)}
.us-settings-title{font-size:14px;font-weight:500}
.us-settings-button{flex:none;display:inline-flex;align-items:center;min-height:32px;padding:6px 12px;border:1px solid var(--us-line);border-radius:7px;background:transparent;color:inherit;font:inherit;white-space:nowrap;cursor:pointer}
.us-settings-button:hover{background:color-mix(in srgb,currentColor 5%,transparent)}
.us-settings-toggle{position:relative;flex:none;width:36px;height:22px;padding:3px;border:0;border-radius:20px;background:color-mix(in srgb,currentColor 18%,transparent);cursor:pointer}
.us-settings-toggle span{display:block;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002;transition:transform .15s}
.us-settings-toggle[aria-checked=true]{background:var(--us-accent)}
.us-settings-toggle[aria-checked=true] span{transform:translateX(14px)}
.us-settings button:focus-visible{outline:2px solid var(--us-accent);outline-offset:3px}
@media(max-width:500px){.us-settings{padding:18px 14px}}`;

/** Usage statistics settings. The statistics themselves open in a modal window, here or from the header pill. */
export function UsageSettings({ details }: { details: ComponentType }) {
  useLocale();
  const { headerBadge } = usePreferences();
  const [open, setOpen] = useState(false);
  return <section className="us-settings" aria-label={ui("Usage statistics")}><style>{CSS}</style>
    <header><h2>{ui("Usage statistics")}</h2><p className="us-settings-hint">{ui("Model usage from DSH and remote agents")}</p></header>
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
