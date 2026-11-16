const secondary = 'var(--dsw-alias-label-secondary,color-mix(in srgb,currentColor 72%,transparent))';
const tertiary = 'var(--dsw-alias-label-tertiary,color-mix(in srgb,currentColor 58%,transparent))';
const border = 'var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent))';
const hover = 'var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))';
const error = 'var(--dsw-alias-state-error-primary,#d14343)';

export const CSS = `
.dm-trigger{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:${secondary};font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dm-trigger:hover,.dm-trigger[aria-expanded=true]{background:${hover};color:var(--dsw-alias-label-primary,inherit)}
.dm-trigger:focus-visible{outline:2px solid var(--dsw-alias-border-focus,Highlight);outline-offset:1px}
.dm-trigger:not([data-wide]){width:28px;justify-content:center;padding:0;position:relative}
.dm-trigger-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-badge{flex:none;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-warning-primary,#b7791f);color:#fff;font-size:10.5px;line-height:16px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
.dm-trigger:not([data-wide]) .dm-badge{position:absolute;top:-2px;right:-4px}
.dm-row{display:flex;flex-direction:column;min-width:0;max-width:260px}
.dm-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-row-meta{color:${tertiary};font-size:11.5px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dm-muted{color:${tertiary};font-size:12px;line-height:18px}
.dm-error{color:${error};font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dm-nowrap{white-space:nowrap;flex:none}
.dm-dialog{display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:20px}
.dm-dialog p{margin:0}
.dm-list{margin:0;padding-left:18px;max-height:180px;overflow:auto}
.dm-banner{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:8px;max-width:min(640px,calc(100vw - 32px));padding:8px 10px 8px 14px;border:.5px solid ${border};border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2,Canvas);box-shadow:0 6px 24px rgba(0,0,0,.14);font-size:13px;line-height:20px}
.dm-banner[data-tone=error]{border-color:${error}}
.dm-banner>span{flex:1;min-width:0;overflow-wrap:anywhere}
.dm-cover{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,Canvas) 72%,transparent);backdrop-filter:blur(2px)}
.dm-cover-card{display:flex;flex-direction:column;align-items:center;gap:8px;padding:22px 28px;border:.5px solid ${border};border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-2,Canvas);box-shadow:0 10px 40px rgba(0,0,0,.16);font-size:14px;line-height:20px;text-align:center}
.dm-spinner{width:20px;height:20px;border-radius:50%;border:2px solid ${border};border-top-color:var(--dsw-alias-label-primary,currentColor);animation:dm-spin .8s linear infinite}
@keyframes dm-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dm-spinner{animation:none}}
.dm-settings{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:20px}
.dm-settings h3{margin:8px 0 0;font-size:12px;line-height:18px;font-weight:500;color:${secondary}}
.dm-card{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:.5px solid ${border};border-radius:var(--dsw-radius-md,12px)}
.dm-card code,.dm-machine code{font-family:var(--dsw-font-family-mono,ui-monospace,monospace);font-size:11.5px}
.dm-line{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.dm-label{min-width:140px;color:${secondary}}
.dm-empty{padding:14px 16px;border:.5px dashed ${border};border-radius:var(--dsw-radius-md,12px);color:${secondary}}
.dm-machines{gap:0;padding:4px 14px}
.dm-machine{display:flex;align-items:center;gap:10px;padding:8px 0}
.dm-machine+.dm-machine{border-top:.5px solid ${border}}
.dm-machine-text{flex:1;min-width:0;display:flex;flex-direction:column}
.dm-machine-text .dm-muted{overflow-wrap:anywhere}
.dm-choices{display:flex;flex-wrap:wrap;gap:6px 16px}
.dm-choices label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
@media (max-width:520px){.dm-label{min-width:0;width:100%}.dm-machine{flex-wrap:wrap}.dm-banner{bottom:8px}}
`;
