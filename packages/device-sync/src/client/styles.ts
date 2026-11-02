// Colors, radii and type follow DSH's `--dsw-*` tokens, as in the other plugins of this repository.
export const styles = `
.dsy{--dsy-accent:var(--dsw-alias-state-business-primary,#4176e6);--dsy-warn:var(--dsw-alias-state-warn-label,#d97706);--dsy-danger:var(--dsw-alias-state-danger-label,#d93025);--dsy-ok:var(--dsw-alias-state-success-primary,#22a06b);--dsy-secondary:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent));--dsy-muted:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 58%,transparent));--dsy-line:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));--dsy-line-strong:var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 18%,transparent));--dsy-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 7%,transparent));--dsy-raised:var(--dsw-alias-bg-layer-3,Canvas);--dsy-track:var(--dsw-alias-bg-module-platform,color-mix(in srgb,currentColor 5%,transparent));--dsy-r-sm:var(--dsw-radius-sm,8px);--dsy-r-md:var(--dsw-radius-md,12px);color:var(--dsw-alias-label-primary,inherit);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.5;box-sizing:border-box}
.dsy *{box-sizing:border-box}
:where(.dsy) :is(button,input,select,textarea){font:inherit;color:inherit}
:where(.dsy) :is(h2,h3,h4,p,ul){margin:0}
.dsy button{cursor:pointer}
.dsy button:disabled{cursor:default;opacity:.45}
.dsy :is(button,input,select,textarea,summary):focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsy-accent));outline-offset:-2px}
.dsy h2{font-size:16px;line-height:24px;font-weight:500}
.dsy h3{font-size:14px;line-height:20px;font-weight:500}
.dsy-muted{color:var(--dsy-muted)}
.dsy-hint{color:var(--dsy-secondary);font-size:12px;line-height:18px}
.dsy-mono{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
.dsy-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsy-line-strong);border-radius:var(--dsy-r-sm);background:transparent;font-size:12px;white-space:nowrap}
.dsy-btn:hover:not(:disabled){background:var(--dsy-hover)}
.dsy-btn[data-kind=primary]{border-color:transparent;background:var(--dsw-alias-brand-primary,CanvasText);color:var(--dsw-alias-label-primary-foreground,Canvas)}
.dsy-btn[data-kind=primary]:hover:not(:disabled){opacity:.88;background:var(--dsw-alias-brand-primary,CanvasText)}
.dsy-btn[data-kind=danger]{color:var(--dsy-danger)}
.dsy-link{border:0;background:transparent;padding:0;color:var(--dsy-accent);font-size:12px}
.dsy-input{height:30px;padding:0 10px;border:.5px solid var(--dsy-line-strong);border-radius:var(--dsy-r-sm);background:transparent;min-width:0}
.dsy-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:14px 0;border-bottom:.5px solid var(--dsy-line)}
.dsy-row:last-child{border-bottom:0}
.dsy-row>div:first-child{min-width:0}
.dsy-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:flex-end}
.dsy-card{border:.5px solid var(--dsy-line-strong);border-radius:var(--dsy-r-md);padding:12px 14px;display:grid;gap:8px}
.dsy-badge{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;background:var(--dsy-track);font-size:11px;line-height:20px;white-space:nowrap}
.dsy-dot{width:7px;height:7px;border-radius:50%;background:var(--dsy-muted);flex:none}
.dsy-dot[data-state=online],.dsy-dot[data-state=idle]{background:var(--dsy-ok)}
.dsy-dot[data-state=running]{background:var(--dsy-accent)}
.dsy-dot[data-state=waiting],.dsy-dot[data-state=paused]{background:var(--dsy-warn)}
.dsy-dot[data-state=offline],.dsy-dot[data-state=unpaired]{background:var(--dsy-muted)}
.dsy-error{color:var(--dsy-danger);font-size:12px;line-height:18px}
.dsy-warn{color:var(--dsy-warn);font-size:12px;line-height:18px}
.dsy-code{font-size:26px;letter-spacing:.18em;font-variant-numeric:tabular-nums;font-weight:600}
.dsy-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px}
.dsy-check input{margin:2px 0 0;flex:none}
.dsy-settings{display:flex;flex-direction:column;gap:18px;max-width:760px}
.dsy-section{display:grid;gap:6px}
.dsy-pair{display:flex;gap:6px;flex-wrap:wrap}
.dsy-filters{display:flex;flex-wrap:wrap;gap:4px 16px}
.dsy-fold{display:flex;align-items:center;gap:6px;width:100%;padding:0;border:0;background:transparent;text-align:left}
.dsy-card>h4{font-size:13px;font-weight:500}
.dsy-fold-group{padding:2px 0;color:var(--dsy-secondary);font-size:12px}
.dsy-chevron{flex:none;width:12px;display:inline-flex;justify-content:center;color:var(--dsy-muted);transition:transform .15s}
.dsy-fold[aria-expanded=true]>.dsy-chevron{transform:rotate(90deg)}
.dsy-count{flex:none;color:var(--dsy-muted);font-size:11px;font-variant-numeric:tabular-nums}
.dsy-group{display:grid;gap:0}
.dsy-srow{display:flex;align-items:center;gap:8px;min-height:32px;padding:3px 4px 3px 18px;border-radius:var(--dsy-r-sm)}
.dsy-srow:hover,.dsy-srow[aria-current=true]{background:var(--dsy-hover)}
.dsy-srow-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;font-size:13px}
.dsy-srow>.dsy-hint{flex:none;white-space:nowrap}
.dsy-wrow{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px;padding:8px 4px 8px 18px;border-top:.5px solid var(--dsy-line)}
.dsy-wrow-main{flex:1 1 180px;min-width:0;display:grid}
.dsy-wrow-path{color:var(--dsy-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsy-chips{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
.dsy-chip{--dsy-tag:var(--dsy-muted);display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:.5px solid var(--dsy-line-strong);border-radius:999px;background:transparent;color:var(--dsy-secondary);font-size:11px;white-space:nowrap}
.dsy-chip:hover:not(:disabled){background:var(--dsy-hover)}
.dsy-chip[aria-pressed=true]{border-color:var(--dsy-tag);background:color-mix(in srgb,var(--dsy-tag) 16%,transparent);color:var(--dsw-alias-label-primary,inherit)}
.dsy-chip-dot{width:7px;height:7px;border-radius:50%;flex:none;box-shadow:inset 0 0 0 1.5px var(--dsy-tag)}
.dsy-chip[aria-pressed=true] .dsy-chip-dot{background:var(--dsy-tag)}
.dsy-btn-sm{height:22px;padding:0 8px;font-size:11px}
.dsy-more{justify-self:start;margin:2px 0 0 18px}
.dsy-pair .dsy-input{flex:1 1 220px}

.dsy-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:max(20px,var(--dsh-frame-overlay-top,20px)) 20px;-webkit-app-region:no-drag}
.dsy-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.5));backdrop-filter:var(--dsw-mask-blur,none)}
.dsy-dialog{position:relative;display:flex;flex-direction:column;width:min(1180px,100%);height:min(860px,100%);border-radius:var(--dsw-radius-panel,24px);overflow:hidden;background:var(--dsw-alias-bg-layer-2,Canvas);box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px rgba(127,127,127,.3),0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05))}
.dsy-dialog-head{display:flex;align-items:center;gap:10px;padding:14px 52px 12px 20px;border-bottom:.5px solid var(--dsy-line)}
.dsy-close{position:absolute;top:12px;right:12px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--dsy-r-sm);background:transparent;color:var(--dsy-secondary)}
.dsy-close:hover{background:var(--dsy-hover)}
.dsy-split{flex:1;min-height:0;display:grid;grid-template-columns:minmax(240px,320px) 1fr}
.dsy-list{overflow:auto;border-right:.5px solid var(--dsy-line);padding:8px}
.dsy-device{margin:6px 0 2px;padding:6px 8px;display:flex;align-items:center;gap:6px;font-weight:500}
.dsy-group-label{padding:8px 8px 2px;font-size:11px;color:var(--dsy-muted);text-transform:uppercase;letter-spacing:.04em}
.dsy-ws{padding:4px 8px;display:flex;align-items:center;gap:6px;color:var(--dsy-secondary);font-size:12px}
.dsy-ws-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsy-tagdot{width:8px;height:8px;border-radius:50%;flex:none}
.dsy-session{width:100%;display:flex;align-items:center;gap:8px;padding:6px 8px 6px 20px;border:0;border-radius:var(--dsy-r-sm);background:transparent;text-align:left}
.dsy-session:hover{background:var(--dsy-hover)}
.dsy-session[aria-current=true]{background:var(--dsy-track)}
.dsy-session-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsy-viewer{min-width:0;display:flex;flex-direction:column}
.dsy-viewer-head{padding:12px 18px;border-bottom:.5px solid var(--dsy-line);display:grid;gap:4px}
.dsy-facts{display:flex;flex-wrap:wrap;gap:6px}
.dsy-timeline{flex:1;min-height:0;overflow:auto;padding:16px 18px;display:flex;flex-direction:column;gap:12px}
.dsy-msg{display:grid;gap:4px;max-width:100%}
.dsy-msg[data-role=user]{justify-self:end;max-width:80%;padding:8px 12px;border-radius:var(--dsy-r-md);background:var(--dsy-track)}
.dsy-msg-text{white-space:pre-wrap;overflow-wrap:anywhere}
.dsy-msg img{max-width:min(320px,100%);max-height:240px;border-radius:var(--dsy-r-sm);display:block}
.dsy-tool{border:.5px solid var(--dsy-line);border-radius:var(--dsy-r-sm);padding:6px 10px;font-size:12px}
.dsy-tool summary{cursor:pointer;color:var(--dsy-secondary)}
.dsy-tool pre{margin:6px 0 0;max-height:280px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.dsy-reasoning{color:var(--dsy-muted);font-size:12px}
.dsy-marker{align-self:center;color:var(--dsy-muted);font-size:11px}
.dsy-draft{opacity:.8}
.dsy-pending{margin:0 18px 10px;padding:10px 12px;border-radius:var(--dsy-r-md);border:.5px solid var(--dsy-warn);display:grid;gap:8px}
.dsy-composer{border-top:.5px solid var(--dsy-line);padding:10px 18px 14px;display:grid;gap:8px}
.dsy-composer textarea{width:100%;min-height:64px;max-height:220px;resize:vertical;padding:8px 10px;border:.5px solid var(--dsy-line-strong);border-radius:var(--dsy-r-md);background:transparent}
.dsy-composer-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsy-continue{border-top:.5px solid var(--dsy-line);padding:10px 18px 14px;display:grid;gap:8px}
.dsy-continue h4{font-size:13px;font-weight:500}
.dsy-continue textarea{width:100%;min-height:52px;max-height:180px;resize:vertical;padding:8px 10px;border:.5px solid var(--dsy-line-strong);border-radius:var(--dsy-r-md);background:transparent}
.dsy-banner{margin:10px 18px 0;padding:8px 12px;border-radius:var(--dsy-r-sm);background:var(--dsy-track);font-size:12px}
.dsy-banner[data-kind=warn]{color:var(--dsy-warn)}
.dsy-empty{margin:auto;color:var(--dsy-muted);text-align:center;padding:24px}
.dsy-thumbs{display:flex;gap:6px;flex-wrap:wrap}
.dsy-thumbs img{height:48px;border-radius:6px}
.dsy-back{display:none}
.dsy-header-button{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;cursor:pointer}
.dsy-header-button:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 7%,transparent))}
@media(max-width:720px){
.dsy-overlay{padding:0}.dsy-dialog{width:100%;height:100%;border-radius:0}
.dsy-split{grid-template-columns:1fr}
.dsy-split[data-open=true] .dsy-list{display:none}
.dsy-split:not([data-open=true]) .dsy-viewer{display:none}
.dsy-list{border-right:0}
.dsy-back{display:inline-flex}
.dsy-msg[data-role=user]{max-width:92%}}
`
