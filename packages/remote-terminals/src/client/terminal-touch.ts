import { findXterm } from './tui-render.js';

// On a touch device a tap on a terminal lands on one of its screen's layers, a canvas, and xterm then focuses its hidden
// input from code. A phone layout such as dsh-web-mobile lets code focus a text input only if the finger went down on that
// input or on an element containing it, so that a page cannot raise the keyboard by itself, and takes focus away again
// on a tap anywhere else. The terminal therefore never got focus, and nothing could be typed in it. With the layers out of
// the pointer's way a tap lands on the screen itself, which contains the input. xterm reads where a pointer is from the
// event's coordinates, not from the element it hit, so selecting, links and the CLI's mouse reports work as before.
// A mouse is left alone: only a device whose main pointer is a finger gets this.
const tapRule = '@media (pointer: coarse){[data-sidebar-terminal] .xterm-screen > :not(.xterm-helpers){pointer-events:none}}';
// A finger on a terminal is the terminal's to read (see TouchScroller): the browser must not pan or zoom the page under it.
// It means nothing to a mouse, so it needs no media query. The padding around a terminal counts too, as it looks like part
// of it; that rule is apart because a browser drops a rule whose selector it does not know, and the others must stay.
const panRules = ['[data-sidebar-terminal] .xterm{touch-action:none}', '[data-sidebar-terminal] :has(> .xterm){touch-action:none}'];
export const touchFocusStyles = [tapRule, ...panRules].join('\n');

/** The part of xterm's terminal that scrolling by touch uses. */
export interface TouchXterm {
  element?: HTMLElement;
  rows: number;
  modes: { mouseTrackingMode: string };
  buffer: { active: { type: string; viewportY: number; baseY: number } };
  scrollLines(amount: number): void;
}

/** How far a finger moves before it is scrolling rather than tapping, in CSS pixels. */
const SLOP = 8;
/** How much of the end of a swipe its speed is measured over, and how long a finger may rest before lifting and still fling. */
const SAMPLE_MS = 100, RESTED_MS = 60;
/** Speeds in pixels per millisecond: the least a lifted finger must have to carry on, and where that carrying on stops. */
const FLING_MIN = 0.25, FLING_STOP = 0.02;
/** How fast a fling slows: its speed falls by e in this time, about what a phone's own lists do. */
const FRICTION_MS = 325;
/** A cell's height when the screen has not been measured. */
const CELL_FALLBACK = 17;

export interface FrameClock { now(): number; frame(run: () => void): number; cancel(id: number): void }
const browserClock: FrameClock = {
  now: () => performance.now(),
  frame: run => requestAnimationFrame(() => run()),
  cancel: id => cancelAnimationFrame(id),
};

/**
 * Scrolls a terminal by touch, as the swipe of a list does. xterm 6, which DSH uses, reads only a wheel: its scrolling area is
 * no native scroll box, and it has no touch handling of its own, so on a phone a terminal could not be scrolled at all.
 *
 * A terminal showing its own history (a shell, or a CLI in its classic renderer) scrolls that history. A program that draws
 * the whole screen itself (fullscreen Claude Code, an editor) gets what a wheel would send it, one line at a time, through
 * xterm's own wheel handling: a mouse report if it asked for them, arrow keys otherwise.
 */
export class TouchScroller {
  private xterm?: TouchXterm;
  private state: 'idle' | 'pending' | 'swiping' | 'other' = 'idle';
  private startX = 0; private startY = 0;
  private x = 0; private y = 0;
  /** Distance moved that is not a whole line yet, in pixels, positive towards newer lines. */
  private rest = 0;
  private samples: Array<{ y: number; time: number }> = [];
  private fling?: number;
  /**
   * @param find - the terminal of an element in it.
   * @param clock - time and animation frames, for a fling.
   */
  constructor(private readonly find: (terminal: Element) => TouchXterm | undefined, private readonly clock: FrameClock = browserClock) {}

  /** A finger went down. A second finger, or one outside a terminal, ends what was going on. */
  start(target: EventTarget | null, x: number, y: number, fingers: number): void {
    this.stopFling();
    this.state = 'idle'; this.xterm = undefined;
    if (fingers !== 1) return;
    const terminal = terminalAt(target);
    const xterm = terminal ? this.find(terminal) : undefined;
    if (!xterm || typeof xterm.scrollLines !== 'function' || !xterm.element) return;
    this.xterm = xterm; this.state = 'pending';
    this.startX = this.x = x; this.startY = this.y = y; this.rest = 0;
    this.samples = [{ y, time: this.clock.now() }];
  }

  move(x: number, y: number): void {
    if (this.state === 'pending') {
      const dx = Math.abs(x - this.startX), dy = Math.abs(y - this.startY);
      // Sideways first means another gesture, such as a phone layout's drawer.
      if (dx >= SLOP && dx > dy) { this.state = 'other'; return; }
      if (dy < SLOP) return;
      // Counted from the edge of the distance a tap is allowed, so that the first line does not jump by it.
      this.state = 'swiping'; this.y = this.startY + Math.sign(y - this.startY) * SLOP;
      this.samples = [{ y, time: this.clock.now() }];
    }
    if (this.state !== 'swiping') return;
    const time = this.clock.now();
    this.samples.push({ y, time });
    while (this.samples.length > 2 && time - this.samples[0].time > SAMPLE_MS) this.samples.shift();
    const moved = this.y - y;
    this.x = x; this.y = y;
    this.scrollBy(moved);
  }

  /** The last finger lifted: a quick swipe carries on and slows down. */
  end(): void {
    const swiping = this.state === 'swiping';
    this.state = 'idle';
    if (!swiping || !this.xterm) return;
    let velocity = this.speed(), last = this.clock.now();
    if (Math.abs(velocity) < FLING_MIN) return;
    const step = () => {
      const now = this.clock.now(), elapsed = Math.max(0, now - last);
      last = now;
      const before = velocity;
      velocity *= Math.exp(-elapsed / FRICTION_MS);
      // The distance covered while the speed fell from one to the other.
      const moved = (before - velocity) * FRICTION_MS;
      if (!this.scrollBy(moved) || Math.abs(velocity) < FLING_STOP) { this.fling = undefined; return; }
      this.fling = this.clock.frame(step);
    };
    this.fling = this.clock.frame(step);
  }

  /** The browser took the touch back, as when a dialog opened: stop without carrying on. */
  cancel(): void { this.stopFling(); this.state = 'idle'; }
  stop(): void { this.cancel(); this.xterm = undefined; }

  /** Pixels per millisecond at the end of the swipe, positive towards newer lines. */
  private speed(): number {
    const now = this.clock.now(), last = this.samples.at(-1), first = this.samples[0];
    if (!last || !first || last === first || now - last.time > RESTED_MS) return 0;
    return (first.y - last.y) / Math.max(1, last.time - first.time);
  }

  /** @returns false once the terminal is gone or its history cannot go further that way. */
  private scrollBy(pixels: number): boolean {
    const xterm = this.xterm, element = xterm?.element;
    if (!xterm || !element?.isConnected) return false;
    const screen = element.querySelector('.xterm-screen')?.getBoundingClientRect();
    const cell = screen && screen.height > 0 && xterm.rows > 0 ? screen.height / xterm.rows : CELL_FALLBACK;
    this.rest += pixels;
    const lines = Math.trunc(this.rest / cell);
    if (!lines) return true;
    this.rest -= lines * cell;
    const own = xterm.buffer.active.type === 'normal' && xterm.modes.mouseTrackingMode === 'none';
    if (!own) { this.wheel(element, lines, screen); return true; }
    const { viewportY, baseY } = xterm.buffer.active;
    const room = lines < 0 ? Math.max(lines, -viewportY) : Math.min(lines, baseY - viewportY);
    if (!room) { this.rest = 0; return false; }
    xterm.scrollLines(room);
    return true;
  }

  /** One wheel line per line moved, where the finger is, for xterm to pass on as the program asked. */
  private wheel(element: HTMLElement, lines: number, screen: DOMRect | undefined): void {
    const View = element.ownerDocument.defaultView?.WheelEvent;
    if (!View) return;
    const inside = (value: number, from = 0, size = 0) => (size > 2 ? Math.min(Math.max(value, from + 1), from + size - 1) : value);
    const clientX = inside(this.x, screen?.left, screen?.width), clientY = inside(this.y, screen?.top, screen?.height);
    for (let count = 0; count < Math.abs(lines); count += 1) {
      element.dispatchEvent(new View('wheel', { deltaY: Math.sign(lines), deltaMode: 1, clientX, clientY, bubbles: true, cancelable: true }));
    }
  }

  private stopFling(): void {
    if (this.fling !== undefined) this.clock.cancel(this.fling);
    this.fling = undefined;
  }
}

/** The terminal a finger went down on: inside it, or in the padding of what holds it, within one of DSH's terminals. */
function terminalAt(target: EventTarget | null): Element | undefined {
  const element = target as Element | null;
  if (typeof element?.closest !== 'function' || !element.closest('[data-sidebar-terminal]')) return undefined;
  return element.closest('.xterm') ?? [...element.children].find(child => child.classList.contains('xterm'));
}

/** Tapping into and scrolling DSH's terminals by touch, wherever they are shown: the sidebar and TUI conversations. */
export function installTouchFocus(): () => void {
  if (typeof document === 'undefined') return () => {};
  const style = document.createElement('style'); style.dataset.remoteTerminalTouch = ''; style.textContent = touchFocusStyles;
  document.head.append(style);
  const scroller = new TouchScroller(terminal => findXterm(terminal) as TouchXterm | undefined);
  // Passive: the styles keep the page from panning, so nothing here needs to hold the browser's scrolling up.
  const options = { capture: true, passive: true };
  const start = (event: TouchEvent) => { const touch = event.touches[0]; scroller.start(event.target, touch?.clientX ?? 0, touch?.clientY ?? 0, event.touches.length); };
  const move = (event: TouchEvent) => { const touch = event.touches[0]; if (event.touches.length === 1 && touch) scroller.move(touch.clientX, touch.clientY); };
  const end = (event: TouchEvent) => { if (event.touches.length === 0) scroller.end(); };
  const cancel = () => scroller.cancel();
  const listeners = [['touchstart', start], ['touchmove', move], ['touchend', end], ['touchcancel', cancel]] as const;
  for (const [type, listener] of listeners) document.addEventListener(type, listener, options);
  return () => {
    for (const [type, listener] of listeners) document.removeEventListener(type, listener, options);
    scroller.stop();
    style.remove();
  };
}
