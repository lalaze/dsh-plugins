export const styles = `
.dsh-usage{--us-accent:#0b9f83;--us-amber:color-mix(in srgb,#d9822b 80%,currentColor);--us-muted:color-mix(in srgb,currentColor 58%,transparent);--us-line:color-mix(in srgb,currentColor 11%,transparent);--us-surface:color-mix(in srgb,currentColor 4.5%,transparent);--us-raised:color-mix(in srgb,currentColor 10%,transparent);box-sizing:border-box;width:100%;max-width:1080px;margin:0 auto;padding:24px 28px 32px;display:grid;gap:16px;font-size:13px;line-height:1.5;container-type:inline-size}
.dsh-usage *{box-sizing:border-box}
.dsh-usage button,.dsh-usage input,.dsh-usage select{font:inherit;color:inherit}
.dsh-usage button{cursor:pointer}
.dsh-usage button:disabled{cursor:default;opacity:.5}
.dsh-usage button:focus-visible,.dsh-usage input:focus-visible,.dsh-usage select:focus-visible,.dsh-usage summary:focus-visible{outline:2px solid var(--us-accent);outline-offset:2px}
.dsh-usage h2,.dsh-usage h3,.dsh-usage p,.dsh-usage dl,.dsh-usage dd{margin:0}
.dsh-usage h2{font-size:20px;font-weight:650;letter-spacing:-.4px}
.dsh-usage h3{font-size:14px;font-weight:600}
.us-muted{color:var(--us-muted)}
.us-number{font-variant-numeric:tabular-nums}
.us-top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.us-subtitle{margin-top:2px!important;color:var(--us-muted);font-size:12px}
.us-actions{display:flex;gap:2px;align-items:center}
.us-link{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:5px 10px;border:0;border-radius:8px;background:transparent;color:var(--us-muted)!important;white-space:nowrap}
.us-link:hover{background:var(--us-surface);color:inherit!important}
.us-link.us-accent{color:var(--us-accent)!important;font-weight:600}
.us-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;background:transparent;border:1px solid var(--us-line);padding:5px 11px;border-radius:7px;white-space:nowrap;min-height:30px}
.us-button:hover{background:var(--us-surface)}
.us-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:14px;background:var(--us-surface)}
.us-tabs button{flex:1 0 auto;min-height:42px;padding:0 14px;border:0;border-radius:10px;background:transparent;color:var(--us-muted);font-size:14px;white-space:nowrap}
.us-tabs button:hover{color:inherit}
.us-tabs button[aria-pressed=true]{background:var(--us-raised);color:inherit;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.us-segment{display:inline-flex;padding:3px;gap:2px;background:var(--us-surface);border-radius:8px}
.us-segment button{border:0;background:transparent;padding:4px 10px;white-space:nowrap;border-radius:6px;color:var(--us-muted);font-size:12px}
.us-segment button[aria-pressed=true]{background:var(--us-raised);color:inherit}
.us-custom-dates{display:flex;align-items:end;gap:8px;flex-wrap:wrap}
.us-custom-dates input{max-width:150px}
.us-custom-dates>.us-muted{padding-bottom:8px}
.us-filter-row{display:flex;align-items:start;justify-content:space-between;gap:10px;margin-top:-4px}
.us-filters{flex:1;min-width:0}
.us-filters summary{width:max-content;max-width:100%;cursor:pointer;color:var(--us-muted);font-size:12px;padding:4px 2px}
.us-filter-row>.us-link{min-height:28px;padding:3px 8px;font-size:12px}
.us-filter-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:10px}
.us-field{display:grid;gap:5px;color:var(--us-muted);font-size:11px}
.us-field input,.us-field select{width:100%;min-width:0;padding:8px 10px;border:1px solid var(--us-line);border-radius:8px;background:transparent;color:inherit;font-size:12px}
.us-field option{background:Canvas;color:CanvasText}
.us-hero{padding:22px 26px 24px;border-radius:20px;background:var(--us-surface);min-width:0}
.us-hero-head{display:flex;justify-content:space-between;align-items:center;gap:12px;color:var(--us-muted);font-size:14px}
.us-partial{border:0;background:transparent;padding:0;color:var(--us-amber)!important;font-size:13px;font-weight:600}
.us-partial:hover{text-decoration:underline}
.us-hero-total{display:flex;align-items:baseline;gap:8px;margin-top:8px;min-width:0}
.us-hero-total strong{font-size:60px;line-height:1.05;font-weight:700;letter-spacing:-1.5px}
.us-hero-total span{color:var(--us-muted);font-size:16px}
.us-hero-exact{margin-top:10px!important;color:var(--us-muted);font-size:14px}
.us-hero-split{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:20px;padding-top:18px;border-top:1px solid var(--us-line)}
.us-hero-split>div{min-width:0}
.us-hero-split span{display:block;color:var(--us-muted);font-size:13px}
.us-hero-split b{display:block;font-size:24px;font-weight:650;line-height:1.3;margin-top:4px}
.us-hero-split small{display:block;color:var(--us-muted);font-size:11px;margin-top:2px}
.us-range{text-align:center;color:var(--us-muted);font-size:12px}
.us-breakdown{display:grid;gap:6px;padding:4px 0}
.us-breakdown ol{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.us-row{display:flex;align-items:center;gap:10px;width:100%;padding:6px 4px;border:0;border-radius:8px;background:transparent;text-align:left}
.us-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px;font-weight:600}
.us-row>b{font-size:16px;font-weight:650}
.us-plus{flex:none;color:var(--us-muted)}
.us-row:hover .us-plus,.us-sources-head:hover .us-plus{color:inherit}
.us-row-bar{display:flex;align-items:center;gap:14px;padding:2px 4px 0}
.us-meter{flex:1;height:6px;border-radius:6px;background:var(--us-line);overflow:hidden}
.us-meter span{display:block;height:100%;border-radius:6px;background:var(--us-accent)}
.us-row-bar>.us-number{flex:none;min-width:50px;text-align:right;color:var(--us-muted);font-size:12px}
.us-row-detail{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px 18px;margin:10px 4px 6px;padding:14px 16px;border-radius:12px;background:var(--us-surface)}
.us-row-detail>div{min-width:0}
.us-row-detail dt{color:var(--us-muted);font-size:11px}
.us-row-detail dd{margin-top:3px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.us-row-detail small{display:block;margin-top:1px;color:var(--us-muted);font-size:11px;font-weight:400}
.us-more{justify-self:start;font-size:12px}
.us-badge{display:inline-block;font-size:11px;font-weight:500;color:var(--us-accent);border:1px solid color-mix(in srgb,var(--us-accent) 20%,transparent);padding:1px 6px;border-radius:4px;background:color-mix(in srgb,var(--us-accent) 7%,transparent)}
.us-badge.us-error{color:var(--us-amber);border-color:color-mix(in srgb,var(--us-amber) 25%,transparent);background:color-mix(in srgb,var(--us-amber) 6%,transparent)}
.us-panel{border-radius:20px;background:var(--us-surface);min-width:0;overflow:hidden}
.us-panel-head{display:flex;justify-content:space-between;align-items:start;gap:16px;flex-wrap:wrap;padding:18px 22px 0}
.us-chart{padding:16px 22px 16px}
.us-chart-readout{min-height:22px;color:var(--us-muted);font-size:11px;display:flex;justify-content:space-between;gap:6px}
.us-chart-body{height:160px;display:flex;gap:12px;margin-top:10px}
.us-y-axis{display:flex;flex-direction:column;justify-content:space-between;width:35px;text-align:right;font-size:10px;color:var(--us-muted);padding-bottom:1px}
.us-plot{flex:1;min-width:0;position:relative;border-bottom:1px solid var(--us-line)}
.us-grid{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none}
.us-grid span{border-top:1px dashed var(--us-line);width:100%}
.us-bars{position:absolute;inset:0;display:flex;align-items:end;gap:4px;padding:0 5px}
.us-bar-hit{height:100%;flex:1;min-width:0;display:flex;align-items:end;justify-content:center;border:0;background:transparent;padding:0;position:relative}
.us-bar{width:100%;max-width:36px;background:var(--us-accent);opacity:.75;border-radius:4px 4px 0 0;min-width:2px}
.us-bar-hit:hover .us-bar,.us-bar-hit:focus .us-bar,.us-bar-hit[aria-pressed=true] .us-bar{opacity:1;filter:brightness(1.08)}
.us-x-axis{margin-left:47px;display:flex;justify-content:space-between;color:var(--us-muted);font-size:10px;margin-top:9px}
.us-sources{display:grid;gap:2px;padding-top:10px;border-top:1px solid var(--us-line)}
.us-sources-head{display:flex;align-items:center;gap:10px;width:100%;padding:8px 4px;border:0;border-radius:8px;background:transparent;text-align:left}
.us-sources-title{flex:1;font-size:15px;font-weight:600}
.us-sources-status{display:inline-flex;align-items:center;gap:7px;color:var(--us-muted);font-size:13px}
.us-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--us-accent);flex-shrink:0}
.us-dot.us-warn{background:var(--us-amber)}
.us-source-list{list-style:none;margin:0;padding:0}
.us-source-list li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:7px 4px}
.us-source-list li>div{min-width:0}
.us-source-list span{font-size:14px}
.us-source-list small{display:block;color:var(--us-muted);font-size:12px}
.us-source-list b{font-size:14px;font-weight:600}
.us-sources-detail{display:grid;gap:10px;padding:8px 4px 4px;color:var(--us-muted);font-size:12px;line-height:1.7}
.us-notice{padding:10px 14px;border:1px solid var(--us-line);background:var(--us-surface);border-radius:10px;font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.us-notice.us-warning{border-color:color-mix(in srgb,#ca9823 30%,transparent);background:color-mix(in srgb,#ca9823 4%,transparent);color:inherit}
.us-empty{display:grid;place-items:center;min-height:180px;padding:30px;text-align:center;color:var(--us-muted);gap:7px}
.us-empty p{font-size:12px}
.us-empty svg{opacity:.5}
.us-loading{padding:24px;color:var(--us-muted)}
@container(max-width:600px){.us-hero{padding:18px 18px 20px;border-radius:16px}
.us-hero-total strong{font-size:46px}
.us-hero-split{gap:12px}
.us-hero-split b{font-size:19px}
.us-tabs button{min-height:38px;padding:0 10px;font-size:13px}
.us-filter-grid{grid-template-columns:1fr}
.us-row-name,.us-row>b{font-size:15px}
.us-panel-head{padding:15px 15px 0}
.us-chart{padding:14px 15px}}
@media(max-width:500px){.dsh-usage{padding:16px 14px 24px;gap:14px}
.dsh-usage h2{font-size:18px}}
`;
