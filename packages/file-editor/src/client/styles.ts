export const styles = `
.fe-tab{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;color:var(--dsw-alias-label-primary,inherit);font-size:13px}
.fe-head{display:flex;align-items:center;gap:6px;flex:none;min-height:35px;padding:0 6px 0 12px;box-sizing:border-box;color:var(--dsw-alias-label-secondary,inherit);border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}
.fe-head>svg{flex:none;opacity:.8}
.fe-path{flex:0 1 auto;min-width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-primary,inherit)}
.fe-dirty{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-primary,currentColor)}
.fe-tools{display:flex;align-items:center;gap:1px;flex:none;margin-left:auto}
.fe-tool{display:inline-grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.fe-tool:hover:enabled,.fe-tool[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 10%,transparent));color:var(--dsw-alias-label-primary,inherit)}
.fe-tool:disabled{opacity:.4;cursor:default}
.fe-tool:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3b82f6);outline-offset:-2px}
.fe-banner{flex:none;margin:8px 12px 0;padding:7px 10px;border-radius:6px;font-size:12px;line-height:1.5}
.fe-banner[data-tone=warn]{background:color-mix(in srgb,#f5b400 16%,transparent)}
.fe-banner[data-tone=error]{background:color-mix(in srgb,#e5484d 16%,transparent)}
.fe-body{flex:1;min-height:0;display:flex;flex-direction:column}
.fe-body>.fv-code,.fe-body>.fv-markdown,.fe-body>.fv-image{flex:1;min-height:0}
.fe-body>.fv-markdown{padding:12px 16px}
.fe-body>.fv-image{padding:8px}
.fe-note{margin:auto;padding:16px;text-align:center;opacity:.7}
`;
