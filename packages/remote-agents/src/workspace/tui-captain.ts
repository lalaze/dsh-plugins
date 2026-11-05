import { RemoteError } from '../core/domain.js';
import type { Store } from '../core/store.js';

/** A line of the terminal's screen, as @xterm/headless gives it. */
export interface ScreenLine {
  readonly length: number;
  translateToString(trimRight?: boolean): string;
  getCell(x: number): { getChars(): string; isDim(): number; isInverse(): number } | undefined;
}
/** The running terminal of a TUI conversation. */
export interface CaptainTerminal {
  /** The screen's visible lines, top to bottom. */
  lines(): readonly ScreenLine[];
  write(data: string): Promise<void>;
}
export interface TeamResult { kind: 'success' | 'error'; text?: string }

const PROMPT_MARKS = new Set(['❯', '›']);
/** Often enough to feel immediate, cheap enough to keep up while a message waits for the prompt to clear. */
const POLL_MS = 1000;
/** Both CLIs treat what comes right after a paste as part of it, Enter included. */
const SUBMIT_DELAY_MS = 400;
const INBOX_RECEIPT = /^AgentTeams inbox receipt: [^\n]*\n+/;

/**
 * Whether the CLI is waiting at an empty prompt, the only time text can be typed into it safely. Both CLIs draw their
 * prompt with one mark, and a placeholder or a suggestion after it dim or with the cursor on its first letter, as text
 * being typed has it at the end. They also mark the highlighted choice of a dialog with it, so a question or a permission
 * prompt counts as text and is left alone: Enter there would answer it.
 */
export function promptIsEmpty(lines: readonly ScreenLine[]): boolean {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index], text = line.translateToString(true), mark = text.search(/\S/);
    if (mark < 0 || !PROMPT_MARKS.has(text[mark])) continue;
    if (line.getCell(mark + 2)?.isInverse()) return true;
    for (let x = mark + 1; x < line.length; x++) {
      const cell = line.getCell(x);
      if (cell && cell.getChars().trim() && !cell.isDim()) return false;
    }
    return true;
  }
  return false;
}

/** What the CLI needs to know beside the team's own message: it has none of DSH's system prompt. */
export const CAPTAIN_GUIDE = 'This session is the team\'s captain. Members work on their own and report here: each report arrives as a message starting "AgentTeams message from member". Stop and wait for them rather than polling or doing their work yourself. When something needs changing, use the other tools on the dsh-agent-teams MCP server. When the reports are in, tell the user the outcome.';
/** Told to a CLI whose user typed /team, which it never saw. The result comes first, as this may title the conversation. */
const typedTeamNotice = (result: string) => `${result}\n\nDSH started this team from a /team line the user typed. ${CAPTAIN_GUIDE}`;

/**
 * A TUI conversation as an AgentTeams captain. AgentTeams wakes its captain with a DSH turn; here the captain is a CLI in a
 * terminal, so that turn hands the team's message to the terminal instead of starting another CLI. Messages wait in the
 * saved state until the CLI is at an empty prompt, so nothing the user is typing is sent, nothing it is asking is answered,
 * and a restart loses none.
 */
export class TuiCaptain {
  /** Runs what follows /team for a conversation; set once the team command's services are up. */
  startTeam?: (sessionId: string, line: string, signal: AbortSignal) => Promise<TeamResult>;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private closed = false;
  /** Conversations whose prompt was empty at the last check. */
  private readonly empty = new Set<string>();
  constructor(private readonly store: Pick<Store, 'snapshot' | 'update'>, private readonly terminal: (sessionId: string) => CaptainTerminal | undefined,
    private readonly delays = { poll: POLL_MS, submit: SUBMIT_DELAY_MS }) { this.schedule(); }
  isTui(sessionId: string): boolean { return this.store.snapshot().tuiSessions?.includes(sessionId) === true; }
  waiting(sessionId: string): number { return this.store.snapshot().tuiDetails?.[sessionId]?.inbox?.length ?? 0; }
  /** Queue messages for the conversation's CLI. */
  async deliver(sessionId: string, messages: readonly string[]): Promise<void> {
    const texts = messages.map(text => text.replace(INBOX_RECEIPT, '').trim()).filter(Boolean);
    if (!texts.length) return;
    await this.store.update(state => {
      const details = state.tuiDetails?.[sessionId];
      state.tuiDetails = { ...state.tuiDetails, [sessionId]: { ...details, inbox: [...details?.inbox ?? [], ...texts] } };
    });
    this.schedule();
  }
  /** The user typed /team in the terminal: start the team here, as DSH's composer would, and tell the CLI. */
  async team(sessionId: string, line: string, signal: AbortSignal): Promise<string> {
    if (!this.isTui(sessionId)) throw new RemoteError('This is not a TUI conversation', 409);
    if (!this.startTeam) throw new RemoteError('DSH is still starting. Try again in a moment.', 409);
    const result = await this.startTeam(sessionId, line, signal);
    if (result.kind === 'error') throw new RemoteError(result.text ?? 'AgentTeams could not create the team');
    const text = result.text ?? 'The team started.';
    await this.deliver(sessionId, [typedTeamNotice(text)]);
    return text;
  }
  private schedule(): void {
    if (this.closed || this.timer || this.running) return;
    const { tuiDetails } = this.store.snapshot();
    if (!Object.values(tuiDetails ?? {}).some(details => details.inbox?.length)) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.delays.poll);
    this.timer.unref?.();
  }
  private async flush(): Promise<void> {
    this.running = true;
    try {
      for (const [sessionId, details] of Object.entries(this.store.snapshot().tuiDetails ?? {})) {
        const next = details.inbox?.[0], terminal = next === undefined ? undefined : this.terminal(sessionId);
        const empty = !!terminal && promptIsEmpty(terminal.lines()), settled = empty && this.empty.has(sessionId);
        // Empty at two checks in a row: someone clearing the prompt or about to type has moved on by the second.
        if (empty) this.empty.add(sessionId); else this.empty.delete(sessionId);
        if (next === undefined || !terminal || !settled) continue;
        // Bracketed, so its line breaks do not submit it; and nothing in it can end the paste early.
        await terminal.write(`\u001b[200~${next.replace(/\u001b/g, '')}\u001b[201~`);
        await new Promise(resolve => setTimeout(resolve, this.delays.submit));
        // A key pressed meanwhile may have cleared it, and Enter would then send nothing. It stays queued for another try.
        if (promptIsEmpty(terminal.lines())) continue;
        await terminal.write('\r');
        this.empty.delete(sessionId);
        await this.store.update(state => {
          const saved = state.tuiDetails?.[sessionId];
          if (saved?.inbox?.[0] === next) saved.inbox = saved.inbox.slice(1);
          if (saved && !saved.inbox?.length) delete saved.inbox;
        });
      }
    } catch { /* the terminal went away: the message stays for the next one */ }
    finally { this.running = false; this.schedule(); }
  }
  close(): void { this.closed = true; clearTimeout(this.timer); this.timer = undefined; }
}
