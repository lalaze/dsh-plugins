/**
 * DSH lays two 10px handles for the chat column's width over the whole view area, at z-index 0 and after the view in the
 * page, so they would take the clicks on whatever of this view lies under them. The view sits one level above.
 */
export const styles = `
.ps-root{--ps-line:color-mix(in srgb,currentColor 13%,transparent);--ps-accent:var(--dsw-alias-state-business-primary,#3b82f6);--ps-warn:var(--dsw-alias-state-warn-primary,#e0982e);--ps-error:var(--dsw-alias-state-error-primary,#d9534f);
  position:relative;z-index:1;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;overflow:auto;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:1.5}
.ps-root *{box-sizing:border-box}
.ps-root button,.ps-root textarea{font:inherit}
.ps-root :focus-visible{outline:2px solid var(--ps-accent);outline-offset:1px}
.ps-note{margin:auto;padding:24px;max-width:460px;text-align:center;opacity:.7}
.ps-page{width:100%;max-width:820px;margin:0 auto;padding:16px 16px 28px}
.ps-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.ps-name{margin:0;font-size:17px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
.ps-updated{font-size:12px;color:var(--dsw-alias-label-secondary,inherit);opacity:.8;white-space:nowrap}
.ps-path{margin:2px 0 0;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);opacity:.75;overflow-wrap:anywhere}
.ps-facts{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 0;padding:0;list-style:none}
.ps-fact{display:flex;align-items:baseline;gap:6px;padding:3px 9px;border:1px solid var(--ps-line);border-radius:999px;corner-shape:round;font-size:12px;white-space:nowrap}
.ps-fact dt{color:var(--dsw-alias-label-secondary,inherit);opacity:.75}
.ps-fact dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums;max-width:260px;overflow:hidden;text-overflow:ellipsis}
.ps-fact[data-tone=warn]{border-color:color-mix(in srgb,var(--ps-warn) 55%,transparent)}
.ps-fact[data-tone=warn] dd{color:var(--ps-warn)}
.ps-fact small{font-weight:400;font-size:11px;opacity:.7}
.ps-alert{margin:12px 0 0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--ps-warn) 55%,transparent);border-radius:var(--dsw-radius-md,8px);background:color-mix(in srgb,var(--ps-warn) 10%,transparent);font-size:12px}
.ps-alert[data-tone=error]{border-color:color-mix(in srgb,var(--ps-error) 55%,transparent);background:color-mix(in srgb,var(--ps-error) 10%,transparent)}
.ps-alert p{margin:0 0 6px}
.ps-alert p:last-child{margin:0}
.ps-fields{display:grid;gap:10px;margin-top:14px}
.ps-field{padding:10px 12px;border:1px solid var(--ps-line);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent)}
.ps-field[data-field=blockers][data-filled]{border-color:color-mix(in srgb,var(--ps-warn) 55%,transparent)}
.ps-field h3{margin:0;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,inherit)}
.ps-hint{margin:1px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);opacity:.75}
.ps-text{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.ps-empty{margin:6px 0 0;opacity:.45}
.ps-area{display:block;width:100%;margin-top:6px;padding:6px 8px;border:1px solid var(--ps-line);border-radius:6px;background:transparent;color:inherit;line-height:1.5;resize:vertical}
.ps-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px}
.ps-button{min-height:28px;padding:3px 12px;border:1px solid var(--ps-line);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;cursor:pointer;white-space:nowrap}
.ps-button:hover:enabled{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 9%,transparent))}
.ps-button:disabled{opacity:.45;cursor:default}
.ps-button[data-primary]{border-color:transparent;background:var(--ps-accent);color:#fff}
.ps-button[data-primary]:hover:enabled{background:color-mix(in srgb,var(--ps-accent) 86%,#000)}
.ps-spacer{flex:1}
.ps-said{margin:8px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}
.ps-foot{margin-top:18px;padding-top:10px;border-top:1px solid var(--ps-line);font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
.ps-foot code{font-family:var(--dsw-font-mono,ui-monospace,monospace);overflow-wrap:anywhere;user-select:all}
@media (max-width:520px){.ps-page{padding:12px 10px 24px}.ps-fact dd{max-width:160px}}
`;
