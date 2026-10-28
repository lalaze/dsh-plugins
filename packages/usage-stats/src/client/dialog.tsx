import React, { useEffect, useRef, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { ui } from './i18n.js';

const CSS = `.us-dialog-overlay{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:24px;background:rgba(0,0,0,.45);-webkit-app-region:no-drag}
.us-dialog{display:flex;flex-direction:column;width:min(1180px,100%);height:min(880px,100%);border-radius:16px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-3,#26272b));color:var(--dsw-alias-label-primary,#eee);box-shadow:var(--dsw-elevation-prominent,0 0 0 1px rgba(127,127,127,.25),0 16px 48px rgba(0,0,0,.4))}
.us-dialog-bar{display:flex;justify-content:flex-end;flex:none;padding:10px 10px 0}
.us-dialog-close{display:grid;place-items:center;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer}
.us-dialog-close:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
.us-dialog-close:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#517ee8);outline-offset:-2px}
.us-dialog-body{flex:1;min-height:0;overflow:auto}
.us-dialog .dsh-usage{padding-top:0}
@media(max-width:500px){.us-dialog-overlay{padding:0}.us-dialog{border-radius:0}}`;

/**
 * The usage dashboard in a modal window over the app. Escape, the close button or the backdrop closes it,
 * and focus returns to whatever opened it.
 */
export function UsageDialog({ Details, onClose }: { Details: ComponentType; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null), onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    close.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onCloseRef.current(); } };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (opener?.isConnected) opener.focus(); };
  }, []);
  return createPortal(<div className="us-dialog-overlay" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}><style>{CSS}</style>
    <div className="us-dialog" role="dialog" aria-modal="true" aria-label={ui("Usage statistics")}>
      <div className="us-dialog-bar"><button ref={close} type="button" className="us-dialog-close" aria-label={ui("Close")} title={ui("Close")} onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button></div>
      <div className="us-dialog-body"><Details /></div>
    </div>
  </div>, document.body);
}
