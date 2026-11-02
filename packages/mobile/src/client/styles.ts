// Colors, radii and type follow DSH's `--dsw-*` tokens, as in the other plugins of this repository.
export const styles = `
.dsm{--dsm-accent:var(--dsw-alias-state-business-primary,#4176e6);--dsm-warn:var(--dsw-alias-state-warn-label,#d97706);--dsm-danger:var(--dsw-alias-state-danger-label,#d93025);--dsm-ok:var(--dsw-alias-state-success-primary,#22a06b);--dsm-secondary:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent));--dsm-muted:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 58%,transparent));--dsm-line:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));--dsm-line-strong:var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 18%,transparent));--dsm-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 7%,transparent));--dsm-raised:var(--dsw-alias-bg-layer-3,Canvas);--dsm-track:var(--dsw-alias-bg-module-platform,color-mix(in srgb,currentColor 5%,transparent));--dsm-r-sm:var(--dsw-radius-sm,8px);--dsm-r-md:var(--dsw-radius-md,12px);color:var(--dsw-alias-label-primary,inherit);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.5;box-sizing:border-box}
.dsm *{box-sizing:border-box}
:where(.dsm) :is(button,input,select,textarea){font:inherit;color:inherit}
:where(.dsm) :is(h2,h3,h4,p,ul){margin:0}
.dsm button{cursor:pointer}
.dsm button:disabled{cursor:default;opacity:.45}
.dsm :is(button,input,select,textarea,summary):focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsm-accent));outline-offset:-2px}
.dsm h2{font-size:16px;line-height:24px;font-weight:500}
.dsm h3{font-size:14px;line-height:20px;font-weight:500}
.dsm-muted{color:var(--dsm-muted)}
.dsm-hint{color:var(--dsm-secondary);font-size:12px;line-height:18px}
.dsm-mono{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
.dsm-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsm-line-strong);border-radius:var(--dsm-r-sm);background:transparent;font-size:12px;white-space:nowrap}
.dsm-btn:hover:not(:disabled){background:var(--dsm-hover)}
.dsm-btn[data-kind=primary]{border-color:transparent;background:var(--dsw-alias-brand-primary,CanvasText);color:var(--dsw-alias-label-primary-foreground,Canvas)}
.dsm-btn[data-kind=primary]:hover:not(:disabled){opacity:.88;background:var(--dsw-alias-brand-primary,CanvasText)}
.dsm-btn[data-kind=danger]{color:var(--dsm-danger)}
.dsm-link{border:0;background:transparent;padding:0;color:var(--dsm-accent);font-size:12px}
.dsm-input{height:30px;padding:0 10px;border:.5px solid var(--dsm-line-strong);border-radius:var(--dsm-r-sm);background:transparent;min-width:0}
.dsm-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 0;border-bottom:.5px solid var(--dsm-line)}
.dsm-row:last-child{border-bottom:0}
.dsm-row>div:first-child{min-width:0}
.dsm-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:flex-end}
.dsm-card{border:.5px solid var(--dsm-line-strong);border-radius:var(--dsm-r-md);padding:12px 14px;display:grid;gap:8px}
.dsm-badge{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;background:var(--dsm-track);font-size:11px;line-height:20px;white-space:nowrap}
.dsm-dot{width:7px;height:7px;border-radius:50%;background:var(--dsm-muted);flex:none}
.dsm-dot[data-state=online],.dsm-dot[data-state=idle]{background:var(--dsm-ok)}
.dsm-dot[data-state=connecting]{background:var(--dsm-accent)}
.dsm-dot[data-state=offline]{background:var(--dsm-danger)}
.dsm-error{color:var(--dsm-danger);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsm-code{font-size:26px;letter-spacing:.18em;font-variant-numeric:tabular-nums;font-weight:600}
.dsm-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px}
.dsm-check input{margin:2px 0 0;flex:none}
.dsm-settings{display:flex;flex-direction:column;gap:18px;max-width:760px}
.dsm-section{display:grid;gap:6px}
.dsm-field{display:grid;gap:4px}
.dsm-field>span{font-size:12px;color:var(--dsm-secondary)}
.dsm-inline{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.dsm-inline .dsm-input{flex:1 1 240px}
.dsm-qr{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.dsm-qr svg{width:240px;height:240px;flex:none;border-radius:var(--dsm-r-sm);background:#fff;padding:10px}
.dsm-qr-text{display:grid;gap:8px;flex:1 1 240px;min-width:0}
.dsm-link-box{font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11px;word-break:break-all;color:var(--dsm-secondary);max-height:54px;overflow:hidden}

`
