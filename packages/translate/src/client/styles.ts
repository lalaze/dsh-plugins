// Matches the host composer's ghost controls (the access-mode trigger beside it): no fill until hover.
const CSS = `
.dsh-translate-composer-button{display:inline-flex;flex:none;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm,6px);outline:none;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer}
.dsh-translate-composer-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-translate-composer-button:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe))}
.dsh-translate-composer-button:disabled{color:var(--dsw-alias-label-dimmed,currentColor);cursor:default}
.dsh-translate-composer-button[data-dsh-translate-error]{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dsh-translate-composer-button svg{flex:none;width:14px;height:14px}
.dsh-translate-composer-button [data-dsh-translate-label]{min-width:0;overflow:hidden;text-overflow:ellipsis}
`;

export function installStyles(): () => void {
  const style = document.createElement('style');
  style.dataset.dshTranslateStyle = '';
  style.textContent = CSS;
  document.head.append(style);
  return () => style.remove();
}
