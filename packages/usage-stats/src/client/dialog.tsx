import React, { useEffect, useRef, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { ui } from './i18n.js';

// DSH's Modal and Settings panel: dimmed mask, panel radius and elevation, a 28px close at the title's right.
// The dashboard's header sticks to the top as the window's title row and leaves room for the close button.
const CSS = `.us-dialog-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;-webkit-app-region:no-drag}
.us-dialog-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.5));backdrop-filter:var(--dsw-mask-blur,none)}
.us-dialog{position:relative;display:flex;flex-direction:column;width:min(640px,100%);height:min(720px,100%);border-radius:var(--dsw-radius-panel,28px);overflow:hidden;background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px rgba(127,127,127,.3),0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05));font-family:var(--dsw-font-family,inherit);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.us-dialog-close{position:absolute;top:20px;right:14px;z-index:2;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer}
.us-dialog-close:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent));color:var(--dsw-alias-label-primary,inherit)}
.us-dialog-close:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:-2px}
.us-dialog-body{flex:1;min-height:0;overflow:auto}
.us-dialog .dsh-usage{max-width:none;padding:0 24px 24px}
.us-dialog .us-top{position:sticky;top:0;z-index:1;margin:0 -24px -2px;padding:22px 54px 10px 24px;background:var(--dsw-alias-bg-layer-2,Canvas)}
@media(max-width:500px){.us-dialog-overlay{padding:0}.us-dialog{width:100%;height:100%;border-radius:0}.us-dialog-close{top:16px;right:12px}
.us-dialog .dsh-usage{padding:0 16px 20px}.us-dialog .us-top{margin:0 -16px -2px;padding:18px 48px 10px 16px}}`;

/**
 * The usage dashboard in a modal window over the app. Escape, the close button or the backdrop closes it,
 * and focus returns to whatever opened it. The dashboard's own header is the window's title row.
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
  return createPortal(<div className="us-dialog-overlay"><style>{CSS}</style>
    <div className="us-dialog-mask" onPointerDown={onClose} />
    <div className="us-dialog" role="dialog" aria-modal="true" aria-label={ui("Usage statistics")}>
      <button ref={close} type="button" className="us-dialog-close" aria-label={ui("Close")} title={ui("Close")} onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
      <div className="us-dialog-body"><Details /></div>
    </div>
  </div>, document.body);
}
