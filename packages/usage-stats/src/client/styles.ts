export const styles = `
.dsh-usage{--us-accent:#0b9f83;--us-purple:#8b78e6;--us-amber:#d9822b;--us-muted:color-mix(in srgb,currentColor 55%,transparent);--us-line:color-mix(in srgb,currentColor 11%,transparent);--us-surface:color-mix(in srgb,currentColor 2.5%,transparent);box-sizing:border-box;width:100%;max-width:1280px;margin:0 auto;padding:28px;display:grid;gap:24px;font-size:13px;line-height:1.5;container-type:inline-size}
.dsh-usage *{box-sizing:border-box}
.dsh-usage button,.dsh-usage input,.dsh-usage select{font:inherit;color:inherit}
.dsh-usage button{cursor:pointer}
.dsh-usage button:disabled{cursor:default;opacity:.5}
.dsh-usage button:focus-visible,.dsh-usage input:focus-visible,.dsh-usage select:focus-visible,.us-scroll:focus-visible{outline:2px solid var(--us-accent);outline-offset:3px}
.dsh-usage h2,.dsh-usage h3,.dsh-usage p{margin:0}
.dsh-usage h2{font-size:24px;font-weight:650;letter-spacing:-.6px}
.dsh-usage h3{font-size:14px;font-weight:600}
.us-muted{color:var(--us-muted)}
.us-number{font-variant-numeric:tabular-nums}
.us-top,.us-toolbar,.us-panel-head,.us-details-head{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.us-title{display:flex;gap:12px;align-items:center}
.us-logo{width:44px;height:44px;flex-shrink:0;display:grid;place-items:center;background:color-mix(in srgb,var(--us-accent) 7%,transparent);color:var(--us-accent);border:1px solid color-mix(in srgb,var(--us-accent) 18%,transparent);border-radius:13px}
.us-subtitle{margin-top:3px!important;color:var(--us-muted);font-size:12px}
.us-actions{display:flex;gap:8px;align-items:center}
.us-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--us-muted);margin-right:5px}
.us-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--us-accent);flex-shrink:0}
.us-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:transparent;border:1px solid var(--us-line);padding:7px 11px;border-radius:7px;white-space:nowrap;min-height:34px}
.us-button:hover{background:var(--us-surface)}
.us-button.us-primary{background:var(--us-accent);color:white;border-color:var(--us-accent)}
.us-tabs{display:flex;gap:20px;align-items:center;border-bottom:1px solid var(--us-line);min-height:41px;overflow-x:auto}
.us-tab{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--us-muted)!important;padding:0 1px 13px;display:flex;align-items:center;gap:7px;white-space:nowrap}
.us-tab[aria-pressed=true]{color:inherit!important;border-bottom-color:var(--us-accent);font-weight:600}
.us-segment{display:inline-flex;padding:3px;gap:2px;background:var(--us-surface);border:1px solid var(--us-line);border-radius:8px}
.us-segment button{border:0;background:transparent;padding:5px 10px;white-space:nowrap;border-radius:5px;color:var(--us-muted)}
.us-segment button[aria-pressed=true]{background:color-mix(in srgb,currentColor 8%,transparent);color:inherit}
.us-toolbar{gap:10px}
.us-period{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.us-filters{border:1px solid var(--us-line);border-radius:10px;padding:12px 16px;background:var(--us-surface)}
.us-filters summary{cursor:pointer;color:var(--us-muted);font-size:12px}
.us-filter-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}
.us-field{display:grid;gap:5px;color:var(--us-muted);font-size:11px}
.us-field input,.us-field select{width:100%;min-width:0;padding:8px 10px;border:1px solid var(--us-line);border-radius:6px;background:transparent;color:inherit;font-size:12px}
.us-field option{background:Canvas;color:CanvasText}
.us-custom-dates{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.us-custom-dates input{max-width:145px}
.us-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--us-line);border-radius:12px;background:var(--us-surface);overflow:hidden}
.us-metric{padding:20px 22px;min-width:0}
.us-metric+.us-metric{border-left:1px solid var(--us-line)}
.us-metric-label{display:flex;justify-content:space-between;gap:10px;color:var(--us-muted);font-size:12px}
.us-metric strong{display:block;font-size:31px;letter-spacing:-1px;font-weight:620;line-height:1.4;margin:9px 0 4px}
.us-metric small{font-size:11px;color:var(--us-muted)}
.us-metric:first-child strong{color:var(--us-accent)}
.us-panel{border:1px solid var(--us-line);border-radius:12px;min-width:0;overflow:hidden}
.us-panel-head{padding:18px 20px 0;align-items:start}
.us-chart{padding:20px 20px 14px}
.us-chart-readout{min-height:25px;color:var(--us-muted);font-size:11px;display:flex;justify-content:space-between;gap:6px}
.us-chart-body{height:180px;display:flex;gap:12px;margin-top:12px}
.us-y-axis{display:flex;flex-direction:column;justify-content:space-between;width:35px;text-align:right;font-size:10px;color:var(--us-muted);padding-bottom:1px}
.us-plot{flex:1;min-width:0;position:relative;border-bottom:1px solid var(--us-line)}
.us-grid{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none}
.us-grid span{border-top:1px dashed var(--us-line);width:100%}
.us-bars{position:absolute;inset:0;display:flex;align-items:end;gap:4px;padding:0 5px}
.us-bar-hit{height:100%;flex:1;min-width:0;display:flex;align-items:end;justify-content:center;border:0;background:transparent;padding:0;position:relative}
.us-bar{width:100%;max-width:36px;background:var(--us-accent);opacity:.75;border-radius:4px 4px 0 0;min-width:2px}
.us-bar-hit:hover .us-bar,.us-bar-hit:focus .us-bar,.us-bar-hit[aria-pressed=true] .us-bar{opacity:1;filter:brightness(1.08)}
.us-x-axis{margin-left:47px;display:flex;justify-content:space-between;color:var(--us-muted);font-size:10px;margin-top:9px}
.us-token-parts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:14px 20px;border-top:1px solid var(--us-line);background:var(--us-surface)}
.us-token-parts span{display:block;color:var(--us-muted);font-size:10px}
.us-token-parts b{font-size:13px;font-weight:550;display:block;margin-top:3px}
.us-breakdown{padding:20px;display:grid;gap:16px}
.us-breakdown .us-panel-head{padding:0}
.us-breakdown-list{list-style:none;margin:0;padding:0;display:grid;gap:14px}
.us-breakdown-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.us-breakdown-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.us-breakdown-bar{height:6px;margin:6px 0 4px;background:var(--us-line);border-radius:6px;overflow:hidden}
.us-breakdown-bar span{display:block;height:100%;border-radius:6px;background:var(--us-accent)}
.us-breakdown-meta{display:flex;justify-content:space-between;gap:12px;font-size:11px;color:var(--us-muted)}
.us-breakdown-more{justify-self:start}
.us-track{height:4px;background:var(--us-line);border-radius:5px;overflow:hidden}
.us-track span{display:block;height:100%;border-radius:5px}
.us-quality{display:flex;gap:12px;flex-wrap:wrap;align-items:center;color:var(--us-muted);font-size:11px}
.us-notice{padding:11px 14px;border:1px solid var(--us-line);background:var(--us-surface);border-radius:8px;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.us-notice.us-warning{border-color:#ca98234d;background:#ca98230a}
.us-details-head{padding:18px 20px;border-bottom:1px solid var(--us-line)}
.us-scroll{overflow:auto;min-width:0}
.us-table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap;min-width:790px}
.us-table th,.us-table td{text-align:right;padding:13px 18px;border-bottom:1px solid var(--us-line);font-variant-numeric:tabular-nums}
.us-table thead th{font-weight:500;color:var(--us-muted);background:var(--us-surface);font-size:11px}
.us-table th:first-child{text-align:left;min-width:185px;max-width:300px}
.us-table tbody th{font-weight:500}
.us-table tbody tr:last-child>*{border-bottom:0}
.us-table tbody tr:hover{background:var(--us-surface)}
.us-table-main{max-width:250px;overflow:hidden;text-overflow:ellipsis}
.us-table-sub{display:block;color:var(--us-muted);font-size:10px;font-weight:400;margin-top:3px;max-width:250px;overflow:hidden;text-overflow:ellipsis}
.us-total-cell{font-weight:600}
.us-share{display:flex;align-items:center;justify-content:end;gap:8px}
.us-share .us-track{width:44px;height:3px}
.us-badge{display:inline-block;font-size:10px;color:var(--us-accent);border:1px solid color-mix(in srgb,var(--us-accent) 20%,transparent);padding:2px 6px;border-radius:4px;background:color-mix(in srgb,var(--us-accent) 7%,transparent)}
.us-badge.us-error{color:#d59a43;border-color:#d59a4333;background:#d59a4308}
.us-pagination{display:flex;justify-content:space-between;align-items:center;padding:11px 18px;border-top:1px solid var(--us-line);font-size:11px;color:var(--us-muted)}
.us-empty{display:grid;place-items:center;min-height:200px;padding:30px;text-align:center;color:var(--us-muted);gap:7px}
.us-empty p{font-size:12px}
.us-empty svg{opacity:.5}
.us-foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--us-muted);font-size:10px}
.us-foot details{max-width:760px}
.us-foot summary{cursor:pointer}
.us-foot p{margin-top:8px!important;line-height:1.8}
.us-loading{padding:24px;color:var(--us-muted)}
@container(max-width:760px){.us-summary{grid-template-columns:repeat(2,minmax(0,1fr))}
.us-metric:nth-child(3){border-left:0;border-top:1px solid var(--us-line)}
.us-metric:nth-child(4){border-top:1px solid var(--us-line)}
.us-filter-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.us-top{align-items:start}
.us-live{display:none}}
@media(max-width:500px){.dsh-usage{padding:18px 14px;gap:18px}
.dsh-usage h2{font-size:21px}
.us-top{gap:14px}
.us-top>.us-actions{width:100%;justify-content:end}
.us-logo{width:38px;height:38px;border-radius:11px}
.us-logo svg{width:25px;height:25px}
.us-metric{padding:16px}
.us-metric strong{font-size:27px}
.us-tabs{gap:17px;font-size:12px}
.us-period{gap:8px}
.us-segment button{padding:5px 8px}
.us-token-parts{grid-template-columns:repeat(2,minmax(0,1fr))}
.us-panel-head,.us-details-head{padding:15px}
.us-chart{padding:15px}
.us-filter-grid{grid-template-columns:1fr}
.us-chart-body{height:160px}
.us-foot{font-size:10px}}
`;
