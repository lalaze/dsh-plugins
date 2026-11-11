/** A conversation's terminal, which stays open in its own element whether or not the conversation is on screen. */
export interface KeptTerminal<Host = HTMLElement> {
  readonly sessionId: string;
  readonly host: Host;
  readonly shell: string;
  readonly generation: number;
  readonly visible: boolean;
}
interface Place<Host> { append(host: Host): void }

/**
 * Opening a terminal means a new emulator, attaching again and drawing the whole screen, which shows as a blank moment
 * each time a conversation is reopened. So the most recently used ones stay open: their elements move between the
 * conversation area and a hidden place, and they keep following their CLI meanwhile. The others open again when needed;
 * their CLI keeps running either way.
 */
export class KeptTerminals<Host extends { remove(): void } = HTMLElement> {
  private list: readonly KeptTerminal<Host>[] = [];
  private readonly listeners = new Set<() => void>();
  /**
   * @param limit - how many stay open.
   * @param hidden - where they wait while out of view.
   * @param createHost - makes the element a terminal lives in.
   * @param generations - the saved number of a conversation's terminal, which a replaced terminal increases.
   */
  constructor(
    private readonly limit: number,
    private readonly hidden: Place<Host>,
    private readonly createHost: () => Host,
    private readonly generations: { load(sessionId: string): number; save(sessionId: string, generation: number): void },
  ) {}
  snapshot = () => this.list;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  generation = (sessionId: string) => this.list.find(item => item.sessionId === sessionId)?.generation;
  /**
   * Puts a conversation's terminal on screen, opening it if it is not among those kept.
   * @param place - the conversation area.
   * @returns takes it off screen again.
   */
  show(sessionId: string, shell: string, place: Place<Host>): () => void {
    const item = this.list.find(other => other.sessionId === sessionId) ?? { sessionId, shell, host: this.createHost(), generation: this.generations.load(sessionId), visible: true };
    place.append(item.host);
    const others = this.list.filter(other => other.sessionId !== sessionId), over = Math.max(0, others.length + 1 - this.limit);
    for (const old of others.slice(0, over)) old.host.remove();
    this.publish([...others.slice(over), { ...item, visible: true }]);
    return () => this.hide(sessionId, item.host);
  }
  /** Closes a conversation's terminal here, for good until it is shown again. */
  drop(sessionId: string): void {
    this.list.find(item => item.sessionId === sessionId)?.host.remove();
    this.publish(this.list.filter(item => item.sessionId !== sessionId));
  }
  /** Replaces a conversation's terminal with a new one. */
  restart(sessionId: string): void {
    this.publish(this.list.map(item => {
      if (item.sessionId !== sessionId) return item;
      this.generations.save(sessionId, item.generation + 1);
      return { ...item, generation: item.generation + 1 };
    }));
  }
  private hide(sessionId: string, host: Host): void {
    if (!this.list.some(item => item.sessionId === sessionId && item.host === host)) return;
    this.hidden.append(host);
    this.publish(this.list.map(item => (item.sessionId === sessionId ? { ...item, visible: false } : item)));
  }
  private publish(list: readonly KeptTerminal<Host>[]): void {
    this.list = list;
    for (const listener of this.listeners) listener();
  }
}
