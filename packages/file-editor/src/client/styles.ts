export const styles = `
.fe-tab{display:flex;flex-direction:column;height:100%;min-height:0;gap:8px;padding:8px 10px 10px;box-sizing:border-box;color:var(--dsw-alias-label-primary,inherit);font-size:13px}
.fe-head{display:flex;align-items:center;gap:6px;min-height:28px;flex-wrap:wrap}
.fe-path{flex:1;min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}
.fe-dirty{flex:none;padding:1px 7px;border-radius:9px;font-size:11px;background:color-mix(in srgb,#f5b400 22%,transparent)}
.fe-button,.fe-segment button{flex:none;height:26px;padding:0 10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.fe-button:hover:not(:disabled),.fe-segment button:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))}
.fe-button:disabled{opacity:.45;cursor:default}
.fe-primary:not(:disabled){border-color:transparent;background:var(--dsw-alias-state-business-primary,#3b82f6);color:#fff}
.fe-primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary,#3b82f6);filter:brightness(1.08)}
.fe-segment{display:inline-flex;flex:none}
.fe-segment button{border-radius:0}.fe-segment button:first-child{border-radius:6px 0 0 6px}.fe-segment button:last-child{border-radius:0 6px 6px 0;margin-left:-1px}
.fe-segment button[aria-checked=true]{background:color-mix(in srgb,currentColor 12%,transparent)}
.fe-banner{flex:none;padding:7px 10px;border-radius:6px;font-size:12px;line-height:1.5}
.fe-banner[data-tone=warn]{background:color-mix(in srgb,#f5b400 16%,transparent)}
.fe-banner[data-tone=error]{background:color-mix(in srgb,#e5484d 16%,transparent)}
.fe-body{flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:8px;overflow:hidden}
.fe-body>.fv-code,.fe-body>.fv-markdown,.fe-body>.fv-image{flex:1;min-height:0}
.fe-body>.fv-image{padding:8px}
.fe-note{margin:auto;padding:16px;text-align:center;opacity:.7}
`;
