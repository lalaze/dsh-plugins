// Colors follow DSH's theme, which marks the body `data-ds-dark-theme` in dark mode; hosts without it follow the system.
const LIGHT = `--gv-fg:var(--dsw-alias-label-primary,#24292f);--gv-muted:var(--dsw-alias-label-secondary,#6e7781);--gv-accent:var(--dsw-alias-state-business-primary,#0969da);
--gv-ok:#1a7f37;--gv-danger:#cf222e;--gv-warn:#9a6700;--gv-panel:color-mix(in srgb,currentColor 4%,transparent);--gv-pop:#ffffff;
--gv-lane-0:#1565c0;--gv-lane-1:#c62828;--gv-lane-2:#2e7d32;--gv-lane-3:#6a1b9a;--gv-lane-4:#00838f;--gv-lane-5:#e65100;--gv-lane-6:#4527a0;--gv-lane-7:#558b2f;
--gv-lane-8:#ad1457;--gv-lane-9:#0277bd;--gv-lane-10:#ef6c00;--gv-lane-11:#00695c`;
const DARK = `--gv-fg:var(--dsw-alias-label-primary,#d1d9e0);--gv-muted:var(--dsw-alias-label-secondary,#9198a1);--gv-accent:var(--dsw-alias-state-business-primary,#58a6ff);
--gv-ok:#3fb950;--gv-danger:#f85149;--gv-warn:#d4a72c;--gv-pop:#1f2328;
--gv-lane-0:#58a6ff;--gv-lane-1:#ff7b72;--gv-lane-2:#3fb950;--gv-lane-3:#bc8cff;--gv-lane-4:#39c5cf;--gv-lane-5:#f0883e;--gv-lane-6:#a371f7;--gv-lane-7:#7ee787;
--gv-lane-8:#ffa198;--gv-lane-9:#76e3ea;--gv-lane-10:#e3b341;--gv-lane-11:#56d364`;
const THEMED = '.gv,.gv-chip,.gv-menu,.gv-diff';
export const styles = `
${THEMED}{${LIGHT};--gv-border:color-mix(in srgb,currentColor 14%,transparent);--gv-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))}
body[data-ds-dark-theme] :is(${THEMED}){${DARK}}
@media(prefers-color-scheme:dark){body:not([data-ds-theme-source]) :is(${THEMED}){${DARK}}}
.gv,.gv-diff{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;color:var(--gv-fg);font-size:13px}
.gv *,.gv-diff *,.gv-chip *,.gv-menu *{box-sizing:border-box}
.gv-icon{display:inline-block;flex:none;vertical-align:-2px}
.gv-head{display:flex;align-items:center;gap:6px;flex:none;min-height:35px;padding:0 6px 0 12px;border-bottom:1px solid var(--gv-border);font-weight:600}
.gv-head .gv-repo{color:var(--gv-muted);font-weight:400;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gv-host{display:inline-flex;align-items:center;gap:4px;max-width:45%;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:500;color:var(--gv-accent);background:color-mix(in srgb,var(--gv-accent) 12%,transparent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gv-spacer{flex:1}
.gv-tool{display:inline-grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.gv-tool:hover:enabled,.gv-tool[aria-pressed=true]{background:var(--gv-hover);color:var(--gv-fg)}
.gv-tool:disabled{opacity:.4;cursor:default}
.gv-tool[data-tone=warn]{color:var(--gv-danger)}
:is(.gv,.gv-diff,.gv-chip) button:focus-visible{outline:2px solid var(--gv-accent);outline-offset:-2px}
@keyframes gv-spin{to{transform:rotate(360deg)}}
@keyframes gv-slide{0%{left:-40%;width:40%}50%{width:60%}100%{left:100%;width:40%}}
.gv-spinner{display:inline-block;width:11px;height:11px;flex:none;border-radius:50%;border:1.5px solid currentColor;border-top-color:transparent;animation:gv-spin .7s linear infinite;vertical-align:-1px}
.gv-progress{position:relative;flex:none;height:2px;overflow:hidden;background:color-mix(in srgb,var(--gv-accent) 18%,transparent)}
.gv-progress::before{content:'';position:absolute;top:0;bottom:0;background:var(--gv-accent);animation:gv-slide 1.15s ease-in-out infinite}
.gv-btn{display:inline-flex;align-items:center;gap:4px;flex:none;border:1px solid var(--gv-border);background:transparent;color:inherit;border-radius:5px;padding:2px 8px;font:inherit;font-size:11.5px;line-height:18px;cursor:pointer;white-space:nowrap}
.gv-btn:hover:enabled{background:var(--gv-hover)}
.gv-btn:disabled{opacity:.5;cursor:default}
.gv-btn[data-tone=danger]{color:var(--gv-danger)}
.gv-input{flex:1;min-width:0;padding:4px 8px;font:inherit;font-size:12px;color:inherit;background:var(--gv-panel);border:1px solid var(--gv-border);border-radius:6px;outline:none}
.gv-input:focus{border-color:var(--gv-accent)}
.gv-tabs{display:flex;flex:none;border-bottom:1px solid var(--gv-border)}
.gv-tabs button{flex:1;padding:6px 0;border:0;border-bottom:2px solid transparent;background:none;color:var(--gv-muted);font:inherit;cursor:pointer}
.gv-tabs button[aria-selected=true]{color:var(--gv-accent);border-bottom-color:var(--gv-accent);font-weight:600}
.gv-write{display:flex;flex-direction:column;gap:6px;flex:none;padding:6px 8px;border-bottom:1px solid var(--gv-border);max-height:55%;overflow:auto}
.gv-row{display:flex;gap:6px;align-items:center}
.gv-status-line{flex:1;min-width:0;font-size:11px;color:var(--gv-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gv-changes{display:flex;flex-direction:column;gap:6px;padding-top:6px;border-top:1px solid var(--gv-border)}
.gv-changes-head{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;color:var(--gv-muted)}
.gv-banner{display:flex;align-items:center;gap:5px;padding:4px 8px;border-radius:6px;font-size:11px;font-weight:600;color:var(--gv-warn);background:color-mix(in srgb,#d29922 15%,transparent);border:1px solid color-mix(in srgb,#d29922 40%,transparent)}
.gv-group-head{padding:2px 4px;font-size:10.5px;font-weight:600;color:var(--gv-muted)}
.gv-group-head[data-tone=danger]{color:var(--gv-danger)}
.gv-list{display:flex;flex-direction:column;gap:1px;max-height:160px;overflow-y:auto}
.gv-change{display:flex;align-items:center;gap:4px;min-width:0;padding:2px 4px 2px 6px;border-radius:5px;font-size:11.5px;cursor:pointer}
.gv-change:hover,.gv-change:focus-within{background:var(--gv-hover)}
.gv-code{flex:none;width:20px;font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10.5px;font-weight:600;color:var(--gv-ok);white-space:pre}
.gv-code[data-conflict]{color:var(--gv-danger)}
.gv-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.gv-act{display:inline-grid;place-items:center;flex:none;width:22px;height:20px;padding:0;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--gv-muted);cursor:pointer;opacity:0}
.gv-change:hover .gv-act,.gv-change:focus-within .gv-act,.gv-act:focus-visible{opacity:1}
.gv-act:hover{color:var(--gv-fg);background:var(--gv-panel);border-color:var(--gv-border)}
.gv-act[data-tone=danger]:hover{color:var(--gv-danger)}
.gv-inline-diff{border:1px solid var(--gv-border);border-radius:6px;overflow:hidden}
.gv-inline-diff-head{display:flex;align-items:center;gap:6px;padding:3px 6px;background:var(--gv-panel);font-size:11px}
.gv-inline-diff-head span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gv-lines{max-height:240px;overflow:auto;padding:4px 0;font:11px/1.5 var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}
.gv-line{display:flex;gap:8px;padding:0 6px;white-space:pre-wrap;word-break:break-all}
.gv-line>span:first-child{flex:none;width:30px;text-align:right;color:var(--gv-muted);opacity:.65;user-select:none}
.gv-line[data-kind=add]{background:color-mix(in srgb,#2ea043 15%,transparent);color:var(--gv-ok)}
.gv-line[data-kind=del]{background:color-mix(in srgb,#f85149 15%,transparent);color:var(--gv-danger)}
.gv-line[data-kind=hunk]{background:color-mix(in srgb,#388bfd 15%,transparent);color:var(--gv-accent);font-weight:600}
.gv-body{flex:1;min-height:0;overflow:auto;padding:4px 0}
.gv-empty{padding:20px 12px;text-align:center;color:var(--gv-muted)}
.gv-warn{padding:24px 16px;text-align:center;color:var(--gv-warn);font-size:12px;line-height:1.7}
.gv-notice{margin:6px 8px;padding:6px 8px;border-radius:5px;font-size:11.5px;white-space:pre-wrap;word-break:break-word;background:var(--gv-panel);border:1px solid var(--gv-border)}
.gv-notice[data-tone=ok]{border-color:color-mix(in srgb,var(--gv-ok) 55%,transparent);color:var(--gv-ok)}
.gv-notice[data-tone=error]{border-color:color-mix(in srgb,var(--gv-danger) 55%,transparent);color:var(--gv-danger)}
.gv-notice-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.gv-notice-row>span{display:inline-flex;align-items:center;gap:6px;min-width:0}
.gv-auth{display:flex;flex-direction:column;gap:6px;margin-top:6px;padding:8px;border-radius:6px;background:color-mix(in srgb,currentColor 7%,transparent);color:var(--gv-fg)}
.gv-auth b{display:flex;align-items:center;gap:5px;font-size:11.5px}
.gv-auth p{margin:0;font-size:11.5px;line-height:1.5}
.gv-search{display:block;width:calc(100% - 16px);margin:4px 8px}
.gv-section{padding:8px 12px 4px;color:var(--gv-muted);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.gv-branch{display:flex;flex-direction:column;gap:2px;margin:1px 4px;padding:5px 8px;border-radius:6px;cursor:pointer;user-select:none}
.gv-branch:hover,.gv-branch:focus-visible{background:var(--gv-hover);outline:none}
.gv-branch-top,.gv-branch-bottom{display:flex;align-items:center;gap:6px;min-width:0}
.gv-branch-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:12.5px}
.gv-branch-bottom{font-size:11px;color:var(--gv-muted)}
.gv-branch-bottom span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gv-branch-bottom span:last-child{flex:none;font-variant-numeric:tabular-nums}
.gv-badge{display:inline-flex;align-items:center;gap:1px;padding:0 6px;border:0;border-radius:8px;font:inherit;font-size:11px;line-height:17px;color:var(--gv-muted);background:var(--gv-panel);white-space:nowrap}
.gv-badge[data-kind=current]{color:#fff;background:var(--gv-ok)}
.gv-badge[data-kind=ahead]{color:var(--gv-ok)}
.gv-badge[data-kind=behind]{color:var(--gv-accent)}
button.gv-badge{cursor:pointer}button.gv-badge:hover:enabled{background:var(--gv-hover)}
.gv-menu{position:fixed;z-index:951;min-width:180px;padding:4px;border:1px solid var(--gv-border);border-radius:8px;background:var(--gv-pop);color:var(--gv-fg);box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px}
.gv-menu-backdrop{position:fixed;inset:0;z-index:950}
.gv-menu [role=menuitem]{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;text-align:left;white-space:nowrap;cursor:pointer}
.gv-menu [role=menuitem]:hover:enabled,.gv-menu [role=menuitem]:focus-visible{background:var(--gv-hover);outline:none}
.gv-menu [role=menuitem]:disabled{opacity:.45;cursor:default}
.gv-menu [role=menuitem][data-tone=danger]{color:var(--gv-danger)}
.gv-menu-title{padding:4px 10px 8px;color:var(--gv-muted);font-size:11px;word-break:break-all}
.gv-menu-actions{display:flex;gap:6px;padding:2px}
.gv-menu-actions .gv-btn{flex:1;justify-content:center}
.gv-menu .gv-input{display:block;width:100%;margin-bottom:6px}
.gv-graph{position:relative;width:max-content;padding:0 8px}
.gv-graph-head{position:relative;height:28px;font-size:12px;font-weight:600;color:var(--gv-muted);user-select:none}
.gv-graph-head>span{position:absolute;top:8px}
.gv-resize{position:absolute;top:0;height:28px;width:6px;cursor:col-resize;touch-action:none;z-index:5}
.gv-resize::after{content:'';position:absolute;left:2.5px;top:6px;bottom:6px;width:1px;background:var(--gv-border)}
.gv-resize:hover::after{background:var(--gv-accent)}
.gv-graph svg{display:block}
.gv-graph svg g{cursor:pointer}
.gv-detail{position:sticky;bottom:0;left:0;padding:6px 10px;border-top:1px solid var(--gv-border);background:var(--gv-pop);font-size:11.5px;max-width:100%}
.gv-detail p{margin:0 0 2px;word-break:break-word}
.gv-detail .gv-row{margin-top:6px}
.gv-tip{position:fixed;z-index:9999;pointer-events:none;padding:3px 8px;border-radius:6px;font-size:11px;line-height:16px;white-space:nowrap;color:#fff;background:rgba(28,32,38,.96);box-shadow:0 4px 14px rgba(0,0,0,.28)}
.gv-chip{position:relative;display:flex;width:100%;max-width:var(--dsh-composer-card-max-width,800px);margin:0 auto}
.gv-chip>button{display:inline-flex;align-items:center;gap:5px;max-width:240px;padding:3px 10px;border:1px solid var(--gv-border);border-radius:999px;background:var(--dsw-alias-bg-primary,transparent);color:var(--gv-fg);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.gv-chip>button:hover:enabled{background:var(--gv-hover)}
.gv-chip>button:disabled{opacity:.65;cursor:default}
.gv-chip>button>span{overflow:hidden;text-overflow:ellipsis}
.gv-chip-pop{position:absolute;left:0;z-index:901;min-width:240px;max-width:320px;max-height:340px;overflow:auto;padding:4px;border:1px solid var(--gv-border);border-radius:8px;background:var(--gv-pop);box-shadow:0 8px 24px rgba(0,0,0,.18)}
.gv-chip-pop>div{padding:4px 8px;font-size:11px;font-weight:600;color:var(--gv-muted)}
.gv-chip-pop [role=option]{display:flex;align-items:center;gap:6px;width:100%;padding:5px 8px;border:0;border-radius:6px;background:none;color:var(--gv-fg);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.gv-chip-pop [role=option]:hover,.gv-chip-pop [role=option]:focus-visible{background:var(--gv-hover);outline:none}
.gv-chip-pop [role=option][aria-selected=true]{font-weight:600}
.gv-chip-pop [role=option]>span:nth-child(1){width:14px;flex:none;color:var(--gv-accent)}
.gv-chip-pop [role=option]>span:nth-child(2){flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gv-chip-pop [role=option]>span:nth-child(3){color:var(--gv-muted);font-size:11px}
.gv-chip-pop p{margin:0;padding:6px 8px;font-size:11px;color:var(--gv-muted)}
.gv-chip-pop p[role=alert]{color:var(--gv-danger)}
.gv-diff-head{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;flex:none;min-height:35px;padding:3px 6px 3px 12px;border-bottom:1px solid var(--gv-border)}
.gv-diff-id{display:flex;align-items:center;gap:6px;flex:1 1 200px;min-width:0}
.gv-diff-name{font-weight:600;white-space:nowrap}
.gv-letter{font-weight:700;font-size:11px}
.gv-tag{padding:0 5px;border-radius:4px;font-size:10.5px;color:var(--gv-ok);background:color-mix(in srgb,var(--gv-ok) 14%,transparent)}
.gv-diff-path{min-width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;font-size:11.5px;color:var(--gv-muted);font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}
.gv-stat{flex:none;font-size:11.5px;font-variant-numeric:tabular-nums;font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}
.gv-stat b{font-weight:600;color:var(--gv-ok)}.gv-stat i{font-style:normal;font-weight:600;color:var(--gv-danger);margin-left:4px}
.gv-diff-tools{display:flex;align-items:center;gap:2px;flex:none;margin-left:auto}
.gv-sep{width:1px;height:16px;margin:0 4px;background:var(--gv-border)}
.gv-size{min-width:22px;text-align:center;font-size:11px;color:var(--gv-muted);font-variant-numeric:tabular-nums}
.gv-notes{display:flex;flex-wrap:wrap;gap:6px;flex:none;padding:6px 12px 0}
.gv-note{padding:3px 8px;border-radius:5px;font-size:11.5px;background:var(--gv-panel)}
.gv-note[data-tone=error]{color:var(--gv-danger);background:color-mix(in srgb,#e5484d 14%,transparent)}
.gv-note[data-tone=ok]{color:var(--gv-ok)}
.gv-note button{margin-left:6px}
.gv-diff-body{flex:1;min-height:0;display:flex;flex-direction:column}
.gv-diff-body>.fv-code{flex:1;min-height:0}
.gv-conflicts{flex:1;min-height:0;overflow:auto;font-size:12px}
.gv-hint{display:flex;align-items:center;gap:6px;padding:8px 12px;color:var(--gv-fg);background:color-mix(in srgb,#d29922 12%,transparent);border-bottom:1px solid color-mix(in srgb,#d29922 25%,transparent)}
.gv-source{margin:0;padding:0 12px;font:12px/1.55 var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}
.gv-source>div{display:flex;gap:10px;white-space:pre-wrap;word-break:break-word}
.gv-source>div>span:first-child{flex:none;width:38px;text-align:right;color:var(--gv-muted);opacity:.65;user-select:none}
.gv-gap{display:block;width:calc(100% - 24px);margin:4px 12px;padding:5px 12px;border:0;border-radius:4px;background:color-mix(in srgb,currentColor 7%,transparent);color:var(--gv-muted);font:inherit;font-size:11px;text-align:center;cursor:pointer}
.gv-gap:hover{background:var(--gv-hover)}
.gv-block{margin:8px 12px;border:1px solid var(--gv-danger);border-radius:6px;overflow:hidden;background:color-mix(in srgb,#ef4444 4%,transparent)}
.gv-block-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:6px 10px;font-size:11.5px;background:color-mix(in srgb,#ef4444 12%,transparent);border-bottom:1px solid color-mix(in srgb,#ef4444 20%,transparent)}
.gv-block-head>b{display:inline-flex;align-items:center;gap:5px;flex:1;min-width:160px;color:var(--gv-danger)}
.gv-sides{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--gv-border)}
.gv-sides>div{min-width:0;padding:8px 10px}
.gv-sides>div:first-child{background:color-mix(in srgb,#3b82f6 8%,var(--gv-pop))}
.gv-sides>div:last-child{background:color-mix(in srgb,#22c55e 8%,var(--gv-pop))}
.gv-sides small{display:block;margin-bottom:4px;font-size:10.5px;font-weight:600;color:var(--gv-accent)}
.gv-sides>div:last-child small{color:var(--gv-ok)}
.gv-sides pre{margin:0;font:12px/1.5 var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);white-space:pre-wrap;word-break:break-word}
.gv-resolved{display:flex;align-items:center;justify-content:center;gap:6px;padding:28px 16px;color:var(--gv-ok);text-align:center}
.gv-deco{flex:none;margin-left:5px;font-size:10.5px;font-weight:700;opacity:.95}
.gv-deco[data-letter="•"]{font-size:13px;line-height:1;opacity:.8}
`;
