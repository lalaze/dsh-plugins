// Token colors follow DSH's theme: it marks the body `data-ds-dark-theme` in dark mode. Hosts without that
// marker follow the system scheme.
const LIGHT = `--fv-keyword:#cf222e;--fv-string:#0a3069;--fv-number:#0550ae;--fv-comment:#6e7781;--fv-type:#953800;--fv-definition:#8250df;
--fv-property:#0550ae;--fv-meta:#6e7781;--fv-link:#0969da;--fv-inserted:#116329;--fv-deleted:#82071e;--fv-heading:#0550ae`;
const DARK = `--fv-keyword:#ff7b72;--fv-string:#a5d6ff;--fv-number:#79c0ff;--fv-comment:#8b949e;--fv-type:#ffa657;--fv-definition:#d2a8ff;
--fv-property:#79c0ff;--fv-meta:#8b949e;--fv-link:#58a6ff;--fv-inserted:#7ee787;--fv-deleted:#ffa198;--fv-heading:#79c0ff`;
export const fileViewStyles = `
.fv-code,.fv-markdown{${LIGHT}}
body[data-ds-dark-theme] .fv-code,body[data-ds-dark-theme] .fv-markdown{${DARK}}
@media(prefers-color-scheme:dark){body:not([data-ds-theme-source]) .fv-code,body:not([data-ds-theme-source]) .fv-markdown{${DARK}}}
.fv-code{min-height:0;overflow:hidden}
.fv-code .tok-keyword,.fv-code .tok-operator.tok-keyword{color:var(--fv-keyword)}
.fv-code .tok-string,.fv-code .tok-string2{color:var(--fv-string)}
.fv-code .tok-number,.fv-code .tok-bool,.fv-code .tok-atom,.fv-code .tok-literal{color:var(--fv-number)}
.fv-code .tok-comment{color:var(--fv-comment);font-style:italic}
.fv-code .tok-typeName,.fv-code .tok-className,.fv-code .tok-namespace{color:var(--fv-type)}
.fv-code .tok-definition,.fv-code .tok-macroName{color:var(--fv-definition)}
.fv-code .tok-propertyName,.fv-code .tok-labelName{color:var(--fv-property)}
.fv-code .tok-meta{color:var(--fv-meta)}
.fv-code .tok-link,.fv-code .tok-url{color:var(--fv-link);text-decoration:underline}
.fv-code .tok-heading{color:var(--fv-heading);font-weight:600}
.fv-code .tok-strong{font-weight:600}.fv-code .tok-emphasis{font-style:italic}.fv-code .tok-strikethrough{text-decoration:line-through}
.fv-code .tok-inserted{color:var(--fv-inserted)}.fv-code .tok-deleted{color:var(--fv-deleted)}
.fv-code .tok-invalid{color:var(--fv-deleted)}
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
`;
