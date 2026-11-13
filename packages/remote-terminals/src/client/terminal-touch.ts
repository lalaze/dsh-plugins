// On a touch device a tap on a terminal lands on one of its screen's layers, a canvas, and xterm then focuses its hidden
// input from code. A phone layout such as dsh-web-mobile lets code focus a text input only if the finger went down on that
// input or on an element containing it, so that a page cannot raise the keyboard by itself, and takes focus away again
// on a tap anywhere else. The terminal therefore never got focus, and nothing could be typed in it. With the layers out of
// the pointer's way a tap lands on the screen itself, which contains the input. xterm reads where a pointer is from the
// event's coordinates, not from the element it hit, so selecting, links and the CLI's mouse reports work as before.
// A mouse is left alone: only a device whose main pointer is a finger gets this.
export const touchFocusStyles = '@media (pointer: coarse){[data-sidebar-terminal] .xterm-screen > :not(.xterm-helpers){pointer-events:none}}';

/** Styles only, for DSH's terminal wherever it is shown: the sidebar and TUI conversations. */
export function installTouchFocus(): () => void {
  if (typeof document === 'undefined') return () => {};
  const style = document.createElement('style'); style.dataset.remoteTerminalTouch = ''; style.textContent = touchFocusStyles;
  document.head.append(style);
  return () => style.remove();
}
