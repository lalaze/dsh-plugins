/** How long a terminal may be starting or connecting before its status is shown. */
export const PENDING_STATUS_DELAY_MS = 700;

// DSH does not keep a sidebar terminal's screen while another conversation is in view: coming back builds it again and
// connects it again, a round trip to DSH that is usually over well within a second. Until then DSH shows a row that says
// "Connecting…" above an empty screen with a cursor, which flashes by on every return. The row is one of DSH's passing
// states exactly while it holds no button (Reconnect, Retry, New terminal, Take control), and those show at once as before.
// A passing state shows only if it lasts, and takes no room until then, so the screen does not jump either. The cursor
// waits with it: it cannot take input yet, and sits wherever the screen being rebuilt has got to. The screen follows the row
// as a sibling, which is how the cursor is found, as `:has()` may not be nested.
const PENDING = '[data-sidebar-terminal] > [role="status"]:not(:has(button))';
export const pendingStatusStyles = `${PENDING}{overflow:hidden;animation:ra-terminal-pending 0s linear ${PENDING_STATUS_DELAY_MS}ms backwards}
@keyframes ra-terminal-pending{from{visibility:hidden;max-height:0;min-height:0;padding-block:0}}
${PENDING} ~ * .xterm-cursor{visibility:hidden}`;

/** Styles only: DSH's terminal and its states are left as they are. */
export function installPendingStatus(): () => void {
  if (typeof document === 'undefined') return () => {};
  const style = document.createElement('style'); style.dataset.remoteTerminalPending = ''; style.textContent = pendingStatusStyles;
  document.head.append(style);
  return () => style.remove();
}
