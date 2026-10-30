// Colors follow DSH's theme: it marks the body `data-ds-dark-theme` in dark mode. Hosts without that
// marker follow the system scheme.
const LIGHT = '--fv-link:#0969da;--fv-status-bg:#f8f8f8;--fv-status-fg:#3b3b3b;--fv-status-border:#e5e5e5';
const DARK = '--fv-link:#58a6ff;--fv-status-bg:#181818;--fv-status-fg:#cccccc;--fv-status-border:#2b2b2b';
export const fileViewStyles = `
.fv-code,.fv-markdown{${LIGHT}}
body[data-ds-dark-theme] .fv-code,body[data-ds-dark-theme] .fv-markdown{${DARK}}
@media(prefers-color-scheme:dark){body:not([data-ds-theme-source]) .fv-code,body:not([data-ds-theme-source]) .fv-markdown{${DARK}}}
.fv-code{position:relative;display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden}
.fv-code-host{flex:1;min-height:0;min-width:0}
.fv-code-note{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;margin:0;font-size:12px;opacity:.7}
.fv-code-note button{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:4px;padding:2px 8px;cursor:pointer}
.fv-status{flex:none;display:flex;justify-content:flex-end;align-items:center;gap:2px;height:22px;padding:0 6px;overflow:hidden;white-space:nowrap;
font:12px/22px system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--fv-status-bg);color:var(--fv-status-fg);border-top:1px solid var(--fv-status-border)}
/* Specific enough to win over a host's own button styles. */
.fv-code .fv-status>*{flex:none;height:22px;margin:0;padding:0 6px;font:inherit;color:inherit;background:none;border:none;border-radius:0;box-shadow:none}
.fv-code .fv-status>button{cursor:pointer;border-radius:3px}.fv-code .fv-status>button:hover:enabled{background:color-mix(in srgb,currentColor 12%,transparent)}
.fv-image{display:flex;flex-direction:column;min-height:0;height:100%}
.fv-image-stage{flex:1;min-height:0;overflow:auto;display:grid;place-items:center;padding:12px;border-radius:6px;cursor:zoom-in;
background:repeating-conic-gradient(color-mix(in srgb,currentColor 7%,transparent) 0 25%,transparent 0 50%) 0 0/16px 16px}
.fv-image[data-actual] .fv-image-stage{place-items:start;cursor:zoom-out}
.fv-image img{max-width:100%;max-height:100%;object-fit:contain;image-rendering:auto}
.fv-image[data-actual] img{max-width:none;max-height:none}
.fv-image-meta{flex:none;padding:6px 2px 0;font-size:12px;opacity:.7;font-variant-numeric:tabular-nums}
.fv-markdown{overflow:auto;min-height:0;padding:4px 14px 16px;line-height:1.6;overflow-wrap:anywhere}
.fv-markdown h1,.fv-markdown h2{border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent);padding-bottom:.25em}
.fv-markdown a{color:var(--fv-link)}
.fv-markdown code{font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.9em;padding:.1em .35em;border-radius:4px;background:color-mix(in srgb,currentColor 8%,transparent)}
.fv-markdown pre{padding:10px 12px;border-radius:6px;overflow:auto;background:color-mix(in srgb,currentColor 6%,transparent)}
.fv-markdown pre code{padding:0;background:none}
.fv-markdown blockquote{margin:0;padding-left:12px;border-left:3px solid color-mix(in srgb,currentColor 20%,transparent);opacity:.85}
.fv-markdown table{border-collapse:collapse}.fv-markdown th,.fv-markdown td{border:1px solid color-mix(in srgb,currentColor 18%,transparent);padding:4px 8px}
.fv-markdown img{max-width:100%}
/* Task lists as on GitHub, whatever the host does to inputs. */
.fv-markdown .contains-task-list{padding-left:1.4em}.fv-markdown .task-list-item{list-style:none}
.fv-markdown input[type=checkbox]{width:auto;height:auto;margin:0 .45em 0 -1.4em;padding:0;border:revert;border-radius:revert;background:revert;vertical-align:-1px}
`;
