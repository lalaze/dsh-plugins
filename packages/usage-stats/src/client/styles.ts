// Colors, radii and type follow DSH's `--dsw-*` tokens; the fallbacks keep the standalone preview readable.
export const styles = `
.dsh-usage{--us-accent:var(--dsw-alias-state-business-primary,#4176e6);--us-warn:var(--dsw-alias-state-warn-label,#d97706);--us-success:var(--dsw-alias-state-success-primary,#22a06b);--us-secondary:var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 75%,transparent));--us-muted:var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 58%,transparent));--us-line:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));--us-card-line:var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4,color-mix(in srgb,currentColor 18%,transparent)));--us-hover:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 7%,transparent));--us-track:var(--dsw-alias-bg-module-platform,color-mix(in srgb,currentColor 6%,transparent));--us-raised:var(--dsw-alias-bg-layer-3,Canvas);--us-radius-sm:var(--dsw-radius-sm,8px);--us-radius-md:var(--dsw-radius-md,12px);--us-radius-lg:var(--dsw-radius-lg,16px);--us-radius-xl:var(--dsw-radius-xl,20px);box-sizing:border-box;width:100%;max-width:720px;margin:0 auto;padding:24px;display:grid;gap:14px;color:var(--dsw-alias-label-primary,inherit);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.5;container-type:inline-size}
.dsh-usage *{box-sizing:border-box}
:where(.dsh-usage) :is(button,input,select){font:inherit;color:inherit}
.dsh-usage button{cursor:pointer}
.dsh-usage button:disabled{cursor:default;opacity:.4}
.dsh-usage button:focus-visible,.dsh-usage input:focus-visible,.dsh-usage select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--us-accent));outline-offset:-2px}
:where(.dsh-usage) :is(h2,h3,p,dl,dd){margin:0}
.dsh-usage h2{font-size:16px;line-height:24px;font-weight:500}
.dsh-usage h3{font-size:13px;font-weight:600}
.us-muted{color:var(--us-muted)}
.us-number{font-variant-numeric:tabular-nums}
.us-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.us-title{min-width:0}
.us-subtitle{margin-top:2px;color:var(--us-muted);font-size:12px;line-height:18px}
.us-actions{display:flex;gap:4px;align-items:center;flex:none;margin-top:-2px}
.us-link{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border:0;border-radius:var(--us-radius-sm);background:transparent;color:var(--us-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.us-link:hover:not(:disabled){background:var(--us-hover);color:var(--dsw-alias-label-primary,inherit)}
.us-link svg{width:14px;height:14px}
.us-button{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3,var(--us-line));border-radius:var(--us-radius-sm);background:transparent;font-size:12px;white-space:nowrap}
.us-button:hover{background:var(--us-hover)}
.us-tabs{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;padding:4px;border-radius:var(--us-radius-lg);background:var(--us-track)}
.us-tabs button{height:34px;padding:0 12px;border:0;border-radius:var(--us-radius-md);background:transparent;color:var(--us-secondary);font-size:14px;line-height:20px;white-space:nowrap;transition:color .18s ease}
.us-tabs button:hover{color:var(--dsw-alias-label-primary,inherit)}
.us-tabs button[aria-pressed=true]{background:var(--us-raised);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3,var(--us-line));color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.us-segment{display:inline-flex;justify-self:start;max-width:100%;gap:2px;padding:3px;border-radius:var(--us-radius-md);background:var(--us-hover);overflow-x:auto;scrollbar-width:none}
.us-segment::-webkit-scrollbar{display:none}
.us-segment button{flex:none;height:26px;padding:0 12px;border:0;border-radius:var(--us-radius-sm);background:transparent;color:var(--us-secondary);font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;transition:color .12s ease}
.us-segment button:hover{color:var(--dsw-alias-label-primary,inherit)}
.us-segment button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-1,Canvas);box-shadow:var(--dsw-elevation-soft,0 0 0 .5px var(--us-line),0 1px 3px rgba(0,0,0,.08));color:var(--dsw-alias-label-primary,inherit)}
.us-custom-dates{display:flex;align-items:end;gap:8px;flex-wrap:wrap}
.us-custom-dates input{max-width:160px}
.us-custom-dates>.us-muted{padding-bottom:6px}
.us-filter-row{display:flex;align-items:center;flex-wrap:wrap;column-gap:10px;row-gap:2px;margin-top:-4px}
.us-filters{display:inline-flex;align-items:center;gap:4px;min-width:0;height:24px;padding:0 6px 0 2px;border:0;border-radius:var(--us-radius-sm);background:transparent;color:var(--us-muted);font-size:12px;white-space:nowrap}
.us-filters:hover{color:var(--us-secondary)}
.us-filters .us-chevron{width:12px;height:12px}
.us-filter-row>.us-range{margin-left:auto;color:var(--us-muted);font-size:12px}
.us-filter-row>.us-link{height:24px;padding:0 6px}
.us-filter-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:-4px}
.us-field{display:grid;gap:4px;color:var(--us-muted);font-size:12px}
.us-field input,.us-field select{width:100%;min-width:0;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,var(--us-line));border-radius:var(--us-radius-md);background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font-size:13px;outline:none}
.us-field input:focus,.us-field select:focus{border-color:var(--us-accent)}
.us-field input::placeholder{color:var(--dsw-alias-label-dimmed,var(--us-muted))}
.us-field option{background:Canvas;color:CanvasText}
.us-hero{min-width:0;padding:16px 18px;border:.5px solid var(--us-card-line);border-radius:var(--us-radius-xl);background:var(--dsw-alias-settings-card-fill,transparent)}
.us-hero-head{display:flex;justify-content:space-between;align-items:center;gap:12px;color:var(--us-secondary);font-size:13px}
.us-partial{padding:0;border:0;background:transparent;color:var(--us-warn);font-size:12px}
.us-partial:hover{text-decoration:underline}
.us-hero-total{display:flex;align-items:baseline;gap:6px;margin-top:4px;min-width:0}
.us-hero-total strong{font-size:32px;line-height:40px;font-weight:600;letter-spacing:-.5px}
.us-hero-total span{color:var(--us-muted);font-size:13px}
.us-hero-exact{color:var(--us-muted);font-size:12px}
.us-hero-split{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:14px;padding-top:12px;border-top:.5px solid var(--us-line)}
.us-hero-split>div{min-width:0}
.us-hero-split span{display:block;color:var(--us-muted);font-size:12px}
.us-hero-split b{display:block;margin-top:2px;font-size:18px;line-height:26px;font-weight:600}
.us-hero-split small{display:block;color:var(--us-muted);font-size:12px}
.us-breakdown{display:grid;gap:4px;margin:0 -10px}
.us-breakdown ol{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.us-row{display:grid;grid-template-columns:minmax(0,1fr) auto 48px 14px;align-items:center;column-gap:10px;row-gap:8px;width:100%;padding:9px 10px 11px;border:0;border-radius:var(--us-radius-md);background:transparent;text-align:left}
.us-row:hover{background:var(--us-hover)}
.us-row-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:22px;font-weight:500}
.us-row>b{font-size:14px;font-weight:600}
.us-row-share{color:var(--us-muted);font-size:12px;text-align:right}
.us-chevron{flex:none;color:var(--us-muted);transition:transform .16s ease}
.us-chevron[data-open]{transform:rotate(90deg)}
.us-row:hover .us-chevron,.us-sources-head:hover .us-chevron{color:var(--dsw-alias-label-primary,inherit)}
.us-meter{grid-column:1/-1;display:block;height:4px;border-radius:2px;background:var(--us-hover);overflow:hidden}
.us-meter span{display:block;height:100%;border-radius:2px;background:var(--us-accent)}
.us-row-detail{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px 16px;margin:2px 10px 8px;padding:12px 14px;border-radius:var(--us-radius-md);background:var(--us-track)}
.us-row-detail>div{min-width:0}
.us-row-detail dt{color:var(--us-muted);font-size:12px}
.us-row-detail dd{margin-top:2px;font-weight:500;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.us-row-detail small{display:block;color:var(--us-muted);font-size:11px;font-weight:400}
.us-more{justify-self:start;margin-left:4px}
.us-badge{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;background:color-mix(in srgb,var(--us-success) 10%,transparent);color:var(--us-success);font-size:11px;line-height:17px;font-weight:500}
.us-badge.us-error{background:color-mix(in srgb,var(--us-warn) 12%,transparent);color:var(--us-warn)}
.us-panel{min-width:0;border:.5px solid var(--us-card-line);border-radius:var(--us-radius-xl);background:var(--dsw-alias-settings-card-fill,transparent);overflow:hidden}
.us-panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:14px 18px 0}
.us-panel-head .us-segment button{height:22px;padding:0 10px;font-size:12px;line-height:18px}
.us-chart{padding:10px 18px 14px}
.us-chart-readout{min-height:18px;display:flex;justify-content:space-between;gap:6px;color:var(--us-muted);font-size:12px}
.us-chart-body{display:flex;gap:10px;height:132px;margin-top:8px}
.us-y-axis{display:flex;flex-direction:column;justify-content:space-between;width:34px;padding-bottom:1px;color:var(--us-muted);font-size:11px;text-align:right}
.us-plot{position:relative;flex:1;min-width:0;border-bottom:.5px solid var(--us-line)}
.us-grid{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none}
.us-grid span{width:100%;border-top:.5px dashed var(--us-line)}
.us-bars{position:absolute;inset:0;display:flex;align-items:end;gap:4px;padding:0 4px}
.us-bar-hit{position:relative;display:flex;align-items:end;justify-content:center;flex:1;min-width:0;height:100%;padding:0;border:0;background:transparent}
.us-bar{width:100%;max-width:28px;min-width:2px;border-radius:3px 3px 0 0;background:var(--us-accent);opacity:.7}
.us-bar-hit:hover .us-bar,.us-bar-hit:focus .us-bar,.us-bar-hit[aria-pressed=true] .us-bar{opacity:1}
.us-x-axis{display:flex;justify-content:space-between;margin:6px 0 0 44px;color:var(--us-muted);font-size:11px}
.us-sources{display:grid;gap:2px;padding-top:8px;border-top:.5px solid var(--us-line)}
.us-sources-head{display:flex;align-items:center;gap:8px;width:calc(100% + 16px);margin:0 -8px;padding:6px 8px;border:0;border-radius:var(--us-radius-sm);background:transparent;text-align:left}
.us-sources-head:hover{background:var(--us-hover)}
.us-sources-title{flex:1;font-size:13px;font-weight:600}
.us-sources-status{display:inline-flex;align-items:center;gap:6px;color:var(--us-muted);font-size:12px}
.us-dot{flex-shrink:0;display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--us-accent)}
.us-dot.us-warn{background:var(--us-warn)}
.us-source-list{list-style:none;margin:0;padding:0}
.us-source-list li{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:6px 0}
.us-source-list li>div{min-width:0}
.us-source-list span{font-size:13px}
.us-source-list small{display:block;color:var(--us-muted);font-size:12px}
.us-source-list b{font-size:13px;font-weight:600}
.us-sources-detail{display:grid;gap:8px;padding:4px 0;color:var(--us-muted);font-size:12px;line-height:1.6}
.us-notice{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:8px 12px;border-radius:var(--us-radius-md);background:var(--us-track);font-size:12px}
.us-notice.us-warning{background:color-mix(in srgb,var(--us-warn) 10%,transparent);color:inherit}
.us-sources-detail .us-notice.us-warning{color:var(--us-warn)}
.us-empty{display:grid;place-items:center;gap:6px;min-height:160px;padding:24px;color:var(--us-muted);text-align:center}
.us-empty h3{color:var(--dsw-alias-label-primary,inherit)}
.us-empty p{font-size:12px}
.us-empty svg{opacity:.5}
.us-loading{padding:24px 0;color:var(--us-muted)}
@media(prefers-reduced-motion:reduce){.us-chevron,.us-tabs button,.us-segment button{transition:none}}
@container(max-width:520px){.us-hero{padding:14px 16px}
.us-hero-total strong{font-size:28px;line-height:36px}
.us-hero-split{gap:12px}
.us-hero-split b{font-size:16px;line-height:24px}
.us-tabs button{height:30px;padding:0 6px;font-size:13px}
.us-filter-grid{grid-template-columns:1fr}
.us-segment{flex-wrap:wrap}
.us-actions .us-link{padding:0 7px}}
@media(max-width:500px){.dsh-usage{padding:16px}}
`;
