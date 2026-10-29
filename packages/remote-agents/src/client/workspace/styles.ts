/**
 * The remote workspace panel: a compact target line, underlined tool tabs, and cards whose controls share
 * one 32px height. Colors follow DSH's design tokens, with the plugin's own variables as fallbacks.
 */
export const workspaceStyles = `
.dsh-ra.ra-workspace-panel,.dsh-ra .ra-workspace-panel{--ws-line:var(--dsw-alias-border-l1,var(--ra-line));--ws-field:color-mix(in srgb,currentColor 5%,transparent);--ws-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 7%,transparent));--ws-muted:var(--dsw-alias-label-secondary,var(--ra-muted));--ws-faint:var(--dsw-alias-label-tertiary,var(--ra-muted));display:flex;flex-direction:column;gap:14px;flex:1;min-height:0;overflow:auto;padding:14px 16px 20px;font-size:13px;container-type:inline-size}
.ra-workspace-panel .ra-ws-glyph{width:16px;height:16px;flex:none}
.ra-workspace-panel .ra-ws-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:24px}
.ra-workspace-panel .ra-ws-target{display:flex;align-items:center;gap:7px;min-width:0;color:var(--ws-muted)}
.ra-workspace-panel .ra-ws-target b{font-weight:600;color:var(--dsw-alias-label-primary,inherit);white-space:nowrap}
.ra-workspace-panel .ra-ws-target .ra-mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.ra-workspace-panel .ra-ws-busy{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:12px;color:var(--ws-muted)}
.ra-workspace-panel .ra-ws-spinner{width:12px;height:12px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:ra-ws-spin .8s linear infinite}
@keyframes ra-ws-spin{to{transform:rotate(360deg)}}
.ra-workspace-panel .ra-ws-tabs{display:flex;gap:18px;border-bottom:1px solid var(--ws-line);overflow-x:auto;scrollbar-width:none;flex:none}
.ra-workspace-panel .ra-ws-tabs button{flex:none;border:0;border-bottom:2px solid transparent;border-radius:0;padding:2px 1px 9px;background:transparent;color:var(--ws-muted);white-space:nowrap}
.ra-workspace-panel .ra-ws-tabs button:hover:enabled{background:transparent;color:var(--dsw-alias-label-primary,inherit)}
.ra-workspace-panel .ra-ws-tabs button[aria-pressed=true]{border-bottom-color:var(--dsw-alias-state-business-primary,var(--ra-accent));color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.ra-workspace-panel .ra-banner{margin:0}
.ra-workspace-panel .ra-ws-section{display:flex;flex-direction:column;gap:12px}
.ra-workspace-panel .ra-ws-note{margin:0;color:var(--ws-muted);font-size:12px;line-height:1.6}
.ra-workspace-panel .ra-ws-card{display:flex;flex-direction:column;gap:12px;padding:12px;border:1px solid var(--ws-line);border-radius:12px;background:color-mix(in srgb,currentColor 2%,transparent)}
.ra-workspace-panel .ra-ws-card-title{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0;font-weight:600}
.ra-workspace-panel .ra-ws-card-title span{font-weight:400;font-size:12px;color:var(--ws-muted)}
.ra-workspace-panel .ra-ws-card-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.ra-workspace-panel .ra-ws-subhead{display:flex;align-items:center;gap:8px;margin:6px 0 0;font-size:12px;font-weight:600;color:var(--ws-muted)}
.ra-workspace-panel .ra-ws-subhead span{min-width:18px;padding:0 6px;border-radius:9px;background:var(--ws-field);font-weight:500;text-align:center;font-variant-numeric:tabular-nums}
.ra-workspace-panel .ra-ws-empty{margin:0;padding:18px 12px;text-align:center;color:var(--ws-faint);font-size:12px}
.ra-workspace-panel .ra-ws-row{display:flex;align-items:center;gap:4px;flex:none}
.ra-workspace-panel :is(.ra-ws-input,.ra-ws-search){width:100%;min-width:0;border:1px solid var(--ws-line);border-radius:8px;background:var(--ws-field);color:inherit;transition:border-color .15s}
.ra-workspace-panel .ra-ws-input{height:32px;padding:0 10px}
.ra-workspace-panel .ra-ws-input:focus,.ra-workspace-panel .ra-ws-search:focus-within{outline:none;border-color:var(--dsw-alias-state-business-primary,var(--ra-accent))}
.ra-workspace-panel .ra-ws-input[type=number]{-moz-appearance:textfield;appearance:textfield}.ra-workspace-panel .ra-ws-input::-webkit-inner-spin-button,.ra-workspace-panel .ra-ws-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.ra-workspace-panel .ra-ws-field{display:flex;flex-direction:column;gap:5px;flex:1 1 0;min-width:0;font-size:12px;color:var(--ws-muted)}
.ra-workspace-panel .ra-ws-field .ra-ws-input{color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:tabular-nums}
.ra-workspace-panel .ra-ws-ports{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}
.ra-workspace-panel .ra-ws-ports .ra-ws-field{flex-basis:110px}
.ra-workspace-panel .ra-ws-arrow{flex:none;height:32px;line-height:32px;color:var(--ws-faint)}
.ra-workspace-panel .ra-ws-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;height:32px;padding:0 12px;border:1px solid var(--ws-line);border-radius:8px;background:transparent;color:inherit;font-size:13px;white-space:nowrap;text-decoration:none}
.ra-workspace-panel .ra-ws-button:hover:enabled,.ra-workspace-panel a.ra-ws-button:hover{background:var(--ws-hover)}
.ra-workspace-panel .ra-ws-button.ra-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary,var(--ra-accent));color:#fff}
.ra-workspace-panel .ra-ws-button.ra-primary:hover:enabled{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--ra-accent)) 88%,#fff)}
.ra-workspace-panel .ra-ws-icon{display:inline-grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--ws-muted)}
.ra-workspace-panel .ra-ws-icon:hover:enabled,.ra-workspace-panel a.ra-ws-icon:hover{background:var(--ws-hover);color:var(--dsw-alias-label-primary,inherit)}
.ra-workspace-panel .ra-ws-danger:hover:enabled{color:var(--ra-bad)}
.ra-workspace-panel .ra-ws-button.ra-ws-danger{margin-left:auto;border-color:transparent;color:var(--ws-muted)}
.ra-workspace-panel .ra-ws-segment{display:flex;gap:2px;padding:2px;border-radius:9px;background:var(--ws-field);border:1px solid var(--ws-line)}
.ra-workspace-panel .ra-ws-segment button{flex:1 1 0;min-width:0;height:28px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--ws-muted);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra-workspace-panel .ra-ws-segment button[aria-checked=true]{background:var(--dsw-alias-bg-layer-3,color-mix(in srgb,currentColor 12%,transparent));color:var(--dsw-alias-label-primary,inherit);box-shadow:0 1px 2px #0003;font-weight:500}
.ra-workspace-panel .ra-ws-tunnels{list-style:none;margin:0;padding:0;border:1px solid var(--ws-line);border-radius:12px;overflow:hidden}
.ra-workspace-panel .ra-ws-tunnels li{display:flex;align-items:center;gap:10px;padding:10px 8px 10px 12px}
.ra-workspace-panel .ra-ws-tunnels li+li{border-top:1px solid var(--ws-line)}
.ra-workspace-panel .ra-ws-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--ws-faint)}
.ra-workspace-panel [data-status=running] .ra-ws-dot{background:var(--ra-good);box-shadow:0 0 0 3px color-mix(in srgb,var(--ra-good) 20%,transparent)}
.ra-workspace-panel [data-status=starting] .ra-ws-dot{background:var(--ra-warn)}
.ra-workspace-panel [data-status=error] .ra-ws-dot{background:var(--ra-bad)}
.ra-workspace-panel .ra-ws-tunnel-main{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.ra-workspace-panel .ra-ws-tunnel-main .ra-mono{font-size:12.5px;color:var(--dsw-alias-label-primary,inherit)}
.ra-workspace-panel .ra-ws-tunnel-main small{font-size:11.5px;color:var(--ws-muted)}
.ra-workspace-panel .ra-ws-error{color:var(--ra-bad)!important;overflow-wrap:anywhere}
.ra-workspace-panel .ra-ws-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto}
.ra-workspace-panel .ra-ws-list li{display:flex;align-items:center;gap:8px;min-width:0}
.ra-workspace-panel .ra-ws-list .ra-mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ra-workspace-panel .ra-ws-tag{flex:none;min-width:40px;padding:1px 7px;border-radius:5px;font-size:11px;text-align:center;background:var(--ws-field);color:var(--ws-muted)}
.ra-workspace-panel .ra-ws-tag[data-action=copy]{background:color-mix(in srgb,var(--ra-good) 15%,transparent);color:var(--ra-good)}
.ra-workspace-panel .ra-ws-tag[data-action=delete]{background:color-mix(in srgb,var(--ra-bad) 15%,transparent);color:var(--ra-bad)}
.ra-workspace-panel .ra-ws-tag[data-action=conflict]{background:color-mix(in srgb,var(--ra-warn) 16%,transparent);color:var(--ra-warn)}
.ra-workspace-panel .ra-ws-skipped summary{cursor:pointer;font-size:12px;color:var(--ws-muted)}
.ra-workspace-panel .ra-ws-skipped pre{margin:8px 0 0;font:11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ws-muted);white-space:pre-wrap}
.ra-workspace-panel .ra-ws-files{display:grid;grid-template-columns:minmax(220px,32%) minmax(0,1fr);gap:14px;flex:1;min-height:420px}
.ra-workspace-panel .ra-ws-files:is([data-layout=list],[data-layout=file]){grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr);min-height:0}
.ra-workspace-panel .ra-ws-browser{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0}
.ra-workspace-panel .ra-ws-toolbar{display:flex;align-items:center;gap:2px;min-width:0}
.ra-workspace-panel .ra-ws-crumbs{display:flex;align-items:center;gap:2px;flex:1;min-width:0;overflow:hidden;white-space:nowrap;font-size:12.5px;color:var(--ws-faint)}
.ra-workspace-panel .ra-ws-crumbs button{min-width:0;max-width:160px;overflow:hidden;text-overflow:ellipsis;border:0;padding:3px 5px;border-radius:5px;background:transparent;color:var(--ws-muted)}
.ra-workspace-panel .ra-ws-crumbs button:hover:enabled{background:var(--ws-hover);color:var(--dsw-alias-label-primary,inherit)}
.ra-workspace-panel .ra-ws-crumbs button:disabled{opacity:1;color:var(--dsw-alias-label-primary,inherit);font-weight:500}
.ra-workspace-panel .ra-ws-inline{display:flex;align-items:center;gap:6px}
.ra-workspace-panel .ra-ws-inline .ra-ws-segment{flex:none}
.ra-workspace-panel .ra-ws-inline .ra-ws-segment button{flex:none}
.ra-workspace-panel .ra-ws-search{display:flex;align-items:center;gap:7px;height:32px;padding:0 10px;color:var(--ws-faint)}
.ra-workspace-panel .ra-ws-search input{flex:1;min-width:0;height:100%;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary,inherit);outline:none}
.ra-workspace-panel .ra-ws-entries{display:flex;flex-direction:column;flex:1;min-height:120px;max-height:440px;overflow:auto;padding:4px;border:1px solid var(--ws-line);border-radius:10px}
.ra-workspace-panel .ra-ws-entries button{display:flex;align-items:center;gap:8px;flex:none;width:100%;min-height:30px;padding:4px 8px;border:0;border-radius:6px;background:transparent;text-align:left;color:inherit}
.ra-workspace-panel .ra-ws-entries button:hover:enabled{background:var(--ws-hover)}
.ra-workspace-panel .ra-ws-entries button[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--ra-accent)) 18%,transparent)}
.ra-workspace-panel .ra-ws-entries .ra-ws-glyph{color:var(--ws-faint)}
.ra-workspace-panel .ra-ws-entries [data-kind=directory] .ra-ws-glyph{color:#e0b44c}
.ra-workspace-panel .ra-ws-entry-name{display:flex;flex-direction:column;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ra-workspace-panel .ra-ws-entry-name small{overflow:hidden;text-overflow:ellipsis;color:var(--ws-faint);font-size:11px}
.ra-workspace-panel .ra-ws-entries button>small{flex:none;font-size:11px;color:var(--ws-faint);font-variant-numeric:tabular-nums}
.ra-workspace-panel .ra-ws-viewer{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0}
.ra-workspace-panel .ra-ws-viewer-head{display:flex;align-items:center;gap:7px;min-height:28px;color:var(--ws-muted)}
.ra-workspace-panel .ra-ws-viewer-head .ra-mono{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,inherit)}
.ra-workspace-panel .ra-ws-dirty{flex:none;padding:1px 7px;border-radius:5px;font-size:11px;background:color-mix(in srgb,var(--ra-warn) 16%,transparent);color:var(--ra-warn)}
.ra-workspace-panel .ra-workspace-editor{flex:1;min-height:320px;width:100%;border:1px solid var(--ws-line);border-radius:10px;background:var(--ws-field);color:inherit;tab-size:2}
.ra-workspace-panel .ra-workspace-editor:focus-within{border-color:var(--dsw-alias-state-business-primary,var(--ra-accent))}
.ra-workspace-panel .ra-ws-preview{flex:1;min-height:320px;padding:8px;border:1px solid var(--ws-line);border-radius:10px;overflow:auto}
.ra-workspace-panel .ra-ws-viewer-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ra-workspace-panel .ra-ws-rename{display:flex;gap:6px;flex:1 1 220px;min-width:0}
.ra-workspace-panel .ra-ws-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;flex:1;min-height:220px;padding:24px;border:1px dashed var(--ws-line);border-radius:12px;text-align:center;color:var(--ws-faint)}
.ra-workspace-panel .ra-ws-placeholder .ra-ws-glyph{width:24px;height:24px}
.ra-workspace-panel .ra-ws-placeholder p{margin:0;color:var(--ws-muted)}
.ra-workspace-panel .ra-ws-placeholder small{max-width:280px;font-size:12px;line-height:1.6}
/* Stacked: with no file open the list fills the panel above a one-line hint; an open file takes the space instead. */
@container (max-width:640px){.ra-workspace-panel .ra-ws-files{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;min-height:0}.ra-workspace-panel .ra-ws-entries{max-height:none}.ra-workspace-panel .ra-ws-files[data-open]{grid-template-rows:auto minmax(0,1fr)}.ra-workspace-panel .ra-ws-files[data-open] .ra-ws-entries{flex:none;max-height:240px}
  .ra-workspace-panel .ra-ws-placeholder{flex:none;min-height:0;padding:0 2px;border:0}.ra-workspace-panel .ra-ws-placeholder :is(.ra-ws-glyph,p){display:none}.ra-workspace-panel .ra-ws-placeholder small{max-width:none}}
@media(max-width:760px){.ra-workspace-panel .ra-ws-files{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto;min-height:0}.ra-workspace-panel .ra-ws-entries{max-height:none}.ra-workspace-panel .ra-ws-files[data-open]{grid-template-rows:auto minmax(0,1fr)}.ra-workspace-panel .ra-ws-files[data-open] .ra-ws-entries{flex:none;max-height:240px}
  .ra-workspace-panel .ra-ws-placeholder{flex:none;min-height:0;padding:0 2px;border:0}.ra-workspace-panel .ra-ws-placeholder :is(.ra-ws-glyph,p){display:none}.ra-workspace-panel .ra-ws-placeholder small{max-width:none}}
`;
