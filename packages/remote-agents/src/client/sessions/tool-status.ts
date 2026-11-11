import { TOOL_STATUS_URL } from '@dsh-plugins/remote-core/domain.js';

// DSH's sparkle icon for tools without their own, as a mask so it takes the row's color.
const SPARKLE = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000"><path d="M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z"/><path d="M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z"/><path d="M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z"/></svg>');
// The second attribute outweighs DSH's own link rule, whichever style comes last.
const LINE = `a[href="${TOOL_STATUS_URL}"][href]`;
export const toolStatusStyles = `
${LINE}{display:block;overflow:hidden;margin:0;border:0;font-size:var(--dsh-content-font-size-secondary,13px);font-weight:400;line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary,#9297a0);text-overflow:ellipsis;white-space:nowrap;pointer-events:none;background:linear-gradient(105deg,transparent 40%,var(--dsw-alias-label-shimmer,#fff8) 50%,transparent 60%) 100% 0/300% 100%,linear-gradient(currentColor,currentColor);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:ra-tool-status 1.5s steps(48) infinite}
${LINE}>svg{display:none}
${LINE}::before{content:'';display:inline-block;width:14px;height:14px;margin-right:8px;vertical-align:-2px;background:currentColor;-webkit-mask:url("data:image/svg+xml,${SPARKLE}") center/contain no-repeat;mask:url("data:image/svg+xml,${SPARKLE}") center/contain no-repeat}
@keyframes ra-tool-status{from{background-position:100% 0,0 0}to{background-position:0 0,0 0}}
@media(prefers-reduced-motion:reduce){${LINE}{background:none;-webkit-text-fill-color:currentColor;animation:none}}
`;

/** The line naming the running tool reads as one of DSH's tool rows rather than as part of the reply. */
export function installToolStatusStyles(): () => void {
  if (typeof document === 'undefined') return () => {};
  const style = document.createElement('style'); style.dataset.remoteToolStatus = ''; style.textContent = toolStatusStyles;
  document.head.append(style); return () => style.remove();
}
