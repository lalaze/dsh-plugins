export const styles = `
.ga-root{--ga-line:color-mix(in srgb,currentColor 13%,transparent);--ga-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 9%,transparent));--ga-accent:var(--dsw-alias-state-business-primary,#3b82f6);--ga-surface:var(--dsw-alias-bg-layer-1,Canvas);--ga-used:#2f9e62;--ga-maybe:#d29a1c;--ga-unused:#d9534f;--ga-retired:#8b8f98;--ga-mono:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);
  position:relative;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;overflow:hidden;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:1.4}
.ga-root *{box-sizing:border-box}
.ga-root button,.ga-root input,.ga-root select{font:inherit}
.ga-root :focus-visible{outline:2px solid var(--ga-accent);outline-offset:-2px}
.ga-dim{opacity:.65}
.ga-note{margin:auto;padding:24px;max-width:460px;text-align:center;opacity:.7}
.ga-count{margin-left:5px;font-size:11px;opacity:.6;font-variant-numeric:tabular-nums}
.ga-dot{display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.9}
[data-usage=used]>.ga-dot,[data-usage=used] .ga-meta>.ga-dot,i[data-usage=used]{background:var(--ga-used)}
[data-usage=maybe]>.ga-dot,[data-usage=maybe] .ga-meta>.ga-dot,i[data-usage=maybe]{background:var(--ga-maybe)}
[data-usage=unused]>.ga-dot,[data-usage=unused] .ga-meta>.ga-dot,i[data-usage=unused]{background:var(--ga-unused)}
[data-usage=retired]>.ga-dot,[data-usage=retired] .ga-meta>.ga-dot{background:var(--ga-retired)}
.ga-tag{flex:none;padding:0 5px;border-radius:8px;background:color-mix(in srgb,currentColor 13%,transparent);font-size:10px;font-weight:500;line-height:16px;white-space:nowrap}
.ga-tag[data-tone=warn]{background:color-mix(in srgb,var(--ga-maybe) 28%,transparent)}
.ga-tag[data-tone=tag]{overflow:hidden;text-overflow:ellipsis;background:color-mix(in srgb,var(--ga-accent) 20%,transparent)}
.ga-tag button{margin-left:3px;padding:0;border:0;background:none;color:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.7}
.ga-tag button:hover{opacity:1}
.ga-taglist{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin:6px 0}
.ga-taglist .ga-tag{line-height:20px;font-size:11px}
.ga-tag-add{border:0;color:inherit;cursor:pointer}
.ga-tag-add:hover:enabled{background:color-mix(in srgb,currentColor 22%,transparent)}
.ga-tag-input{flex:1 1 80px;min-width:70px;height:22px;padding:0 2px;border:0;border-bottom:1px solid var(--ga-line);background:transparent;color:inherit;font-size:12px}
.ga-tag-form{display:flex;gap:6px}
.ga-tag-form .ga-search{max-width:none}
.ga-textarea{display:block;width:100%;margin-top:6px;padding:6px 8px;border:1px solid var(--ga-line);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1.5;resize:vertical}
.ga-field{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12px;white-space:nowrap}
.ga-field .ga-search{max-width:none;font-family:var(--ga-mono)}
.ga-selbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:none;padding:6px 10px;border-bottom:1px solid var(--ga-line);background:color-mix(in srgb,var(--ga-accent) 12%,transparent)}
.ga-selbar .ga-tools{gap:6px}

.ga-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:none;padding:8px 10px;border-bottom:1px solid var(--ga-line)}
.ga-seg{display:inline-flex;flex:none;border:1px solid var(--ga-line);border-radius:7px;overflow:hidden}
.ga-seg button{height:26px;padding:0 10px;border:0;background:transparent;color:inherit;cursor:pointer;opacity:.75}
.ga-seg button[aria-selected=true]{background:var(--ga-hover);opacity:1;font-weight:600}
.ga-search{flex:1 1 150px;min-width:110px;max-width:300px;height:28px;padding:0 8px;border:1px solid var(--ga-line);border-radius:6px;background:transparent;color:inherit}
.ga-chips{display:flex;flex-wrap:wrap;gap:4px}
.ga-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:1px solid var(--ga-line);border-radius:13px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap}
.ga-chip:hover{background:var(--ga-hover)}
.ga-chip[aria-pressed=true]{border-color:color-mix(in srgb,currentColor 45%,transparent);background:color-mix(in srgb,currentColor 12%,transparent);font-weight:600}
.ga-chip .ga-count{margin-left:0}
.ga-tools{display:flex;align-items:center;gap:2px;flex:none;margin-left:auto}
.ga-select{height:28px;max-width:150px;margin-right:4px;padding:0 4px;border:1px solid var(--ga-line);border-radius:6px;background:transparent;color:inherit;font-size:12px}
.ga-tool{display:inline-grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:16px;line-height:1}
.ga-tool:hover:enabled,.ga-tool[aria-pressed=true]{background:var(--ga-hover)}
.ga-tool:disabled{opacity:.4;cursor:default}
.ga-button{height:26px;padding:0 10px;border:1px solid var(--ga-line);border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:12px;white-space:nowrap}
.ga-button:hover:enabled{background:var(--ga-hover)}
.ga-button:disabled{opacity:.5;cursor:default}
.ga-button[data-primary]{border-color:transparent;background:var(--ga-accent);color:var(--dsw-alias-label-on-color,#fff)}
.ga-banner{flex:none;margin:8px 10px 0;padding:7px 10px;border-radius:6px;font-size:12px;line-height:1.5}
.ga-banner[data-tone=warn]{background:color-mix(in srgb,#f5b400 16%,transparent)}
.ga-banner[data-tone=error]{background:color-mix(in srgb,#e5484d 16%,transparent)}

.ga-main{position:relative;display:flex;flex:1;min-height:0}
.ga-tree{flex:none;width:232px;padding:6px 0;overflow:auto;border-right:1px solid var(--ga-line)}
.ga-tree ul{margin:0;padding:0;list-style:none}
.ga-tree-row{display:flex;align-items:center;gap:2px;height:26px;padding-right:8px}
.ga-tree-row:hover{background:var(--ga-hover)}
.ga-tree-row[data-selected]{background:color-mix(in srgb,var(--ga-accent) 16%,transparent)}
.ga-caret{display:inline-grid;place-items:center;flex:none;width:16px;height:20px;padding:0;border:0;background:none;color:inherit;font-size:10px;opacity:.6;cursor:pointer}
.ga-caret[data-open]{transform:rotate(90deg)}
.ga-tree-label{flex:1;min-width:0;padding:0;border:0;background:none;color:inherit;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}

.ga-grid{position:relative;display:flex;flex:1;min-width:0;overflow-x:hidden;overflow-y:auto;outline:none}
.ga-rows{position:relative;flex:1;min-width:0}
.ga-row{position:absolute;left:8px;right:8px;display:grid}
.ga-cell{position:relative;display:flex;flex-direction:column;gap:2px;min-width:0;margin:2px;padding:6px;border:1px solid transparent;border-radius:8px;background:none;color:inherit;text-align:left;cursor:pointer}
.ga-check{position:absolute;top:9px;left:9px;z-index:1;width:16px;height:16px;margin:0;opacity:0;cursor:pointer}
.ga-cell:hover .ga-check,.ga-check:checked,.ga-check:focus-visible,.ga-rows[data-picking] .ga-check{opacity:1}
@media (hover:none){.ga-check{opacity:.85}}
.ga-cell[data-checked]{background:color-mix(in srgb,var(--ga-accent) 10%,transparent)}
.ga-cell[data-usage=retired] .ga-thumb img{opacity:.7}
.ga-cell:hover{background:var(--ga-hover)}
.ga-cell[aria-selected=true]{border-color:var(--ga-accent);background:color-mix(in srgb,var(--ga-accent) 13%,transparent)}
.ga-thumb,.ga-preview,.ga-twin-thumb{display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:6px;background:repeating-conic-gradient(color-mix(in srgb,currentColor 8%,transparent) 0 25%,transparent 0 50%) 0 0/16px 16px}
.ga-thumb img,.ga-preview img,.ga-twin-thumb img{flex:none;max-width:100%;max-height:100%;object-fit:contain}
.ga-root img[data-crisp]{image-rendering:pixelated}
.ga-ph{font-size:10px;letter-spacing:.04em;opacity:.45}
.ga-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.ga-meta{display:flex;align-items:center;gap:5px;overflow:hidden;font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit)}

.ga-detail{display:flex;flex-direction:column;flex:none;width:320px;min-height:0;border-left:1px solid var(--ga-line);background:var(--ga-surface)}
.ga-detail-head{display:flex;align-items:center;gap:6px;flex:none;min-height:36px;padding:0 4px 0 12px;border-bottom:1px solid var(--ga-line)}
.ga-detail-head strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ga-detail-body{flex:1;min-height:0;padding:12px;overflow:auto}
.ga-detail-body p{margin:8px 0}
.ga-detail-body h4{margin:16px 0 6px;font-size:12px;font-weight:600}
.ga-preview{height:272px;padding:8px}
.ga-facts{font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}
.ga-path code,.ga-refs code,.ga-link,.ga-twin-path,.ga-status-folder,.ga-vlabel,.ga-family h3,.ga-fname{font-family:var(--ga-mono)}
.ga-path code{font-size:11.5px;word-break:break-all}
.ga-actions{display:flex;flex-wrap:wrap;gap:6px}
.ga-actions.ga-end{justify-content:flex-end;margin:14px 0 0}
.ga-actions .ga-start{margin-right:auto}
.ga-verdict{font-size:12px;line-height:1.5}
.ga-verdict .ga-dot,.ga-verdict .ga-tag{margin-right:6px}
.ga-refs,.ga-twins{display:grid;gap:8px;margin:0;padding:0;list-style:none}
.ga-refs li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 6px;align-items:baseline}
.ga-link{min-width:0;padding:0;border:0;background:none;color:var(--ga-accent);font-size:11.5px;text-align:left;word-break:break-all;cursor:pointer}
.ga-link:disabled{color:inherit;cursor:default}
.ga-kind{font-size:10px;opacity:.7;white-space:nowrap}
.ga-kind[data-kind=path]{color:var(--ga-used);opacity:1}
.ga-refs code{display:-webkit-box;grid-column:1/-1;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:3;word-break:break-all;font-size:11px;line-height:1.45;opacity:.7}
.ga-twins{gap:2px}
.ga-twin{display:grid;grid-template-columns:36px minmax(0,1fr);column-gap:8px;width:100%;padding:4px;border:0;border-radius:6px;background:none;color:inherit;text-align:left;cursor:pointer}
.ga-twin:hover{background:var(--ga-hover)}
.ga-twin-thumb{grid-row:1/3;width:36px;height:36px;border-radius:4px}
.ga-twin-path{font-size:11px;word-break:break-all}

.ga-versions{flex:1;min-width:0;padding:12px 16px;overflow:auto}
.ga-versions>p{margin:0 0 14px;max-width:720px}
.ga-family{margin:0 0 20px}
.ga-family h3{margin:0 0 4px;font-size:13px;font-weight:600}
.ga-vrow{display:grid;grid-template-columns:minmax(150px,1.5fr) 56px minmax(90px,2fr) 56px 60px 84px 76px auto;align-items:center;gap:8px;min-height:32px;padding:3px 6px;border-top:1px solid var(--ga-line);font-variant-numeric:tabular-nums}
.ga-vrow[data-dead]>span:not(:first-child):not(:last-child){opacity:.55}
.ga-vhead{min-height:24px;border-top:0;font-size:11px;opacity:.65}
.ga-vlabel{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.ga-vactions{display:flex;gap:4px;justify-content:flex-end}
.ga-usage-bar{display:flex;gap:1px;height:8px;overflow:hidden;border-radius:4px;background:color-mix(in srgb,currentColor 8%,transparent)}
.ga-usage-bar i{display:block;min-width:2px}

.ga-overlay{position:absolute;inset:0;z-index:6;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.38)}
.ga-dialog{width:min(520px,100%);max-height:100%;padding:16px;overflow:auto;border:1px solid var(--ga-line);border-radius:10px;background:var(--ga-surface);box-shadow:0 12px 40px rgba(0,0,0,.25)}
.ga-dialog h3{margin:0 0 6px;font-size:14px}
.ga-dialog>p{margin:0 0 10px;font-size:12px;line-height:1.5}
.ga-dialog>.ga-banner{margin:0 0 10px}
.ga-frow{display:grid;grid-template-columns:minmax(0,1fr) 96px 96px;align-items:center;gap:8px;min-height:30px;padding:2px 4px;border-top:1px solid var(--ga-line)}
.ga-frow label{display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.ga-fname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}

.ga-settings{height:auto;overflow:visible;gap:10px}
.ga-settings>p,.ga-settings h4{margin:0}
.ga-modes{display:flex;flex-wrap:wrap;gap:6px 18px}
.ga-modes label{display:flex;align-items:center;gap:6px;cursor:pointer}
.ga-wrow{grid-template-columns:minmax(0,1fr) auto 132px;min-height:40px}
.ga-wname{display:flex;flex-direction:column;min-width:0}
.ga-wname>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ga-wrow .ga-dot{background:color-mix(in srgb,currentColor 35%,transparent)}
.ga-wrow .ga-dot[data-on]{background:var(--ga-used)}
.ga-wrow .ga-select{max-width:none;margin:0}
.ga-note p{margin:0 0 10px}

.ga-seg button[aria-checked=true]{background:var(--ga-hover);opacity:1;font-weight:600}
.ga-seg button:disabled{cursor:default}
.ga-button[data-danger]{border-color:transparent;background:var(--ga-unused);color:#fff}
.ga-dialog.ga-gen{width:min(720px,100%)}
.ga-gen .ga-field:first-of-type{margin-top:4px}
.ga-grow{flex:1;max-width:none;margin:0}
.ga-wrap{flex-wrap:wrap;white-space:normal}
.ga-wrap .ga-tools{gap:8px}
.ga-check-label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.ga-refpics{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.ga-refpic{display:inline-flex;align-items:center;gap:6px;max-width:220px;padding:3px 2px 3px 3px;border:1px solid var(--ga-line);border-radius:7px}
.ga-refpic .ga-twin-thumb{flex:none;width:36px;height:36px}
.ga-refpic .ga-twin-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ga-refpic .ga-tool{width:22px;height:22px;font-size:14px}
.ga-compare{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:12px 0 0}
.ga-compare figure{margin:0;min-width:0}
.ga-compare .ga-preview{height:clamp(140px,26vh,236px)}
.ga-compare figcaption{margin-top:4px;font-size:11.5px;text-align:center;color:var(--dsw-alias-label-secondary,inherit);font-variant-numeric:tabular-nums}
.ga-gen>.ga-dim{margin:8px 0 0;font-size:11.5px;line-height:1.5}
.ga-gen>.ga-actions.ga-end{position:sticky;bottom:-16px;z-index:1;margin:12px -16px -16px;padding:10px 16px;border-top:1px solid var(--ga-line);background:var(--ga-surface)}
.ga-sources{display:flex;flex-direction:column;gap:8px;margin:10px 0}
.ga-sources>p{margin:0}
.ga-srow{grid-template-columns:minmax(0,1fr) auto;min-height:44px}
.ga-srow .ga-actions{justify-content:flex-end}
.ga-default{margin-left:6px;vertical-align:1px}
.ga-sform{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--ga-line);border-radius:8px}
.ga-sform>p{margin:0;font-size:11.5px;line-height:1.5}
.ga-sform .ga-actions.ga-end{margin:4px 0 0}
.ga-sfield{display:grid;grid-template-columns:72px minmax(0,1fr);align-items:center;gap:8px;font-size:12px}
.ga-sfield .ga-search{max-width:none}

.ga-status{display:flex;gap:12px;flex:none;padding:5px 12px;border-top:1px solid var(--ga-line);font-size:11.5px;white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit)}
.ga-status>span{overflow:hidden;text-overflow:ellipsis}
.ga-status>span:first-child{flex:none}
.ga-status-end{min-width:0;margin-left:auto}

.ga-root[data-narrow] .ga-tree{position:absolute;inset:0 auto 0 0;z-index:3;width:min(280px,84%);background:var(--ga-surface);box-shadow:8px 0 24px rgba(0,0,0,.18)}
.ga-root[data-narrow] .ga-detail{position:absolute;inset:auto 0 0 0;z-index:4;width:auto;height:68%;border-left:0;border-top:1px solid var(--ga-line);box-shadow:0 -8px 24px rgba(0,0,0,.18)}
.ga-root[data-narrow] .ga-preview{height:176px}
.ga-root[data-narrow] .ga-search{max-width:none}
.ga-root[data-narrow] .ga-chips{flex-wrap:nowrap;max-width:100%;overflow-x:auto;scrollbar-width:none}
.ga-root[data-narrow] .ga-chip{flex:none}
.ga-root[data-narrow] .ga-vrow{grid-template-columns:minmax(0,1fr) 36px 36px 36px 36px auto}
.ga-root[data-narrow] .ga-vactions{flex-direction:column}
.ga-root[data-narrow] .ga-vrow>:nth-child(3),.ga-root[data-narrow] .ga-vrow>:nth-child(7){display:none}
.ga-root[data-narrow] .ga-status-end{display:none}
`;
