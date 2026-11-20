/**
 * DSH lays two 10px handles for the chat column's width over the whole view area, at z-index 0 and after the view in the
 * page, so they would take the clicks on whatever of this view lies under them. The view sits one level above.
 */
export const styles = `
.ps-root{--ps-line:color-mix(in srgb,currentColor 13%,transparent);--ps-accent:var(--dsw-alias-state-business-primary,#3b82f6);--ps-warn:var(--dsw-alias-state-warn-primary,#e0982e);--ps-error:var(--dsw-alias-state-error-primary,#d9534f);
  position:relative;z-index:1;display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;overflow:auto;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:1.5}
.ps-root *{box-sizing:border-box}
.ps-root button,.ps-root textarea,.ps-root input{font:inherit}
.ps-root :focus-visible{outline:2px solid var(--ps-accent);outline-offset:1px}
.ps-note{margin:auto;padding:24px;max-width:460px;text-align:center;opacity:.7}
/* The bottom is left free: DSH's composer floats over the lower part of a view in an ordinary conversation. */
.ps-page{width:100%;max-width:820px;margin:0 auto;padding:16px 16px 150px}
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
.ps-field h3{display:flex;align-items:baseline;gap:8px;margin:0;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,inherit)}
.ps-count{font-weight:400;font-variant-numeric:tabular-nums;opacity:.7}
.ps-state{margin-left:auto;font-weight:400;font-size:11px;letter-spacing:0;opacity:.6}
.ps-field .ps-alert{margin-top:8px}
.ps-theirs{max-height:9em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;opacity:.85}
.ps-choice{display:flex;flex-wrap:wrap;gap:8px}
/* Reads as text until it is pointed at or typed in. */
.ps-area{display:block;width:calc(100% + 14px);min-height:calc(1.5em + 8px);margin:3px -7px -4px;padding:3px 6px;border:1px solid transparent;border-radius:6px;background:transparent;color:inherit;line-height:1.5;resize:none;overflow:hidden;field-sizing:content}
.ps-area:hover{border-color:var(--ps-line)}
.ps-area:focus,.ps-area:focus-visible{outline:none;border-color:var(--ps-accent)}
.ps-area::placeholder,.ps-goal-input::placeholder{color:inherit;opacity:.42}
.ps-goals{margin:6px 0 0;padding:0;list-style:none}
.ps-goal{display:flex;align-items:flex-start;gap:6px;min-height:26px;padding-left:calc(var(--ps-depth,0)*22px)}
.ps-goal input[type=checkbox],.ps-goal-box,.ps-goal-plus{flex:none;width:15px;height:15px;margin:5px 2px 0 0}
.ps-goal input[type=checkbox]{accent-color:var(--ps-accent);cursor:pointer}
.ps-goal input[type=checkbox]:disabled{opacity:.4;cursor:default}
.ps-goal-box{padding:0;border:1px dashed color-mix(in srgb,currentColor 45%,transparent);border-radius:3px;background:transparent;cursor:pointer}
.ps-goal-plus{font-size:15px;line-height:15px;text-align:center;opacity:.45}
.ps-goal-text{flex:1;min-width:0;padding:2px 4px;border:0;border-radius:4px;background:transparent;color:inherit;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;cursor:text}
.ps-goal-text:hover{background:color-mix(in srgb,currentColor 6%,transparent)}
.ps-goal[data-done]>.ps-goal-text{font-weight:400;text-decoration:line-through;opacity:.5}
.ps-goal-input{flex:1;min-width:0;height:25px;padding:1px 4px;border:1px solid transparent;border-radius:4px;background:transparent;color:inherit;font:inherit}
.ps-goal-input:hover{border-color:var(--ps-line)}
.ps-goal-input:focus,.ps-goal-input:focus-visible{outline:none;border-color:var(--ps-accent)}
.ps-goal-count{margin-top:4px;font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;opacity:.6}
.ps-goal-new{margin-top:2px}
.ps-root .ps-icon{flex:none;width:24px;height:24px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font-size:15px;line-height:1;opacity:.35;cursor:pointer}
.ps-icon:hover,.ps-icon:focus-visible{opacity:1;background:color-mix(in srgb,currentColor 9%,transparent)}
.ps-root .ps-button.ps-goal-confirm{min-height:24px;padding:1px 8px;font-size:12px;border-color:color-mix(in srgb,var(--ps-error) 60%,transparent);color:var(--ps-error)}
/* One card per goal: each has a status of its own. */
.ps-goal-cards{display:grid;gap:8px}
.ps-section{display:flex;align-items:baseline;gap:8px;margin:6px 0 0;padding:0 2px;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,inherit)}
.ps-card{border:1px solid var(--ps-line);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent)}
.ps-card[data-blocked]{border-color:color-mix(in srgb,var(--ps-warn) 55%,transparent)}
.ps-card-head{display:flex;align-items:flex-start;gap:6px;padding:7px 8px 7px 12px}
.ps-card-head>input[type=checkbox]{flex:none;width:16px;height:16px;margin:5px 2px 0 0;accent-color:var(--ps-accent);cursor:pointer}
/* The rule that makes buttons inherit the font outweighs a single class, so what sets a font of its own names the root too. */
.ps-root .ps-card-title{flex:1;min-width:0;padding:2px 4px;border:0;border-radius:4px;background:transparent;color:inherit;font-size:14px;font-weight:600;line-height:1.5;text-align:left;overflow-wrap:anywhere;cursor:pointer}
.ps-card[data-open] .ps-card-title{cursor:text}
.ps-card-title:hover{background:color-mix(in srgb,currentColor 6%,transparent)}
.ps-root .ps-card[data-done] .ps-card-title{font-weight:400;text-decoration:line-through;opacity:.5}
.ps-card-head .ps-goal-input{font-size:14px;font-weight:600;height:27px}
.ps-card-head .ps-goal-count{margin-top:6px}
.ps-root .ps-card-line{display:block;width:100%;margin:-4px 0 0;padding:0 12px 8px 40px;border:0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font-size:12px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.ps-card-line span{margin-right:8px;opacity:.65}
.ps-card-line[data-tone=warn]{color:var(--ps-warn)}
.ps-card-body{display:grid;gap:2px;padding:2px 12px 10px 40px;border-top:1px solid var(--ps-line)}
.ps-part{display:grid;grid-template-columns:56px minmax(0,1fr);gap:0 10px;padding-top:6px}
.ps-part-name{padding-top:4px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,inherit)}
.ps-part-name .ps-state{display:block;margin:0;font-size:10px}
.ps-part[data-part=blockers][data-filled] .ps-part-name{color:var(--ps-warn)}
.ps-part .ps-area{margin-top:0}
.ps-part .ps-goals{margin-top:0}
.ps-root .ps-fold{font-size:19px;transition:transform .12s}
.ps-fold[data-open]{transform:rotate(90deg)}
.ps-card-new{padding:4px 12px;border-style:dashed}
.ps-card-new .ps-goal-new{margin:0}
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
@media (max-width:520px){.ps-page{padding:12px 10px 150px}.ps-fact dd{max-width:160px}.ps-card-body{padding-left:12px}.ps-card-line{padding-left:12px}.ps-part{grid-template-columns:minmax(0,1fr)}.ps-part-name{padding-top:2px}}
/* Fingers need more to hit than a pointer does. */
@media (pointer:coarse){.ps-root .ps-icon{width:32px;height:32px}.ps-card-head>input[type=checkbox]{width:20px;height:20px;margin-top:6px}.ps-goal{min-height:34px}.ps-goal input[type=checkbox],.ps-goal-box,.ps-goal-plus{width:18px;height:18px;margin-top:7px}.ps-goal-text{padding:6px 4px}.ps-goal-input{height:32px}}
`;
