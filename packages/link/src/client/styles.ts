const secondary = 'var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent))';
const tertiary = 'var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 58%,transparent))';
const border = 'var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent))';
const hover = 'var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))';
const error = 'var(--dsw-alias-state-error-primary,#d14343)';

export const CSS = `
.dl-trigger{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:${secondary};font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dl-trigger:hover,.dl-trigger[aria-expanded=true]{background:${hover};color:var(--dsw-alias-label-primary,inherit)}
.dl-trigger:focus-visible{outline:2px solid var(--dsw-alias-border-focus,Highlight);outline-offset:1px}
.dl-trigger:not([data-wide]){width:28px;justify-content:center;padding:0;position:relative}
.dl-trigger-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-badge{flex:none;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-warning-primary,#b7791f);color:#fff;font-size:10.5px;line-height:16px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
.dl-trigger:not([data-wide]) .dl-badge{position:absolute;top:-2px;right:-4px}
.dl-row{display:flex;flex-direction:column;min-width:0;max-width:260px}
.dl-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-row-meta{color:${tertiary};font-size:11.5px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dl-muted{color:${tertiary};font-size:12px;line-height:18px}
.dl-error{color:${error};font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dl-nowrap{white-space:nowrap;flex:none}
.dl-dialog{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:20px}
.dl-dialog p{margin:0}
.dl-list{margin:0;padding-left:18px;max-height:180px;overflow:auto}
.dl-banner{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:8px;max-width:min(640px,calc(100vw - 32px));padding:8px 10px 8px 14px;border:.5px solid ${border};border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2,Canvas);box-shadow:0 6px 24px rgba(0,0,0,.14);font-size:13px;line-height:20px}
.dl-banner[data-tone=error]{border-color:${error}}
.dl-banner>span{flex:1;min-width:0;overflow-wrap:anywhere}
.dl-cover{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,Canvas) 72%,transparent);backdrop-filter:blur(2px)}
.dl-cover-card{display:flex;flex-direction:column;align-items:center;gap:8px;padding:22px 28px;border:.5px solid ${border};border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-2,Canvas);box-shadow:0 10px 40px rgba(0,0,0,.16);font-size:14px;line-height:20px;text-align:center}
.dl-spinner{width:20px;height:20px;border-radius:50%;border:2px solid ${border};border-top-color:var(--dsw-alias-label-primary,currentColor);animation:dl-spin .8s linear infinite}
@keyframes dl-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dl-spinner{animation:none}}
.dl-settings{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:20px}
.dl-settings h3{margin:8px 0 0;font-size:12px;line-height:18px;font-weight:500;color:${secondary}}
.dl-card{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:.5px solid ${border};border-radius:var(--dsw-radius-md,12px)}
.dl-card code,.dl-machine code{font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11.5px}
.dl-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.dl-label{min-width:140px;color:${secondary}}
.dl-empty{padding:14px 16px;border:.5px dashed ${border};border-radius:var(--dsw-radius-md,12px);color:${secondary}}
.dl-machines{gap:0;padding:4px 14px}
.dl-machine{display:flex;align-items:center;gap:10px;padding:8px 0}
.dl-machine+.dl-machine{border-top:.5px solid ${border}}
.dl-machine-text{flex:1;min-width:0;display:flex;flex-direction:column}
.dl-machine-text .dl-muted{overflow-wrap:anywhere}
.dl-choices{display:flex;flex-wrap:wrap;gap:6px 16px}
.dl-choices label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
@media (max-width:520px){.dl-label{min-width:0;width:100%}.dl-machine{flex-wrap:wrap}.dl-banner{bottom:8px}}
`;
