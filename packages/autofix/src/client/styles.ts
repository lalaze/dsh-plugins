/** One stylesheet for the board and the settings, in DSH's own tokens so both themes and the wallpaper keep working. */
export const CSS = `
.tp-board,.tp-settings{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary,inherit);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:20px}
.tp-board *,.tp-settings *,.tp-chat *{box-sizing:border-box}
:where(.tp-board,.tp-settings,.tp-chat) :is(h2,h3,p,pre,ul){margin:0}
.tp-board{padding:0 24px 24px}
.tp-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
.tp-board>.tp-top{position:sticky;top:0;z-index:1;margin:0 -24px;padding:22px 54px 10px 24px;background:var(--dsw-alias-bg-layer-2,Canvas)}
.tp-board h2,.tp-settings h2{font-size:16px;line-height:24px;font-weight:500}
.tp-board h3,.tp-settings h3,.tp-fold>summary{display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent))}
.tp-board h3 span,.tp-fold>summary span{padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent));font-size:11px;font-variant-numeric:tabular-nums}
.tp-board section,.tp-fold{display:flex;flex-direction:column;gap:8px}
.tp-fold>summary{cursor:pointer;list-style:none}
.tp-fold>summary::before{content:'›';display:inline-block;width:10px;transition:transform .12s}
.tp-fold[open]>summary::before{transform:rotate(90deg)}
.tp-fold[open]>summary{margin-bottom:8px}
.tp-muted{color:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 58%,transparent));font-size:12px;line-height:18px}
.tp-empty{padding:14px 16px;border:.5px dashed var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 16%,transparent));border-radius:var(--dsw-radius-md,12px);color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent))}
.tp-error{color:var(--dsw-alias-state-error-primary,#d14343);font-size:12px;line-height:18px;overflow-wrap:anywhere}
:where(.tp-error,.tp-muted)>pre{margin:4px 0 0;font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11.5px;line-height:17px;white-space:pre-wrap;max-height:150px;overflow:auto;opacity:.9}
.tp-card{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,transparent)}
.tp-card[data-status=review]{border-color:var(--dsw-alias-state-business-primary,#4176e6)}
.tp-card>header{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.tp-title{min-width:0;color:inherit;font-size:14px;line-height:20px;font-weight:500;text-decoration:none;overflow-wrap:anywhere}
.tp-title:hover{text-decoration:underline}
.tp-meta{color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent));font-size:12px;line-height:18px;overflow-wrap:anywhere}
.tp-state{flex:none;display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent))}
.tp-state[data-status=review]{color:var(--dsw-alias-state-business-primary,#4176e6)}
.tp-state[data-status=failed]{color:var(--dsw-alias-state-error-primary,#d14343)}
.tp-state[data-status=done]{color:var(--dsw-alias-state-success-primary,#22a06b)}
.tp-state i{width:6px;height:6px;border-radius:50%;background:currentColor;animation:tp-pulse 1.2s ease-in-out infinite}
@keyframes tp-pulse{50%{opacity:.25}}
.tp-checks{display:flex;flex-direction:column;gap:2px;padding:0;list-style:none;font-size:12px;line-height:18px}
.tp-checks li{display:flex;justify-content:space-between;gap:12px}
.tp-checks code{min-width:0;font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11.5px;overflow-wrap:anywhere}
.tp-checks span{flex:none;color:var(--dsw-alias-state-success-primary,#22a06b)}
.tp-checks li[data-ok=false] span{color:var(--dsw-alias-state-error-primary,#d14343)}
.tp-checks li[data-warning]{color:var(--dsw-alias-state-warning-primary,#b7791f)}
.tp-report>summary{cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent))}
.tp-report>div{margin-top:6px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;line-height:19px;max-height:260px;overflow:auto}
.tp-diff{margin-top:6px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-3,color-mix(in srgb,currentColor 5%,transparent));overflow:auto;max-height:420px}
.tp-diff pre{padding:8px 10px;font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11.5px;line-height:17px;white-space:pre;tab-size:2}
.tp-diff .tp-stat{border-bottom:.5px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent))}
.tp-diff span[data-kind=add]{color:var(--dsw-alias-state-success-primary,#22a06b)}
.tp-diff span[data-kind=del]{color:var(--dsw-alias-state-error-primary,#d14343)}
.tp-diff span[data-kind=hunk],.tp-diff span[data-kind=file]{color:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 58%,transparent))}
.tp-diff span[data-kind=file]{font-weight:600}
.tp-actions,.tp-assign{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.tp-actions{margin-top:2px}
.tp-spacer{flex:1}
.tp-form{display:flex;flex-direction:column;gap:8px}
.tp-button{flex:none;display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 16%,transparent));border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
.tp-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 7%,transparent))}
.tp-button[data-primary]{border-color:transparent;background:var(--dsw-alias-brand-primary,CanvasText);color:var(--dsw-alias-label-primary-foreground,Canvas)}
.tp-button[data-primary]:hover:not(:disabled){background:var(--dsw-alias-brand-primary,CanvasText);opacity:.88}
.tp-button[data-quiet]{border-color:transparent;color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent))}
.tp-button[data-danger]{color:var(--dsw-alias-state-error-primary,#d14343)}
.tp-button:disabled{opacity:.45;cursor:default}
:where(.tp-board,.tp-settings,.tp-chat) :is(select,input,textarea){min-width:0;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 16%,transparent));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:12.5px}
:where(.tp-board,.tp-settings,.tp-chat) textarea{height:auto;padding:6px 8px;line-height:18px;resize:vertical;font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:12px}
.tp-form textarea{font-family:inherit;font-size:13px}
.tp-pick{display:inline-flex;align-items:center;justify-content:space-between;gap:6px;min-width:120px;max-width:260px;height:28px;padding:0 8px 0 10px;border:.5px solid var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 16%,transparent));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:12.5px;cursor:pointer}
.tp-pick span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp-pick svg{flex:none;opacity:.6}
.tp-pick[data-empty] span{color:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 58%,transparent))}
.tp-pick:hover:not(:disabled),.tp-pick[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 7%,transparent))}
.tp-pick:disabled{opacity:.45;cursor:default}
.tp-pick:focus-visible,.tp-pick-search:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:1px}
.tp-pick-list{position:fixed;z-index:2147483600;display:flex;flex-direction:column;box-sizing:border-box;padding:4px;border:.5px solid var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 16%,transparent));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-3,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:var(--dsw-shadow-popover,0 12px 32px rgba(0,0,0,.22));font-family:var(--dsw-font-family,inherit);font-size:12.5px;line-height:18px;outline:0}
.tp-pick-search{box-sizing:border-box;width:100%;height:28px;margin-bottom:4px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 16%,transparent));border-radius:var(--dsw-radius-sm,8px);background:transparent;color:inherit;font:inherit}
.tp-pick-options{min-height:0;overflow:auto}
.tp-pick-options>div{padding:5px 8px;border-radius:6px;cursor:pointer;overflow-wrap:anywhere}
.tp-pick-options>div[data-active]{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))}
.tp-pick-options>div[aria-selected=true]{font-weight:600}
.tp-pick-options>p{margin:0;padding:8px;color:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 58%,transparent))}
:where(.tp-board,.tp-settings,.tp-chat) :is(button,select,input,textarea,summary,a):focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:1px}
.tp-settings>.tp-button{align-self:flex-start}
.tp-settings{--tp-fill:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 6%,transparent));--tp-fill-strong:var(--dsw-alias-interactive-bg-active,color-mix(in srgb,currentColor 11%,transparent));--tp-line:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));--tp-accent:var(--dsw-alias-state-business-primary,#4176e6);--tp-danger:var(--dsw-alias-state-error-primary,#d14343);--tp-soft:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 58%,transparent));max-width:760px;gap:0;padding-top:14px}
.tp-head{display:flex;justify-content:space-between;align-items:center;gap:16px;min-height:32px}
.tp-settings h2{font-size:18px;line-height:26px;font-weight:600}
.tp-head+.tp-muted{margin-top:4px;font-size:13px;line-height:20px}
.tp-tip{margin-top:12px;padding:10px 14px;border-radius:12px;background:var(--tp-fill);font-size:13px;line-height:20px}
.tp-settings h3{margin-top:32px;font-size:15px;line-height:22px;font-weight:600;color:inherit}
.tp-settings h3+.tp-muted{margin-top:2px}
.tp-settings .tp-empty{margin-top:12px}
.tp-rows+.tp-muted{margin-top:10px}
.tp-settings :is(input,textarea):not(.tp-embed *){height:32px;padding:0 10px;border:1px solid transparent;border-radius:10px;background:var(--tp-fill);font-size:13px}
.tp-settings :is(input,textarea):not(.tp-embed *):hover:not(:disabled){background:var(--tp-fill-strong)}
.tp-settings :is(input,textarea):not(.tp-embed *):focus{outline:0;border-color:var(--tp-accent);background:transparent}
.tp-settings :is(input,textarea):not(.tp-embed *)::placeholder{color:var(--tp-soft);opacity:.8}
.tp-settings textarea{width:100%;height:auto;padding:8px 10px;font-size:12.5px;line-height:19px}
.tp-settings .tp-button{height:32px;padding:0 12px;border:1px solid var(--tp-line);border-radius:10px;font-size:13px}
.tp-settings .tp-button[data-primary]{border-color:transparent}
.tp-settings .tp-button[data-danger]{border-color:transparent;color:var(--tp-danger)}
.tp-settings .tp-button[data-danger]:hover{background:color-mix(in srgb,var(--tp-danger) 10%,transparent)}
.tp-settings .tp-pick{height:32px;min-width:150px;max-width:280px;padding:0 10px 0 12px;border:1px solid transparent;border-radius:10px;background:var(--tp-fill);font-size:13px}
.tp-settings .tp-pick:hover:not(:disabled),.tp-settings .tp-pick[aria-expanded=true]{background:var(--tp-fill-strong)}
.tp-add{gap:6px;margin-top:10px}
.tp-add>span{font-size:15px;line-height:1}
.tp-row{display:flex;align-items:center;justify-content:space-between;gap:24px;min-width:0;padding:14px 0;border-bottom:1px solid var(--tp-line)}
.tp-rows>.tp-row:last-child,.tp-more>.tp-row:last-child,.tp-row:has(+.tp-folder){border-bottom:0}
.tp-row:has(+.tp-folder){padding-bottom:8px}
.tp-row-text{display:flex;flex:1 1 auto;flex-direction:column;gap:2px;min-width:0}
.tp-row-text>span{font-size:14px;line-height:22px}
.tp-row-text>small{font-size:12px;line-height:18px;color:var(--tp-soft)}
.tp-row-control{display:flex;flex:none;align-items:center;justify-content:flex-end;gap:8px;max-width:60%}
.tp-settings .tp-row-control>:is(input,.tp-pick){width:220px;max-width:100%}
.tp-row[data-stacked]{flex-direction:column;align-items:stretch;gap:8px}
.tp-row[data-stacked]>.tp-row-control{max-width:none;justify-content:flex-start}
.tp-row[data-stacked]>.tp-row-control>*{flex:1 1 auto;width:100%}
.tp-repo{margin-top:10px;border:1px solid var(--tp-line);border-radius:14px;overflow:hidden}
.tp-repo-head{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:10px 14px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.tp-repo-head:hover{background:var(--tp-fill)}
.tp-settings .tp-repo-head:focus-visible{outline-offset:-2px;border-radius:14px}
.tp-chevron{flex:none;opacity:.6;transition:transform .12s}
[aria-expanded=true]>.tp-chevron,.tp-more[open]>summary>.tp-chevron{transform:rotate(90deg)}
.tp-repo-name{flex:none;max-width:45%;font-size:14px;line-height:22px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp-repo-meta{flex:1 1 0;min-width:0;color:var(--tp-soft);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp-badge{flex:none;height:22px;padding:0 8px;border-radius:999px;background:var(--tp-fill);color:var(--dsw-alias-label-secondary,inherit);font-size:11.5px;line-height:22px;white-space:nowrap}
.tp-badge[data-warn]{background:color-mix(in srgb,#f59e0b 16%,transparent);color:color-mix(in srgb,#d97706 72%,currentColor)}
.tp-repo-body{padding:0 16px 14px;border-top:1px solid var(--tp-line)}
.tp-repo-body .tp-row{padding:12px 0}
.tp-repo-body .tp-row-text>span{font-size:13px;line-height:20px}
.tp-folder{display:flex;flex-direction:column;gap:6px;padding-bottom:12px;border-bottom:1px solid var(--tp-line)}
.tp-inline{display:flex;gap:8px;min-width:0}
.tp-inline>input{flex:1 1 0;min-width:0}
.tp-link{padding:0;border:0;background:none;color:var(--tp-accent);font:inherit;cursor:pointer}
.tp-link:hover{text-decoration:underline}
.tp-more{border-bottom:1px solid var(--tp-line)}
.tp-more>summary{display:flex;align-items:center;gap:6px;padding:12px 0;color:var(--dsw-alias-label-secondary,inherit);font-size:13px;line-height:20px;cursor:pointer;list-style:none}
.tp-more>summary::-webkit-details-marker{display:none}
.tp-more>summary:hover{color:inherit}
.tp-more[open]>summary{border-bottom:1px solid var(--tp-line)}
.tp-repo-foot{display:flex;justify-content:flex-end;padding-top:12px}
.tp-chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-height:32px;padding:4px 6px;border:1px solid transparent;border-radius:10px;background:var(--tp-fill);cursor:text}
.tp-chips:focus-within{border-color:var(--tp-accent);background:transparent}
.tp-settings .tp-chips>input,.tp-settings .tp-chips>input:hover,.tp-settings .tp-chips>input:focus{flex:1 1 80px;width:auto;min-width:80px;height:22px;padding:0 4px;border:0;border-radius:4px;background:transparent}
.tp-chip{display:inline-flex;align-items:center;gap:2px;height:22px;padding:0 2px 0 8px;border:1px solid var(--tp-line);border-radius:7px;background:var(--dsw-alias-bg-layer-3,Canvas);font-size:12px;line-height:20px;white-space:nowrap}
.tp-chip>button{width:18px;height:18px;padding:0;border:0;border-radius:5px;background:none;color:var(--tp-soft);font:inherit;font-size:14px;line-height:16px;cursor:pointer}
.tp-chip>button:hover{background:var(--tp-fill-strong);color:inherit}
.tp-stepper{display:inline-flex;align-items:center;height:32px;border-radius:10px;background:var(--tp-fill)}
.tp-stepper>button{width:30px;height:32px;padding:0;border:0;border-radius:10px;background:none;color:inherit;font:inherit;font-size:16px;cursor:pointer}
.tp-stepper>button:hover:not(:disabled){background:var(--tp-fill-strong)}
.tp-stepper>button:disabled{opacity:.3;cursor:default}
.tp-stepper>output{min-width:26px;text-align:center;font-size:14px;font-variant-numeric:tabular-nums}
.tp-status{display:inline-flex;flex:none;align-items:center;gap:6px;color:color-mix(in srgb,#d97706 72%,currentColor);font-size:12.5px;line-height:18px}
.tp-status>i{width:7px;height:7px;border-radius:50%;background:#f59e0b}
.tp-status[data-ready]{color:var(--dsw-alias-label-secondary,inherit)}
.tp-status[data-ready]>i{background:var(--dsw-alias-state-success-primary,#22a06b)}
.tp-switch{position:relative;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--tp-fill-strong);cursor:pointer;transition:background .12s}
.tp-switch::after{content:'';display:block;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .12s}
.tp-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary,CanvasText)}
.tp-switch[aria-checked=true]::after{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground,Canvas)}
.tp-relay{display:flex;flex-direction:column;gap:4px;margin:0;padding:0 0 12px;border-bottom:1px solid var(--tp-line);list-style:none;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary,inherit)}
.tp-relay li{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.tp-relay i{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#22a06b)}
.tp-relay li[data-error] i{background:#f59e0b}
.tp-relay small{flex-basis:100%;padding-left:13px;color:var(--tp-soft);font-size:12px;overflow-wrap:anywhere}
.tp-row:has(+.tp-relay){border-bottom:0;padding-bottom:8px}
.tp-need{display:flex;align-items:center;gap:16px;margin-top:10px;padding:12px 14px;border-radius:14px;background:color-mix(in srgb,#f59e0b 12%,transparent)}
.tp-need[data-optional]{border:1px dashed var(--tp-line);background:transparent}
.tp-need-text{display:flex;flex:1 1 auto;flex-direction:column;gap:2px;min-width:0}
.tp-need-text>span{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;font-size:14px;line-height:22px;font-weight:500}
.tp-need-text code{font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11.5px;font-weight:400;color:var(--tp-soft)}
.tp-need-text>small{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}
.tp-need-text>small.tp-error{color:var(--tp-danger)}
.tp-models{margin-top:10px;padding:14px 16px;border:1px solid var(--tp-line);border-radius:14px}
.tp-repo-body.tp-embed{padding-top:14px}
.tp-savebar{position:sticky;bottom:12px;z-index:2;display:flex;align-items:center;gap:8px;min-height:50px;margin-top:20px;padding:8px 8px 8px 14px;border:1px solid var(--tp-line);border-radius:14px;background:var(--dsw-alias-bg-layer-3,Canvas);box-shadow:0 8px 28px rgba(0,0,0,.16)}
.tp-savebar>span{flex:1 1 auto;min-width:0;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.tp-savebar[data-kind=error]>span{color:var(--tp-danger)}
.tp-chat{display:flex;flex-direction:column;gap:6px;max-width:720px;margin:4px 0;color:var(--dsw-alias-label-primary,inherit);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:20px}
.tp-chat-line{color:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent));font-size:12.5px;line-height:19px;overflow-wrap:anywhere}
.tp-chat-line>.tp-muted{color:inherit;font-size:inherit;line-height:inherit}
.tp-new{border-style:dashed}
.tp-back[data-over]>textarea{border-color:var(--dsw-alias-state-business-primary,#4176e6)}
.tp-new[data-over]{border-color:var(--dsw-alias-state-business-primary,#4176e6);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 6%,transparent)}
.tp-new>input.tp-new-title{height:32px;font-size:14px;font-weight:500}
.tp-new>textarea{font-family:inherit;font-size:13px;line-height:20px}
.tp-pictures{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}
.tp-pictures li{position:relative;width:96px;height:72px;border:.5px solid var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 16%,transparent));border-radius:var(--dsw-radius-sm,8px);overflow:hidden;background:var(--dsw-alias-bg-layer-3,color-mix(in srgb,currentColor 5%,transparent))}
.tp-pictures img{display:block;width:100%;height:100%;object-fit:contain}
.tp-pictures span{position:absolute;left:0;bottom:0;padding:0 5px;border-top-right-radius:6px;background:rgba(0,0,0,.62);color:#fff;font-size:10.5px;line-height:16px;font-family:var(--dsw-font-family-mono,ui-monospace,monospace)}
.tp-pictures button{position:absolute;top:3px;right:3px;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:rgba(0,0,0,.62);color:#fff;font-size:13px;line-height:18px;cursor:pointer}
.tp-pill{display:inline-flex;align-items:center;gap:6px;flex:none;box-sizing:border-box;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,currentColor 16%,transparent));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:1;cursor:pointer;-webkit-app-region:no-drag}
.tp-pill:hover,.tp-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent));color:var(--dsw-alias-label-primary,inherit)}
.tp-pill:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}
.tp-pill b{min-width:16px;padding:1px 5px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#4176e6);color:#fff;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;text-align:center}
.tp-pill i{width:6px;height:6px;border-radius:50%;background:currentColor;animation:tp-pulse 1.2s ease-in-out infinite}
.tp-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;-webkit-app-region:no-drag}
.tp-mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.5));backdrop-filter:var(--dsw-mask-blur,none)}
.tp-dialog{position:relative;display:flex;flex-direction:column;width:min(820px,100%);height:min(860px,100%);border-radius:var(--dsw-radius-panel,28px);overflow:hidden;background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);box-shadow:var(--dsw-shadow-panel,0 24px 64px rgba(0,0,0,.28))}
.tp-close{position:absolute;top:20px;right:14px;z-index:2;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer}
.tp-close:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))}
.tp-dialog-body{flex:1;min-height:0;overflow:auto}
@media(max-width:560px){.tp-need{flex-direction:column;align-items:stretch}.tp-row{flex-direction:column;align-items:stretch;gap:8px}.tp-row-control{max-width:none;justify-content:flex-start}.tp-settings .tp-row-control>:is(input,.tp-pick){width:100%;max-width:none}.tp-repo-meta{display:none}.tp-repo-name{flex:1 1 0;max-width:none}.tp-overlay{padding:0}.tp-dialog{width:100%;height:100%;border-radius:0}.tp-board{padding:0 16px 20px}.tp-board>.tp-top{margin:0 -16px;padding:18px 48px 10px 16px}.tp-card>header{flex-direction:column;gap:2px}.tp-pick{max-width:none;flex:1 1 100%}}
@media(prefers-reduced-motion:reduce){.tp-chevron{transition:none}.tp-state i,.tp-pill i{animation:none}.tp-fold>summary::before{transition:none}}`;
