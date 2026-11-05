export const styles = `
@media(max-width:760px){.dsh-ra .ra-settings-heading{flex-wrap:wrap}}
.dsh-ra{--ra-line:var(--dsh-border,color-mix(in srgb,currentColor 14%,transparent));--ra-muted:var(--dsh-text-secondary,#9297a0);--ra-accent:var(--dsh-accent,#517ee8);--ra-panel:var(--dsh-bg-secondary,color-mix(in srgb,currentColor 4%,transparent));--ra-bg:var(--dsh-bg,#1d1f24);--ra-warn:#e0a03c;--ra-bad:#db6262;--ra-good:#4eb78c;color:var(--dsh-text,inherit);font:13px/1.55 system-ui,sans-serif;box-sizing:border-box}
.dsh-ra *{box-sizing:border-box}.dsh-ra button,.dsh-ra input,.dsh-ra select,.dsh-ra textarea{font:inherit;color:inherit}.dsh-ra button{cursor:pointer;border:1px solid var(--ra-line);background:transparent;border-radius:8px;padding:6px 12px}.dsh-ra button:hover:enabled{background:var(--ra-panel)}.dsh-ra button:disabled{opacity:.45;cursor:default}.dsh-ra :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--ra-accent);outline-offset:2px}.dsh-ra button.ra-primary{background:var(--ra-accent);color:#fff;border-color:transparent}.dsh-ra .ra-danger{color:var(--ra-bad)}.dsh-ra :is(h2,h3,p){margin:0}.dsh-ra h2{font-size:18px;font-weight:650;letter-spacing:-.3px}.dsh-ra h3{font-size:14px;font-weight:600}.dsh-ra .ra-muted{color:var(--ra-muted)}.dsh-ra .ra-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.dsh-ra .ra-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dsh-ra input,.dsh-ra select,.dsh-ra textarea{background:var(--dsh-input-background,transparent);border:1px solid var(--ra-line);border-radius:8px;padding:8px 10px;width:100%;min-width:0}.dsh-ra select{background-color:var(--ra-bg)}.dsh-ra .ra-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12px;color:var(--ra-muted)}.dsh-ra .ra-field>:is(input,select){color:var(--dsh-text,inherit);font-size:13px}.dsh-ra .ra-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:12px 0}.dsh-ra .ra-foot{font-size:11px;color:var(--ra-muted);margin-top:12px}
.dsh-ra .ra-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 8px;border-radius:20px;background:var(--ra-panel);border:1px solid var(--ra-line);white-space:nowrap;color:var(--ra-muted)}.dsh-ra .ra-badge:is([data-status=connected],[data-status=idle]){color:var(--ra-good)}.dsh-ra .ra-badge:is([data-status=running],[data-status=starting],[data-status=connecting]){color:var(--ra-accent)}.dsh-ra .ra-badge[data-status=attention]{color:var(--ra-warn)}.dsh-ra .ra-badge[data-status=error]{color:var(--ra-bad)}
.dsh-ra .ra-banner{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:9px 12px;border:1px solid color-mix(in srgb,var(--ra-warn) 40%,transparent);background:color-mix(in srgb,var(--ra-warn) 7%,transparent);border-radius:10px;margin:10px 0;overflow-wrap:anywhere;font-size:12.5px}.dsh-ra .ra-banner[data-tone=error]{border-color:color-mix(in srgb,var(--ra-bad) 45%,transparent);background:color-mix(in srgb,var(--ra-bad) 7%,transparent)}.dsh-ra .ra-banner button{flex:none}.dsh-ra .ra-empty{text-align:center;padding:60px 16px;color:var(--ra-muted)}
.dsh-ra .ra-host-list{list-style:none;margin:12px 0 4px;padding:0;border:1px solid var(--ra-line);border-radius:12px;overflow:hidden}.dsh-ra .ra-host-row{display:flex;align-items:center;gap:10px;padding:12px 14px}.dsh-ra .ra-host-row+.ra-host-row{border-top:1px solid var(--ra-line)}.dsh-ra .ra-host-name{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.dsh-ra .ra-host-name .ra-mono{overflow-wrap:anywhere}.dsh-ra .ra-host-error{font-size:11.5px;color:var(--ra-bad);overflow-wrap:anywhere}.dsh-ra .ra-host-row button{font-size:12px;padding:5px 10px;flex:none}
.dsh-ra .ra-host-form{margin-top:14px;padding:16px;border:1px solid var(--ra-line);border-radius:12px}
.dsh-ra .ra-remove-confirm{flex-wrap:wrap}.dsh-ra .ra-remove-confirm>span{flex:1 1 260px}
.dsh-ra .ra-host-row.ra-host-with-clis{display:block}.dsh-ra .ra-host-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.dsh-ra .ra-host-top>.ra-host-name{flex:1 1 220px}.dsh-ra .ra-host-settings{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--ra-line);margin-top:10px;padding-top:10px}.dsh-ra .ra-host-title{display:flex;align-items:center;gap:4px 8px;flex-wrap:wrap;min-width:0}.dsh-ra .ra-host-title .ra-mono{min-width:0}.dsh-ra .ra-host-settings .ra-cli-options{margin:0;align-items:center}.dsh-ra .ra-cli-label{color:var(--ra-muted);font-size:12px;margin-right:2px}.dsh-ra .ra-host-settings .ra-actions{margin-top:8px}.dsh-ra .ra-cli-options{border:0;padding:0;margin:10px 0 14px;display:flex;flex-wrap:wrap;gap:8px 14px;min-width:0}.dsh-ra .ra-cli-options legend{padding:0;margin-bottom:8px;color:var(--ra-muted);font-size:12px}.dsh-ra .ra-cli-options label{display:flex;align-items:center;gap:7px;cursor:pointer;font-size:12px}.dsh-ra .ra-cli-options input{width:auto;margin:0;accent-color:var(--ra-accent)}.dsh-ra .ra-cli-settings>.ra-actions{justify-content:space-between;font-size:11px}.dsh-ra .ra-share-setting{display:flex;flex-direction:column;gap:4px;font-size:12px}.dsh-ra .ra-share-setting label{display:flex;align-items:center;gap:7px;cursor:pointer}.dsh-ra .ra-share-setting input{width:auto;margin:0;accent-color:var(--ra-accent)}.dsh-ra .ra-share-setting small{font-size:11px}
.dsh-ra .ra-share-list{border:1px solid var(--ra-line);border-radius:12px;padding:12px 14px;margin:0;display:flex;flex-direction:column;gap:8px;min-width:0}.dsh-ra .ra-share-list legend{padding:0 4px;font-size:13px;font-weight:600}.dsh-ra .ra-share-list>p{font-size:12px;margin:0 0 2px}.dsh-ra .ra-share-list label{display:flex;align-items:baseline;gap:8px;cursor:pointer;font-size:12.5px;min-width:0}.dsh-ra .ra-share-list input{flex:none;width:auto;margin:0;accent-color:var(--ra-accent);align-self:center}.dsh-ra .ra-share-name{flex:none;font-weight:500}.dsh-ra .ra-share-description{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.dsh-ra .ra-ssh-config{margin:12px 0 18px}.dsh-ra .ra-ssh-config .ra-foot{margin-top:8px}.dsh-ra .ra-ssh-config>.ra-actions>button{height:40px;flex:none;border-radius:10px}
.dsh-ra .ra-ssh-select{flex:1 1 220px;min-width:0}.dsh-ra .ra-ssh-trigger{display:flex;align-items:center;gap:10px;width:100%;height:40px;padding:8px 12px;border-radius:10px;text-align:left;background:var(--dsw-alias-bg-module-platform,var(--ra-panel));transition:background .15s,border-color .15s}.dsh-ra .ra-ssh-trigger:hover:enabled{border-color:color-mix(in srgb,currentColor 30%,transparent)}.dsh-ra .ra-ssh-trigger[aria-expanded=true]{border-color:var(--ra-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--ra-accent) 12%,transparent)}.dsh-ra .ra-ssh-trigger>span{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.dsh-ra .ra-ssh-trigger svg{flex:none;color:var(--dsw-alias-label-secondary,var(--ra-muted))}.dsh-ra .ra-ssh-trigger>svg:last-child{width:14px;height:14px;transition:transform .15s}.dsh-ra .ra-ssh-trigger[aria-expanded=true]>svg:last-child{transform:rotate(180deg)}.dsh-ra .ra-ssh-placeholder{color:var(--dsw-alias-label-secondary,var(--ra-muted))}
.dsh-ra .ra-ssh-menu{position:fixed;inset:auto;margin:0;padding:0;box-sizing:border-box;width:320px;max-width:calc(100vw - 24px);border:1px solid var(--dsw-alias-border-l2,var(--ra-line));border-radius:12px;color:var(--dsw-alias-label-primary,var(--dsh-text,#e5e7eb));background:var(--dsw-alias-bg-layer-2,var(--dsh-bg,#202126));box-shadow:0 12px 40px #0003,0 2px 8px #0002;overflow:hidden}.dsh-ra .ra-ssh-menu:popover-open{display:flex;flex-direction:column}.dsh-ra .ra-ssh-search{display:flex;align-items:center;gap:9px;flex:none;margin:8px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l3,var(--ra-line));border-radius:8px;color:var(--dsw-alias-label-secondary,var(--ra-muted));background:var(--dsw-alias-bg-module-platform,var(--ra-panel))}.dsh-ra .ra-ssh-search:focus-within{border-color:color-mix(in srgb,var(--ra-accent) 60%,var(--ra-line))}.dsh-ra .ra-ssh-search svg{flex:none}.dsh-ra .ra-ssh-search input{padding:0;border:0;border-radius:0;background:transparent;color:inherit;font-size:13px;line-height:20px}.dsh-ra .ra-ssh-search input::placeholder{color:var(--dsw-alias-label-secondary,var(--ra-muted))}.dsh-ra .ra-ssh-search input:focus-visible{outline:none}.dsh-ra .ra-ssh-options{min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 6px 6px;scroll-padding:6px;scrollbar-width:thin}.dsh-ra .ra-ssh-item{display:flex;align-items:center;gap:10px;min-height:40px;margin:2px 0;padding:6px 10px;border-radius:7px;font-size:13px;cursor:pointer}.dsh-ra .ra-ssh-item[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--ra-accent) 12%,transparent))}.dsh-ra .ra-ssh-item[aria-selected=true]{color:var(--dsw-alias-button-info-fill,var(--ra-accent))}.dsh-ra .ra-ssh-item[aria-disabled=true]{opacity:.5;cursor:default}.dsh-ra .ra-ssh-item-icon{display:flex;align-items:center;justify-content:center;flex:none;width:25px;height:25px;border:1px solid var(--ra-line);border-radius:6px;color:var(--dsw-alias-label-secondary,var(--ra-muted))}.dsh-ra .ra-ssh-item-name{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.dsh-ra .ra-ssh-item>svg{flex:none}.dsh-ra .ra-ssh-saved{font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-secondary,var(--ra-muted))}.dsh-ra .ra-ssh-no-results{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-secondary,var(--ra-muted));font-size:12px}.dsh-ra .ra-ssh-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;padding:8px 12px;border-top:1px solid var(--ra-line);color:var(--dsw-alias-label-secondary,var(--ra-muted));font-size:10px}.dsh-ra .ra-ssh-footer>span:last-child{display:flex;align-items:center;gap:4px;white-space:nowrap}.dsh-ra .ra-ssh-footer kbd{font:inherit;min-width:16px;text-align:center;padding:0 3px;border:1px solid var(--ra-line);border-radius:3px;background:var(--ra-panel)}
.dsh-ra .ra-team-usage{margin:4px 0 2px;padding:10px 12px;border:1px solid var(--ra-line);border-radius:10px;background:var(--ra-panel);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-ra .ra-team-list .ra-host-row{flex-wrap:wrap}.dsh-ra .ra-team-list .ra-host-name{flex:1 1 260px}.dsh-ra .ra-team-form h4{margin:14px 0 4px;font-size:13px;font-weight:600}.dsh-ra .ra-team-form>p{font-size:12px;margin-bottom:8px}
.dsh-ra .ra-team-card{border:1px solid var(--ra-line);border-radius:10px;margin-top:8px;overflow:hidden}.dsh-ra .ra-team-card[data-open=true]{background:color-mix(in srgb,var(--ra-panel) 50%,transparent)}.dsh-ra .ra-team-card-head{display:flex;align-items:center;gap:6px;padding:4px 6px 4px 4px}.dsh-ra .ra-team-card-toggle{flex:1;min-width:0;display:flex;align-items:center;gap:8px;border:0;background:transparent;text-align:left;padding:6px 8px;border-radius:7px}.dsh-ra .ra-team-card-toggle>strong{flex:none;font-size:13px}.dsh-ra .ra-team-card-toggle>.ra-muted{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px}.dsh-ra .ra-team-card-remove{flex:none;height:30px;width:30px;padding:0;font-size:16px;border:0}
.dsh-ra .ra-team-fields{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:10px;align-items:end;padding:4px 12px 14px}.dsh-ra .ra-team-fields input:not([type=checkbox]),.dsh-ra .ra-team-fields select{height:36px;padding-block:0}.dsh-ra .ra-team-member-fields>.ra-field:nth-child(-n+2){grid-column:span 6}.dsh-ra .ra-team-member-fields>.ra-field:nth-child(3){grid-column:span 3}.dsh-ra .ra-team-member-fields>.ra-field:nth-child(4){grid-column:span 5}.dsh-ra .ra-team-member-fields>.ra-field:nth-child(5){grid-column:span 4}.dsh-ra .ra-team-task-fields>.ra-field:nth-child(1){grid-column:span 4}.dsh-ra .ra-team-task-fields>.ra-field:nth-child(2){grid-column:span 8}.dsh-ra .ra-team-subject,.dsh-ra .ra-team-description,.dsh-ra .ra-team-field-note{grid-column:1/-1}.dsh-ra .ra-team-task-fields>.ra-team-subject,.dsh-ra .ra-team-task-fields>.ra-team-description{grid-column:1/-1}.dsh-ra .ra-team-field-note{margin:0;font-size:12px}.dsh-ra .ra-team-deps{grid-column:1/-1;border:0;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:12px}.dsh-ra .ra-team-deps legend{float:left;padding:0;margin-right:4px;color:var(--ra-muted)}.dsh-ra .ra-team-deps label{display:flex;align-items:center;gap:5px;cursor:pointer}.dsh-ra .ra-team-deps input{width:auto;margin:0;accent-color:var(--ra-accent)}
.dsh-ra .ra-team-fields textarea{resize:vertical}.dsh-ra .ra-team-save{justify-content:flex-end;margin-top:14px}
.dsh-ra .ra-team-card{container-type:inline-size}@container(max-width:420px){.dsh-ra .ra-team-member-fields>.ra-field:nth-child(n){grid-column:span 6}.dsh-ra .ra-team-member-fields>.ra-field:nth-child(4){grid-column:1/-1;order:1}.dsh-ra .ra-team-member-fields>.ra-field:nth-child(5){order:0}}.dsh-ra .ra-team-line{display:block;width:fit-content;max-width:100%;padding:2px 7px;border:1px solid var(--ra-line);border-radius:6px;background:var(--ra-panel);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}.dsh-ra .ra-team-list .ra-team-line{margin-top:2px}.dsh-ra .ra-team-howto{margin:0;padding:0 0 0 20px;display:flex;flex-direction:column;gap:6px;font-size:13px}.dsh-ra .ra-team-howto .ra-team-line{margin-top:4px}.dsh-ra .ra-team-syntax{font-size:12px}.dsh-ra .ra-team-syntax summary{cursor:pointer;color:var(--ra-muted);width:fit-content}.dsh-ra .ra-team-syntax[open] summary{margin-bottom:6px}.dsh-ra .ra-team-syntax p{margin:6px 0 0}.dsh-ra .ra-team-form h4{display:flex;align-items:center;gap:7px}.dsh-ra .ra-team-number{flex:none;display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:var(--ra-panel);border:1px solid var(--ra-line);font-size:11px;font-weight:600}.dsh-ra .ra-team-flow{display:flex;flex-direction:column;gap:8px;margin-top:6px}.dsh-ra .ra-team-flow-steps{list-style:none;margin:0;padding:10px 12px;border:1px solid var(--ra-line);border-radius:10px;display:flex;flex-direction:column;gap:8px;font-size:12px}.dsh-ra .ra-team-flow-steps>li{display:grid;grid-template-columns:82px minmax(0,1fr);gap:8px}.dsh-ra .ra-team-flow-at{color:var(--ra-muted)}.dsh-ra .ra-team-flow-tasks{display:flex;flex-direction:column;gap:4px;min-width:0}.dsh-ra .ra-team-flow-tasks>div{display:flex;flex-wrap:wrap;gap:2px 8px;overflow-wrap:anywhere}.dsh-ra .ra-team-flow .ra-banner,.dsh-ra .ra-team-form .ra-team-save-error{margin:0;align-items:center}.dsh-ra .ra-team-form .ra-team-save-error{margin-top:14px}.dsh-ra .ra-team-flow .ra-banner button{height:28px;padding:0 10px}
.dsh-ra .ra-chevron{flex:none;transition:transform .15s;color:var(--ra-muted)}.dsh-ra .ra-chevron[data-open=true]{transform:rotate(90deg)}
.dsh-ra .ra-menu-panel{min-width:180px;width:max-content;max-width:260px;padding:6px;gap:2px}.dsh-ra .ra-menu-panel>button{display:block;width:100%;text-align:left;border:0;border-radius:7px;padding:8px 10px;font-size:13px;color:inherit}.dsh-ra .ra-menu-panel>button:hover:enabled{background:var(--ra-panel)}.dsh-ra .ra-menu-panel>button:disabled{opacity:.45}.dsh-ra .ra-menu-panel>button.ra-danger{color:var(--ra-bad)}
.dsh-ra .ra-host-expand{flex:none;width:26px;height:26px;padding:0;border:0;display:grid;place-items:center;color:var(--ra-muted);align-self:start;margin-top:1px}.dsh-ra .ra-host-top>.ra-detail-menu{flex:none;margin-left:auto}
.dsh-ra .ra-share-badge{color:var(--ra-accent)}
.dsh-ra .ra-add-host{margin-top:12px}
.dsh-ra .ra-page{display:flex;flex-direction:column;gap:10px;min-width:0;padding:12px 0}.dsh-ra .ra-empty{text-align:center;padding:40px 16px;color:var(--ra-muted)}.dsh-ra.ra-settings{padding:20px 24px}.dsh-ra .ra-intro{margin-bottom:12px}.dsh-ra .ra-chat-projects .ra-grid .ra-field:last-child{grid-column:1/-1}
.dsh-ra .ra-settings-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}
.dsh-ra.ra-dialog{padding:0;border:1px solid var(--ra-line);border-radius:16px;width:min(1440px,calc(100vw - 88px));height:min(920px,calc(100dvh - 48px));max-width:none;max-height:none;background:var(--ra-bg);color:var(--dsh-text,inherit);overflow:hidden;box-shadow:0 28px 100px #0006;font-size:14px;line-height:1.6;--ra-line:color-mix(in srgb,var(--dsh-text,#e5e7eb) 10%,transparent);--ra-panel:var(--dsh-bg-secondary,#202124);--ra-good:color-mix(in srgb,#4eb78c 55%,var(--dsh-text,#e5e7eb));--ra-warn:color-mix(in srgb,#e0a03c 50%,var(--dsh-text,#e5e7eb));--ra-bad:color-mix(in srgb,#db6262 60%,var(--dsh-text,#e5e7eb))}
.ra-dialog::backdrop{background:#0008;backdrop-filter:blur(6px)}
.dsh-ra .ra-dialog-bar{height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 18px 0 22px;border-bottom:1px solid var(--ra-line);font-size:13px}
.dsh-ra .ra-dialog-bar button{display:grid;place-items:center;width:30px;height:30px;border:0;padding:0;color:var(--ra-muted)}
.dsh-ra .ra-sessions{display:grid;grid-template-columns:minmax(285px,28%) minmax(0,1fr);height:calc(100% - 44px);min-height:0;scrollbar-width:thin;scrollbar-color:var(--ra-line) transparent}
.dsh-ra .ra-session-list{display:flex;flex-direction:column;border-right:1px solid var(--ra-line);background:color-mix(in srgb,var(--ra-panel) 52%,var(--ra-bg));min-height:0;padding:22px 0 0}
.dsh-ra .ra-list-heading{display:flex;align-items:center;justify-content:space-between;padding:0 22px;margin-bottom:14px;gap:12px}
.dsh-ra .ra-list-heading h2{font-size:23px;line-height:1.4;letter-spacing:-.5px;font-weight:600}
.dsh-ra .ra-icon-button{display:inline-grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:7px;color:var(--ra-muted);flex:none}
.dsh-ra .ra-session-search{display:flex;align-items:center;gap:9px;padding:0 11px;margin:0 22px;background:color-mix(in srgb,var(--ra-panel) 85%,transparent);border:1px solid var(--ra-line);border-radius:8px;color:var(--ra-muted);min-height:39px}
.dsh-ra .ra-session-search:focus-within{border-color:var(--ra-accent)}
.dsh-ra .ra-session-search svg{flex:none}
.dsh-ra .ra-session-search input{border:0;background:transparent;padding:8px 0;font-size:14px;outline:none;color:var(--dsh-text,inherit)}
.dsh-ra .ra-session-search input:focus-visible{outline:none}
.dsh-ra .ra-session-search input::placeholder{color:var(--ra-muted)}
.dsh-ra .ra-filters{display:flex;gap:22px;margin:16px 22px 0;border-bottom:1px solid var(--ra-line);flex:none}
.dsh-ra .ra-filters button{display:flex;align-items:center;gap:8px;font-size:13px;border:0;border-bottom:2px solid transparent;border-radius:0;padding:6px 2px 10px;color:var(--ra-muted);white-space:nowrap}
.dsh-ra .ra-filters button:hover:enabled{background:transparent;color:var(--dsh-text,inherit)}
.dsh-ra .ra-filters button[aria-pressed=true]{color:var(--dsh-text,inherit);border-bottom-color:var(--ra-accent);font-weight:550}
.dsh-ra .ra-filters button span{font-size:11px;min-width:19px;padding:0 4px;background:var(--ra-accent);border-radius:4px;color:#fff;text-align:center;font-variant-numeric:tabular-nums}
.dsh-ra .ra-session-items{overflow:auto;min-height:0;flex:1;padding-bottom:20px;scrollbar-width:thin;overscroll-behavior:contain}
.dsh-ra .ra-session-group>h3{padding:12px 24px 8px;font-size:12px;font-weight:500;color:var(--ra-muted)}
.dsh-ra button.ra-session-item{display:flex;flex-direction:column;gap:8px;text-align:left;width:100%;padding:14px 24px;border:0;border-left:2px solid transparent;border-radius:0;position:relative;transition:background .15s}.dsh-ra button.ra-session-item>.ra-badge{align-self:flex-start;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.dsh-ra button.ra-session-item::after{content:'';position:absolute;bottom:0;left:24px;right:24px;border-bottom:1px solid color-mix(in srgb,var(--ra-line) 45%,transparent)}
.dsh-ra button.ra-session-item:hover{background:color-mix(in srgb,var(--dsh-text,#e5e7eb) 4%,transparent)}
.dsh-ra button.ra-session-item[aria-current=true]{background:color-mix(in srgb,var(--ra-accent) 13%,transparent);border-left-color:var(--ra-accent)}
.dsh-ra .ra-session-topline{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;width:100%}
.dsh-ra .ra-session-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:550;line-height:1.55;min-width:0;overflow-wrap:anywhere}
.dsh-ra .ra-session-title>span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.dsh-ra .ra-session-dot{color:var(--ra-accent);flex:none}
.dsh-ra .ra-session-dot[data-status=attention]{color:var(--ra-warn)}
.dsh-ra .ra-session-dot[data-status=error]{color:var(--ra-bad)}
.dsh-ra time{font-size:12px;color:var(--ra-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-ra .ra-session-topline time{padding-top:1px;flex:none}
.dsh-ra .ra-session-meta{color:var(--ra-muted);font-size:12px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:100%;line-height:1.6}
.dsh-ra .ra-list-empty{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:30px 24px;color:var(--ra-muted);font-size:12px;line-height:1.8}
.dsh-ra .ra-list-empty h3{font-size:14px;color:var(--dsh-text,inherit)}
.dsh-ra .ra-list-empty button{font-size:12px;margin-top:5px}
.dsh-ra .ra-list-footer{padding:0 22px 16px;flex:none}
.dsh-ra .ra-archive-link{display:flex;align-items:center;gap:12px;width:100%;border:0;border-top:1px solid var(--ra-line);border-radius:0;padding:18px 0 6px;color:var(--ra-muted);font-size:13px;text-align:left}
.dsh-ra .ra-archive-link>span{flex:1}
.dsh-ra .ra-archive-link small{font-size:11px}
.dsh-ra .ra-archive-link[aria-pressed=true]{color:var(--ra-accent)}
.dsh-ra .ra-archive-link:hover:enabled{background:transparent;color:var(--dsh-text,inherit)}
.dsh-ra .ra-bulk-archive{width:100%;font-size:11px;border:0;text-align:left;color:var(--ra-muted);padding:8px 0 14px}
.dsh-ra .ra-session-notice{font-size:12px;line-height:1.7;color:var(--ra-good);padding:12px 22px 0}
.dsh-ra .ra-session-list>.ra-banner{margin:12px 14px 0;font-size:12px;align-items:flex-start}
.dsh-ra .ra-session-main{min-width:0;min-height:0;display:flex;flex-direction:column;position:relative}
.dsh-ra .ra-back{display:none}
.dsh-ra .ra-selection-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;max-width:340px;margin:auto;padding:32px;color:var(--ra-muted);text-align:center}
.dsh-ra .ra-selection-empty h2{font-size:18px;color:var(--dsh-text,inherit)}
.dsh-ra .ra-selection-empty p{font-size:13px;line-height:1.8}
.dsh-ra .ra-selection-empty button{font-size:13px;margin-top:8px}
.dsh-ra .ra-new-session{display:flex;flex-direction:column;gap:20px;overflow:auto;padding:36px;max-width:640px;width:100%;margin:0 auto}
.dsh-ra .ra-new-session h2{font-size:22px}
.dsh-ra .ra-new-session .ra-field{font-size:13px}
.dsh-ra .ra-new-session>.ra-primary{align-self:flex-end}
.dsh-ra .ra-new-session>.ra-grid{margin:0}
.dsh-ra .ra-session-detail{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}
.dsh-ra .ra-detail-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 24px 17px;border-bottom:1px solid var(--ra-line);flex:none}
.dsh-ra .ra-detail-title{min-width:0;flex:1}
.dsh-ra .ra-detail-heading h2{font-size:18px;font-weight:600;overflow-wrap:anywhere;line-height:1.5;margin-bottom:5px}
.dsh-ra .ra-detail-heading p{font-size:13px;color:var(--ra-muted);overflow-wrap:anywhere}
.dsh-ra .ra-detail-actions{display:flex;align-items:center;gap:8px;flex:none;padding-top:3px}
.dsh-ra .ra-detail-actions>button{display:flex;align-items:center;gap:7px;font-size:12px;border:0;color:var(--ra-muted);padding:5px 6px;white-space:nowrap}
.dsh-ra .ra-detail-menu{position:relative}
.dsh-ra .ra-options-panel{position:absolute;z-index:4;right:0;top:38px;display:flex;flex-direction:column;gap:12px;width:285px;max-width:calc(100vw - 40px);background:var(--ra-bg);border:1px solid var(--ra-line);border-radius:12px;padding:16px;box-shadow:0 12px 32px #0003;font-size:12px}
.dsh-ra .ra-options-panel>.ra-mono{overflow-wrap:anywhere;font-size:11px}
.dsh-ra .ra-options-panel>button{text-align:left;border:0;border-bottom:1px solid var(--ra-line);border-radius:0;padding:6px 0 12px}
.dsh-ra .ra-options-status{font-size:12px;color:var(--ra-good)}
.dsh-ra .ra-options-status[data-status=attention]{color:var(--ra-warn)}
.dsh-ra .ra-options-status[data-status=error]{color:var(--ra-bad)}
.dsh-ra .ra-options-panel .ra-field{font-size:12px}
.dsh-ra .ra-options-panel small{font-size:11px;line-height:1.7}
.dsh-ra .ra-rename{display:flex;gap:8px;padding:16px 24px;flex:none}
.dsh-ra .ra-session-detail>.ra-banner{margin:12px 24px;flex-shrink:0}
.dsh-ra .ra-permissions{flex:none;max-height:48%;overflow:auto}
.dsh-ra .ra-permissions:empty{display:none}
.dsh-ra .ra-permission{margin:18px 24px 0;padding:18px;border:1px solid color-mix(in srgb,var(--ra-warn) 35%,var(--ra-line));background:color-mix(in srgb,var(--ra-warn) 4%,var(--ra-bg));border-radius:10px;font-size:13px}
.dsh-ra .ra-permission h3{font-size:15px;margin-bottom:8px}
.dsh-ra .ra-permission details{margin-top:10px}
.dsh-ra .ra-permission pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto}
.dsh-ra .ra-permission button{font-size:12px}
.dsh-ra .ra-question{border:0;margin:12px 0;padding:0;min-width:0}
.dsh-ra .ra-question legend{font-weight:600;margin-bottom:8px}
.dsh-ra .ra-option{display:flex;align-items:flex-start;gap:8px;padding:5px 0}
.dsh-ra .ra-option input{width:auto;margin-top:4px}
.dsh-ra .ra-option small{display:block;color:var(--ra-muted)}
.dsh-ra .ra-output{flex:1;min-height:80px;overflow:auto;padding:22px 24px 12px;overscroll-behavior:contain;scrollbar-width:thin}
.dsh-ra .ra-message{display:flex;gap:14px;margin-bottom:26px;overflow-wrap:anywhere;max-width:100%}
.dsh-ra .ra-agent-avatar{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:50%;background:color-mix(in srgb,var(--dsh-text,#fff) 9%,transparent);font-size:21px;font-weight:600;line-height:1}
.dsh-ra .ra-message-content{min-width:0;flex:1}
.dsh-ra .ra-message-byline{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin:3px 0 14px;font-size:14px;line-height:1.5}
.dsh-ra .ra-message-byline strong{font-weight:600}
.dsh-ra .ra-message pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.8}
.dsh-ra .ra-message[data-kind=user_message]{margin:0 0 26px auto;max-width:87%;width:fit-content;display:block}
.dsh-ra .ra-message[data-kind=user_message] pre{padding:13px 17px;border:1px solid color-mix(in srgb,var(--ra-accent) 25%,var(--ra-line));background:color-mix(in srgb,var(--ra-accent) 12%,var(--ra-bg));border-radius:13px;font-size:15px}
.dsh-ra .ra-message-time{text-align:right;margin-top:6px}
.dsh-ra .ra-message[data-kind=error]{color:var(--ra-bad)}
.dsh-ra .ra-message[data-kind=interrupted],.dsh-ra .ra-message[data-kind=unprompted]{color:var(--ra-muted);font-size:13px}
.dsh-ra .ra-message[data-kind=model_switch]{color:var(--ra-warn);font-size:13px}
.dsh-ra .ra-markdown{font-size:16px;line-height:1.8}.dsh-ra .ra-markdown>p{max-width:650px}
.dsh-ra .ra-markdown :is(p,ul,ol,blockquote,pre){margin:0 0 14px}
.dsh-ra .ra-markdown>:last-child{margin-bottom:0}
.dsh-ra .ra-markdown :is(h1,h2,h3,h4){font-size:17px;font-weight:600;line-height:1.6;margin:20px 0 10px}
.dsh-ra .ra-markdown>:first-child{margin-top:0}
.dsh-ra .ra-markdown :is(ul,ol){padding-left:24px}
.dsh-ra .ra-markdown li{padding-left:3px;margin:6px 0}
.dsh-ra .ra-markdown code{font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 5px;border-radius:4px;background:color-mix(in srgb,currentColor 7%,transparent);overflow-wrap:anywhere}
.dsh-ra .ra-markdown pre{padding:14px;background:var(--ra-panel);border-radius:8px;overflow:auto;white-space:pre-wrap}
.dsh-ra .ra-markdown pre code{padding:0;background:none}
.dsh-ra .ra-markdown a{color:var(--ra-accent);text-underline-offset:3px}
.dsh-ra .ra-markdown blockquote{padding-left:14px;border-left:2px solid var(--ra-line);color:var(--ra-muted)}
.dsh-ra .ra-tools-group{margin:0 0 22px 50px;border:1px solid var(--ra-line);border-radius:9px;overflow:hidden;font-size:13px}
.dsh-ra .ra-tools-group>summary{display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;list-style:none;background:color-mix(in srgb,var(--ra-panel) 50%,transparent)}
.dsh-ra .ra-tools-group>summary::-webkit-details-marker{display:none}
.dsh-ra .ra-tools-group>summary>span:first-of-type{flex:1}
.dsh-ra .ra-tools-group>summary>svg:first-child{transition:transform .15s}
.dsh-ra .ra-tools-group[open]>summary>svg:first-child{transform:rotate(90deg)}
.dsh-ra .ra-tools-group>summary>.ra-muted{font-size:11px}
.dsh-ra .ra-tool{padding:10px 14px;font-size:12px;border-top:1px solid var(--ra-line)}
.dsh-ra .ra-tool summary{cursor:pointer;overflow-wrap:anywhere}
.dsh-ra .ra-tool summary span{float:right;font-size:11px;margin-left:10px}
.dsh-ra .ra-tool pre{font:12px/1.7 ui-monospace,monospace;padding-top:12px;margin:0;max-height:300px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-ra .ra-thinking{font-size:13px;color:var(--ra-muted);margin:0 0 20px 50px}
.dsh-ra .ra-thinking summary{cursor:pointer}
.dsh-ra .ra-thinking pre{margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.8}
.dsh-ra .ra-turn-status{display:flex;align-items:center;gap:9px;color:var(--ra-good);font-size:12px;margin:8px 0 12px 50px}
.dsh-ra .ra-compose{flex:none;margin:8px 24px 20px;padding:15px 16px 12px;border:1px solid color-mix(in srgb,var(--ra-accent) 17%,var(--ra-line));border-radius:14px;background:color-mix(in srgb,var(--ra-panel) 65%,var(--ra-bg))}
.dsh-ra .ra-compose:focus-within{border-color:color-mix(in srgb,var(--ra-accent) 55%,var(--ra-line))}
.dsh-ra .ra-compose textarea{font-size:15px;line-height:1.7;resize:vertical;max-height:180px;min-height:54px;padding:0;border:0;background:transparent;border-radius:0}
.dsh-ra .ra-compose textarea:focus-visible{outline:none}
.dsh-ra .ra-compose textarea::placeholder{color:var(--ra-muted)}
.dsh-ra .ra-compose-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px}
.dsh-ra .ra-compose-actions>.ra-primary{display:flex;align-items:center;justify-content:center;gap:7px;padding:8px 13px;border-radius:8px;font-size:13px;margin-left:auto}
.dsh-ra .ra-composer-provider{font-size:12px;color:var(--ra-muted);white-space:nowrap}
.dsh-ra .ra-compose-wait{font-size:11px;color:var(--ra-muted)}
.dsh-ra .ra-compose>.ra-banner{margin:0 0 12px}
.dsh-ra .ra-compose-note{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px;border-top:1px solid var(--ra-line);font-size:12px;color:var(--ra-muted);flex:none}
.dsh-ra .ra-compose-note button{display:flex;align-items:center;gap:8px;flex:none;font-size:13px}
@media(prefers-color-scheme:light){.dsh-ra{--ra-bg:var(--dsh-bg,#fff)}}
@media(max-width:1000px) and (min-width:761px){.dsh-ra.ra-dialog{width:calc(100vw - 40px)}.dsh-ra .ra-sessions{grid-template-columns:270px minmax(0,1fr)}.dsh-ra .ra-list-heading,.dsh-ra .ra-list-footer{padding-left:18px;padding-right:18px}.dsh-ra .ra-session-search,.dsh-ra .ra-filters{margin-left:18px;margin-right:18px}.dsh-ra .ra-detail-actions>button{font-size:0;gap:0}.dsh-ra .ra-detail-actions>button svg{width:18px;height:18px}}
@media(max-width:760px){.dsh-ra.ra-dialog{width:100vw;height:100dvh;border:0;border-radius:0;margin:0}.dsh-ra .ra-sessions{grid-template-columns:minmax(0,1fr)}.dsh-ra .ra-session-main{display:none}.dsh-ra .ra-sessions[data-detail=true] .ra-session-list{display:none}.dsh-ra .ra-sessions[data-detail=true] .ra-session-main{display:flex}.dsh-ra .ra-session-list{border:0}.dsh-ra .ra-back{display:flex;align-items:center;gap:7px;align-self:flex-start;margin:9px 16px 0;font-size:12px;border:0;color:var(--ra-muted);padding:5px 0;flex:none}.dsh-ra .ra-session-detail{flex:1;height:auto}.dsh-ra .ra-detail-heading{padding:12px 16px 15px;gap:10px}.dsh-ra .ra-detail-heading h2{font-size:17px}.dsh-ra .ra-detail-heading p{font-size:12px}.dsh-ra .ra-detail-actions{gap:3px}.dsh-ra .ra-detail-actions>button{font-size:0;gap:0;padding:6px}.dsh-ra .ra-detail-actions>button svg{width:18px;height:18px}.dsh-ra .ra-output{padding:20px 16px 8px}.dsh-ra .ra-permission{margin:14px 16px 0;padding:14px}.dsh-ra .ra-compose{margin:8px 16px calc(16px + env(safe-area-inset-bottom));padding:13px 14px 11px}.dsh-ra .ra-compose textarea{font-size:16px}.dsh-ra .ra-compose-wait{display:none}.dsh-ra .ra-compose-note{padding:16px;flex-wrap:wrap}.dsh-ra .ra-compose-note button{width:100%;justify-content:center}.dsh-ra .ra-new-session{padding:24px 20px}.dsh-ra .ra-message{gap:10px}.dsh-ra .ra-agent-avatar{width:28px;height:28px;font-size:17px}.dsh-ra .ra-message-byline{font-size:13px;margin-top:1px}.dsh-ra .ra-markdown{font-size:14px}.dsh-ra .ra-message[data-kind=user_message]{max-width:92%}.dsh-ra .ra-tools-group,.dsh-ra .ra-thinking,.dsh-ra .ra-turn-status{margin-left:38px}.dsh-ra .ra-list-footer{padding-bottom:calc(18px + env(safe-area-inset-bottom))}.dsh-ra .ra-grid{grid-template-columns:minmax(0,1fr)}.dsh-ra .ra-host-row{flex-wrap:wrap}.dsh-ra .ra-host-name{flex-basis:100%}.dsh-ra.ra-settings{padding:16px}}
@media(prefers-reduced-motion:reduce){.dsh-ra .ra-session-item,.dsh-ra .ra-tools-group>summary>svg{transition:none}}
.dsh-ra.ra-flow{padding:0;border:1px solid var(--ra-line);border-radius:14px;width:min(620px,calc(100vw - 32px));max-height:min(720px,calc(100dvh - 32px));background:var(--ra-bg);color:var(--dsh-text,inherit);overflow:hidden;box-shadow:0 28px 100px #0006;display:none;flex-direction:column}.dsh-ra.ra-flow[open]{display:flex}.ra-flow::backdrop{background:#0008;backdrop-filter:blur(4px)}
.dsh-ra .ra-flow-body{display:flex;flex-direction:column;gap:14px;padding:16px 20px 20px;min-height:0;overflow:auto}
.dsh-ra .ra-flow-tabs{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:4px;padding:4px;border:1px solid var(--ra-line);border-radius:10px;background:var(--ra-panel)}.dsh-ra .ra-flow-tabs button{display:flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:7px;padding:7px 10px;color:var(--ra-muted)}.dsh-ra .ra-flow-tabs button[aria-selected=true]{background:var(--ra-bg);color:var(--dsh-text,inherit);box-shadow:0 1px 3px #0002}
.dsh-ra .ra-flow-local{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:6px 2px}.dsh-ra .ra-flow-local button,.dsh-ra .ra-flow-foot .ra-primary{display:inline-flex;align-items:center;gap:8px}
.dsh-ra .ra-flow-browser{display:flex;flex-direction:column;gap:10px;min-height:0}.dsh-ra .ra-flow-path{display:flex;align-items:center;gap:6px}.dsh-ra .ra-flow-path input{flex:1}.dsh-ra .ra-flow-path>button[type=submit]{flex:none}.dsh-ra .ra-flow-path .ra-icon-button{border:1px solid var(--ra-line)}
.dsh-ra .ra-flow-list{display:flex;flex-direction:column;height:280px;overflow:auto;padding:4px;border:1px solid var(--ra-line);border-radius:10px;scrollbar-width:thin}.dsh-ra .ra-flow-entry{display:flex;align-items:center;gap:9px;width:100%;flex:none;border:0;border-radius:7px;padding:6px 9px;text-align:left}.dsh-ra .ra-flow-entry>svg{flex:none;color:var(--ra-accent)}.dsh-ra .ra-flow-entry>span{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.dsh-ra .ra-flow-entry[data-hidden]{color:var(--ra-muted)}.dsh-ra .ra-flow-note{margin:auto;padding:24px 12px;color:var(--ra-muted);font-size:12px}
.dsh-ra .ra-flow-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.dsh-ra .ra-flow-foot label{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ra-muted);cursor:pointer}.dsh-ra .ra-flow-foot label input{width:auto;margin:0;accent-color:var(--ra-accent)}.dsh-ra .ra-flow .ra-foot{margin-top:0}.dsh-ra .ra-flow .ra-banner{margin:0}
.dsh-ra .ra-flow-foot button{display:inline-flex;align-items:center;gap:6px}.dsh-ra .ra-flow-foot .ra-actions{margin-left:auto}
.dsh-ra button.ra-primary.ra-danger-fill{background:var(--ra-bad)}
.dsh-ra .ra-select-mark{flex:none;padding:0 6px;border-radius:5px;background:color-mix(in srgb,currentColor 8%,transparent);color:var(--ra-muted);font:500 11px/18px ui-monospace,SFMono-Regular,Menlo,monospace}
.dsh-ra .ra-select-menu{padding:0}.dsh-ra .ra-select-menu [role=listbox]{padding:6px}
.dsh-ra .ra-select-search{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,var(--ra-line));background:inherit;color:var(--ra-muted)}.dsh-ra .ra-select-search input{flex:1;min-width:0;padding:0;border:0;background:transparent;color:var(--dsh-text,inherit);font-size:13px}.dsh-ra .ra-select-search input:focus-visible{outline:none}
.dsh-ra .ra-select-empty{padding:14px 10px;text-align:center;font-size:12px;color:var(--ra-muted)}
.dsh-ra .ra-machine-item[aria-disabled=true]{opacity:.5;cursor:default}
.dsh-ra .ra-wt{display:flex;flex-direction:column;gap:14px;min-width:0}
.dsh-ra .ra-wt-segment{display:flex;gap:2px;align-self:flex-start;padding:3px;border:1px solid var(--ra-line);border-radius:9px;background:var(--ra-panel)}.dsh-ra .ra-wt-segment button{border:0;border-radius:6px;padding:5px 14px;font-size:12.5px;color:var(--ra-muted)}.dsh-ra .ra-wt-segment button[aria-checked=true]{background:var(--ra-bg);color:var(--dsh-text,inherit);box-shadow:0 1px 3px #0002;font-weight:550}
.dsh-ra .ra-wt-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:end}@media(max-width:560px){.dsh-ra .ra-wt-row{grid-template-columns:minmax(0,1fr)}}
.dsh-ra .ra-wt-input{height:48px;border-radius:10px;padding:0 12px;font-size:13px}.dsh-ra .ra-wt-input::placeholder{font-family:var(--dsh-font-family,inherit);color:var(--ra-muted)}
.dsh-ra .ra-wt-where{margin:-4px 0 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ra .ra-wt-setup summary{cursor:pointer;width:fit-content;font-size:12px;color:var(--ra-muted)}.dsh-ra .ra-wt-setup pre{margin:8px 0 0;padding:8px 10px;max-height:140px;overflow:auto;border:1px solid var(--ra-line);border-radius:8px;background:color-mix(in srgb,currentColor 3%,transparent);white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.6}
.dsh-ra .ra-wt-list{display:flex;flex-direction:column;gap:6px;padding-top:14px;border-top:1px solid var(--ra-line)}.dsh-ra .ra-wt-list h4{display:flex;align-items:center;gap:8px;margin:0;font-size:12px;font-weight:600;color:var(--ra-muted)}.dsh-ra .ra-wt-list h4 span{min-width:18px;padding:0 6px;border-radius:9px;background:color-mix(in srgb,currentColor 8%,transparent);font-weight:500;text-align:center;font-variant-numeric:tabular-nums}
.dsh-ra .ra-wt-list ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}.dsh-ra .ra-wt-list li{display:flex;align-items:center;gap:10px;min-width:0;padding:7px 6px;border-radius:8px}.dsh-ra .ra-wt-list li:hover{background:color-mix(in srgb,currentColor 4%,transparent)}.dsh-ra .ra-wt-list li>svg{flex:none;color:var(--ra-muted)}
.dsh-ra .ra-wt-list-main{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}.dsh-ra .ra-wt-list-main>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.dsh-ra .ra-wt-list-main small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ra-muted);font-size:11px}
.dsh-ra .ra-wt-icon{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:7px;color:var(--ra-muted)}.dsh-ra .ra-wt-icon:hover:enabled{color:var(--dsh-text,inherit)}
.dsh-ra .ra-wt-job{display:flex;flex-direction:column;gap:14px;min-width:0}.dsh-ra .ra-wt-job h3{overflow-wrap:anywhere}
.dsh-ra .ra-wt-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}.dsh-ra .ra-wt-steps li{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--ra-muted)}.dsh-ra .ra-wt-steps li>svg,.dsh-ra .ra-wt-steps .ra-wt-spinner{flex:none}
.dsh-ra .ra-wt-steps li[data-state=done]{color:var(--dsh-text,inherit)}.dsh-ra .ra-wt-steps li[data-state=done]>svg{color:var(--ra-good)}.dsh-ra .ra-wt-steps li[data-state=running]{color:var(--dsh-text,inherit);font-weight:550}.dsh-ra .ra-wt-steps li[data-state=failed]{color:var(--ra-bad)}.dsh-ra .ra-wt-steps li[data-state=skipped]>span{text-decoration:line-through;text-decoration-color:color-mix(in srgb,currentColor 40%,transparent)}
.dsh-ra .ra-wt-steps small{margin-left:auto;font-size:11px;color:var(--ra-muted);font-weight:400}
.dsh-ra .ra-wt-spinner{width:14px;height:14px;margin:1px;border:1.6px solid var(--ra-accent);border-right-color:transparent;border-radius:50%;animation:ra-wt-spin .8s linear infinite}@keyframes ra-wt-spin{to{transform:rotate(360deg)}}
.dsh-ra .ra-wt-log{margin:0;height:200px;overflow:auto;padding:10px 12px;border:1px solid var(--ra-line);border-radius:10px;background:color-mix(in srgb,currentColor 4%,transparent);font:11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;scrollbar-width:thin}
.dsh-ra .ra-wt-detail{display:block;margin-top:6px;white-space:pre-wrap;opacity:.85}.dsh-ra .ra-wt-note{font-size:12px}
.dsh-ra .ra-wt-risks{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:13px}.dsh-ra .ra-wt-risks li[data-tone=warn]{color:var(--ra-warn)}
.dsh-ra .ra-wt-check{display:flex;align-items:flex-start;gap:9px;font-size:13px;cursor:pointer}.dsh-ra .ra-wt-check input{width:auto;margin:3px 0 0;accent-color:var(--ra-accent)}.dsh-ra .ra-wt-check input:disabled+span{opacity:.6}.dsh-ra .ra-wt-check small{display:block;margin-top:2px;font-size:11.5px;color:var(--ra-muted)}
.dsh-ra .ra-machine-select{min-width:0}
.dsh-ra .ra-machine-trigger{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:7px 12px;border-radius:10px;text-align:left;background:var(--dsw-alias-bg-module-platform,var(--ra-panel));transition:background .15s,border-color .15s,box-shadow .15s}
.dsh-ra .ra-machine-trigger:hover:enabled{border-color:color-mix(in srgb,currentColor 28%,transparent)}
.dsh-ra .ra-machine-trigger[aria-expanded=true]{border-color:var(--ra-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ra-accent) 14%,transparent)}
.dsh-ra .ra-machine-trigger-icon{display:flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;border:1px solid var(--ra-line);border-radius:8px;color:var(--ra-muted);background:color-mix(in srgb,var(--ra-panel) 70%,transparent)}.dsh-ra .ra-machine-trigger[aria-expanded=true] .ra-machine-trigger-icon{color:var(--ra-accent);border-color:color-mix(in srgb,var(--ra-accent) 45%,var(--ra-line))}
.dsh-ra .ra-machine-trigger-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;text-align:left}
.dsh-ra .ra-machine-label{display:flex;align-items:center;gap:7px;min-width:0;font-size:13px;font-weight:550;color:var(--dsh-text,inherit)}
.dsh-ra .ra-machine-name{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dsh-ra .ra-machine-connection{font-size:11px;line-height:1.4;color:var(--ra-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dsh-ra .ra-machine-dot{flex:none;display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ra-muted);box-shadow:0 0 0 3px color-mix(in srgb,var(--ra-muted) 14%,transparent)}
.dsh-ra .ra-machine-dot[data-status=connected]{background:var(--ra-good);box-shadow:0 0 0 3px color-mix(in srgb,var(--ra-good) 16%,transparent)}
.dsh-ra .ra-machine-dot[data-status=connecting]{background:var(--ra-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ra-accent) 16%,transparent)}
.dsh-ra .ra-machine-dot[data-status=error]{background:var(--ra-bad);box-shadow:0 0 0 3px color-mix(in srgb,var(--ra-bad) 16%,transparent)}
.dsh-ra .ra-machine-chevron{flex:none;color:var(--ra-muted);transition:transform .15s}
.dsh-ra .ra-machine-trigger[aria-expanded=true] .ra-machine-chevron{transform:rotate(180deg)}
.dsh-ra .ra-machine-menu{position:fixed;inset:auto;margin:0;padding:6px;box-sizing:border-box;width:320px;max-width:calc(100vw - 24px);border:1px solid var(--dsw-alias-border-l2,var(--ra-line));border-radius:12px;color:var(--dsh-text,#e5e7eb);background:var(--dsw-alias-bg-layer-2,var(--dsh-bg,#202126));box-shadow:0 16px 44px #0004,0 2px 8px #0002;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.dsh-ra .ra-machine-menu:popover-open{display:block}
.dsh-ra .ra-machine-item{display:flex;align-items:center;gap:10px;min-height:48px;margin:2px 0;padding:7px 10px;border-radius:8px;font-size:13px;cursor:pointer;color:var(--dsh-text,inherit)}
.dsh-ra .ra-machine-item[data-active=true]{background:color-mix(in srgb,var(--ra-accent) 12%,transparent)}
.dsh-ra .ra-machine-item[aria-selected=true]{color:var(--ra-accent)}
.dsh-ra .ra-machine-item-icon{display:flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border:1px solid var(--ra-line);border-radius:7px;color:var(--ra-muted);background:color-mix(in srgb,var(--ra-panel) 70%,transparent)}
.dsh-ra .ra-machine-item[aria-selected=true] .ra-machine-item-icon{border-color:color-mix(in srgb,var(--ra-accent) 45%,var(--ra-line));color:var(--ra-accent)}
.dsh-ra .ra-machine-item-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-ra .ra-machine-item-name{display:flex;align-items:center;gap:7px;min-width:0}
.dsh-ra .ra-machine-item-connection{font-size:11px;line-height:1.4;color:var(--ra-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dsh-ra .ra-machine-item>svg:last-child{flex:none;color:var(--ra-accent)}
`;
