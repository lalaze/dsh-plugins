/**
 * A TUI conversation has a terminal where a chat has its composer, so a plugin that writes into a conversation's input
 * finds nothing to write into there. dsh-remote-terminals offers the terminal's prompt instead. The plugins' pages are
 * separate bundles on one page, sharing no module, so it is handed over through the page itself.
 */
export interface TuiPrompt {
  /** Whether the conversation is a TUI one. */
  has(sessionId: string): boolean;
  /**
   * Types text at the CLI's prompt, as a paste, without sending it. The terminal may still be opening, so the text waits
   * for it a while; bring the conversation's Chat view on screen so it opens.
   * @returns whether the terminal took the text. It is withdrawn otherwise.
   */
  paste(sessionId: string, text: string): Promise<boolean>;
}
const KEY = '__dshRemoteTuiPrompt';
type Page = { [KEY]?: TuiPrompt };
/** @returns takes the offer back, as when the plugin making it is switched off. */
export function offerTuiPrompt(prompt: TuiPrompt): () => void {
  const page = window as unknown as Page;
  page[KEY] = prompt;
  return () => { if (page[KEY] === prompt) delete page[KEY]; };
}
/** Read when it is needed rather than kept: the plugin offering it may load later, or be switched off. */
export const tuiPrompt = () => (typeof window === 'undefined' ? undefined : (window as unknown as Page)[KEY]);
