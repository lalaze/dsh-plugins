// Matches the host composer's ghost controls (the access-mode trigger beside it): no fill until hover.
const CSS = `
.dsh-translate-composer-button{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);outline:none;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer}
.dsh-translate-composer-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-translate-composer-button:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.dsh-translate-composer-button:disabled{color:var(--dsw-alias-label-dimmed,currentColor);cursor:default}
.dsh-translate-composer-button[data-dsh-translate-busy]{color:var(--dsw-alias-label-secondary,currentColor);cursor:progress}
.dsh-translate-composer-button[data-dsh-translate-error]{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dsh-translate-composer-button svg{flex:none;width:14px;height:14px}
.dsh-translate-send-notice{position:fixed;z-index:2147483000;box-sizing:border-box;max-width:min(520px,calc(100vw - 12px));padding:7px 12px;border:1px solid #52525b;border-radius:7px;background:#18181b;color:#f4f4f5;box-shadow:0 6px 18px #0007;font-size:12px;line-height:1.5}
.dsh-translate-send-notice[data-tone=error]{color:#fca5a5}
.dsh-translate-paragraph-button{position:fixed;z-index:2147483000;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#a1a1aa);cursor:pointer;opacity:.7}
.dsh-translate-paragraph-button[hidden]{display:none}
.dsh-translate-paragraph-button:hover,.dsh-translate-paragraph-button:focus-visible{opacity:1;outline:none;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.dsh-translate-paragraph-button[data-open]{opacity:1;color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.dsh-translate-paragraph-button svg{width:14px;height:14px}
.dsh-translate-paragraph-card{position:relative;display:block;box-sizing:border-box;min-width:0;max-width:100%;margin:6px 0 12px;padding:2px 28px 2px 12px;border:0;border-left:2px solid var(--dsw-alias-border-main,rgba(127,127,127,.3));border-radius:0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);box-shadow:none;font-size:13px;font-weight:400;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;text-align:start}
.dsh-translate-paragraph-card[data-state=busy]>div{display:flex;gap:6px;align-items:center;color:var(--dsw-alias-label-secondary,#a1a1aa)}
.dsh-translate-paragraph-card[data-state=busy] svg{flex:none;width:14px;height:14px}
.dsh-translate-paragraph-card[data-state=error]{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dsh-translate-paragraph-source{margin-bottom:2px;color:var(--dsw-alias-label-secondary,inherit);font-size:12px;overflow-wrap:anywhere}
.dsh-translate-paragraph-close{position:absolute;top:4px;right:4px;width:22px;height:22px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font-size:16px;line-height:1;cursor:pointer}
.dsh-translate-paragraph-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,inherit)}
.dsh-translate-spinner{animation:dsh-translate-spin .8s linear infinite}
@keyframes dsh-translate-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-translate-spinner{animation-duration:2.4s}}
`;

export function installStyles(): () => void {
  const style = document.createElement('style');
  style.dataset.dshTranslateStyle = '';
  style.textContent = CSS;
  document.head.append(style);
  return () => style.remove();
}
